// Production authentication is intentionally disabled during development.
import { getAppSession } from "@/lib/app-session";

import {
  BatchWriteCommand,
  QueryCommand,
  ScanCommand,

  type QueryCommandInput,

  type ScanCommandInput,

  type BatchWriteCommandOutput,

  type BatchWriteCommandInput,
} from "@aws-sdk/lib-dynamodb";
import { ddb } from "@/lib/dynamo";
import { RECONCILIATION_TABLES } from "@/lib/reconciliation-tables";
import {
  effectiveRealPropertySource,
  usesPeriodSnapshot,
} from "@/lib/real-property-effective-core";
import {
  filterActiveRealPropertyRecords,
  getRealPropertyPeriodState,
} from "@/lib/real-property-snapshot";
import {
  PW_COMBINED_EFFICIENCY,
  PW_ENERGY_CONSTANT,
  PW_HEAD_FT,
  PW_KWH_PER_KGAL,
  RECONCILIATION_EPSILON,
  SS_KWH_PER_KGAL,
  isProducedWaterPumpingGroup,
  pumpingEnergyForPwAllocation,
  pumpingReserveForSewerEligibility,
  reserveElectricityPool,
} from "@/lib/reconciliation-pumping";
import {
  calculateMeterPropQAllocations,
  classifyMeterCalculationEligibility,
  distributeNonMeteredPool,
  facilityUtilityGroupKey,
  isMeteredConsumptionOverSource,
  isMeteredFacilityUtilityEligible,
  matchingRealPropertyRowsForUtilityGroup,
  isNonMeteredPoolUnallocatable,
  isNonMeteredFacilityEligible,
  resolveRealPropertyUtilityGroup,
} from "@/lib/reconciliation-allocation";
import {
  classifyReconciliationInvoiceRow,
  evaluateReconciliationBillingStatus,
} from "@/lib/reconciliation-invoice";
import {
  derivedSewerConsumption,
  distributeSewerNonMeteredPool,
  potentialDerivedSewerConsumption,
  resolveDerivedSewerEligibility,
  summarizeSewerNonMeteredPool,
} from "@/lib/reconciliation-sewer";
import {
  isUtilityCode,
  reimbursementSnapshotFields,
  resolveUtilityReimbursement,
  pumpingReimbursementUtility,
  splitReimbursementConsumption,
} from "@/lib/utility-reimbursement";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

// ============================================================
// TABLES / INDEXES

// ============================================================
const RECONCILIATION_TABLE = RECONCILIATION_TABLES.reconciliation;
const READINGS_TABLE = RECONCILIATION_TABLES.readings;
const METERS_TABLE = RECONCILIATION_TABLES.meters;
const CUSTOMERS_TABLE = RECONCILIATION_TABLES.customers;
const INVOICES_TABLE = RECONCILIATION_TABLES.invoices;
const PROPQ_TABLE = RECONCILIATION_TABLES.propQ;
const PLANT_UNIT_TABLE = RECONCILIATION_TABLES.plantUnit;
const SUPPORTED_RECONCILIATION_UTILITIES = new Set(["EL", "NG", "PW", "SS"]);
const RP_LEGACY_TABLE = RECONCILIATION_TABLES.realPropertyLegacy;
const RP_MONTHLY_TABLE = RECONCILIATION_TABLES.realPropertyMonthly;
const FIRST_MONTHLY_RP_BILLING_PERIOD_ID = 182;
const FY26_FIRST_BILLING_PERIOD_ID = 171;
const FY26 = 2026;
const BILLING_PERIOD_INDEX = "billing-period-index";

// Natural-gas meter consumption is stored as CF. Invoice/reconciliation
// consumption is MMBTU. This is the same factor used by Monthly Data.
const NATURAL_GAS_MMBTU_PER_CF = 0.001031;

const WRITE_BATCH_SIZE = 25;
const EPSILON = RECONCILIATION_EPSILON;

type Item = Record<string, unknown>;

type AllocationSource =
  | "METER"
  | "NONMETERED"
  | "DERIVED_SS"
  | "SS_NONMETERED"
  | "PW_PUMPING"
  | "SS_PUMPING"
  | "UNALLOCATED_METER";

type ReconciliationIssue = {
  type: "ALLOCATION" | "UNALLOCATED_METER";
  code: string;
  utilityGroup: string;
  utilityType: string;
  meterId?: string;
  facilityNumber?: string;
  customerId?: string;
  sourceRpId?: string;
  message: string;
  blocking: boolean;
};

// ============================================================
// BASIC HELPERS

// ============================================================

function badRequest(
  message: string,
  details?: Record<string, unknown>,
): Response {
  return Response.json(
    {
      error: message,
      ...(details ?? {}),
    },
    { status: 400 },
  );
}
function text(value: unknown): string {
  return value === undefined || value === null ? "" : String(value).trim();
}
function numberOrNull(value: unknown): number | null {
  const normalized = text(value).replace(/[$,]/g, "");
  if (!normalized) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}
// End of reconciliation route.
function numberValue(value: unknown): number {
  return numberOrNull(value) ?? 0;
}

function firstText(item: Item | undefined, ...keys: string[]): string {
  if (!item) return "";
  for (const key of keys) {
    const value = text(item[key]);
    if (value) return value;
  }
  return "";
}

function firstNumber(item: Item | undefined, ...keys: string[]): number | null {
  if (!item) return null;
  for (const key of keys) {
    const value = numberOrNull(item[key]);
    if (value !== null) return value;
  }
  return null;
}

function utility(value: unknown): string {
  return text(value).toUpperCase();
}

function commodityFlagEnabled(item: Item | undefined, utilityType: string): boolean {
  if (!item) return false;
  const normalizedUtility = utility(utilityType);
  return (
    numberValue(item[normalizedUtility]) !== 0 ||
    numberValue(item[`${normalizedUtility}Usage`]) !== 0
  );
}

function reconciliationInvoiceUtility(value: unknown): string {
  const utilityType = utility(value);

  // IW (Purchased Water) is intentionally excluded from reconciliation.
  // It remains in the source invoice data for audit/history only.
  if (utilityType === "IW") return "";
  return utilityType;
}

