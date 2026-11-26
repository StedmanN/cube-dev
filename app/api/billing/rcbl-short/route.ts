// app/api/billing/rcbl-short/route.ts

// Production authentication: uncomment alongside the blocks inside GET and POST.
import { getAppSession } from "@/lib/app-session";

import { randomUUID } from "node:crypto";

import { NextRequest, NextResponse } from "next/server";

import {
  BatchWriteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";

import { ddb } from "@/lib/dynamo";
import { getRealPropertyPeriodState } from "@/lib/real-property-snapshot";
import {
  isRetryableDynamoError,
  logDynamoError,
  publicDynamoErrorResponse,
} from "@/lib/dynamo-error";
import {
  HistoryArchiveConsistencyError,
  buildHistoryMetadataRecord,
  historyMetadataFromRecord,
  historyMetadataIsComplete,
  historyMetadataKey,
  historyMetadataMatches,
  historyVersionIsComplete,
  isHistoryMetadataRecord,
  type HistoryArchiveMetadata,
} from "@/lib/rcbl-history";
import {
  validateReconciliationReadiness,
} from "@/lib/rcbl-reconciliation-readiness";
import {
  billingPreviewsMatch,
  billingPreviewFingerprint,
  unresolvedOfficialCustomerBillingIssues,
} from "@/lib/rcbl-billing-integrity";
import { splitReimbursementCharge } from "@/lib/utility-reimbursement";
import { compute3556ReportingSplit } from "@/lib/3556-reporting";
import { resolveAccountingCrosswalkFromScannedRecords } from "@/lib/reporting-crosswalk";
import { fingerprint3556, mappingPK } from "@/lib/reporting-classification";

export const dynamic = "force-dynamic";

export const revalidate = 0;

// DynamoDB source tables: saved reconciliation allocations, finalized 3556 rates,
// and utility invoice costs. RCBL_SHORT_TABLE is the destination for saved bills.
const RECONCILIATION_TABLE =

  process.env.CUBE_RECONCILIATION_TABLE_NAME ||

  "p72-CUBE-MONTHLY-RECONCILIATION";

const RATE_TABLE =

  process.env.CUBE_3556_TABLE_NAME ||

  "p72-CUBE-3556";

const INVOICES_TABLE =

  process.env.CUBE_INVOICES_TABLE_NAME ||

  "p72-CUBE-INVOICES";

const CUSTOMERS_TABLE =

  process.env.CUBE_CUSTOMERS_TABLE_NAME ||

  "p72-CUBE-CUSTOMERS";

const RCBL_SHORT_TABLE =

  process.env.CUBE_RCBL_SHORT_TABLE_NAME ||

  "p72-CUBE-RCBL-SHORT";

const RCBL_SHORT_HISTORY_TABLE =

  process.env.CUBE_RCBL_SHORT_HISTORY_TABLE_NAME ||

  "p72-CUBE-RCBL-SHORT-HISTORY";

const CURRENT_POINTER_RECORD_TYPE = "BILL_VERSION_POINTER";

type Item = Record<string, any>;

type RateSelection = {

  rateKey: string;

  rateLabel: string;

  rate: number | null;

};

function text(value: unknown): string {

  if (value === undefined || value === null) return "";

  return String(value).trim();

}

function numberValue(value: unknown): number {

  if (typeof value === "number") {

    return Number.isFinite(value) ? value : 0;

  }

  const parsed = Number(

    text(value).replace(/[$,%s,]/g, ""),

  );

  return Number.isFinite(parsed) ? parsed : 0;

}

function round(value: number, places = 8): number {

  const factor = 10 ** places;

  return Math.round((value + Number.EPSILON) * factor) / factor;

}

function normalize(value: unknown): string {

  return text(value)

    .toUpperCase()

    .replace(/&/g, "AND")

    .replace(/[^A-Z0-9]/g, "");

}

function normalizeFiscalYear(value: unknown): string {

  const digits = text(value).replace(/D/g, "");

  if (!digits) return "";

  if (digits.length >= 4) {

    return digits.slice(-4);

  }

  if (digits.length === 2) {

    return `20${digits}`;

  }

  return digits;

}

// Translate reconciliation group IDs and legacy TACX into canonical 3556 group names.
function normalizeUtilityGroup(value: unknown): string {

  const valueText = normalize(value);

  // Reconciliation/invoice data stores utility group IDs.

  // 3556 stores the corresponding names.

  if (valueText === "1") return "WWYK";

  if (valueText === "2") return "TAC";

  if (valueText === "TACX") return "TAC";

  return valueText;

}

function normalizeUtilitySystem(value: unknown): string {

  const valueText = normalize(value);

  if (

    valueText === "EL" ||

    valueText === "ELECTRIC" ||

    valueText === "ELECTRICITY"

  ) {

    return "ELECTRICITY";

  }

  if (

    valueText === "NG" ||

    valueText === "NATURALGAS" ||

    valueText === "GAS"

  ) {

    return "NATURALGAS";

  }

  if (

    valueText === "PW" ||

    valueText === "PRODUCEDWATER" ||

    valueText === "WATER"

  ) {

    return "PRODUCEDWATER";

  }

  if (

    valueText === "SS" ||

    valueText === "SW" ||

    valueText === "SEWER" ||

    valueText === "WASTEWATER"

  ) {

    return "SEWER";

  }

  return valueText;

}

function normalizeInvoiceUtilitySystem(value: unknown): string {

  const valueText = normalize(value);

  // Purchased Water (IW) is recovered through Sewer.

  if (valueText === "IW" || valueText === "PURCHASEDWATER") {

    return "SEWER";

  }

  return normalizeUtilitySystem(value);

}

function displayUtilitySystem(value: unknown): string {

  switch (normalizeUtilitySystem(value)) {

    case "ELECTRICITY":

      return "Electricity";

    case "NATURALGAS":

      return "Natural Gas";

    case "PRODUCEDWATER":

      return "Produced Water";

    case "SEWER":

      return "Sewer";

    default:

      return text(value);

  }

}

function normalizeCustomerType(value: unknown): string {

  const customerType = text(value);

  return customerType || "Non-Reimbursable";

}

function reimbursementDisposition(allocation: Item):
  | "CUSTOMER_REIMBURSABLE"
  | "CE_ABSORBED" {
  const stored = text(allocation.ReimbursementDisposition).toUpperCase();
  if (stored === "CUSTOMER_REIMBURSABLE" || stored === "CE_ABSORBED") {
    return stored;
  }
  return normalize(allocation.CustomerType) === "REIMBURSABLE"
    ? "CUSTOMER_REIMBURSABLE"
    : "CE_ABSORBED";
}

// Resolve the customer RateClass to the corresponding FINAL 3556 sales rate.
// Missing or nonnumeric rates remain null so the bill is flagged for review.
function selectSalesRate(

  rateClass: unknown,

  calculatedSalesRates: Item,

): RateSelection {

  const rateClassText = normalize(rateClass);

  let rateKey = "";

  let rateLabel = "";

  // CUBE RATE_CLASS -> 3556 final calculated sales-rate field:

  //

  // DOD Fed (MFH)  -> A-3   -> calculatedSalesRates.mfh

  // Non Fed        -> B-6   -> calculatedSalesRates.nonFederal

  // Non DOD Fed    -> C-5   -> calculatedSalesRates.nonDodFederal

  // DOD Fed        -> D-1&2 -> calculatedSalesRates.dod

  // DOD Fed (DBOF) -> D-1&2 -> calculatedSalesRates.dod

  // Services       -> E-7   -> calculatedSalesRates.categoryCMwr

  // Installation   -> D-1&2 -> calculatedSalesRates.dod

  //

  // Keep specific mappings ahead of the broader DoD match.

  if (

    rateClassText === "DODFEDMFH" ||

    rateClassText === "A3" ||

    rateClassText.includes("MFH") ||

    rateClassText.includes("PRIVATIZEDMFH")

  ) {

    rateKey = "mfh";

    rateLabel = "A-3 / MFH USAF Utility Rate";

  } else if (

    rateClassText === "NONFED" ||

    rateClassText === "B6" ||

    rateClassText.includes("NONFEDERAL") ||

    rateClassText.includes("COMMERCIAL")

  ) {

    rateKey = "nonFederal";

    rateLabel = "B-6 / Non-Federal Organization USAF Utility Rate";

  } else if (

    rateClassText === "NONDODFED" ||

    rateClassText === "C5" ||

    rateClassText.includes("NONDOD")

  ) {

    rateKey = "nonDodFederal";

    rateLabel = "C-5 / Non-DoD Federal Agency USAF Utility Rate";

  } else if (

    rateClassText === "SERVICES" ||

    rateClassText === "E7" ||

    rateClassText.includes("MWR") ||

    rateClassText.includes("AAFES") ||

    rateClassText.includes("PCS") ||

    rateClassText.includes("TDY")

  ) {

    rateKey = "categoryCMwr";

    rateLabel = "E-7 / Category C MWR USAF Utility Rate";

  } else if (

    rateClassText === "INSTALLATION" ||

    rateClassText === "DODFED" ||

    rateClassText === "DODFEDDBOF" ||

    rateClassText === "D12" ||

    (

      rateClassText.includes("DOD") &&

      !rateClassText.includes("NONDOD") &&

      !rateClassText.includes("MWR")

    )

  ) {

    rateKey = "dod";

    rateLabel = "D-1&2 / DoD Agency USAF Utility Rate";

  } else if (

    rateClassText.includes("LOCALPREVAILING") ||

    rateClassText.includes("UTILITYPROVIDER")

  ) {

    rateKey = "localPrevailing";

    rateLabel = "Local Prevailing or Utility Provider Rate";

  }

  if (!rateKey) {

    return {

      rateKey: "",

      rateLabel: "Unmapped Rate Class",

      rate: null,

    };

  }

  const rawRate = calculatedSalesRates?.[rateKey];

  if (

    rawRate === undefined ||

    rawRate === null ||

    text(rawRate) === ""

  ) {

    return {

      rateKey,

      rateLabel,

      rate: null,

    };

  }

  const parsed = Number(

    text(rawRate).replace(/[$,%s,]/g, ""),

  );

  return {

    rateKey,

    rateLabel,

    rate: Number.isFinite(parsed) ? parsed : null,

  };

}

// Read every DynamoDB scan page; a single ScanCommand is not exhaustive.
async function scanAll(

  tableName: string,

): Promise<Item[]> {

  const items: Item[] = [];

  let ExclusiveStartKey: Item | undefined;

  do {

    const response = await ddb.send(

      new ScanCommand({

        TableName: tableName,

        ExclusiveStartKey,

      }),

    );

    items.push(...(response.Items ?? []));

    ExclusiveStartKey = response.LastEvaluatedKey;

  } while (ExclusiveStartKey);

  return items;

}

// Compute calendar-month cutoff from the fiscal-year billing period.
// The effective-date check prevents future rates from being used on past bills.
function billingPeriodCutoff(allocation: Item): string {

  const fy = Number(normalizeFiscalYear(allocation.FY));

  const monthName = text(allocation.BillingMonth).toLowerCase();

  const monthMap: Record<string, number> = {

    january: 1,

    jan: 1,

    february: 2,

    feb: 2,

    march: 3,

    mar: 3,

    april: 4,

    apr: 4,

    may: 5,

    june: 6,

    jun: 6,

    july: 7,

    jul: 7,

    august: 8,

    aug: 8,

    september: 9,

    sep: 9,

    october: 10,

    oct: 10,

    november: 11,

    nov: 11,

    december: 12,

    dec: 12,

  };

  const month = monthMap[monthName];

  if (!fy || !month) {

    return "";

  }

  // FY is the fiscal year ending in September.

  // October-December belong to the prior calendar year.

  const calendarYear = month >= 10 ? fy - 1 : fy;

  // Use the last instant/day of the billing month as the cutoff so a 3556

  // effective during that month is eligible for that month's bill.

  const lastDay = new Date(

    Date.UTC(calendarYear, month, 0),

  )

    .toISOString()

    .slice(0, 10);

  return lastDay;

}

// Select the most recent FINAL 3556 effective by the billing cutoff
// for the specific Utility Group and Utility System pair.
function chooseFinalRate(

  finalRates: Item[],

  allocation: Item,

): Item | null {

  const utilityGroup = normalizeUtilityGroup(

    allocation.UtilityGroup,

  );

  const utilitySystem = normalizeUtilitySystem(

    allocation.UtilityType,

  );

  const cutoff = billingPeriodCutoff(allocation);

  /*

    IMPORTANT:

    3556 applicability is controlled by EFFECTIVE DATE, not by the

    fiscalYear label stored on the 3556.

    Example:

      January 3556 is effective 2026-01-01

      June FY26 bill => January 3556 applies

      September 3556 is effective 2026-09-01

      June FY26 bill => September 3556 does NOT apply

    Therefore we match only the utility pair, require FINAL status

    upstream, reject future effective dates, then take the newest

    applicable effective date.

  */

  const matches = finalRates

    .filter((record) => {

      const effectiveDate = text(record.effectiveDate);

      return (

        normalizeUtilityGroup(record.utilityGroup) ===

          utilityGroup &&

        normalizeUtilitySystem(record.utilitySystem) ===

          utilitySystem &&

        Boolean(effectiveDate) &&

        Boolean(cutoff) &&

        effectiveDate <= cutoff

      );

    })

    .sort((a, b) => {

      const effectiveCompare = text(

        b.effectiveDate,

      ).localeCompare(text(a.effectiveDate));

      if (effectiveCompare !== 0) {

        return effectiveCompare;

      }

      return text(b.approvedAt).localeCompare(

        text(a.approvedAt),

      );

    });

  return matches[0] ?? null;

}

// GET: preview-only bill generation. No RCBL Short billing records are written.
// Reconciliation allocations are priced, consolidated per customer, and checked
// against invoice charges for cost recovery.
export async function GET(

  request: NextRequest,

) {

  try {
    // ========================================================
    // AUTHENTICATION
    //
    // Authenticate before reading request parameters or accessing
    // DynamoDB. Keep this disabled during local development;
    // uncomment the auth import and this block to enforce login.
    // ========================================================

    const session =
      await getAppSession();

    if (
      !session?.user
    ) {
      return Response.json(
        {
          ok: false,
          error:
            "Unauthorized",
        },
        {
          status: 401,
        },
      );
    }

    // ========================================================
    // AUTHENTICATED REQUEST
    // ========================================================

    const billingPeriodId = Number(

      request.nextUrl.searchParams.get(

        "billing_period_id",

      ),

    );

    if (!Number.isInteger(billingPeriodId)) {

      return NextResponse.json(

        {

          error:

            "billing_period_id is required.",

        },

        { status: 400 },

      );

    }

    const realPropertyState =
      await getRealPropertyPeriodState(billingPeriodId);

    const view = text(
      request.nextUrl.searchParams.get("view"),
    ).toLowerCase();

    if (view === "saved") {
      const savedRows = await scanSavedBillingPeriod(billingPeriodId);
      const current = currentSavedRecords(savedRows);
      if (current.records.length === 0) {
        return NextResponse.json(
          { error: "No saved RCBL Short bill exists for this billing period." },
          { status: 404 },
        );
      }
      return NextResponse.json({
        ...savedRowsToPreview(
          current.records,
          billingPeriodId,
          current.pointer,
        ),
        sourceDataPotentiallyStale:
          realPropertyState?.BillsPotentiallyStale === true,
        sourceDataChangedAt: realPropertyState?.ChangedAt ?? null,
        sourceDataChangeOperation:
          realPropertyState?.ChangeOperation ?? null,
      });
    }

    if (view === "history") {
      const [historyRows, currentRows] = await Promise.all([
        scanHistoryBillingPeriod(billingPeriodId),
        scanSavedBillingPeriod(billingPeriodId),
      ]);
      const activeVersionId = text(
        currentRows.find(
          (row) => text(row.RecordType) === CURRENT_POINTER_RECORD_TYPE,
        )?.CurrentVersionId,
      );
      const versionId = text(
        request.nextUrl.searchParams.get("version_id"),
      );

      if (!versionId) {
        return NextResponse.json({
          ok: true,
          billingPeriodId,
          versions: historyVersionSummaries(
            historyRows,
            currentRows,
            billingPeriodId,
            activeVersionId,
          ),
        });
      }

      const versionRows = historyRows.filter(
        (row) => text(row.VersionId) === versionId,
      );
      const metadataRows = historyRows
        .filter(isHistoryMetadataRecord)
        .map(historyMetadataFromRecord)
        .filter(
          (metadata): metadata is HistoryArchiveMetadata => metadata !== null,
        );
      const metadata = metadataRows.find(
        (entry) => entry.sourceVersionId === versionId,
      );
      const sourceRecords = historySourceRecords(
        currentRows,
        billingPeriodId,
        versionId,
      );
      const availableVersionIds = new Set(
        currentRows
          .filter(
            (row) => text(row.RecordType) !== CURRENT_POINTER_RECORD_TYPE,
          )
          .map((row) => text(row.VersionId))
          .filter(Boolean),
      );
      const complete = metadata
        ? historyMetadataIsComplete(
            metadata,
            sourceRecords,
            activeVersionId,
            metadataRows,
            availableVersionIds,
          )
        : historyVersionIsComplete(
            versionRows,
            sourceRecords,
            versionId,
            billingPeriodId,
            activeVersionId,
          );

      if (!complete) {
        return NextResponse.json(
          {
            error:
              "The requested historical bill version is incomplete or is no longer verifiable.",
          },
          { status: 404 },
        );
      }
      return NextResponse.json(
        savedRowsToPreview(metadata ? sourceRecords : versionRows, billingPeriodId, {
          CurrentVersionId: versionId,
          CurrentVersionNumber:
            metadata?.sourceVersionNumber ?? versionRows[0]?.VersionNumber,
          SavedAt: metadata?.archivedAt ?? versionRows[0]?.ArchivedAt,
        }),
      );
    }

    const [reconciliationRecords, rateRecords, invoiceRecords] =

      await Promise.all([

        scanAll(RECONCILIATION_TABLE),

        scanAll(RATE_TABLE),

        scanAll(INVOICES_TABLE),

      ]);

    const periodReconciliationRecords = reconciliationRecords.filter(
      (item) => Number(item.billing_period_id) === billingPeriodId,
    );
    const reconciliationReadiness = validateReconciliationReadiness(
      periodReconciliationRecords,
      billingPeriodId,
      invoiceRecords,
    );

    const allocations = reconciliationRecords.filter(

      (item) =>

        Number(item.billing_period_id) ===

          billingPeriodId &&

        text(item.RecordType).toUpperCase() ===

          "ALLOCATION",

    );

    if (allocations.length === 0) {

      return NextResponse.json(

        {

          error:

            "No saved reconciliation allocations were found for this billing period. Generate and save Monthly Reconciliation first.",

        },

        { status: 404 },

      );

    }

    // Accounting crosswalk metadata is stored separately from FINAL rate rows;
    // failed/invalid configuration must never silently revert to guessed codes.
    const accountingCrosswalk = resolveAccountingCrosswalkFromScannedRecords(rateRecords);

    const finalRates = rateRecords.filter(

      (record) =>

        text(record.status).toUpperCase() === "FINAL",

    );

    // Reporting row-classification records are stored separately from FINAL 3556
    // worksheets. They cannot change any approved rate or worksheet cost.
    const reportingMappings = new Map<string, Item>();
    for (const record of rateRecords) {
      if (text(record.RecordType) !== "REPORTING_CLASSIFICATION" || text(record.SK) !== "CURRENT") continue;
      reportingMappings.set(text(record.PK), record);
    }

    const lines = allocations.map(

      (allocation) => {

        const rateRecord = chooseFinalRate(

          finalRates,

          allocation,

        );

        const rateSelection = selectSalesRate(

          allocation.RateClass,

          rateRecord?.calculatedSalesRates ?? {},

        );

        const consumption = numberValue(

          allocation.AllocatedTotalConsumption,

        );

        const calculatedAmount =

          rateRecord && rateSelection.rate !== null

            ? round(

                consumption * rateSelection.rate,

                2,

              )

            : null;

        const disposition = reimbursementDisposition(allocation);
        const { customerChargeAmount, ceAbsorbedAmount } =
          splitReimbursementCharge(calculatedAmount, disposition);

        const issues: string[] = [];

        if (!text(allocation.CustomerID)) {

          issues.push("Customer ID is missing.");

        }

        if (!text(allocation.RateClass)) {

          issues.push(

            "Customer Rate Class is missing.",

          );

        } else if (!rateSelection.rateKey) {

          issues.push(

            `Rate Class "${text(

              allocation.RateClass,

            )}" is not mapped to a 3556 sales rate.`,

          );

        }

        if (!rateRecord) {

          issues.push(

            `No FINAL 3556 effective on or before the ${text(

              allocation.BillingMonth,

            )} FY ${text(

              allocation.FY,

            )} billing period was found for ${normalizeUtilityGroup(

              allocation.UtilityGroup,

            )}, ${displayUtilitySystem(

              allocation.UtilityType,

            )}.`,

          );

        } else if (

          rateSelection.rateKey &&

          rateSelection.rate === null

        ) {

          issues.push(

            `${rateSelection.rateLabel} is not numeric on FINAL 3556 ${text(

              rateRecord.id,

            )}.`,

          );

        }

        const mapping = rateRecord ? reportingMappings.get(mappingPK(text(rateRecord.id))) : null;
        const sourceMatches = Boolean(rateRecord && mapping && mapping.SourceFingerprint === fingerprint3556(rateRecord));
        const reportingSplit = compute3556ReportingSplit({
          rate: rateRecord,
          rateKey: rateSelection.rateKey,
          utility: allocation.UtilityType,
          originalCharge: customerChargeAmount,
          classifications: sourceMatches ? mapping?.Assignments : undefined,
        });
        if (mapping && !sourceMatches && reportingSplit.status === "READY") {
          reportingSplit.status = "REVIEW";
          reportingSplit.issues.push("3556 reporting classifications are stale; revalidate the worksheet mapping.");
          reportingSplit.purchasedUtilityAmount = null;
          reportingSplit.components = {};
        }

        return {

          reconciliationId: text(

            allocation.ReconciliationID,

          ),

          customerId: text(allocation.CustomerID),

          customerName: text(

            allocation.CustomerName,

          ),

          customerType: normalizeCustomerType(

            allocation.CustomerType,

          ),

          reportType: text(allocation.ReportType),

          rateClass: text(allocation.RateClass),

          facilityId: text(allocation.FacilityID),

          facilityNumber: text(

            allocation.FacilityNumber,

          ),

          categoryCode: text(

            allocation.CategoryCode,

          ),

          allocationSource: text(

            allocation.AllocationSource,

          ),

          sourceId: text(allocation.SourceID),

          meterId: text(allocation.MeterID),

          utilityGroup: normalizeUtilityGroup(

            allocation.UtilityGroup,

          ),

          utilityGroupSource: text(

            allocation.UtilityGroup,

          ),

          utilityType: text(

            allocation.UtilityType,

          ),

          utilitySystem: displayUtilitySystem(

            allocation.UtilityType,

          ),

          consumptionUM: text(

            allocation.ConsumptionUM,

          ),

          allocatedConsumption: round(

            consumption,

          ),

          rateId: rateRecord

            ? text(rateRecord.id)

            : "",

          rateEffectiveDate: rateRecord

            ? text(rateRecord.effectiveDate)

            : "",

          rateKey: rateSelection.rateKey,

          rateLabel: rateSelection.rateLabel,

          rate: rateSelection.rate,

          calculatedAmount,
          reportingSplit,
          // Freeze candidate accounting codes alongside the issued breakdown.
          // PROVISIONAL / PENDING / DISPUTED statuses are not approval.
          reportingCodes: Object.fromEntries(
            [reportingSplit.utility, ...Object.keys(reportingSplit.components)]
              .filter((component): component is string => Boolean(component))
              .map((component) => [component, accountingCrosswalk.codes[component as keyof typeof accountingCrosswalk.codes] ?? null]),
          ),
          reportingCrosswalkUpdatedAt: accountingCrosswalk.updatedAt,
          customerChargeAmount,
          ceAbsorbedAmount,
          amount: customerChargeAmount,
          reimbursementUtilityType: text(
            allocation.ReimbursementUtilityType ?? allocation.UtilityType,
          ),
          reimbursementSource: text(allocation.ReimbursementSource),
          reimbursementOverride: allocation.ReimbursementOverride ?? null,
          reimbursementOverrideApplied:
            numberValue(allocation.ReimbursementOverrideApplied) === 1,
          effectiveReimbursementType: text(
            allocation.EffectiveReimbursementType,
          ) ||
            (disposition === "CUSTOMER_REIMBURSABLE"
              ? "Reimbursable"
              : "Non-Reimbursable"),
          reimbursementDisposition: disposition,

          ready: issues.length === 0,

          issues,

        };

      },

    );

    const customerMap = new Map<

      string,

      {

        customerId: string;

        customerName: string;

        customerType: string;

        reportType: string;

        rateClass: string;

        totalAmount: number;

        readyAmount: number;

        lineCount: number;

        readyLineCount: number;

        issueCount: number;

        lines: typeof lines;

      }

    >();

    for (const line of lines) {

      const key =

        line.customerId ||

        `MISSING#${line.customerName}`;

      const existing =

        customerMap.get(key) ?? {

          customerId: line.customerId,

          customerName:

            line.customerName ||

            "Unnamed Customer",

          customerType: line.customerType,

          reportType: line.reportType,

          rateClass: line.rateClass,

          totalAmount: 0,

          readyAmount: 0,

          lineCount: 0,

          readyLineCount: 0,

          issueCount: 0,

          lines: [],

        };

      existing.lineCount += 1;

      existing.lines.push(line);

      if (line.ready && line.amount !== null) {

        existing.readyLineCount += 1;

        existing.readyAmount = round(

          existing.readyAmount + line.amount,

          2,

        );

      } else {

        existing.issueCount +=

          Math.max(line.issues.length, 1);

      }

      customerMap.set(key, existing);

    }

    // Read the customer agreement/document from the authoritative Customer Registry.

    // This is PDF display metadata only and does not change allocation or rates.

    const rcblCommentsByCustomerId = new Map<string, string>();

    let customerScanKey: Record<string, unknown> | undefined;

    do {

      const customerPage = await ddb.send(new ScanCommand({

        TableName: CUSTOMERS_TABLE,

        ProjectionExpression: "CustomerID, RCBLComment",

        ExclusiveStartKey: customerScanKey,

      }));

      for (const item of customerPage.Items ?? []) {

        const id = text(item.CustomerID).trim().toUpperCase();

        if (id) rcblCommentsByCustomerId.set(id, text(item.RCBLComment));

      }

      customerScanKey = customerPage.LastEvaluatedKey;

    } while (customerScanKey);

    const customers = Array.from(

      customerMap.values(),

    )

      .map((customer) => ({

        ...customer,

        rcblComment: rcblCommentsByCustomerId.get(text(customer.customerId).trim().toUpperCase()) ?? "",

        totalAmount:

          customer.issueCount === 0

            ? customer.readyAmount

            : null,

        status:

          customer.issueCount === 0

            ? "READY"

            : "REVIEW",

      }))

      .sort((a, b) =>

        a.customerName.localeCompare(

          b.customerName,

        ),

      );

    const reimbursableCustomers =

      customers.filter(

        (customer) =>

          normalize(customer.customerType) ===

          "REIMBURSABLE",

      );

    const nonReimbursableCustomers =

      customers.filter(

        (customer) =>

          normalize(customer.customerType) !==

          "REIMBURSABLE",

      );

    const readyCustomers = customers.filter(

      (customer) =>

        customer.status === "READY",

    );

    // ----------------------------------------------------------

    // INVOICE COST RECOVERY CONTROL

    // ----------------------------------------------------------

    // Compare customer billing against invoice CHARGE by Utility Group + Utility.

    // IW (Purchased Water) is intentionally combined with SS (Sewer).

    // UOM=ALL service-fee rows remain included because this is a dollar-cost check.

    const invoiceCostByUtility = new Map<string, number>();

    for (const invoice of invoiceRecords) {

      if (Number(invoice.billing_period_id) !== billingPeriodId) continue;

      const utilityGroup = normalizeUtilityGroup(

        invoice.utility_group_id ?? invoice.UtilityGroup,

      );

      const utilitySystem = normalizeInvoiceUtilitySystem(

        invoice.utility_type_cd ?? invoice.UtilityType,

      );

      if (!utilityGroup || !utilitySystem) continue;

      const key = `${utilityGroup}|${utilitySystem}`;

      const charge = numberValue(invoice.charge ?? invoice.Charge);

      invoiceCostByUtility.set(

        key,

        round((invoiceCostByUtility.get(key) ?? 0) + charge, 2),

      );

    }

    const customerBillingByUtility = new Map<string, number>();
    const ceAbsorbedByUtility = new Map<string, number>();
    const calculatedBillingByUtility = new Map<string, number>();

    for (const line of lines) {

      if (line.calculatedAmount === null) continue;

      const utilityGroup = normalizeUtilityGroup(line.utilityGroup);

      const utilitySystem = normalizeUtilitySystem(line.utilityType);

      if (!utilityGroup || !utilitySystem) continue;

      const key = `${utilityGroup}|${utilitySystem}`;

      customerBillingByUtility.set(

        key,

        round(
          (customerBillingByUtility.get(key) ?? 0) +
            numberValue(line.customerChargeAmount),
          2,
        ),

      );
      ceAbsorbedByUtility.set(
        key,
        round(
          (ceAbsorbedByUtility.get(key) ?? 0) +
            numberValue(line.ceAbsorbedAmount),
          2,
        ),
      );
      calculatedBillingByUtility.set(
        key,
        round(
          (calculatedBillingByUtility.get(key) ?? 0) +
            numberValue(line.calculatedAmount),
          2,
        ),
      );

    }

    const recoveryKeys = new Set<string>([

      ...invoiceCostByUtility.keys(),

      ...customerBillingByUtility.keys(),
      ...ceAbsorbedByUtility.keys(),
      ...calculatedBillingByUtility.keys(),

    ]);

    const costRecovery = Array.from(recoveryKeys)

      .map((key) => {

        const [utilityGroup, utilitySystem] = key.split("|");

        const invoiceCost = round(invoiceCostByUtility.get(key) ?? 0, 2);

        const customerBilling = round(customerBillingByUtility.get(key) ?? 0, 2);
        const ceAbsorbed = round(ceAbsorbedByUtility.get(key) ?? 0, 2);
        const calculatedBilling = round(
          calculatedBillingByUtility.get(key) ?? 0,
          2,
        );

        const difference = round(calculatedBilling - invoiceCost, 2);

        const recoveryPercent =

          invoiceCost > 0

            ? round((calculatedBilling / invoiceCost) * 100, 2)

            : null;

        return {

          utilityGroup,

          utilitySystem: displayUtilitySystem(utilitySystem),

          invoiceCost,

          customerBilling,
          ceAbsorbed,
          calculatedBilling,

          difference,

          recoveryPercent,

          status: difference >= 0 ? "COVERED" : "SHORT",

        };

      })

      .sort((a, b) =>

        `${a.utilityGroup}|${a.utilitySystem}`.localeCompare(

          `${b.utilityGroup}|${b.utilitySystem}`,

        ),

      );

    const totalInvoiceCost = round(

      costRecovery.reduce((sum, item) => sum + item.invoiceCost, 0),

      2,

    );

    const totalCustomerBilling = round(

      costRecovery.reduce((sum, item) => sum + item.customerBilling, 0),

      2,

    );

    const totalCEAbsorbed = round(
      costRecovery.reduce((sum, item) => sum + item.ceAbsorbed, 0),
      2,
    );
    const totalCalculatedBilling = round(
      costRecovery.reduce((sum, item) => sum + item.calculatedBilling, 0),
      2,
    );
    const totalRecoveryDifference = round(
      totalCalculatedBilling - totalInvoiceCost,
      2,
    );

    const allUtilitiesCovered = costRecovery.every(

      (item) => item.status === "COVERED",

    );

    const billingMonth = text(

      allocations[0]?.BillingMonth,

    );

    const fiscalYear = text(

      allocations[0]?.FY,

    );

    const livePreview = {

      ok: true,

      preview: true,

      persisted: false,

      billingPeriodId,

      billingMonth,

      fiscalYear,

      generatedAt: new Date().toISOString(),

      reconciliationReady: reconciliationReadiness.ready,

      reconciliationIssues: reconciliationReadiness.failures,

      reconciliationSnapshotId: reconciliationReadiness.snapshotId,
      sourceDataPotentiallyStale:
        realPropertyState?.ReconciliationPotentiallyStale === true,
      sourceDataChangedAt: realPropertyState?.ChangedAt ?? null,

      summary: {

        allocationCount: allocations.length,

        customerCount: customers.length,

        reimbursableCustomerCount:

          reimbursableCustomers.length,

        nonReimbursableCustomerCount:

          nonReimbursableCustomers.length,

        readyCustomerCount:

          readyCustomers.length,

        reviewCustomerCount:

          customers.length -

          readyCustomers.length,

        readyBillTotal: round(

          readyCustomers.reduce(

            (sum, customer) =>

              sum +

              (customer.totalAmount ?? 0),

            0,

          ),

          2,

        ),

        totalInvoiceCost,

        totalCustomerBilling,
        totalCEAbsorbed,
        totalCalculatedBilling,

        totalRecoveryDifference,

        allUtilitiesCovered,

      },

      costRecovery,

      customers,

    };

    // The server generates a stable identity for the complete, reviewed bill.
    // The browser will send only this fingerprint and the snapshot ID when
    // saving; the POST handler reconstructs and saves the entire bill itself.
    return NextResponse.json({
      ...livePreview,
      previewFingerprint: billingPreviewFingerprint(livePreview),
    });

  } catch (error) {

    logDynamoError("RCBL Short preview", error);

    const publicError = publicDynamoErrorResponse(error);

    if (publicError) {

      return NextResponse.json(publicError.body, {

        status: publicError.status,

      });

    }

    return NextResponse.json(

      {

        error:

          error instanceof Error

            ? error.message

            : "Unable to generate RCBL Short preview.",

      },

      { status: 500 },

    );

  }

}

// Find previously saved billing records for duplicate-save protection.
async function scanSavedBillingPeriod(billingPeriodId: number): Promise<Item[]> {

  const rows: Item[] = [];

  let ExclusiveStartKey: Record<string, unknown> | undefined;

  do {

    const result = await ddb.send(

      new ScanCommand({

        TableName: RCBL_SHORT_TABLE,

        FilterExpression: "billing_period_id = :billingPeriodId",

        ExpressionAttributeValues: {

          ":billingPeriodId": billingPeriodId,

        },

        ExclusiveStartKey,

      }),

    );

    rows.push(...((result.Items ?? []) as Item[]));

    ExclusiveStartKey = result.LastEvaluatedKey;

  } while (ExclusiveStartKey);

  return rows;

}

function currentSavedRecords(rows: Item[]): {
  pointer: Item | null;
  records: Item[];
} {
  const pointer =
    rows.find(
      (item) =>
        text(item.RecordType) === CURRENT_POINTER_RECORD_TYPE,
    ) ?? null;
  const currentVersionId = text(pointer?.CurrentVersionId);
  const billRecordTypes = new Set([
    "BILL_METADATA",
    "CUSTOMER_BILL",
    "BILLING_LINE",
  ]);

  return {
    pointer,
    records: rows.filter((item) => {
      if (!billRecordTypes.has(text(item.RecordType))) return false;
      // A legacy bill has no pointer and no VersionId. Versioned candidate
      // records must remain invisible until a pointer explicitly activates
      // their version.
      return currentVersionId
        ? text(item.VersionId) === currentVersionId
        : !text(item.VersionId);
    }),
  };
}

function savedRowsToPreview(
  records: Item[],
  billingPeriodId: number,
  pointer?: Item | null,
): Item {
  const metadata = records.find(
    (item) => text(item.RecordType) === "BILL_METADATA",
  );
  const customerBills = records.filter(
    (item) => text(item.RecordType) === "CUSTOMER_BILL",
  );
  const billingLines = records.filter(
    (item) => text(item.RecordType) === "BILLING_LINE",
  );
  const lineMap = new Map<string, Item[]>();

  for (const line of billingLines) {
    const customerId = text(line.CustomerID);
    const lines = lineMap.get(customerId) ?? [];
    lines.push({
      ...line,
      issues: Array.isArray(line.issues) ? line.issues : [],
    });
    lineMap.set(customerId, lines);
  }

  const customers = customerBills.map((bill) => {
    const customerId = text(bill.CustomerID);
    const lines = lineMap.get(customerId) ?? [];
    return {
      customerId,
      customerName: text(bill.CustomerName),
      customerType: text(bill.CustomerType),
      reportType: text(bill.ReportType),
      rateClass: text(bill.RateClass),
      rcblComment: text(bill.RCBLComment),
      totalAmount: bill.TotalAmount === null ? null : bill.TotalAmount,
      readyAmount: numberValue(bill.ReadyAmount),
      lineCount: numberValue(bill.LineCount) || lines.length,
      readyLineCount: numberValue(bill.ReadyLineCount),
      issueCount: numberValue(bill.IssueCount),
      status: text(bill.BillingStatus) === "READY" ? "READY" : "REVIEW",
      lines,
    };
  });

  const storedSummary = metadata?.PreviewSummary;
  const summary =
    storedSummary && typeof storedSummary === "object"
      ? storedSummary
      : {
          allocationCount: billingLines.length,
          customerCount: customers.length,
          reimbursableCustomerCount: customers.filter(
            (customer) =>
              normalize(customer.customerType) === "REIMBURSABLE",
          ).length,
          nonReimbursableCustomerCount: customers.filter(
            (customer) =>
              normalize(customer.customerType) !== "REIMBURSABLE",
          ).length,
          readyCustomerCount: customers.filter(
            (customer) => customer.status === "READY",
          ).length,
          reviewCustomerCount: customers.filter(
            (customer) => customer.status !== "READY",
          ).length,
          readyBillTotal: customers.reduce(
            (sum, customer) =>
              sum + numberValue(customer.totalAmount),
            0,
          ),
          totalInvoiceCost: 0,
          totalCustomerBilling: customers.reduce(
            (sum, customer) =>
              sum + numberValue(customer.totalAmount),
            0,
          ),
          totalRecoveryDifference: 0,
          allUtilitiesCovered: true,
        };

  const first = records[0] ?? {};
  return {
    ok: true,
    preview: false,
    persisted: true,
    readOnly: true,
    billingPeriodId,
    billingMonth: text(metadata?.BillingMonth ?? first.BillingMonth),
    fiscalYear: text(metadata?.FY ?? first.FY),
    generatedAt: text(
      metadata?.PreviewGeneratedAt ??
        pointer?.SavedAt ??
        first.SavedAt,
    ),
    savedAt: text(pointer?.SavedAt ?? first.SavedAt),
    savedVersionId: text(
      pointer?.CurrentVersionId ?? first.VersionId,
    ),
    savedVersionNumber: numberValue(
      pointer?.CurrentVersionNumber ?? first.VersionNumber,
    ),
    summary,
    costRecovery: Array.isArray(metadata?.CostRecovery)
      ? metadata.CostRecovery
      : [],
    customers,
  };
}

async function scanHistoryBillingPeriod(
  billingPeriodId: number,
): Promise<Item[]> {
  const rows: Item[] = [];
  let ExclusiveStartKey: Record<string, unknown> | undefined;

  do {
    const result = await ddb.send(
      new QueryCommand({
        TableName: RCBL_SHORT_HISTORY_TABLE,
        KeyConditionExpression: "#bp = :billingPeriodId",
        ExpressionAttributeNames: {
          "#bp": "billing_period_id",
        },
        ExpressionAttributeValues: {
          ":billingPeriodId": billingPeriodId,
        },
        ExclusiveStartKey,
      }),
    );
    rows.push(...((result.Items ?? []) as Item[]));
    ExclusiveStartKey = result.LastEvaluatedKey;
  } while (ExclusiveStartKey);

  return rows;
}

function historySourceRecords(
  currentRows: Item[],
  billingPeriodId: number,
  versionId: string,
): Item[] {
  const billRecordTypes = new Set([
    "BILL_METADATA",
    "CUSTOMER_BILL",
    "BILLING_LINE",
  ]);
  const legacyVersionId = `LEGACY-${billingPeriodId}`;
  return currentRows.filter((row) => {
    if (!billRecordTypes.has(text(row.RecordType))) return false;
    return versionId === legacyVersionId
      ? !text(row.VersionId)
      : text(row.VersionId) === versionId;
  });
}

function historyVersionSummaries(
  rows: Item[],
  currentRows: Item[],
  billingPeriodId: number,
  activeVersionId: string,
) {
  const metadataRows = rows
    .filter(isHistoryMetadataRecord)
    .map(historyMetadataFromRecord)
    .filter((metadata): metadata is HistoryArchiveMetadata => metadata !== null);
  const availableVersionIds = new Set(
    currentRows
      .filter((row) => text(row.RecordType) !== CURRENT_POINTER_RECORD_TYPE)
      .map((row) => text(row.VersionId))
      .filter(Boolean),
  );
  const versions = new Map<string, Item>();

  for (const metadata of metadataRows) {
    const sourceRecords = historySourceRecords(
      currentRows,
      billingPeriodId,
      metadata.sourceVersionId,
    );
    if (
      !historyMetadataIsComplete(
        metadata,
        sourceRecords,
        activeVersionId,
        metadataRows,
        availableVersionIds,
      )
    ) {
      continue;
    }
    versions.set(metadata.sourceVersionId, {
      versionId: metadata.sourceVersionId,
      versionNumber: metadata.sourceVersionNumber,
      actionAt: metadata.archivedAt,
      actorUserId: metadata.actorUserId,
      actorDisplayName: metadata.actorDisplayName,
      action: metadata.action,
      replacementReason: metadata.replacementReason,
      customerCount: metadata.sourceCustomerCount,
      recordCount: metadata.sourceRecordCount,
    });
  }

  // Continue to read complete archives created by the former full-copy
  // implementation. New writes never create these rows.
  const legacyRows = rows.filter((row) => !isHistoryMetadataRecord(row));
  const legacyVersionIds = new Set(
    legacyRows.map((row) => text(row.VersionId)).filter(Boolean),
  );
  for (const versionId of legacyVersionIds) {
    const versionRows = legacyRows.filter(
      (row) => text(row.VersionId) === versionId,
    );
    if (
      !historyVersionIsComplete(
        versionRows,
        historySourceRecords(currentRows, billingPeriodId, versionId),
        versionId,
        billingPeriodId,
        activeVersionId,
      )
    ) {
      continue;
    }
    versions.set(versionId, {
      versionId,
      versionNumber: numberValue(versionRows[0].VersionNumber),
      actionAt: text(versionRows[0].ActionAt ?? versionRows[0].ArchivedAt),
      actorUserId: text(versionRows[0].ActorUserId),
      actorDisplayName: text(versionRows[0].ActorDisplayName),
      action: text(versionRows[0].Action),
      replacementReason: text(versionRows[0].ReplacementReason),
      customerCount: versionRows.filter(
        (row) => text(row.RecordType) === "CUSTOMER_BILL",
      ).length,
      recordCount: versionRows.length,
    });
  }

  return Array.from(versions.values())
    .sort(
      (left, right) =>
        numberValue(right.versionNumber) - numberValue(left.versionNumber) ||
        text(right.actionAt).localeCompare(text(left.actionAt)),
    );
}

function actorFromSession(session: unknown) {
  const user =
    session && typeof session === "object" && "user" in session
      ? (session as { user?: Record<string, unknown> }).user
      : undefined;
  const userId =
    text(user?.id) ||
    text(user?.email) ||
    "unknown-authenticated-user";
  const displayName =
    text(user?.name) ||
    text(user?.email) ||
    userId;
  return { userId, displayName };
}

// DynamoDB BatchWrite accepts at most 25 writes per batch. Retry
// unprocessed items with bounded exponential backoff.
async function batchWriteRequests(

  tableName: string,

  requests: Array<{ PutRequest?: { Item: Item } }>,

): Promise<void> {

  for (let index = 0; index < requests.length; index += 25) {

    let pending = requests.slice(index, index + 25);

    let attempts = 0;

    while (pending.length > 0) {

      let result;

      try {

        result = await ddb.send(

          new BatchWriteCommand({

            RequestItems: { [tableName]: pending },

          }),

        );

      } catch (error) {

        attempts += 1;

        if (!isRetryableDynamoError(error) || attempts >= 8) {

          logDynamoError("RCBL Short BatchWriteItem", error);

          throw error;

        }

        await new Promise((resolve) =>

          setTimeout(resolve, Math.min(1000, 50 * 2 ** attempts)),

        );

        continue;

      }

      pending = (result.UnprocessedItems?.[tableName] ?? []) as typeof pending;

      attempts += 1;

      if (pending.length > 0) {

        if (attempts >= 8) {

          throw new Error("Unable to complete RCBL Short batch write after retries.");

        }

        await new Promise((resolve) => setTimeout(resolve, Math.min(1000, 50 * 2 ** attempts)));

      }

    }

  }

}

function safeIdPart(value: unknown): string {

  return text(value).replace(/[^A-Za-z0-9_.-]/g, "_") || "UNKNOWN";

}

function buildVersionRecords(
  preview: Item,
  billingPeriodId: number,
  versionId: string,
  versionNumber: number,
  actionAt: string,
  action: string,
  replacementReason: string,
  actor: { userId: string; displayName: string },
): Item[] {
  const records: Item[] = [];
  const versionPrefix = `${billingPeriodId}#VERSION#${safeIdPart(versionId)}`;
  const shared = {
    billing_period_id: billingPeriodId,
    BillingMonth: text(preview.billingMonth),
    FY: text(preview.fiscalYear),
    VersionId: versionId,
    VersionNumber: versionNumber,
    ActionAt: actionAt,
    Action: action,
    ActorUserId: actor.userId,
    ActorDisplayName: actor.displayName,
    ReplacementReason: replacementReason,
  };

  records.push({
    RCBLShortID: `${versionPrefix}#META`,
    RecordType: "BILL_METADATA",
    ...shared,
    PreviewGeneratedAt: text(preview.generatedAt),
    PreviewSummary: preview.summary,
    CostRecovery: preview.costRecovery,
  });

  for (const customer of (preview.customers as Item[]) ?? []) {
    const customerId = safeIdPart(
      customer.customerId || customer.customerName,
    );
    const lines = Array.isArray(customer.lines) ? customer.lines : [];

    records.push({
      RCBLShortID: `${versionPrefix}#CUSTOMER#${customerId}#BILL`,
      RecordType: "CUSTOMER_BILL",
      ...shared,
      CustomerID: text(customer.customerId),
      CustomerName: text(customer.customerName),
      CustomerType: text(customer.customerType),
      ReportType: text(customer.reportType),
      RateClass: text(customer.rateClass),
      RCBLComment: text(customer.rcblComment),
      TotalAmount: customer.totalAmount,
      ReadyAmount: Number(customer.readyAmount ?? 0),
      LineCount: Number(customer.lineCount ?? lines.length),
      ReadyLineCount: Number(customer.readyLineCount ?? 0),
      IssueCount: Number(customer.issueCount ?? 0),
      BillingStatus: text(customer.status),
      SavedAt: actionAt,
    });

    lines.forEach((line: Item, lineIndex: number) => {
      records.push({
        RCBLShortID:
          `${versionPrefix}#CUSTOMER#${customerId}#LINE#${String(lineIndex + 1).padStart(4, "0")}`,
        RecordType: "BILLING_LINE",
        ...shared,
        CustomerID: text(customer.customerId),
        CustomerName: text(customer.customerName),
        CustomerType: text(customer.customerType),
        ReportType: text(customer.reportType),
        RateClass: text(customer.rateClass),
        ...line,
        VersionId: versionId,
        VersionNumber: versionNumber,
        ActionAt: actionAt,
        Action: action,
        ActorUserId: actor.userId,
        ActorDisplayName: actor.displayName,
        ReplacementReason: replacementReason,
        SavedAt: actionAt,
      });
    });
  }

  return records;
}

function reportingSplitsMatch(left: Item, right: Item): boolean {
  const signatures = (preview: Item) => JSON.stringify(
    (preview.customers ?? []).map((c: Item) => ({
      id: c.customerId,
      lines: (c.lines ?? []).map((l: Item) => ({
        id: l.reconciliationId,
        split: l.reportingSplit ?? null,
      })),
    })),
  );
  return signatures(left) === signatures(right);
}

async function loadAuthoritativePreview(
  request: NextRequest,
  billingPeriodId: number,
): Promise<{ response: Response; payload: Item }> {
  const url = new URL(request.url);
  url.searchParams.set("billing_period_id", String(billingPeriodId));
  url.searchParams.delete("view");
  url.searchParams.delete("version_id");
  const response = await GET(
    new NextRequest(url, { headers: request.headers }),
  );
  const payload = (await response.json().catch(() => ({}))) as Item;
  return { response, payload };
}

class PointerOutcomeUnknownError extends Error {
  readonly code = "RCBL_POINTER_OUTCOME_UNKNOWN";

  constructor() {
    super(
      "The billing version pointer write may have completed, but its outcome could not be verified. Do not retry until the saved bill status is checked.",
    );
    this.name = "PointerOutcomeUnknownError";
  }
}

class PointerActivationConflictError extends Error {
  readonly code = "RCBL_VERSION_CONFLICT";

  constructor() {
    super(
      "The saved bill changed while this replacement was being prepared. Reload the billing period and try again.",
    );
    this.name = "PointerActivationConflictError";
  }
}

async function readCurrentPointer(
  billingPeriodId: number,
): Promise<Item | null> {
  const rows = await scanSavedBillingPeriod(billingPeriodId);
  return (
    rows.find(
      (item) => text(item.RecordType) === CURRENT_POINTER_RECORD_TYPE,
    ) ?? null
  );
}

async function verifyPointerAfterFailure(
  billingPeriodId: number,
  versionId: string,
  expectedVersionId?: string,
): Promise<"active" | "inactive" | "different"> {
  const pointer = await readCurrentPointer(billingPeriodId);
  if (!pointer) return "inactive";
  const currentVersionId = text(pointer.CurrentVersionId);
  if (currentVersionId === versionId) return "active";
  if (expectedVersionId && currentVersionId === expectedVersionId) {
    return "inactive";
  }
  return "different";
}

// POST: persist the complete server-authoritative preview to DynamoDB,
// identified by a small fingerprint from the preview the user reviewed.
// Replacement creates a new version and advances the current pointer.
export async function POST(request: NextRequest) {

  let operationPhase = "request";
  let operationBillingPeriodId: number | undefined;
  let operationVersionId = "";

  try {

        // ========================================================
    // AUTHENTICATION
    //
    // Authenticate before reading request parameters or accessing
    // DynamoDB. Keep this disabled during local development;
    // uncomment the auth import and this block to enforce login.
    // ========================================================

    const session =
      await getAppSession();

    if (
      !session?.user
    ) {
      return Response.json(
        {
          ok: false,
          error:
            "Unauthorized",
        },
        {
          status: 401,
        },
      );
    }

    // ========================================================
    // AUTHENTICATED REQUEST
    // ========================================================

    operationPhase = "validate request";
    const body = (await request.json()) as Item;
    const billingPeriodId = Number(
      body.billing_period_id ?? body.billingPeriodId,
    );
    operationBillingPeriodId = billingPeriodId;
    const replace = body.replace === true || body.regenerate === true;
    const replacementReason = text(
      body.replacement_reason ?? body.replacementReason,
    );
    const previewFingerprint = text(body.preview_fingerprint);
    const previewSnapshotId = text(body.reconciliation_snapshot_id);

    if (!Number.isInteger(billingPeriodId)) {
      return NextResponse.json(
        { error: "billing_period_id is required." },
        { status: 400 },
      );
    }

    // Do not accept whole previews: large billing periods exceed the
    // framework request-body limit. Require the identity issued by GET.
    if (!/^[a-f0-9]{64}$/.test(previewFingerprint) || !previewSnapshotId) {
      return NextResponse.json(
        {
          error:
            "Generate a new Current Preview before saving. Refresh CUBE if this browser tab was open before the update.",
        },
        { status: 400 },
      );
    }

    operationPhase = "validate reconciliation readiness";
    const [currentReconciliationRecords, currentInvoiceRecords] =
      await Promise.all([
        scanAll(RECONCILIATION_TABLE),
        scanAll(INVOICES_TABLE),
      ]);
    const reconciliationReadiness = validateReconciliationReadiness(
      currentReconciliationRecords,
      billingPeriodId,
      currentInvoiceRecords,
    );
    if (!reconciliationReadiness.ready) {
      const details = reconciliationReadiness.failures
        .map(
          (failure) =>
            `${failure.utilityGroup} ${failure.utilityType}: ${failure.reason}`,
        )
        .join("; ");
      return NextResponse.json(
        {
          error:
            `RCBL Short cannot be saved because the reconciliation is not billing-ready. ${details}`,
          reconciliationReady: false,
          reconciliationIssues: reconciliationReadiness.failures,
        },
        { status: 409 },
      );
    }
    if (
      !previewSnapshotId ||
      previewSnapshotId !== reconciliationReadiness.snapshotId
    ) {
      return NextResponse.json(
        {
          error:
            "This RCBL Short preview is stale because the reconciliation changed. Generate a new preview before saving.",
          reconciliationReady: true,
          stalePreview: true,
        },
        { status: 409 },
      );
    }

    operationPhase = "recalculate authoritative bill preview";
    const authoritativeResult = await loadAuthoritativePreview(
      request,
      billingPeriodId,
    );
    const authoritativePreview = authoritativeResult.payload;
    if (
      !authoritativeResult.response.ok ||
      authoritativePreview.preview !== true ||
      authoritativePreview.reconciliationReady !== true
    ) {
      return NextResponse.json(
        {
          error:
            text(authoritativePreview.error) ||
            "The current authoritative billing preview is not ready to save.",
          reconciliationReady: authoritativePreview.reconciliationReady === true,
          reconciliationIssues: authoritativePreview.reconciliationIssues ?? [],
        },
        { status: 409 },
      );
    }
    if (
      Number(authoritativePreview.billingPeriodId) !== billingPeriodId ||
      authoritativePreview.persisted !== false ||
      billingPreviewFingerprint(authoritativePreview) !== previewFingerprint
    ) {
      return NextResponse.json(
        {
          error:
            "The submitted preview no longer matches the current authoritative billing calculation. Generate a new preview before saving.",
          stalePreview: true,
        },
        { status: 409 },
      );
    }
    const customerBillingIssues = unresolvedOfficialCustomerBillingIssues(
      authoritativePreview,
    );
    if (customerBillingIssues.length > 0) {
      const details = customerBillingIssues
        .map(
          (issue) =>
            `${issue.customerId} (${issue.customerName}): ${issue.reason}`,
        )
        .join("; ");
      return NextResponse.json(
        {
          error:
            `RCBL Short cannot be saved because reimbursable customer billing issues remain unresolved. ${details}`,
          customerBillingIssues,
        },
        { status: 409 },
      );
    }

    if (replace && !replacementReason) {
      return NextResponse.json(
        { error: "A reason is required when replacing a saved bill." },
        { status: 400 },
      );
    }

    operationPhase = "load current bill";
    const existingRows = await scanSavedBillingPeriod(billingPeriodId);
    const current = currentSavedRecords(existingRows);
    const hasSavedBill = current.records.some(
      (item) => text(item.RecordType) === "CUSTOMER_BILL",
    );

    if (hasSavedBill && !replace) {
      return NextResponse.json(
        {
          error:
            `RCBL Short billing already exists for Billing Period ${billingPeriodId}. Use Replace Saved Bill after entering a reason.`,
          canReplace: true,
          existingRecordCount: current.records.length,
        },
        { status: 409 },
      );
    }

    if (replace && !hasSavedBill) {
      return NextResponse.json(
        { error: "There is no saved bill to replace for this billing period." },
        { status: 409 },
      );
    }

    const actor = actorFromSession(session);
    const actionAt = new Date().toISOString();
    const versionId = `${Date.now()}-${randomUUID()}`;
    operationVersionId = versionId;
    const versionNumber = current.pointer
      ? numberValue(current.pointer.CurrentVersionNumber) + 1
      : 1;
    const sourceVersionId =
      text(current.pointer?.CurrentVersionId) ||
      `LEGACY-${billingPeriodId}`;
    const sourceVersionNumber = current.pointer
      ? numberValue(current.pointer.CurrentVersionNumber)
      : 0;

    const proposedArchiveMetadata: HistoryArchiveMetadata = {
      billingPeriodId,
      sourceVersionId,
      sourceVersionNumber,
      newVersionId: versionId,
      newVersionNumber: versionNumber,
      archivedAt: actionAt,
      action: "REPLACED",
      actorUserId: actor.userId,
      actorDisplayName: actor.displayName,
      replacementReason,
      sourceRecordCount: current.records.length,
      sourceCustomerCount: current.records.filter(
        (record) => text(record.RecordType) === "CUSTOMER_BILL",
      ).length,
    };

    // Preflight only the one metadata key for this source version. Existing
    // full-copy rows from failed legacy attempts are intentionally ignored;
    // they are not completion metadata and cannot block a new replacement.
    if (replace) {
      operationPhase = "history metadata preflight";
      const existingMetadata = await ddb.send(
        new GetCommand({
          TableName: RCBL_SHORT_HISTORY_TABLE,
          Key: {
            billing_period_id: billingPeriodId,
            HistoryKey: historyMetadataKey(sourceVersionId),
          },
          ConsistentRead: true,
        }),
      );
      if (
        existingMetadata.Item &&
        !historyMetadataMatches(existingMetadata.Item as Item, proposedArchiveMetadata)
      ) {
        throw new HistoryArchiveConsistencyError(
          `History metadata already exists for ${sourceVersionId} with different billing or audit data. Existing history was not changed; reload the bill before replacing it.`,
        );
      }
    }

    const records = buildVersionRecords(
      authoritativePreview,
      billingPeriodId,
      versionId,
      versionNumber,
      actionAt,
      replace ? "REPLACE" : "CREATE",
      replacementReason,
      actor,
    );

    // New records use unique versioned keys. A failed write cannot overwrite
    // or delete the currently pointed-to version; orphaned candidates remain
    // invisible until a pointer swap succeeds.
    operationPhase = "candidate record writes";
    console.info("RCBL Short candidate writes started", {
      billingPeriodId,
      versionId,
      recordCount: records.length,
    });
    await batchWriteRequests(
      RCBL_SHORT_TABLE,
      records.map((Item) => ({ PutRequest: { Item } })),
    );
    console.info("RCBL Short candidate writes completed", {
      billingPeriodId,
      versionId,
      recordCount: records.length,
    });

    operationPhase = "recheck authoritative inputs before pointer activation";
    const latestAuthoritativeResult = await loadAuthoritativePreview(
      request,
      billingPeriodId,
    );
    const latestAuthoritativePreview = latestAuthoritativeResult.payload;
    if (
      !latestAuthoritativeResult.response.ok ||
      latestAuthoritativePreview.preview !== true ||
      latestAuthoritativePreview.reconciliationReady !== true ||
      !billingPreviewsMatch(authoritativePreview, latestAuthoritativePreview) ||
      !reportingSplitsMatch(authoritativePreview, latestAuthoritativePreview) ||
      unresolvedOfficialCustomerBillingIssues(latestAuthoritativePreview).length > 0
    ) {
      return NextResponse.json(
        {
          error:
            "The reconciliation, invoice, rate, or billing allocation inputs changed while the candidate bill was being written. The candidate was not activated; generate a new preview and try again.",
          stalePreview: true,
        },
        { status: 409 },
      );
    }

    const pointer: Item = {
      RCBLShortID: `${billingPeriodId}#BILL#CURRENT`,
      RecordType: CURRENT_POINTER_RECORD_TYPE,
      billing_period_id: billingPeriodId,
      CurrentVersionId: versionId,
      CurrentVersionNumber: versionNumber,
      SavedAt: actionAt,
      Action: replace ? "REPLACE" : "CREATE",
      ActorUserId: actor.userId,
      ActorDisplayName: actor.displayName,
      ReplacementReason: replacementReason,
      BillingMonth: text(authoritativePreview.billingMonth),
      FY: text(authoritativePreview.fiscalYear),
    };
    const pointerNames: Record<string, string> = {};
    const pointerValues: Record<string, unknown> = {};
    let pointerCondition = "attribute_not_exists(#key)";

    if (current.pointer) {
      pointerNames["#version"] = "CurrentVersionId";
      pointerValues[":expectedVersion"] = text(
        current.pointer.CurrentVersionId,
      );
      pointerCondition = "#version = :expectedVersion";
    } else {
      pointerNames["#key"] = "RCBLShortID";
    }

    const historyMetadataRecord = replace
      ? buildHistoryMetadataRecord(proposedArchiveMetadata)
      : null;

    operationPhase = "pointer activation";
    console.info("RCBL Short pointer activation started", {
      billingPeriodId,
      versionId,
      versionNumber,
      replacing: replace,
    });
    try {
      if (historyMetadataRecord) {
        await ddb.send(
          new TransactWriteCommand({
            TransactItems: [
              {
                Put: {
                  TableName: RCBL_SHORT_TABLE,
                  Item: pointer,
                  ConditionExpression: pointerCondition,
                  ExpressionAttributeNames: pointerNames,
                  ExpressionAttributeValues:
                    Object.keys(pointerValues).length > 0
                      ? pointerValues
                      : undefined,
                },
              },
              {
                Put: {
                  TableName: RCBL_SHORT_HISTORY_TABLE,
                  Item: historyMetadataRecord,
                  ConditionExpression:
                    "attribute_not_exists(#billingPeriodId) AND attribute_not_exists(#historyKey)",
                  ExpressionAttributeNames: {
                    "#billingPeriodId": "billing_period_id",
                    "#historyKey": "HistoryKey",
                  },
                },
              },
            ],
          }),
        );
      } else {
        await ddb.send(
          new PutCommand({
            TableName: RCBL_SHORT_TABLE,
            Item: pointer,
            ConditionExpression: pointerCondition,
            ExpressionAttributeNames: pointerNames,
            ExpressionAttributeValues:
              Object.keys(pointerValues).length > 0
                ? pointerValues
                : undefined,
          }),
        );
      }
    } catch (error) {
      try {
        const outcome = await verifyPointerAfterFailure(
          billingPeriodId,
          versionId,
          text(current.pointer?.CurrentVersionId) || undefined,
        );
        if (outcome === "active") {
          if (historyMetadataRecord) {
            const metadataReadback = await ddb.send(
              new GetCommand({
                TableName: RCBL_SHORT_HISTORY_TABLE,
                Key: {
                  billing_period_id: billingPeriodId,
                  HistoryKey: historyMetadataKey(sourceVersionId),
                },
                ConsistentRead: true,
              }),
            );
            if (
              !metadataReadback.Item ||
              !historyMetadataMatches(
                metadataReadback.Item as Item,
                proposedArchiveMetadata,
              )
            ) {
              throw new PointerOutcomeUnknownError();
            }
          }
          console.warn("RCBL Short pointer activation verified after error", {
            billingPeriodId,
            versionId,
          });
          return NextResponse.json({
            ok: true,
            persisted: true,
            replaced: replace,
            pointerOutcomeVerified: true,
            billingPeriodId,
            savedAt: actionAt,
            versionId,
            versionNumber,
            previousRecordCount: replace ? current.records.length : 0,
            savedRecordCount: records.length,
            customerCount: (authoritativePreview.customers as Item[]).length,
          });
        }
        if (outcome === "different") {
          throw new PointerActivationConflictError();
        }
        const errorName =
          error && typeof error === "object" && "name" in error
            ? String((error as { name?: unknown }).name)
            : "";
        if (errorName === "TransactionCanceledException") {
          throw new HistoryArchiveConsistencyError(
            "The billing version transaction was canceled before activation. Reload the billing period and try again.",
          );
        }
        throw error;
      } catch (readbackError) {
        if (
          readbackError instanceof PointerActivationConflictError ||
          readbackError instanceof PointerOutcomeUnknownError ||
          readbackError instanceof HistoryArchiveConsistencyError ||
          readbackError === error
        ) {
          throw readbackError;
        }
        throw new PointerOutcomeUnknownError();
      }
    }
    console.info("RCBL Short pointer activation completed", {
      billingPeriodId,
      versionId,
      versionNumber,
    });

    return NextResponse.json({
      ok: true,
      persisted: true,
      replaced: replace,
      billingPeriodId,
      savedAt: actionAt,
      versionId,
      versionNumber,
      previousRecordCount: replace ? current.records.length : 0,
      savedRecordCount: records.length,
      customerCount: (authoritativePreview.customers as Item[]).length,
    });

  } catch (error) {

    logDynamoError("RCBL Short save", error);

    console.error("RCBL Short operation failed", {
      billingPeriodId: operationBillingPeriodId,
      versionId: operationVersionId,
      phase: operationPhase,
      errorName:
        error && typeof error === "object" && "name" in error
          ? String((error as { name?: unknown }).name)
          : "",
      errorCode:
        error && typeof error === "object" && "code" in error
          ? String((error as { code?: unknown }).code)
          : "",
    });

    if (error instanceof HistoryArchiveConsistencyError) {
      return NextResponse.json(
        {
          error: error.message,
          code: error.code,
          retryable: false,
        },
        { status: 409 },
      );
    }

    if (error instanceof PointerActivationConflictError) {
      return NextResponse.json(
        {
          error: error.message,
          code: error.code,
          retryable: false,
        },
        { status: 409 },
      );
    }

    if (error instanceof PointerOutcomeUnknownError) {
      return NextResponse.json(
        {
          error: error.message,
          code: error.code,
          retryable: false,
        },
        { status: 503 },
      );
    }

    const name =
      error && typeof error === "object" && "name" in error
        ? String((error as { name?: unknown }).name)
        : "";

    if (name === "ConditionalCheckFailedException") {
      return NextResponse.json(
        {
          error:
            "The saved bill changed while this replacement was being prepared. Reload the billing period and try again.",
          code: "RCBL_VERSION_CONFLICT",
        },
        { status: 409 },
      );
    }

    const publicError = publicDynamoErrorResponse(error);

    if (publicError) {

      return NextResponse.json(publicError.body, {

        status: publicError.status,

      });

    }

    return NextResponse.json(

      { error: error instanceof Error ? error.message : "Unable to save RCBL Short billing records." },

      { status: 500 },

    );

  }

}
