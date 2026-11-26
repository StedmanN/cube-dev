import {

  QueryCommand,

  ScanCommand,

  type QueryCommandInput,

  type ScanCommandInput,

} from "@aws-sdk/lib-dynamodb";

// Production authentication (disabled until deployment):
import { getAppSession } from "@/lib/app-session";

import { ddb } from "@/lib/dynamo";
import {
  effectiveRealPropertySource,
  normalizeLegacyRealPropertyRecord,
  usesPeriodSnapshot,
} from "@/lib/real-property-effective-core";
import {
  filterActiveRealPropertyRecords,
  getRealPropertyPeriodState,
  logicalMonthlyRpId,
} from "@/lib/real-property-snapshot";

export const dynamic = "force-dynamic";

export const revalidate = 0;

// ============================================================

// TABLES

// ============================================================

const LEGACY_RP_TABLE = "p72-CUBE-RP-LEGACY";

const MONTHLY_RP_TABLE = "p72-CUBE-RP-MONTHLY";

const ESTIMATES_TABLE = "p72-CUBE-ESTIMATES";

const INVOICES_TABLE = "p72-CUBE-INVOICES";

const CUSTOMERS_TABLE = "p72-CUBE-CUSTOMERS";

// ============================================================

// INDEXES

// ============================================================

const BILLING_PERIOD_INDEX = "billing-period-index";

// ============================================================

// REAL PROPERTY EFFECTIVE SOURCE
// Use the immutable annual legacy baseline through BP 181 unless that billing
// period has a month-specific override snapshot. BP 182 onward is monthly RP.

//

// BP 181 and earlier without an override:

//   p72-CUBE-RP-LEGACY

//

// BP 182 and later:

//   p72-CUBE-RP-MONTHLY

//

// September FY26 = BP 182

// August FY26    = BP 181

//

// Legacy Real Property is an ANNUAL FY snapshot. It does not

// contain billing_period_id, so the selected billing period must

// first be converted to its fiscal year.

// ============================================================

const FY26_FIRST_BILLING_PERIOD_ID = 171; // October FY26

const FY26 = 2026;

// ============================================================

// TYPES

// ============================================================

type Item = Record<string, unknown>;

type RealPropertyResult = {

  items: Item[];

  source: "legacy" | "legacy_override" | "monthly";

  tableName: string;

  fiscalYear: number;

};

// ============================================================

// HELPERS

// ============================================================

function text(value: unknown): string {

  return value === undefined || value === null ? "" : String(value).trim();

}

function numeric(value: unknown): number {

  const parsed = Number(text(value).replace(/[$,]/g, ""));

  return Number.isFinite(parsed) ? parsed : 0;

}

function billingPeriodToFiscalYear(billingPeriodId: number): number {

  // BP 171-182 = FY26, BP 159-170 = FY25, BP 183-194 = FY27, etc.

  return FY26 + Math.floor((billingPeriodId - FY26_FIRST_BILLING_PERIOD_ID) / 12);

}

function utilityFlag(value: unknown): number {

  return numeric(value) !== 0 ? 1 : 0;

}

function normalizeLegacyRealProperty(item: Item, billingPeriodId: number): Item {
  return normalizeLegacyRealPropertyRecord(item, { billingPeriodId });
}

function normalizeMonthlyRealProperty(item: Item): Item {

  return {

    ...item,

    StorageMonthlyRPID: item.MonthlyRPID,

    MonthlyRPID: logicalMonthlyRpId(item),

    RecordSource: "monthly",

  };

}

// ============================================================

// QUERY BILLING PERIOD
// Follow LastEvaluatedKey to retrieve every matching GSI page.

// Used for tables that HAVE the billing-period-index GSI.

// ============================================================