function round(value: number, decimals = 8): number {
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function safeKeyPart(value: unknown): string {
  const normalized = text(value);
  return normalized ? normalized.replace(/#/g, "_") : "NA";
}

function normalizeUtilityGroup(value: unknown): string {
  const normalized = text(value).toUpperCase();
  if (normalized === "1" || normalized === "WWYK" || normalized === "SHCZ") {
    return "1";
  }
  if (normalized === "2" || normalized === "TACX") {
    return "2";
  }
  return "";
}

function utilityGroupFromSubInstallation(value: unknown): string {
  return normalizeUtilityGroup(value);
}

function reconciliationUnit(utilityType: string, invoiceUnits: Set<string>): string {
  if (utilityType === "NG") return "MMBTU";
  if (utilityType === "EL") return "KWH";
  if (utilityType === "PW" || utilityType === "SS") return "KGAL";
  if (invoiceUnits.size === 1) return Array.from(invoiceUnits)[0];
  return invoiceUnits.size > 1 ? "MIXED" : "";
}

// ============================================================
// CONSUMPTION NORMALIZATION

// ============================================================

function normalizeMeterConsumption(utilityType: string, consumption: number): number {
  if (utilityType === "NG") {
    return consumption * NATURAL_GAS_MMBTU_PER_CF;
  }
  return consumption;
}

// ============================================================
// REAL PROPERTY HELPERS

// ============================================================

function billingPeriodToFiscalYear(billingPeriodId: number): number {
  return FY26 + Math.floor((billingPeriodId - FY26_FIRST_BILLING_PERIOD_ID) / 12);
}

function utilityFlag(value: unknown): number {
  return numberValue(value) !== 0 ? 1 : 0;
}

function normalizeLegacyRealProperty(
  item: Item,
  billingPeriodId: number,
): Item {
  const legacyRpId = firstText(item, "LegacyRPID");
  const customerQty = firstNumber(item, "CustomerQty") ?? 0;
  return {
    ...item,
    MonthlyRPID: legacyRpId,
    LegacyRPID: legacyRpId,
    FY: firstNumber(item, "FY") ?? billingPeriodToFiscalYear(billingPeriodId),
    BillingMonth: "",
    billing_period_id: billingPeriodId,
    FacilityID: firstText(item, "FacilityID"),
    CustomerID: firstText(item, "CustomerID"),
    RPUID: "",
    SiteCode: firstText(item, "SiteCode", "site_cd", "SITE_CD"),
    FacilityNumber: firstText(item, "FacilityNumber", "facility_nbr", "FACILITY_NBR"),
    NextGenCustomerName: "",
    CUBECustomerName: firstText(item, "LegacyCustomerName", "CustomerName"),
    LegacyCustomerName: firstText(item, "LegacyCustomerName"),
    CategoryCode: firstText(item, "CategoryCode"),
    CategoryDescription: firstText(item, "CategoryDescription"),
    AllocationQty: customerQty,
    AllocationUM: firstText(item, "AllocationUM") || "SF",
    UtilityGroup: normalizeUtilityGroup(
      firstText(item, "UtilityGroup", "utility_group_id", "sub_inst_cd", "SUB_INST_CD"),
    ),
    EL: utilityFlag(item.ELUsage),
    NG: utilityFlag(item.NGUsage),
    PW: utilityFlag(item.PWUsage),
    SS: utilityFlag(item.SSUsage),
    RecordSource: "legacy",
  };
}

function normalizeMonthlyRealProperty(item: Item): Item {
  return {
    ...item,
    RecordSource: "monthly",
  };
}

// ============================================================
// DYNAMODB HELPERS

// ============================================================

async function queryByBillingPeriod(
  tableName: string,
  billingPeriodId: number,
): Promise<Item[]> {
  const items: Item[] = [];
  let exclusiveStartKey: QueryCommandInput["ExclusiveStartKey"] | undefined;
  do {
    const result = await ddb.send(
      new QueryCommand({
        TableName: tableName,
        IndexName: BILLING_PERIOD_INDEX,
        KeyConditionExpression: "#bp = :bp",
        ExpressionAttributeNames: {
          "#bp": "billing_period_id",
        },
        ExpressionAttributeValues: {
          ":bp": billingPeriodId,
        },
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );
    items.push(...((result.Items ?? []) as Item[]));
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);
  return filterActiveRealPropertyRecords(tableName, billingPeriodId, items);
}

async function loadLegacyRealProperty(
  billingPeriodId: number,
  fiscalYear: number,
): Promise<Item[]> {
  const items: Item[] = [];
  let exclusiveStartKey: ScanCommandInput["ExclusiveStartKey"] | undefined;
  do {
    const result = await ddb.send(
      new ScanCommand({
        TableName: RP_LEGACY_TABLE,
        FilterExpression: "#fy = :fy",
        ExpressionAttributeNames: { "#fy": "FY" },
        ExpressionAttributeValues: { ":fy": fiscalYear },
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );
    items.push(...((result.Items ?? []) as Item[]));
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);
  return items.map((item) =>
    normalizeLegacyRealProperty(item, billingPeriodId),
  );
}

async function loadRealPropertyForPeriod(
  billingPeriodId: number,
): Promise<{
  items: Item[];
  source: "legacy" | "legacy_override" | "monthly";
  tableName: string;
  fiscalYear: number;
}> {
  const fiscalYear = billingPeriodToFiscalYear(billingPeriodId);
  const periodState = await getRealPropertyPeriodState(billingPeriodId);
  const source = effectiveRealPropertySource(
    billingPeriodId,
    periodState !== null,
  );
  if (!usesPeriodSnapshot(billingPeriodId, periodState !== null)) {
    return {
      items: await loadLegacyRealProperty(billingPeriodId, fiscalYear),
      source: "legacy",
      tableName: RP_LEGACY_TABLE,
      fiscalYear,
    };
  }
  return {
    items: (
      await queryByBillingPeriod(RP_MONTHLY_TABLE, billingPeriodId)
    ).map((item) => ({
      ...normalizeMonthlyRealProperty(item),
      RecordSource: source,
    })),
    source,
    tableName: RP_MONTHLY_TABLE,
    fiscalYear,
  };
}

async function queryReconciliationPeriod(billingPeriodId: number): Promise<Item[]> {
  const items: Item[] = [];
  let exclusiveStartKey: QueryCommandInput["ExclusiveStartKey"] | undefined;
  do {
    const result = await ddb.send(
      new QueryCommand({
        TableName: RECONCILIATION_TABLE,
        KeyConditionExpression: "#bp = :bp",
        ExpressionAttributeNames: {
          "#bp": "billing_period_id",
        },
        ExpressionAttributeValues: {
          ":bp": billingPeriodId,
        },
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );
    items.push(...((result.Items ?? []) as Item[]));
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);
  return items;
}

async function scanAll(tableName: string): Promise<Item[]> {
  const items: Item[] = [];
  let exclusiveStartKey: ScanCommandInput["ExclusiveStartKey"] | undefined;
  do {
    const result = await ddb.send(
      new ScanCommand({
        TableName: tableName,
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );
    items.push(...((result.Items ?? []) as Item[]));
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);
  return items;
}

type BatchWriteRequest = NonNullable<
  NonNullable<BatchWriteCommandInput["RequestItems"]>[string]
>[number];

async function runBatchWriteRequests(
  requests: BatchWriteRequest[],
): Promise<void> {
  for (
    let offset = 0;
    offset < requests.length;
    offset += WRITE_BATCH_SIZE
  ) {
    let pending: BatchWriteRequest[] =
      requests.slice(offset, offset + WRITE_BATCH_SIZE);
    while (pending.length > 0) {
      const result = (await ddb.send(
        new BatchWriteCommand({
          RequestItems: {
            [RECONCILIATION_TABLE]: pending,
          },
        }),
      )) as BatchWriteCommandOutput;
      pending =
        result.UnprocessedItems?.[RECONCILIATION_TABLE] ?? [];
    }
  }
}
async function writeReconciliationSnapshot(
  billingPeriodId: number,
  existing: Item[],
  records: Item[],
): Promise<void> {

  // DynamoDB does not allow multiple operations for the same item key in a
  // single BatchWrite request. Delete the old snapshot first, wait for all
  // deletes to complete, and only then write the replacement snapshot.
  const deleteRequests: BatchWriteRequest[] = [];
  for (const item of existing) {
    const reconciliationId = firstText(item, "ReconciliationID");
    if (!reconciliationId) continue;
    deleteRequests.push({
      DeleteRequest: {
        Key: {
          billing_period_id: billingPeriodId,
          ReconciliationID: reconciliationId,
        },
      },
    });
  }

  // Protect BatchWrite from duplicate generated keys. A duplicate here means
  // two generated records would target the same DynamoDB item.
  const uniqueRecords = new Map<string, Item>();
  for (const item of records) {
    const reconciliationId = firstText(item, "ReconciliationID");
    if (!reconciliationId) {
      throw new Error(
        "A generated reconciliation record is missing ReconciliationID.",
      );
    }
    if (uniqueRecords.has(reconciliationId)) {
      throw new Error(
        `Duplicate reconciliation key generated: ${reconciliationId}`,
      );
    }
    uniqueRecords.set(reconciliationId, item);
  }
  const putRequests: BatchWriteRequest[] =
    Array.from(uniqueRecords.values()).map((item) => ({
      PutRequest: {
        Item: item,
      },
    }));
  await runBatchWriteRequests(deleteRequests);
  await runBatchWriteRequests(putRequests);
}

export async function GET(request: Request) {
  // Production authentication (enable before deployment):
  const session = await getAppSession();
  if (!session?.user) {
    return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  try {
    const url = new URL(request.url);
    const billingPeriodId = Number(url.searchParams.get("billing_period_id"));
    if (!Number.isInteger(billingPeriodId)) {
      return badRequest("billing_period_id is required.");
    }
    const [records, realPropertyState] = await Promise.all([
      queryReconciliationPeriod(billingPeriodId),
      getRealPropertyPeriodState(billingPeriodId),
    ]);
    const summaries = records.filter(
      (item) => text(item.RecordType) === "SUMMARY",
    );
    const allocations = records.filter(
      (item) => text(item.RecordType) === "ALLOCATION",
    );
    const unallocatedMeters = records.filter(
      (item) => text(item.RecordType) === "UNALLOCATED_METER",
    );
    const poolContributions = records.filter(
      (item) => text(item.RecordType) === "POOL_CONTRIBUTION",
    );
    const generatedAt = records.reduce((latest, item) => {
      const value = firstText(item, "CreatedDate");
      return value > latest ? value : latest;
    }, "");
    const includedMeters = summaries.reduce(
      (sum, item) => sum + numberValue(item.MeterCount),
      0,
    );
    const structuredIssues: ReconciliationIssue[] = [];
    for (const summary of summaries) {
      const issues = Array.isArray(summary.Issues)
        ? (summary.Issues as ReconciliationIssue[])
        : [];
      structuredIssues.push(...issues);
    }
    const meterIssues = unallocatedMeters.map(
      (item) =>
        firstText(item, "UnallocatedReason") ||
        `${firstText(item, "MeterID", "SourceID") || "Meter"} could not be allocated.`,
    );
    return Response.json({
      ok: true,
      preview: false,
      persisted: records.length > 0,
      billingPeriodId,
      exists: records.length > 0,
      sourceDataPotentiallyStale:
        records.length > 0 &&
        realPropertyState?.ReconciliationPotentiallyStale === true,
      sourceDataChangedAt: realPropertyState?.ChangedAt ?? null,
      sourceDataChangeOperation: realPropertyState?.ChangeOperation ?? null,
      generatedAt,
      recordCount: records.length,
      summaryCount: summaries.length,
      allocationCount: allocations.length,
      unallocatedMeterCount: unallocatedMeters.length,
      poolContributionCount: poolContributions.length,
      sourceCounts: {
        includedMeters,
      },
      issues: {
        meter: meterIssues,
        allocation: [],
        structured: structuredIssues,
      },
      records,
      summaries,
      allocations,
      unallocatedMeters,
      poolContributions,
    });
  } catch (error) {
    console.error("Reconciliation read failed:", error);
    return Response.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Unable to read reconciliation.",
      },
      { status: 500 },
    );
  }
}
// ============================================================
// POST - GENERATE / REGENERATE RECONCILIATION

// ============================================================

export async function POST(request: Request) {
  // Production authentication (enable before deployment):
  const session = await getAppSession();
  if (!session?.user) {
    return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = (await request.json().catch(() => ({}))) as Item;
    const url = new URL(request.url);
    const billingPeriodId = Number(
      body.billing_period_id ?? url.searchParams.get("billing_period_id"),
    );
    if (!Number.isInteger(billingPeriodId)) {
      return badRequest("billing_period_id is required.");
    }

    // Load the billing-period snapshots in parallel. Meter master is needed to
    // resolve Facility Number, Utility, and WWYK/TACX utility group.
    const [
      readings,
      invoices,
      propQRows,
      plantUnitRows,
      realPropertyResult,
      meters,
      customers,
      existing,
    ] = await Promise.all([
      queryByBillingPeriod(READINGS_TABLE, billingPeriodId),
      queryByBillingPeriod(INVOICES_TABLE, billingPeriodId),
      queryByBillingPeriod(PROPQ_TABLE, billingPeriodId),
      queryByBillingPeriod(PLANT_UNIT_TABLE, billingPeriodId),
      loadRealPropertyForPeriod(billingPeriodId),
      scanAll(METERS_TABLE),
      scanAll(CUSTOMERS_TABLE),
      queryReconciliationPeriod(billingPeriodId),
    ]);
    const rpRows = realPropertyResult.items;
    if (propQRows.length === 0) {
      return badRequest(
        "No PropQ records exist for this billing period. Generate PropQ before reconciliation.",
      );
    }
    if (rpRows.length === 0) {
      return badRequest(
        realPropertyResult.source === "legacy"
          ? `No legacy Real Property snapshot exists for FY${realPropertyResult.fiscalYear}.`
          : "No monthly Real Property snapshot exists for this billing period.",
        {
          realPropertySource: realPropertyResult.source,
          realPropertyTable: realPropertyResult.tableName,
          fiscalYear: realPropertyResult.fiscalYear,
        },
      );
    }

    // ----------------------------------------------------------
    // PERIOD METADATA

    // ----------------------------------------------------------
    const periodSource = propQRows[0] ?? rpRows[0] ?? invoices[0] ?? readings[0];
    const fy = firstNumber(periodSource, "FY", "fy");
    const billingMonth = firstText(
      periodSource,
      "BillingMonth",
      "billing_month_nm",
      "billing_month",
    );
    const billingMonthCode = firstText(periodSource, "BillingMonthCode");
    const createdDate = new Date().toISOString();

    // ----------------------------------------------------------
    // LOOKUPS

    // ----------------------------------------------------------
    const meterById = new Map<string, Item>();
    for (const meter of meters) {
      const meterId = firstText(meter, "meterid", "METERID");
      if (meterId) meterById.set(meterId, meter);
    }
    const rpByMonthlyId = new Map<string, Item>();
    const rpByLegacyId = new Map<string, Item>();
    const rpByFacilityNumber = new Map<string, Item[]>();
    for (const rp of rpRows) {
      const monthlyRpId = firstText(rp, "MonthlyRPID");
      const legacyRpId = firstText(rp, "LegacyRPID");
      if (monthlyRpId) rpByMonthlyId.set(monthlyRpId, rp);
      if (legacyRpId) rpByLegacyId.set(legacyRpId, rp);
      const facilityNumber = firstText(rp, "FacilityNumber", "facility_nbr");
      if (facilityNumber) {
        const list = rpByFacilityNumber.get(facilityNumber) ?? [];
        list.push(rp);
        rpByFacilityNumber.set(facilityNumber, list);
      }
    }

    // PropQ remains at the RP/CAT allocation grain. When multiple RP rows belong
    // to one customer, their allocations naturally sum to the customer total.
    // This preserves the CAT-code view without losing customer billing rollups.
    const propQByFacilityUtilityGroup = new Map<string, Item[]>();
    const propQEnriched: Item[] = [];
    for (const propQ of propQRows) {
      const monthlyRpId = firstText(propQ, "MonthlyRPID");
      const legacyRpId = firstText(propQ, "LegacyRPID");
      const rp =
        (monthlyRpId ? rpByMonthlyId.get(monthlyRpId) : undefined) ??
        (legacyRpId ? rpByLegacyId.get(legacyRpId) : undefined);
      const facilityId = firstText(propQ, "FacilityID") || firstText(rp, "FacilityID");
      const facilityNumber =
        firstText(propQ, "FacilityNumber") ||
        firstText(rp, "FacilityNumber", "facility_nbr");
      const utilityType = utility(propQ.UtilityType);
      const utilityGroup = normalizeUtilityGroup(
        firstText(propQ, "UtilityGroup", "utility_group_id") ||
          firstText(rp, "UtilityGroup", "utility_group_id", "sub_inst_cd", "SUB_INST_CD"),
      );
      const enriched: Item = {
        ...propQ,
        FacilityID: facilityId,
        FacilityNumber: facilityNumber,
        UtilityType: utilityType,
        UtilityGroup: utilityGroup,
        CustomerID: firstText(propQ, "CustomerID") || firstText(rp, "CustomerID"),
        CustomerName:
          firstText(propQ, "CustomerName", "CUBECustomerName") ||
          firstText(rp, "CUBECustomerName", "NextGenCustomerName", "CustomerName"),
        RPCommodityEnabled:
          commodityFlagEnabled(rp, utilityType) ||
          commodityFlagEnabled(propQ, utilityType)
            ? 1
            : 0,
        UtilityReimbursementOverrides:
          rp?.UtilityReimbursementOverrides ??
          propQ.UtilityReimbursementOverrides ??
          {},
        CategoryCode: firstText(propQ, "CategoryCode") || firstText(rp, "CategoryCode"),
        MonthlyRPID: monthlyRpId,
        LegacyRPID: legacyRpId || firstText(rp, "LegacyRPID"),
        AreaSF: firstNumber(propQ, "AreaSF") ?? firstNumber(rp, "AllocationQty") ?? 0,
      };
      propQEnriched.push(enriched);
      if (facilityNumber && utilityType && utilityGroup) {
        const key = facilityUtilityGroupKey(
          facilityNumber,
          utilityType,
          utilityGroup,
        );
        const list = propQByFacilityUtilityGroup.get(key) ?? [];
        list.push(enriched);
        propQByFacilityUtilityGroup.set(key, list);
      }
    }

    // ----------------------------------------------------------
    // INVOICE TOTALS BY UTILITY GROUP + UTILITY

    // ----------------------------------------------------------

    type InvoiceBucket = {
      utilityGroup: string;
      utilityType: string;
      consumption: number;
      units: Set<string>;
      rows: number;
      excludedRows: number;
      chargeOnlyRows: number;
      chargeOnlyAmount: number;
    };
    const invoiceBuckets = new Map<string, InvoiceBucket>();
    for (const invoice of invoices) {
      const utilityGroup =
        normalizeUtilityGroup(
          firstText(invoice, "utility_group_id", "UtilityGroup"),
        ) || firstText(invoice, "utility_group_id", "UtilityGroup");
      const utilityType = reconciliationInvoiceUtility(
        firstText(invoice, "utility_type_cd", "UtilityType"),
      );
      if (!utilityGroup || !utilityType) continue;
      if (!SUPPORTED_RECONCILIATION_UTILITIES.has(utilityType)) continue;
      const rawUnit = firstText(invoice, "consumption_um", "ConsumptionUM");
      const classification = classifyReconciliationInvoiceRow({
        utilityType,
        consumption: invoice.consumption,
        consumptionUnit: rawUnit,
        charge: invoice.charge,
      });
      const key = `${utilityGroup}|${utilityType}`;
      let bucket = invoiceBuckets.get(key);
      if (!bucket) {
        bucket = {
          utilityGroup,
          utilityType,
          consumption: 0,
          units: new Set<string>(),
          rows: 0,
          excludedRows: 0,
          chargeOnlyRows: 0,
          chargeOnlyAmount: 0,
        };
        invoiceBuckets.set(key, bucket);
      }
      bucket.rows += 1;
      if (classification.kind === "CHARGE_ONLY") {
        bucket.chargeOnlyRows += 1;
        bucket.chargeOnlyAmount += classification.charge;
        continue;
      }
      if (classification.kind === "INVALID") {
        bucket.excludedRows += 1;
        continue;
      }
      if (rawUnit) bucket.units.add(rawUnit.toUpperCase());
      bucket.consumption += classification.normalizedConsumption;
    }

    // ----------------------------------------------------------
    // INCLUDED METERS / METERED TOTALS

    // ----------------------------------------------------------

    type MeterSource = {
      meterId: string;
      facilityNumber: string;
      utilityGroup: string;
      utilityType: string;
      meterType: string;
      rawConsumption: number;
      normalizedConsumption: number;
      usedAdjustedConsumption: boolean;
    };
    const meterSources: MeterSource[] = [];
    const usedMeterFacilityUtilityGroupKeys = new Set<string>();
    const meteredByGroupUtility = new Map<string, number>();
    const meterIssues: string[] = [];
    const calculationPoolContributions: Item[] = [];
    const calculationEligibilityIssues: ReconciliationIssue[] = [];
    for (const reading of readings) {
      if (numberValue(reading.used_in_calculation) !== 1) continue;
      const meterId = firstText(reading, "meterid", "METERID");
      if (!meterId) {
        meterIssues.push("A used meter reading is missing meterid.");
        continue;
      }
      const master = meterById.get(meterId);
      const facilityNumber =
        firstText(master, "facility_nbr", "FACILITY_NBR") ||
        firstText(reading, "facility_nbr", "FACILITY_NBR");
      const utilityType = utility(
        firstText(master, "utility_type_cd", "UTILITY_TYPE_CD") ||
          firstText(reading, "utility_type_cd", "UTILITY_TYPE_CD"),
      );
      let utilityGroup = utilityGroupFromSubInstallation(
        firstText(master, "sub_inst_cd", "SUB_INST_CD") ||
          firstText(reading, "sub_inst_cd", "SUB_INST_CD"),
      );
      if (utilityType && !SUPPORTED_RECONCILIATION_UTILITIES.has(utilityType)) {
        continue;
      }

      // SS is derived from allocated PW and is not independently allocated.
      if (utilityType === "SS") {
        continue;
      }

      if (!utilityGroup && facilityNumber) {
        const facilityRpRows = rpByFacilityNumber.get(facilityNumber) ?? [];
        const groupResolution =
          resolveRealPropertyUtilityGroup(facilityRpRows);

        if (groupResolution.status === "RESOLVED") {
          utilityGroup = utilityGroupFromSubInstallation(
            groupResolution.utilityGroup,
          );
        } else {
          const candidateGroups =
            groupResolution.status === "AMBIGUOUS"
              ? Array.from(
                  new Set(
                    groupResolution.utilityGroups
                      .map(utilityGroupFromSubInstallation)
                      .filter(Boolean),
                  ),
                )
              : [];
          const affectedGroups = candidateGroups.length
            ? candidateGroups
            : Array.from(
                new Set(
                  Array.from(invoiceBuckets.values())
                    .filter((bucket) => bucket.utilityType === utilityType)
                    .map((bucket) => bucket.utilityGroup),
                ),
              );
          const message =
            groupResolution.status === "AMBIGUOUS"
              ? `${meterId}: active Real Property rows for Facility ${facilityNumber} do not identify one complete, consistent utility group; resolve the meter's Sub Installation or the RP group values.`
              : `${meterId}: active Real Property rows for Facility ${facilityNumber} do not identify a utility group; resolve the meter's Sub Installation or the RP group values.`;
          meterIssues.push(message);
          for (const affectedGroup of affectedGroups) {
            calculationEligibilityIssues.push({
              type: "ALLOCATION",
              code: "METER_UTILITY_GROUP_UNRESOLVED",
              utilityGroup: affectedGroup,
              utilityType,
              meterId,
              facilityNumber,
              message,
              blocking: true,
            });
          }
        }
      }

      if (!facilityNumber || !utilityType || !utilityGroup) {
        meterIssues.push(
          `${meterId}: unable to resolve Facility Number, Utility Type, or Utility Group.`,
        );
        continue;
      }
      const facilityRpRows = matchingRealPropertyRowsForUtilityGroup(
        rpByFacilityNumber.get(facilityNumber) ?? [],
        utilityGroup,
      );
      const adjusted = numberOrNull(reading.adjusted_consumption);
      const rawConsumption = adjusted ?? numberValue(reading.consumption);
      const normalizedConsumption = normalizeMeterConsumption(
        utilityType,
        rawConsumption,
      );
      const calculationEligibility = classifyMeterCalculationEligibility(
        facilityRpRows,
        utilityType,
        utilityGroup,
      );
      const calculationDisabled = calculationEligibility === "ALL_DISABLED";
      const mixedCalculationEligibility = calculationEligibility === "MIXED";
      if (calculationDisabled || mixedCalculationEligibility) {
        const reasonCode = mixedCalculationEligibility
          ? "MIXED_RP_CALCULATION_ELIGIBILITY"
          : "RP_CALCULATION_DISABLED";
        calculationPoolContributions.push({
          billing_period_id: billingPeriodId,
          ReconciliationID:
            `POOL#METER#${safeKeyPart(utilityGroup)}#${safeKeyPart(utilityType)}` +
            `#${safeKeyPart(meterId)}`,
          RecordType: "POOL_CONTRIBUTION",
          FY: fy,
          BillingMonth: billingMonth,
          BillingMonthCode: billingMonthCode,
          UtilityGroup: utilityGroup,
          UtilityType: utilityType,
          FacilityNumber: facilityNumber,
          MeterID: meterId,
          SourceID: meterId,
          SourceConsumption: round(normalizedConsumption),
          SourceRawConsumption: round(rawConsumption),
          SourceRawUM: utilityType === "NG" ? "CF" : reconciliationUnit(utilityType, new Set()),
          ConsumptionUM: reconciliationUnit(utilityType, new Set()),
          CalculationExcludedConsumption: round(normalizedConsumption),
          PoolReasonCode: reasonCode,
          PoolDisposition: "NONMETERED_POOL",
          Blocking: mixedCalculationEligibility ? 1 : 0,
          CreatedDate: createdDate,
        });
        if (mixedCalculationEligibility) {
          const message =
            `${meterId}: Facility ${facilityNumber} has both ${utilityType}-enabled and ` +
            `${utilityType}-disabled RP records. The complete meter was returned to the ` +
            "existing nonmetered pool because no approved method exists to split its " +
            "consumption between calculation-eligible and excluded records.";
          meterIssues.push(message);
          calculationEligibilityIssues.push({
            type: "ALLOCATION",
            code: reasonCode,
            utilityGroup,
            utilityType,
            meterId,
            facilityNumber,
            message,
            blocking: true,
          });
        }
        continue;
      }
      if (
        !isMeteredFacilityUtilityEligible(
          facilityRpRows,
          utilityType,
          utilityGroup,
        )
      ) {
        // A Used meter does not override a disabled RP commodity flag. Leave
        // this reading out of metered totals so its consumption remains in the
        // applicable nonmetered pool. The source reading and RP row are kept
        // unchanged, and this is not an allocation exception.
        continue;
      }
      meterSources.push({
        meterId,
        facilityNumber,
        utilityGroup,
        utilityType,
        meterType: firstText(master, "meter_type_cd", "METER_TYPE_CD"),
        rawConsumption,
        normalizedConsumption,
        usedAdjustedConsumption: adjusted !== null,
      });
      usedMeterFacilityUtilityGroupKeys.add(
        facilityUtilityGroupKey(facilityNumber, utilityType, utilityGroup),
      );
      const key = `${utilityGroup}|${utilityType}`;
      meteredByGroupUtility.set(
        key,
        (meteredByGroupUtility.get(key) ?? 0) + normalizedConsumption,
      );
    }

    // ----------------------------------------------------------
    // PLANT UNIT PW PRODUCTION

    // ----------------------------------------------------------
    const plantPwByUtilityGroup = new Map<string, number>();
    for (const plantRow of plantUnitRows) {
      const plantUtility = utility(
        firstText(
          plantRow,
          "produced_utility_type_cd",
          "UtilityType",
          "utility_type_cd",
        ),
      );
      if (plantUtility !== "PW") continue;
      const utilityGroup = normalizeUtilityGroup(
        firstText(
          plantRow,
          "utility_group_id",
          "UtilityGroup",
          "sub_inst_cd",
        ),
      );
      if (!utilityGroup) continue;
      const production =
        firstNumber(
          plantRow,
          "total_production",
          "TotalProduction",
          "production",
        ) ?? 0;
      plantPwByUtilityGroup.set(
        utilityGroup,
        (plantPwByUtilityGroup.get(utilityGroup) ?? 0) + production,
      );
    }

    function plantPwForGroup(utilityGroup: string): number {

      // WWYK (group 1) adds well-water production to invoice PW.
      return utilityGroup === "1"
        ? plantPwByUtilityGroup.get(utilityGroup) ?? 0
        : 0;
    }

    function allocationSourceConsumption(
      utilityGroup: string,
      utilityType: string,
      invoiceConsumption: number,
    ): number {
      if (utilityType === "PW") {
        return invoiceConsumption + plantPwForGroup(utilityGroup);
      }
      return invoiceConsumption;
    }

    // ----------------------------------------------------------
    // NONMETERED PROJECTED-USAGE WEIGHTS
    //
    // Nonmetered pool is calculated at Utility Group + Utility:
    // Invoice - all included meters in that group/utility.
    // It is then distributed across every eligible RP record in the same
    // group/utility using EstimatedUsage as the weight.

    // ----------------------------------------------------------
    const projectedTotalByGroupUtility = new Map<string, number>();
    for (const propQ of propQEnriched) {
      const utilityGroup = firstText(propQ, "UtilityGroup");
      const utilityType = utility(propQ.UtilityType);
      const facilityNumber = firstText(propQ, "FacilityNumber");
      if (
        !isNonMeteredFacilityEligible(
          {
            facilityNumber,
            utilityType,
            utilityGroup,
            rpCommodityEnabled: numberValue(propQ.RPCommodityEnabled) === 1,
          },
          usedMeterFacilityUtilityGroupKeys,
        )
      ) {
        continue;
      }
      const estimatedUsage = numberValue(propQ.EstimatedUsage);
      if (!utilityGroup || !utilityType) continue;
      const key = `${utilityGroup}|${utilityType}`;
      projectedTotalByGroupUtility.set(
        key,
        (projectedTotalByGroupUtility.get(key) ?? 0) + estimatedUsage,
      );
    }

    // ----------------------------------------------------------
    // CUSTOMER BILLING CLASSIFICATION SNAPSHOT

    // ----------------------------------------------------------
    // Reconciliation stores the customer billing classification that was in
    // effect when this billing-period allocation was generated. Billing/rates
    // can therefore use the historical reconciliation snapshot later instead
    // of depending on a customer master record that may have changed.
    const customerById = new Map<string, Item>();
    for (const customer of customers) {
      const customerId = firstText(
        customer,
        "CustomerID",
        "customerid",
        "customer_id",
      );
      if (!customerId) continue;
      customerById.set(customerId, customer);
    }

    function reimbursementFields(
      customerType: string,
      source: Item,
      utilityTypeValue: unknown,
      calculationEnabled: boolean,
    ): Item {
      const utilityType = utility(utilityTypeValue);
      if (!isUtilityCode(utilityType)) return {};
      return reimbursementSnapshotFields(
        resolveUtilityReimbursement({
          utilityType,
          customerType,
          overrides: source.UtilityReimbursementOverrides,
          calculationEnabled,
        }),
      );
    }

    function customerBillingSnapshot(propQ: Item): Item {
      const customerId = firstText(propQ, "CustomerID");
      const customer = customerById.get(customerId);
      const customerName =
        firstText(
          customer,
          "CustomerName",
          "customer_nm",
          "CUSTOMER_NM",
          "customer_name",
        ) ||
        firstText(propQ, "CustomerName");

      // Business rule: a blank CUSTOMER_TYPE is Non-Reimbursable.
      const customerType =
        firstText(
          customer,
          "CustomerType",
          "customer_type",
          "CUSTOMER_TYPE",
        ) || "Non-Reimbursable";
      const reportType = firstText(
        customer,
        "ReportType",
        "report_type",
        "REPORT_TYPE",
      );
      const rateClass = firstText(
        customer,
        "RateClass",
        "rate_class",
        "RATE_CLASS",
      );
      return {
        CustomerName: customerName,
        CustomerType: customerType,
        ReportType: reportType,
        RateClass: rateClass,

        // Rate application is intentionally a later billing step.
        RateID: null,
        Rate: null,
        Amount: null,
        BillingStatus: "AWAITING_RATE",
        ...reimbursementFields(
          customerType,
          propQ,
          propQ.UtilityType,
          numberValue(propQ.RPCommodityEnabled) === 1,
        ),
      };
    }

    // ----------------------------------------------------------
    // CREATE ALLOCATION RECORDS

    // ----------------------------------------------------------
    const allocationItems: Item[] = [];
    const allocationIssues: string[] = [];
    const structuredIssues: ReconciliationIssue[] = [
      ...calculationEligibilityIssues,
    ];
    const unallocatedMeterItems: Item[] = [];

    function unallocatedMeterItem(
      meter: MeterSource,
      reasonCode: string,
      reason: string,
    ): Item {
      return {
        billing_period_id: billingPeriodId,
        ReconciliationID:
          `UNALLOCATED#METER#${safeKeyPart(meter.utilityGroup)}#${safeKeyPart(meter.utilityType)}` +
          `#${safeKeyPart(meter.meterId)}`,
        RecordType: "UNALLOCATED_METER",
        FY: fy,
        BillingMonth: billingMonth,
        BillingMonthCode: billingMonthCode,
        UtilityGroup: meter.utilityGroup,
        UtilityType: meter.utilityType,
        FacilityNumber: meter.facilityNumber,
        MeterID: meter.meterId,
        MeterType: meter.meterType,
        AllocationSource: "UNALLOCATED_METER",
        SourceID: meter.meterId,
        SourceConsumption: round(meter.normalizedConsumption),
        SourceRawConsumption: round(meter.rawConsumption),
        SourceRawUM:
          meter.utilityType === "NG"
            ? "CF"
            : reconciliationUnit(meter.utilityType, new Set()),
        ConsumptionUM: reconciliationUnit(
          meter.utilityType,
          invoiceBuckets.get(`${meter.utilityGroup}|${meter.utilityType}`)?.units ?? new Set(),
        ),
        UsedAdjustedConsumption: meter.usedAdjustedConsumption ? 1 : 0,
        AllocatedMeteredConsumption: 0,
        AllocatedNonMeteredConsumption: 0,
        AllocatedTotalConsumption: 0,
        UnallocatedMeteredConsumption: round(meter.normalizedConsumption),
        UnallocatedReasonCode: reasonCode,
        UnallocatedReason: reason,
        ReconciliationStatus: "UNALLOCATED",
        CreatedDate: createdDate,
      };
    }

    function baseAllocation(
      propQ: Item,
      sourceType: AllocationSource,
      sourceId: string,
    ): Item {
      return {
        billing_period_id: billingPeriodId,
        RecordType: "ALLOCATION",
        FY: fy,
        BillingMonth: billingMonth,
        BillingMonthCode: billingMonthCode,
        FacilityID: firstText(propQ, "FacilityID"),
        FacilityNumber: firstText(propQ, "FacilityNumber"),
        UtilityGroup: firstText(propQ, "UtilityGroup"),
        UtilityType: utility(propQ.UtilityType),
        CustomerID: firstText(propQ, "CustomerID"),
        ...customerBillingSnapshot(propQ),
        CategoryCode: firstText(propQ, "CategoryCode"),
        MonthlyRPID: firstText(propQ, "MonthlyRPID"),
        LogicalMonthlyRPID: firstText(propQ, "LogicalMonthlyRPID"),
        LegacyRPID: firstText(propQ, "LegacyRPID"),
        EstimateID: firstText(propQ, "EstimateID"),
        PropQID: firstText(propQ, "PropQID"),
        AreaSF: numberValue(propQ.AreaSF),
        SpaceType: firstText(propQ, "SpaceType"),
        ProjectedUsage: numberValue(propQ.EstimatedUsage),
        FacilityPropQ: numberValue(propQ.PropQ),
        AllocationSource: sourceType,
        SourceID: sourceId,
        CreatedDate: createdDate,
        ReconciliationStatus: "RECONCILED",
      };
    }

    // Meter allocation: every included meter is split across the RP/customer
    // rows for that exact Facility + Utility + Utility Group using the saved
    // facility PropQ.
    for (const meter of meterSources) {
      const propQRowsForMeter =
        propQByFacilityUtilityGroup.get(
          facilityUtilityGroupKey(
            meter.facilityNumber,
            meter.utilityType,
            meter.utilityGroup,
          ),
        ) ?? [];
      if (propQRowsForMeter.length === 0) {
        const facilityRpRows = matchingRealPropertyRowsForUtilityGroup(
          rpByFacilityNumber.get(meter.facilityNumber) ?? [],
          meter.utilityGroup,
        );
        const utilityEnabledRpRows = facilityRpRows.filter(
          (rp) => numberValue(rp[meter.utilityType]) === 1,
        );
        const reasonCode = facilityRpRows.length === 0 ? "NO_RP" : "MISSING_PROPQ";
        const reason =
          facilityRpRows.length === 0
            ? `No RP rows exist for Facility ${meter.facilityNumber} in the billing-period RP source.`
            : `Facility ${meter.facilityNumber} has ${utilityEnabledRpRows.length} ${meter.utilityType}-enabled RP row(s), but no saved PropQ rows were found.`;
        unallocatedMeterItems.push(
          unallocatedMeterItem(meter, reasonCode, reason),
        );
        structuredIssues.push({
          type: "UNALLOCATED_METER",
          code: reasonCode,
          utilityGroup: meter.utilityGroup,
          utilityType: meter.utilityType,
          meterId: meter.meterId,
          facilityNumber: meter.facilityNumber,
          message: reason,
          blocking: true,
        });

        allocationIssues.push(`${meter.meterId}: ${reason}`);
        continue;
      }
      const meterPropQAllocations = calculateMeterPropQAllocations(
        meter.normalizedConsumption,
        propQRowsForMeter.map((row) => numberValue(row.PropQ)),
        EPSILON,
      );
      const propQTotal = meterPropQAllocations.totalPropQ;
      if (
        !meterPropQAllocations.exceedsMeter &&
        Math.abs(propQTotal - 1) > EPSILON
      ) {
        const propQIssueMessage = `${meter.meterId}: Facility ${meter.facilityNumber} ${meter.utilityType} PropQ totals ${round(propQTotal, 10)} instead of 1.`;
        allocationIssues.push(propQIssueMessage);
        structuredIssues.push({
          type: "ALLOCATION",
          code: "PROPQ_NOT_ONE",
          utilityGroup: meter.utilityGroup,
          utilityType: meter.utilityType,
          meterId: meter.meterId,
          facilityNumber: meter.facilityNumber,
          message: propQIssueMessage,
          blocking: true,
        });
      }
      if (meterPropQAllocations.exceedsMeter) {
        const overAllocatedPropQMessage =
          `${meter.meterId}: Facility ${meter.facilityNumber} ${meter.utilityType} PropQ total ` +
          `${round(propQTotal, 10)} would allocate more than the recorded meter consumption.`;
        allocationIssues.push(overAllocatedPropQMessage);
        structuredIssues.push({
          type: "ALLOCATION",
          code: "PROPQ_EXCEEDS_ONE",
          utilityGroup: meter.utilityGroup,
          utilityType: meter.utilityType,
          meterId: meter.meterId,
          facilityNumber: meter.facilityNumber,
          message: overAllocatedPropQMessage,
          blocking: true,
        });
        unallocatedMeterItems.push(
          unallocatedMeterItem(
            meter,
            "PROPQ_EXCEEDS_ONE",
            overAllocatedPropQMessage,
          ),
        );
        continue;
      }
      for (const [propQIndex, propQ] of propQRowsForMeter.entries()) {
        const facilityPropQ = numberValue(propQ.PropQ);
        const allocatedConsumption = meterPropQAllocations.allocations[propQIndex];
        const monthlyRpId = firstText(propQ, "MonthlyRPID");
        const legacyRpId = firstText(propQ, "LegacyRPID");
        const allocationRpId = monthlyRpId || legacyRpId || firstText(propQ, "PropQID");
        allocationItems.push({
          ...baseAllocation(propQ, "METER", meter.meterId),
          ReconciliationID:
            `ALLOC#METER#${safeKeyPart(meter.utilityGroup)}#${safeKeyPart(meter.utilityType)}` +
            `#${safeKeyPart(meter.meterId)}#${safeKeyPart(allocationRpId)}`,
          MeterID: meter.meterId,
          MeterType: meter.meterType,
          SourceConsumption: round(meter.normalizedConsumption),
          SourceRawConsumption: round(meter.rawConsumption),
          SourceRawUM: meter.utilityType === "NG" ? "CF" : reconciliationUnit(meter.utilityType, new Set()),
          ConsumptionUM: reconciliationUnit(
            meter.utilityType,
            invoiceBuckets.get(`${meter.utilityGroup}|${meter.utilityType}`)?.units ?? new Set(),
          ),
          UsedAdjustedConsumption: meter.usedAdjustedConsumption ? 1 : 0,
          AllocationWeight: round(facilityPropQ, 12),
          AllocatedMeteredConsumption: round(allocatedConsumption),
          AllocatedNonMeteredConsumption: 0,
          AllocatedTotalConsumption: round(allocatedConsumption),
        });
      }
    }

    // The pumping rows are created from PW allocations below, but their
    // electricity must be reserved before the WWYK EL nonmetered pool is
    // distributed. Build the same PW allocation set the downstream pumping
    // loop will use, including the prospective PW nonmetered allocations.
    const wwykPwInvoiceBucket = invoiceBuckets.get("1|PW");
    const wwykPwInvoiceConsumption = wwykPwInvoiceBucket?.consumption ?? 0;
    const wwykPlantPwProduction = plantPwForGroup("1");
    const wwykPwBasis =
      wwykPwInvoiceConsumption + wwykPlantPwProduction;
    const wwykSsInvoiceConsumption =
      invoiceBuckets.get("1|SS")?.consumption ?? 0;
    const wwykSsPwFactor =
      wwykPwBasis > 0
        ? wwykSsInvoiceConsumption / wwykPwBasis
        : 0;
    const wwykPwAllocationsForPumping = allocationItems
      .filter(
        (item) =>
          isProducedWaterPumpingGroup(firstText(item, "UtilityGroup")) &&
          utility(item.UtilityType) === "PW",
      )
      .map((item) => {
        const eligibility = resolveDerivedSewerEligibility(item, rpRows);
        return {
          pwConsumption: numberValue(item.AllocatedTotalConsumption),
          sewerEligible:
            eligibility.status === "MATCHED" && eligibility.eligible,
        };
      });

    function nonMeteredEligibleRows(
      utilityGroup: string,
      utilityType: string,
    ): Item[] {
      return propQEnriched.filter((row) => {
        if (
          firstText(row, "UtilityGroup") !== utilityGroup ||
          utility(row.UtilityType) !== utilityType
        ) {
          return false;
        }
        const facilityNumber = firstText(row, "FacilityNumber");
        return isNonMeteredFacilityEligible(
          {
            facilityNumber,
            utilityType,
            utilityGroup,
            rpCommodityEnabled: numberValue(row.RPCommodityEnabled) === 1,
          },
          usedMeterFacilityUtilityGroupKeys,
        );
      });
    }

    if (wwykPwInvoiceBucket) {
      const pwKey = "1|PW";
      const pwMeteredConsumption = meteredByGroupUtility.get(pwKey) ?? 0;
      const pwSourceConsumption = allocationSourceConsumption(
        "1",
        "PW",
        wwykPwInvoiceConsumption,
      );
      const pwNonMeteredPool = pwSourceConsumption - pwMeteredConsumption;
      const pwProjectedUsageTotal = projectedTotalByGroupUtility.get(pwKey) ?? 0;
      const pwEligibleRows = nonMeteredEligibleRows("1", "PW");

      if (pwProjectedUsageTotal > 0) {
        const pwDistribution = distributeNonMeteredPool(
          pwNonMeteredPool,
          pwEligibleRows,
          (propQ) => numberValue(propQ.EstimatedUsage),
        );
        for (const [allocationIndex, allocatedConsumption] of pwDistribution.allocations.entries()) {
          const sourceRp = pwEligibleRows[allocationIndex];
          const eligibility = resolveDerivedSewerEligibility(sourceRp, rpRows);
          wwykPwAllocationsForPumping.push(
            {
              pwConsumption: round(allocatedConsumption),
              sewerEligible:
                eligibility.status === "MATCHED" && eligibility.eligible,
            },
          );
        }
      }
    }

    const wwykPumpingReserve = pumpingReserveForSewerEligibility(
      wwykPwAllocationsForPumping,
      wwykSsPwFactor,
    );
    const wwykElInvoiceBucket = invoiceBuckets.get("1|EL");
    const wwykElPool = reserveElectricityPool(
      wwykElInvoiceBucket?.consumption ?? 0,
      meteredByGroupUtility.get("1|EL") ?? 0,
      wwykPumpingReserve,
    );
    if (wwykPumpingReserve > EPSILON && !wwykElInvoiceBucket) {
      return badRequest(
        "WWYK PW/SS pumping electricity was calculated, but no WWYK EL invoice exists to fund it.",
        {
          billingPeriodId,
          utilityGroup: "1",
          pumpingReservedKwh: round(wwykPumpingReserve),
        },
      );
    }
    if (wwykElPool.insufficientPool) {
      return badRequest(
        "WWYK PW/SS pumping electricity exceeds the available WWYK EL nonmetered pool.",
        {
          billingPeriodId,
          utilityGroup: "1",
          invoiceConsumption: round(wwykElInvoiceBucket?.consumption ?? 0),
          meteredConsumption: round(meteredByGroupUtility.get("1|EL") ?? 0),
          originalNonMeteredPool: round(wwykElPool.originalNonMeteredPool),
          pumpingReservedKwh: round(wwykElPool.pumpingReserved),
        },
      );
    }

    // Nonmetered allocation: group-level invoice less group-level metered.
    // For WWYK EL, the original pool is preserved for reporting while the
    // pumping reserve is removed from the distributable amount.
    // Unlike meter allocation, this weight is based on projected usage across
    // the entire Utility Group + Utility, not facility PropQ.
    for (const [key, invoiceBucket] of invoiceBuckets.entries()) {

      // SS is derived from customer PW below, not allocated through PropQ.
      if (invoiceBucket.utilityType === "SS") {
        continue;
      }
      const meteredConsumption = meteredByGroupUtility.get(key) ?? 0;
      const sourceConsumption = allocationSourceConsumption(
        invoiceBucket.utilityGroup,
        invoiceBucket.utilityType,
        invoiceBucket.consumption,
      );
      const pumpingReserved =
        invoiceBucket.utilityGroup === "1" && invoiceBucket.utilityType === "EL"
          ? wwykPumpingReserve
          : 0;
      const electricityPool = reserveElectricityPool(
        sourceConsumption,
        meteredConsumption,
        pumpingReserved,
      );
      const sourceOverrun =
        invoiceBucket.utilityType !== "SS" &&
        isMeteredConsumptionOverSource(
          meteredConsumption,
          sourceConsumption,
          EPSILON,
        );
      if (sourceOverrun) {
        const sourceOverrunMessage =
          `Utility Group ${invoiceBucket.utilityGroup} ${invoiceBucket.utilityType}: ` +
          `metered consumption ${round(meteredConsumption)} exceeds source consumption ${round(sourceConsumption)}.`;
        allocationIssues.push(sourceOverrunMessage);
        structuredIssues.push({
          type: "ALLOCATION",
          code: "METERED_EXCEEDS_SOURCE",
          utilityGroup: invoiceBucket.utilityGroup,
          utilityType: invoiceBucket.utilityType,
          message: sourceOverrunMessage,
          blocking: true,
        });
        continue;
      }
      const nonMeteredPool = electricityPool.distributableNonMeteredPool;
      const eligibleRows = nonMeteredEligibleRows(
        invoiceBucket.utilityGroup,
        invoiceBucket.utilityType,
      );
      const nonMeteredDistribution = distributeNonMeteredPool(
        nonMeteredPool,
        eligibleRows,
        (propQ) => numberValue(propQ.EstimatedUsage),
      );
      const projectedUsageTotal = nonMeteredDistribution.projectedUsageTotal;
      if (
        isNonMeteredPoolUnallocatable(
          nonMeteredPool,
          eligibleRows.length,
          EPSILON,
        )
      ) {
        const nonMeteredIssueMessage = `Utility Group ${invoiceBucket.utilityGroup} ${invoiceBucket.utilityType}: no RP/PropQ rows available for nonmetered allocation.`;
        allocationIssues.push(nonMeteredIssueMessage);
        structuredIssues.push({
          type: "ALLOCATION",
          code: "NO_NONMETERED_PROPQ",
          utilityGroup: invoiceBucket.utilityGroup,
          utilityType: invoiceBucket.utilityType,
          message: nonMeteredIssueMessage,
          blocking: true,
        });
        continue;
      }
      if (projectedUsageTotal <= 0 && Math.abs(nonMeteredPool) > EPSILON) {
        const projectedUsageIssueMessage = `Utility Group ${invoiceBucket.utilityGroup} ${invoiceBucket.utilityType}: projected usage total is zero, so the nonmetered pool cannot be allocated.`;
        allocationIssues.push(projectedUsageIssueMessage);
        structuredIssues.push({
          type: "ALLOCATION",
          code: "ZERO_PROJECTED_USAGE",
          utilityGroup: invoiceBucket.utilityGroup,
          utilityType: invoiceBucket.utilityType,
          message: projectedUsageIssueMessage,
          blocking: true,
        });
        continue;
      }
      for (const [eligibleRowIndex, propQ] of eligibleRows.entries()) {
        const estimatedUsage = numberValue(propQ.EstimatedUsage);
        const nonMeteredWeight =
          projectedUsageTotal > 0 ? estimatedUsage / projectedUsageTotal : 0;
        const allocatedConsumption =
          nonMeteredDistribution.allocations[eligibleRowIndex] ??
          nonMeteredPool * nonMeteredWeight;
        const monthlyRpId = firstText(propQ, "MonthlyRPID");
        const legacyRpId = firstText(propQ, "LegacyRPID");
        const allocationRpId =
          monthlyRpId || legacyRpId || firstText(propQ, "PropQID");
        allocationItems.push({
          ...baseAllocation(propQ, "NONMETERED", "NONMETERED"),
          ReconciliationID:
            `ALLOC#NONMETERED#${safeKeyPart(invoiceBucket.utilityGroup)}` +
            `#${safeKeyPart(invoiceBucket.utilityType)}#${safeKeyPart(allocationRpId)}`,
          ConsumptionUM: reconciliationUnit(
            invoiceBucket.utilityType,
            invoiceBucket.units,
          ),
          SourceConsumption: round(nonMeteredPool),
          UtilityGroupProjectedUsage: round(projectedUsageTotal),
          AllocationWeight: round(nonMeteredWeight, 12),
          NonMeteredWeight: round(nonMeteredWeight, 12),
          AllocatedMeteredConsumption: 0,
          AllocatedNonMeteredConsumption: round(allocatedConsumption),
          AllocatedTotalConsumption: round(allocatedConsumption),
        });
      }
    }

    // ----------------------------------------------------------
    // DERIVED SS + ITEMIZED PW/SS PUMPING ELECTRICITY

    // ----------------------------------------------------------
    // Snapshot only the original PW allocations so newly appended derived
    // records are never recursively processed.
    const pwAllocationSnapshot = allocationItems.filter(
      (item) => utility(item.UtilityType) === "PW",
    );
    const sewerEligibilityIssueKeys = new Set<string>();
    for (const pwAllocation of pwAllocationSnapshot) {
      const utilityGroup = firstText(pwAllocation, "UtilityGroup");
      if (!utilityGroup) continue;
      const pwConsumption = numberValue(
        pwAllocation.AllocatedTotalConsumption,
      );
      const pwInvoiceConsumption =
        invoiceBuckets.get(`${utilityGroup}|PW`)?.consumption ?? 0;
      const plantPwProduction = plantPwForGroup(utilityGroup);
      const pwBasis =
        utilityGroup === "1"
          ? pwInvoiceConsumption + plantPwProduction
          : pwInvoiceConsumption;
      const ssInvoiceConsumption =
        invoiceBuckets.get(`${utilityGroup}|SS`)?.consumption ?? 0;
      const ssPwFactor =
        pwBasis > 0 ? ssInvoiceConsumption / pwBasis : 0;
      const sewerEligibility = resolveDerivedSewerEligibility(
        pwAllocation,
        rpRows,
      );
      const sewerEligible =
        sewerEligibility.status === "MATCHED" && sewerEligibility.eligible;
      const ssConsumption = derivedSewerConsumption(
        pwConsumption,
        ssPwFactor,
        sewerEligibility,
      );
      const pumpingEnergy = pumpingEnergyForPwAllocation(
        pwConsumption,
        ssPwFactor,
      );
      const sourceReconciliationId =
        firstText(pwAllocation, "ReconciliationID") ||
        firstText(pwAllocation, "PropQID");
      const itemKey = safeKeyPart(sourceReconciliationId);
      const customerId = firstText(pwAllocation, "CustomerID");
      const facilityNumber = firstText(pwAllocation, "FacilityNumber");
      const sourceRpId = sewerEligibility.sourceRpId;
      const reimbursementSourceRp =
        sewerEligibility.status === "MATCHED"
          ? (sewerEligibility.realProperty as Item)
          : pwAllocation;
      const electricityReimbursementFields = reimbursementFields(
        firstText(pwAllocation, "CustomerType"),
        reimbursementSourceRp,
        pumpingReimbursementUtility("PW_PUMPING"),
        commodityFlagEnabled(reimbursementSourceRp, "EL"),
      );
      const sewerPumpingReimbursementFields = reimbursementFields(
        firstText(pwAllocation, "CustomerType"),
        reimbursementSourceRp,
        pumpingReimbursementUtility("SS_PUMPING"),
        sewerEligible,
      );
      const sharedAuditFields: Item = {
        PWSourceReconciliationID: sourceReconciliationId,
        PWAllocatedKGAL: round(pwConsumption),
        PWInvoiceKGAL: round(pwInvoiceConsumption),
        PlantUnitPWKGAL: round(plantPwProduction),
        PWBasisKGAL: round(pwBasis),
        SSInvoiceKGAL: round(ssInvoiceConsumption),
        SSPWFactor: round(ssPwFactor, 12),
        PWHeadFT: PW_HEAD_FT,
        PWEnergyConstant: PW_ENERGY_CONSTANT,
        PWCombinedEfficiency: PW_COMBINED_EFFICIENCY,
        PWKwhPerKgal: round(PW_KWH_PER_KGAL, 12),
        SSKwhPerKgal: SS_KWH_PER_KGAL,
        SourceRPID: sourceRpId,
        SourceRPMatchStatus: sewerEligibility.status,
        SourceRPSSCommodityEnabled: sewerEligible ? 1 : 0,
      };

      if (sewerEligibility.status === "REVIEW_REQUIRED") {
        const issueKey = `${utilityGroup}|${sewerEligibility.reasonCode}|${sourceRpId}|${customerId}|${facilityNumber}`;
        if (!sewerEligibilityIssueKeys.has(issueKey)) {
          sewerEligibilityIssueKeys.add(issueKey);
          const message =
            `${sewerEligibility.message} Derived sewer and SS pumping were not generated; ` +
            "review the PW allocation's active RP link.";
          allocationIssues.push(message);
          structuredIssues.push({
            type: "ALLOCATION",
            code: sewerEligibility.reasonCode,
            utilityGroup,
            utilityType: "SS",
            facilityNumber,
            customerId,
            sourceRpId,
            message,
            blocking: true,
          });
        }
      } else if (!sewerEligibility.eligible) {
        const potentialSsConsumption = potentialDerivedSewerConsumption(
          pwConsumption,
          ssPwFactor,
        );
        if (Math.abs(potentialSsConsumption) > EPSILON) {
          calculationPoolContributions.push({
            billing_period_id: billingPeriodId,
            ReconciliationID:
              `POOL#SS#${safeKeyPart(utilityGroup)}#${itemKey}`,
            RecordType: "POOL_CONTRIBUTION",
            FY: fy,
            BillingMonth: billingMonth,
            BillingMonthCode: billingMonthCode,
            UtilityGroup: utilityGroup,
            UtilityType: "SS",
            CustomerID: customerId,
            FacilityNumber: facilityNumber,
            SourceRPID: sourceRpId,
            SourceID: sourceReconciliationId,
            SourceConsumption: round(ssInvoiceConsumption),
            CalculationExcludedConsumption: round(potentialSsConsumption),
            PoolReasonCode: "SS_CALCULATION_DISABLED",
            PoolDisposition: "UNRESOLVED_NONMETERED_POOL",
            Blocking: 1,
            SSPWFactor: round(ssPwFactor, 12),
            CreatedDate: createdDate,
          });
        }
      }

      if (sewerEligible) {
        // Store derived SS separately without redistributing excluded usage.
        allocationItems.push({
          ...pwAllocation,
          ReconciliationID:
            `ALLOC#DERIVED_SS#${safeKeyPart(utilityGroup)}#${itemKey}`,
          UtilityType: "SS",
          ConsumptionUM: "KGAL",
          AllocationSource: "DERIVED_SS",
          SourceID: sourceReconciliationId,
          SourceConsumption: round(ssInvoiceConsumption),
          AllocationWeight: round(ssPwFactor, 12),
          AllocatedMeteredConsumption: 0,
          AllocatedNonMeteredConsumption: 0,
          AllocatedDerivedConsumption: round(ssConsumption),
          AllocatedTotalConsumption: round(ssConsumption),
          CalculationMethod: "PW_TIMES_SS_PW_FACTOR",
          DerivedFromUtility: "PW",
          DerivedForCustomerID: customerId,
          ...reimbursementFields(
            firstText(pwAllocation, "CustomerType"),
            reimbursementSourceRp,
            "SS",
            true,
          ),
          ...sharedAuditFields,
        });
      }

      // TAC retains its purchased-water / derived-sewer allocation, but it
      // does not use the WWYK produced-water pumping-energy methodology.
      if (!isProducedWaterPumpingGroup(utilityGroup)) continue;

      // Store PW pumping KWH as its own EL allocation.
      allocationItems.push({
        ...pwAllocation,
        ReconciliationID:
          `ALLOC#PW_PUMPING#${safeKeyPart(utilityGroup)}#${itemKey}`,
        UtilityType: "EL",
        ConsumptionUM: "KWH",
        AllocationSource: "PW_PUMPING",
        SourceID: sourceReconciliationId,
        SourceConsumption: round(pwConsumption),
        SourceRawUM: "KGAL",
        AllocationWeight: null,
        AllocatedMeteredConsumption: 0,
        AllocatedNonMeteredConsumption: 0,
        AllocatedDerivedConsumption: pumpingEnergy.pwPumpingKwh,
        AllocatedTotalConsumption: pumpingEnergy.pwPumpingKwh,
        CalculationMethod: "PW_KGAL_TIMES_PUMPING_KWH_PER_KGAL",
        DerivedFromUtility: "PW",
        DerivedForCustomerID: customerId,
        PumpingKWH: pumpingEnergy.pwPumpingKwh,
        ...electricityReimbursementFields,
        ...sharedAuditFields,
      });

      if (sewerEligible) {
        // Store SS pumping KWH only for the eligible derived sewer row.
        allocationItems.push({
          ...pwAllocation,
          ReconciliationID:
            `ALLOC#SS_PUMPING#${safeKeyPart(utilityGroup)}#${itemKey}`,
          UtilityType: "EL",
          ConsumptionUM: "KWH",
          AllocationSource: "SS_PUMPING",
          SourceID: sourceReconciliationId,
          SourceConsumption: round(ssConsumption),
          SourceRawUM: "KGAL",
          AllocationWeight: null,
          AllocatedMeteredConsumption: 0,
          AllocatedNonMeteredConsumption: 0,
          AllocatedDerivedConsumption: pumpingEnergy.ssPumpingKwh,
          AllocatedTotalConsumption: pumpingEnergy.ssPumpingKwh,
          CalculationMethod: "SS_KGAL_TIMES_2_18_KWH_PER_KGAL",
          DerivedFromUtility: "SS",
          DerivedForCustomerID: customerId,
          DerivedSSKGAL: round(ssConsumption),
          PumpingKWH: pumpingEnergy.ssPumpingKwh,
          ...sewerPumpingReimbursementFields,
          ...sharedAuditFields,
        });
      }
    }

    // SS Calculation OFF quantities enter a group-specific non-metered pool.
    // Its approved weighting basis is the set of already-validated NONMETERED
    // PW allocations in that group whose exact active RP source has SS enabled.
    const sewerPoolContributionsByGroup = new Map<string, Item[]>();
    for (const contribution of calculationPoolContributions) {
      if (
        utility(contribution.UtilityType) !== "SS" ||
        firstText(contribution, "PoolDisposition") !==
          "UNRESOLVED_NONMETERED_POOL"
      ) {
        continue;
      }
      const utilityGroup = firstText(contribution, "UtilityGroup");
      const groupContributions =
        sewerPoolContributionsByGroup.get(utilityGroup) ?? [];
      groupContributions.push(contribution);
      sewerPoolContributionsByGroup.set(utilityGroup, groupContributions);
    }

    // The present workflow derives SS and does not independently meter it, but
    // retain this guard so a future direct SS allocation cannot also receive a
    // non-metered SS share.
    const directSewerMeterRpIds = new Set(
      allocationItems
        .filter(
          (item) =>
            utility(item.UtilityType) === "SS" &&
            firstText(item, "AllocationSource") === "METER",
        )
        .flatMap((item) =>
          [
            firstText(item, "MonthlyRPID"),
            firstText(item, "LogicalMonthlyRPID"),
            firstText(item, "LegacyRPID"),
          ].filter(Boolean),
        ),
    );

    for (const [utilityGroup, groupContributions] of
      sewerPoolContributionsByGroup) {
      const poolConsumption = round(
        groupContributions.reduce(
          (sum, contribution) =>
            sum + numberValue(contribution.CalculationExcludedConsumption),
          0,
        ),
      );
      if (Math.abs(poolConsumption) <= EPSILON) continue;
      const recipients = pwAllocationSnapshot.flatMap((pwAllocation) => {
        if (
          firstText(pwAllocation, "UtilityGroup") !== utilityGroup ||
          firstText(pwAllocation, "AllocationSource") !== "NONMETERED"
        ) {
          return [];
        }
        const eligibility = resolveDerivedSewerEligibility(
          pwAllocation,
          rpRows,
        );
        if (eligibility.status !== "MATCHED" || !eligibility.eligible) {
          return [];
        }
        const recipientId = firstText(pwAllocation, "ReconciliationID");
        const sourceRpId = eligibility.sourceRpId;
        return [
          {
            recipientId,
            utilityGroup,
            allocationSource: firstText(pwAllocation, "AllocationSource"),
            ssCalculationEnabled: true,
            pwNonMeteredConsumption: numberValue(
              pwAllocation.AllocatedNonMeteredConsumption,
            ),
            hasDirectSewerMeterAllocation:
              directSewerMeterRpIds.has(sourceRpId),
            pwAllocation,
            realProperty: eligibility.realProperty as Item,
            sourceRpId,
          },
        ];
      });
      const distribution = distributeSewerNonMeteredPool(
        poolConsumption,
        utilityGroup,
        recipients,
        EPSILON,
      );
      const poolDistributionId =
        `POOL-DIST#SS#${safeKeyPart(utilityGroup)}`;

      if (distribution.status === "DISTRIBUTED") {
        let roundedDistributed = 0;
        for (const [distributionIndex, poolAllocation] of
          distribution.allocations.entries()) {
          const isLast =
            distributionIndex === distribution.allocations.length - 1;
          const allocatedConsumption = isLast
            ? round(poolConsumption - roundedDistributed)
            : round(poolAllocation.allocatedConsumption);
          roundedDistributed = round(
            roundedDistributed + allocatedConsumption,
          );
          const recipient = poolAllocation.recipient;
          const pwAllocation = recipient.pwAllocation;
          const sourceReconciliationId = firstText(
            pwAllocation,
            "ReconciliationID",
          );
          const groupPwInvoice =
            invoiceBuckets.get(`${utilityGroup}|PW`)?.consumption ?? 0;
          const groupPwBasis =
            groupPwInvoice + plantPwForGroup(utilityGroup);
          const groupSsInvoice =
            invoiceBuckets.get(`${utilityGroup}|SS`)?.consumption ?? 0;
          const groupSsPwFactor =
            groupPwBasis > 0 ? groupSsInvoice / groupPwBasis : 0;

          allocationItems.push({
            ...pwAllocation,
            ReconciliationID:
              `ALLOC#SS_NONMETERED#${safeKeyPart(utilityGroup)}#${safeKeyPart(sourceReconciliationId)}`,
            UtilityType: "SS",
            ConsumptionUM: "KGAL",
            AllocationSource: "SS_NONMETERED",
            SourceID: poolDistributionId,
            SourceConsumption: poolConsumption,
            AllocationWeight: round(poolAllocation.weight, 12),
            NonMeteredWeight: round(poolAllocation.weight, 12),
            AllocatedMeteredConsumption: 0,
            AllocatedNonMeteredConsumption: allocatedConsumption,
            AllocatedDerivedConsumption: 0,
            AllocatedTotalConsumption: allocatedConsumption,
            CalculationMethod: "SS_POOL_BY_NONMETERED_PW_SHARE",
            DerivedFromUtility: "PW",
            PWSourceReconciliationID: sourceReconciliationId,
            PWAllocatedKGAL: round(
              numberValue(pwAllocation.AllocatedTotalConsumption),
            ),
            PWNonMeteredWeightingBasisKGAL: round(
              distribution.weightingBasis,
            ),
            SSPWFactor: round(groupSsPwFactor, 12),
            SourceRPID: recipient.sourceRpId,
            SourceRPMatchStatus: "MATCHED",
            SourceRPSSCommodityEnabled: 1,
            PoolDistributionID: poolDistributionId,
            PoolContributionConsumption: poolConsumption,
            PoolDisposition: "DISTRIBUTED_NONMETERED_POOL",
            ...reimbursementFields(
              firstText(pwAllocation, "CustomerType"),
              recipient.realProperty,
              "SS",
              true,
            ),
          });
        }
        for (const contribution of groupContributions) {
          contribution.PoolDisposition = "DISTRIBUTED_NONMETERED_POOL";
          contribution.PoolDistributionID = poolDistributionId;
          contribution.PoolDistributionWeightBasis = round(
            distribution.weightingBasis,
          );
          contribution.Blocking = 0;
        }
        continue;
      }

      const reason =
        distribution.reasonCode === "DUPLICATE_PW_RECIPIENT"
          ? "the eligible PW allocation identifiers are missing or duplicated"
          : "no eligible non-metered PW allocation with SS Calculation enabled exists";
      const message =
        `${poolConsumption} KGAL remains in Utility Group ${utilityGroup}'s SS ` +
        `non-metered pool because ${reason}. Billing is blocked.`;
      allocationIssues.push(message);
      structuredIssues.push({
        type: "ALLOCATION",
        code: "SS_NONMETERED_POOL_UNRESOLVED",
        utilityGroup,
        utilityType: "SS",
        message,
        blocking: true,
      });
    }

    for (const allocation of allocationItems) {
      const allocatedConsumption = numberValue(
        allocation.AllocatedTotalConsumption,
      );
      const customerReimburses =
        firstText(allocation, "ReimbursementDisposition") ===
        "CUSTOMER_REIMBURSABLE";
      const split = splitReimbursementConsumption(
        round(allocatedConsumption),
        customerReimburses ? "CUSTOMER_REIMBURSABLE" : "CE_ABSORBED",
      );
      allocation.AllocatedReimbursableConsumption =
        split.allocatedReimbursableConsumption;
      allocation.AllocatedCEAbsorbedConsumption =
        split.allocatedCEAbsorbedConsumption;
    }

    // ----------------------------------------------------------
    // SUMMARY RECORDS BY UTILITY GROUP + UTILITY

    // ----------------------------------------------------------
    const summaryItems: Item[] = [];
    const allSummaryKeys = new Set<string>([
      ...invoiceBuckets.keys(),
      ...meteredByGroupUtility.keys(),
      ...projectedTotalByGroupUtility.keys(),
    ]);
    for (const key of allSummaryKeys) {
      const [utilityGroup, utilityType] = key.split("|");
      const invoiceBucket = invoiceBuckets.get(key);
      const invoiceConsumption = invoiceBucket?.consumption ?? 0;
      const plantUnitProduction =
        utilityType === "PW" ? plantPwForGroup(utilityGroup) : 0;
      const sourceConsumption = allocationSourceConsumption(
        utilityGroup,
        utilityType,
        invoiceConsumption,
      );
      const meteredConsumption =
        utilityType === "SS"
          ? 0
          : meteredByGroupUtility.get(key) ?? 0;
      const originalNonMeteredPool =
        utilityType === "SS"
          ? sourceConsumption
          : sourceConsumption - meteredConsumption;
      const pumpingReserved =
        utilityGroup === "1" && utilityType === "EL"
          ? wwykPumpingReserve
          : 0;
      const distributableNonMeteredPool =
        originalNonMeteredPool - pumpingReserved;
      const sourceOverrun =
        utilityType !== "SS" &&
        isMeteredConsumptionOverSource(
          meteredConsumption,
          sourceConsumption,
          EPSILON,
        );
      const groupAllocations = allocationItems.filter(
        (item) =>
          firstText(item, "UtilityGroup") === utilityGroup &&
          utility(item.UtilityType) === utilityType,
      );
      const allocatedMetered = groupAllocations.reduce(
        (sum, item) => sum + numberValue(item.AllocatedMeteredConsumption),
        0,
      );
      const allocatedNonMetered = groupAllocations.reduce(
        (sum, item) => sum + numberValue(item.AllocatedNonMeteredConsumption),
        0,
      );
      const allocatedDerived = groupAllocations.reduce(
        (sum, item) => sum + numberValue(item.AllocatedDerivedConsumption),
        0,
      );
      const groupUnallocatedMeters = unallocatedMeterItems.filter(
        (item) =>
          firstText(item, "UtilityGroup") === utilityGroup &&
          utility(item.UtilityType) === utilityType,
      );
      const groupPoolContributions = calculationPoolContributions.filter(
        (item) =>
          firstText(item, "UtilityGroup") === utilityGroup &&
          utility(item.UtilityType) === utilityType,
      );
      const calculationExcludedConsumption = groupPoolContributions.reduce(
        (sum, item) =>
          sum + numberValue(item.CalculationExcludedConsumption),
        0,
      );
      const distributedPoolConsumption = groupAllocations
        .filter(
          (item) =>
            firstText(item, "AllocationSource") === "SS_NONMETERED",
        )
        .reduce(
          (sum, item) =>
            sum + numberValue(item.AllocatedNonMeteredConsumption),
          0,
        );
      const unallocatedMetered = groupUnallocatedMeters.reduce(
        (sum, item) => sum + numberValue(item.UnallocatedMeteredConsumption),
        0,
      );
      const allocatedTotal =
        allocatedMetered + allocatedNonMetered + allocatedDerived;
      const sewerPoolAccounting =
        utilityType === "SS"
          ? summarizeSewerNonMeteredPool({
              sourceConsumption,
              allocatedConsumption: allocatedTotal,
              poolContribution: calculationExcludedConsumption,
              distributedPoolConsumption,
              epsilon: EPSILON,
            })
          : null;
      const unallocatedNonMetered = sewerPoolAccounting
        ? sewerPoolAccounting.totalUnallocatedConsumption
        : sourceOverrun
          ? 0
          : Math.abs(distributableNonMeteredPool) > EPSILON &&
                allocatedNonMetered === 0
            ? distributableNonMeteredPool
            : 0;
      const accountedTotal =
        allocatedMetered +
        unallocatedMetered +
        allocatedNonMetered +
        allocatedDerived +
        unallocatedNonMetered;

      // Accounting balance includes explicitly unallocated consumption.
      // It answers whether the full invoice is accounted for, even when some
      // consumption cannot yet be assigned to a customer.
      const accountingDifference = sourceConsumption - accountedTotal;

      // Billing allocation difference: source consumption not yet assigned
      // to customer allocation records.
      const difference = sourceConsumption - allocatedTotal;
      const relatedIssues = structuredIssues.filter(
        (issue) =>
          issue.utilityGroup === utilityGroup &&
          issue.utilityType === utilityType,
      );
      const readiness = evaluateReconciliationBillingStatus({
        accountingDifference,
        allocationDifference: difference,
        unallocatedMetered,
        unallocatedNonMetered,
        invalidInvoiceRows: invoiceBucket?.excludedRows ?? 0,
        issueCount: relatedIssues.length,
      });
      summaryItems.push({
        billing_period_id: billingPeriodId,
        ReconciliationID: `SUMMARY#${safeKeyPart(utilityGroup)}#${safeKeyPart(utilityType)}`,
        RecordType: "SUMMARY",
        FY: fy,
        BillingMonth: billingMonth,
        BillingMonthCode: billingMonthCode,
        UtilityGroup: utilityGroup,
        UtilityType: utilityType,
        ConsumptionUM: reconciliationUnit(
          utilityType,
          invoiceBucket?.units ?? new Set(),
        ),
        InvoiceConsumption: round(invoiceConsumption),
        PlantUnitProduction: round(plantUnitProduction),
        SourceConsumption: round(sourceConsumption),
        MeteredConsumption: round(meteredConsumption),
        // Preserve the original invoice-minus-metered pool for reporting.
        NonMeteredConsumption: round(originalNonMeteredPool),
        PumpingReservedConsumption: round(pumpingReserved),
        DistributableNonMeteredConsumption: round(distributableNonMeteredPool),
        AllocatedMeteredConsumption: round(allocatedMetered),
        UnallocatedMeteredConsumption: round(unallocatedMetered),
        AllocatedNonMeteredConsumption: round(allocatedNonMetered),
        AllocatedDerivedConsumption: round(allocatedDerived),
        UnallocatedNonMeteredConsumption: round(unallocatedNonMetered),
        AllocatedTotalConsumption: round(allocatedTotal),
        AccountedConsumption: round(accountedTotal),
        AccountingDifference: round(accountingDifference),
        Difference: round(difference),
        AccountingStatus: readiness.accountingStatus,
        BillingReady: readiness.billingReady ? 1 : 0,
        UnallocatedMeterCount: groupUnallocatedMeters.length,
        IssueCount: relatedIssues.length,
        Issues: relatedIssues,
        ProjectedUsageTotal: round(projectedTotalByGroupUtility.get(key) ?? 0),
        InvoiceRows: invoiceBucket?.rows ?? 0,
        ExcludedInvoiceRows: invoiceBucket?.excludedRows ?? 0,
        InvalidInvoiceRows: invoiceBucket?.excludedRows ?? 0,
        ChargeOnlyInvoiceRows: invoiceBucket?.chargeOnlyRows ?? 0,
        ChargeOnlyInvoiceAmount: round(invoiceBucket?.chargeOnlyAmount ?? 0),
        MeterCount: meterSources.filter(
          (meter) =>
            meter.utilityGroup === utilityGroup && meter.utilityType === utilityType,
        ).length,
        AllocationRows: groupAllocations.length,
        PoolContributionRows: groupPoolContributions.length,
        CalculationExcludedConsumption: round(
          calculationExcludedConsumption,
        ),
        DistributedPoolConsumption: round(
          sewerPoolAccounting?.distributedPoolConsumption ?? 0,
        ),
        UnresolvedPoolConsumption: round(
          sewerPoolAccounting?.unresolvedPoolConsumption ?? 0,
        ),
        OtherUnallocatedNonMeteredConsumption: round(
          sewerPoolAccounting?.otherUnallocatedConsumption ?? 0,
        ),
        ReconciliationStatus: readiness.reconciliationStatus,
        CreatedDate: createdDate,
      });
    }

    // ----------------------------------------------------------
    // PERSIST RECONCILIATION SNAPSHOT
    //
    // POST is the explicit generate/regenerate action. Once calculation
    // succeeds, the prior billing-period snapshot is replaced with the new
    // SUMMARY, ALLOCATION, and UNALLOCATED_METER records.

    // ----------------------------------------------------------
    const reconciliationRecords = [
      ...summaryItems,
      ...allocationItems,
      ...unallocatedMeterItems,
      ...calculationPoolContributions,
    ];
    if (reconciliationRecords.length === 0) {
      return badRequest("No reconciliation records could be generated.", {
        meterIssues,
        allocationIssues,
      });
    }
    await writeReconciliationSnapshot(
      billingPeriodId,
      existing,
      reconciliationRecords,
    );
    return Response.json({
      ok: true,
      preview: false,
      persisted: true,
      replacedExistingRecordCount: existing.length,
      billingPeriodId,
      generatedAt: createdDate,
      recordCount: reconciliationRecords.length,
      summaryCount: summaryItems.length,
      allocationCount: allocationItems.length,
      unallocatedMeterCount: unallocatedMeterItems.length,
      realPropertySource: realPropertyResult.source,
      realPropertyTable: realPropertyResult.tableName,
      fiscalYear: realPropertyResult.fiscalYear,
      sourceCounts: {
        invoices: invoices.length,
        meterReadings: readings.length,
        includedMeters: meterSources.length,
        propQ: propQRows.length,
        plantUnit: plantUnitRows.length,
        realProperty: rpRows.length,
      },
      issues: {
        meter: meterIssues,
        allocation: allocationIssues,
        structured: structuredIssues,
      },
      summaries: summaryItems,
      allocations: allocationItems,
      unallocatedMeters: unallocatedMeterItems,
    });
  } catch (error) {
    console.error("Reconciliation generation failed:", error);
    return Response.json(
      {
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "Unable to generate monthly reconciliation.",
      },
      { status: 500 },
    );
  }
}