async function queryBillingPeriod(

  tableName: string,

  billingPeriodId: number,

): Promise<Item[]> {

  const items: Item[] = [];

  let exclusiveStartKey:

    | QueryCommandInput["ExclusiveStartKey"]

    | undefined;

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

// ============================================================

// LEGACY REAL PROPERTY
// Scan FY-filtered annual records and adapt fields to monthly UI shape.

//

// p72-CUBE-RP-LEGACY contains annual FY snapshots and does NOT

// contain billing_period_id. Every month in a legacy fiscal year

// therefore uses the same annual snapshot for that FY.

// ============================================================

async function loadLegacyRealProperty(

  billingPeriodId: number,

  fiscalYear: number,

): Promise<Item[]> {

  const items: Item[] = [];

  let exclusiveStartKey:

    | ScanCommandInput["ExclusiveStartKey"]

    | undefined;

  do {

    const result = await ddb.send(

      new ScanCommand({

        TableName: LEGACY_RP_TABLE,

        FilterExpression: "#fy = :fy",

        ExpressionAttributeNames: {

          "#fy": "FY",

        },

        ExpressionAttributeValues: {

          ":fy": fiscalYear,

        },

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

// ============================================================

// REAL PROPERTY SOURCE

// ============================================================

async function loadRealProperty(

  billingPeriodId: number,

): Promise<RealPropertyResult> {

  const fiscalYear = billingPeriodToFiscalYear(billingPeriodId);
  const periodState = await getRealPropertyPeriodState(billingPeriodId);
  const source = effectiveRealPropertySource(
    billingPeriodId,
    periodState !== null,
  );

  if (!usesPeriodSnapshot(billingPeriodId, periodState !== null)) {

    const items = await loadLegacyRealProperty(

      billingPeriodId,

      fiscalYear,

    );

    return {

      items,

      source: "legacy",

      tableName: LEGACY_RP_TABLE,

      fiscalYear,

    };

  }

  const items = (
    await queryBillingPeriod(MONTHLY_RP_TABLE, billingPeriodId)
  ).map((item) => ({
    ...normalizeMonthlyRealProperty(item),
    RecordSource: source,
  }));

  return {

    items,

    source,

    tableName: MONTHLY_RP_TABLE,

    fiscalYear,

  };

}

// ============================================================

// UTILITY CONFIGURATION

// ============================================================

const UTILITY_NAMES: Record<string, string> = {

  EL: "Electric",

  NG: "Natural Gas",

  PW: "Produced Water",

  SS: "Sewer",

};

const UTILITIES = ["EL", "NG", "PW", "SS"];

// ============================================================

// GET

// ============================================================

export async function GET(request: Request) {
  // ========================================================
  // PRODUCTION AUTHENTICATION (CURRENTLY DISABLED)
  // ========================================================
  const session = await getAppSession();
  if (!session?.user) {
    return Response.json(
      { ok: false, error: "Unauthorized" },
      { status: 401 },
    );
  }

  try {

    const url = new URL(request.url);

    const raw = url.searchParams.get("billing_period_id")?.trim() ?? "";

    if (!/^\d+$/.test(raw)) {

      return Response.json(

        {

          ok: false,

          error: "billing_period_id is required.",

        },

        { status: 400 },

      );

    }

    const billingPeriodId = Number(raw);

    if (!Number.isSafeInteger(billingPeriodId) || billingPeriodId <= 0) {

      return Response.json(

        {

          ok: false,

          error: "Invalid billing_period_id.",

        },

        { status: 400 },

      );

    }

    // Real Property changes source at BP 182. Estimates and invoices

    // continue to use their billing-period GSIs for every period.

    const [realPropertyResult, estimates, invoices, periodState, customers] = await Promise.all([

      loadRealProperty(billingPeriodId),

      queryBillingPeriod(ESTIMATES_TABLE, billingPeriodId),

      queryBillingPeriod(INVOICES_TABLE, billingPeriodId),

      getRealPropertyPeriodState(billingPeriodId),

      scanAll(CUSTOMERS_TABLE),

    ]);

    const customerDefaults: Record<
      string,
      { customerType: string; reimbursable: boolean }
    > = Object.fromEntries(
      customers
        .map((customer) => [
          text(customer.CustomerID),
          {
            customerType:
              text(customer.CustomerType) || "Non-Reimbursable",
            reimbursable:
              text(customer.CustomerType).toUpperCase() === "REIMBURSABLE",
          },
        ])
        .filter(([customerId]) => Boolean(customerId)),
    );
    const realProperty: Item[] = realPropertyResult.items.map((item): Item => ({
      ...item,
      CustomerType:
        customerDefaults[text(item.CustomerID)]?.customerType ??
        "Non-Reimbursable",
      CustomerReimbursementDefault:
        customerDefaults[text(item.CustomerID)]?.reimbursable ?? false,
    }));

    // ========================================================

    // INVOICE VS ESTIMATE SUMMARY
    // Compare consumption by utility; variance is relative to estimates.

    // ========================================================

    const summary = UTILITIES.map((utility) => {

      const utilityInvoices = invoices.filter(

        (item) => text(item.utility_type_cd).toUpperCase() === utility,

      );

      const utilityEstimates = estimates.filter(

        (item) =>

          text(item.UtilityType ?? item.utility_type_cd).toUpperCase() ===

          utility,

      );

      const invoiceConsumption = utilityInvoices.reduce(

        (sum, item) => sum + numeric(item.consumption),

        0,

      );

      const estimatedConsumption = utilityEstimates.reduce(

        (sum, item) =>

          sum + numeric(item.EstimatedUsage ?? item.estimated_usage),

        0,

      );

      const difference = invoiceConsumption - estimatedConsumption;

      const variancePercent =

        estimatedConsumption !== 0

          ? (difference / estimatedConsumption) * 100

          : null;

      const invoiceUnits = Array.from(

        new Set(

          utilityInvoices

            .map((item) => text(item.consumption_um))

            .filter(Boolean),

        ),

      );

      return {

        utility_type_cd: utility,

        utility_name: UTILITY_NAMES[utility],

        invoice_consumption: invoiceConsumption,

        estimated_consumption: estimatedConsumption,

        difference,

        variance_percent: variancePercent,

        invoice_count: utilityInvoices.length,

        estimate_count: utilityEstimates.length,

        invoice_um: invoiceUnits.join(", "),

      };

    });

    // ========================================================

    // SORT REAL PROPERTY

    // ========================================================

    realProperty.sort((a, b) => {

      const facilityA = text(

        a.FacilityNumber ??

          a.facility_nbr ??

          a.FACILITY_NBR ??

          a.FacilityID,

      );

      const facilityB = text(

        b.FacilityNumber ??

          b.facility_nbr ??

          b.FACILITY_NBR ??

          b.FacilityID,

      );

      const facilityCompare = facilityA.localeCompare(

        facilityB,

        undefined,

        {

          numeric: true,

          sensitivity: "base",

        },

      );

      if (facilityCompare !== 0) return facilityCompare;

      return text(a.CustomerID).localeCompare(

        text(b.CustomerID),

        undefined,

        {

          numeric: true,

          sensitivity: "base",

        },

      );

    });

    return Response.json({

      ok: true,

      billingPeriodId,

      fiscalYear: realPropertyResult.fiscalYear,

      realPropertySource: realPropertyResult.source,

      realPropertyTable: realPropertyResult.tableName,

      legacyBaselinePreserved:
        realPropertyResult.source === "legacy_override",

      realProperty,

      customerDefaults,

      estimates,

      summary,

      counts: {

        realProperty: realProperty.length,

        estimates: estimates.length,

        invoices: invoices.length,

      },

      sourceChangeStatus: periodState
        ? {
            dataVersion: periodState.ActiveDataVersion,
            changedAt: periodState.ChangedAt,
            changedBy: periodState.ChangedBy,
            operation: periodState.ChangeOperation,
            reconciliationPotentiallyStale:
              periodState.ReconciliationPotentiallyStale,
            billsPotentiallyStale: periodState.BillsPotentiallyStale,
          }
        : null,

    });

  } catch (error) {

    console.error("Real Property GET failed:", error);

    return Response.json(

      {

        ok: false,

        error:

          error instanceof Error

            ? error.message

            : "Unable to load Real Property data.",

      },

      { status: 500 },

    );

  }

}
