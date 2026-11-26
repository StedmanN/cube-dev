import {

  QueryCommand,

  ScanCommand,

  type QueryCommandInput,

  type ScanCommandInput,

} from "@aws-sdk/lib-dynamodb";

import { getAppSession } from "@/lib/app-session";
import { ddb } from "@/lib/dynamo";
import { filterActiveRealPropertyRecords } from "@/lib/real-property-snapshot";

export const dynamic = "force-dynamic";

export const revalidate = 0;

// ============================================================

// CUBE TABLES / INDEXES
// Historical invoice consumption and RP estimate areas are used to
// preview next-FY intensity suggestions; this route never saves values.

// ============================================================

const INVOICES_TABLE = "p72-CUBE-INVOICES";

const ESTIMATES_TABLE = "p72-CUBE-ESTIMATES";

const INTENSITY_VALUES_TABLE = "p72-CUBE-INTENSITY-VALUES";

const FY_INDEX = "fy-index";

const BILLING_PERIOD_INDEX = "billing-period-index";

const UTILITIES = ["EL", "NG", "PW", "SS"] as const;

type UtilityType = (typeof UTILITIES)[number];

type Item = Record<string, unknown>;

type IntensityValueRecord = {

  intensityid: string;

  fy: number;

  index: number;

  space_type: string;

  space_type_id: number;

  utility_type_cd: string;

};

type PeriodRow = {

  fy: number;

  billingPeriodId: number;

  utilityType: UtilityType;

  actual: number;

  areaBySpaceType: Map<number, number>;

};

type Suggestion = {

  intensityid: string;

  fy: number;

  utility_type_cd: UtilityType;

  space_type_id: number;

  space_type: string;

  previous_index: number;

  suggested_index: number;

  change_pct: number;

  method: "CALIBRATED" | "CARRY_FORWARD";

  confidence: "HIGH" | "MEDIUM" | "LOW";

  periods_with_area: number;

  // Diagnostic only. Never written to DynamoDB.

  unconstrained_index?: number;

  unconstrained_change_pct?: number;

};

type PeriodDiagnostic = {

  fy: number;

  billingPeriodId: number;

  utilityType: UtilityType;

  actual: number;

  currentEstimate: number;

  suggestedEstimate: number;

  currentErrorPct: number | null;

  suggestedErrorPct: number | null;

  currentVariance: number;

  suggestedVariance: number;

};

type UtilityDiagnostic = {

  utilityType: UtilityType;

  periods: number;

  invoiceTotal: number;

  currentEstimateTotal: number;

  suggestedEstimateTotal: number;

  currentTotalVariance: number;

  suggestedTotalVariance: number;

  currentTotalErrorPct: number | null;

  suggestedTotalErrorPct: number | null;

  currentMape: number | null;

  suggestedMape: number | null;

  improvementPercentagePoints: number | null;

  currentBias: "OVER" | "UNDER" | "BALANCED";

  suggestedBias: "OVER" | "UNDER" | "BALANCED";

};

type BoundaryDiagnostic = {

  intensityid: string;

  utility_type_cd: UtilityType;

  space_type_id: number;

  space_type: string;

  previous_index: number;

  suggested_index: number;

  change_pct: number;

  boundary: "LOWER" | "UPPER";

};

type PwUnconstrainedDiagnostic = {

  space_type_id: number;

  space_type: string;

  previous_index: number;

  constrained_index: number;

  unconstrained_index: number;

  constrained_change_pct: number;

  unconstrained_change_pct: number;

  periods_with_area: number;

};

type PwModelDiagnostic = {

  periods: number;

  invoiceTotal: number;

  currentEstimateTotal: number;

  constrainedEstimateTotal: number;

  unconstrainedEstimateTotal: number;

  currentMape: number | null;

  constrainedMape: number | null;

  unconstrainedMape: number | null;

  currentTotalErrorPct: number | null;

  constrainedTotalErrorPct: number | null;

  unconstrainedTotalErrorPct: number | null;

  currentBias: "OVER" | "UNDER" | "BALANCED";

  constrainedBias: "OVER" | "UNDER" | "BALANCED";

  unconstrainedBias: "OVER" | "UNDER" | "BALANCED";

};

type InvoiceUnitDiagnostic = {

  utilityType: UtilityType;

  consumptionUnit: string;

  rows: number;

  rawConsumptionTotal: number;

  normalizedConsumptionTotal: number | null;

  status: "INCLUDED" | "CONVERTED" | "EXCLUDED";

};

// ============================================================

// SETTINGS

// ============================================================

// A suggested value may move no more than +/- 25% from the

// immediately preceding FY intensity value.

const MAX_ADJUSTMENT = 0.25;

// A space type must appear in at least this many usable billing

// periods before CUBE is allowed to calibrate it.

const MIN_PERIODS_FOR_CALIBRATION = 6;

// Coordinate-descent iterations. The problem is small because

// it is solved independently for EL, NG, PW, and SS.

const MAX_OPTIMIZATION_ITERATIONS = 100;

const CONVERGENCE_TOLERANCE = 1e-10;

// ============================================================

// BASIC HELPERS

// ============================================================

function text(value: unknown): string {

  return value === undefined || value === null

    ? ""

    : String(value).trim();

}

function numberValue(value: unknown): number {

  if (typeof value === "number") {

    return Number.isFinite(value) ? value : 0;

  }

  const parsed = Number(

    text(value).replace(/[$,]/g, ""),

  );

  return Number.isFinite(parsed) ? parsed : 0;

}

function isUtilityType(

  value: string,

): value is UtilityType {

  return (UTILITIES as readonly string[]).includes(value);

}

function roundValue(

  value: number,

  decimals = 8,

): number {

  const factor = 10 ** decimals;

  return Math.round((value + Number.EPSILON) * factor) / factor;

}

function clamp(

  value: number,

  minimum: number,

  maximum: number,

): number {

  return Math.min(maximum, Math.max(minimum, value));

}

// ============================================================

// INVOICE UNIT NORMALIZATION
// Reject unknown units rather than mixing incompatible consumption totals.

//

// The estimate table must be compared to invoice consumption

// in the same units used by the CUBE intensity values.

//

// EL -> KWH

// NG -> MMBTU

// PW -> KGAL

// SS -> KGAL

//

// Unknown units are ignored rather than silently converted.

// ============================================================

function normalizeInvoiceConsumption(

  utilityType: UtilityType,

  consumption: number,

  unitValue: unknown,

): number | null {

  const unit = text(unitValue)

    .toUpperCase()

    .replace(/\s+/g, "");

  if (!Number.isFinite(consumption)) {

    return null;

  }

  if (utilityType === "EL") {

    if (unit === "KWH") return consumption;

    if (unit === "MWH") return consumption * 1000;

    return null;

  }

  if (utilityType === "NG") {

    if (unit === "MMBTU") return consumption;

    if (unit === "MBTU") return consumption;

    if (unit === "THERM" || unit === "THERMS") {

      return consumption * 0.1;

    }

    return null;

  }

  if (utilityType === "PW" || utilityType === "SS") {

    if (unit === "KGAL" || unit === "KGL") {

      return consumption;

    }

    if (unit === "GAL" || unit === "GALLON" || unit === "GALLONS") {

      return consumption / 1000;

    }

    return null;

  }

  return null;

}

function invoiceUnitStatus(

  utilityType: UtilityType,

  unitValue: unknown,

): "INCLUDED" | "CONVERTED" | "EXCLUDED" {

  const unit = text(unitValue).toUpperCase().replace(/\s+/g, "");

  if (utilityType === "EL") {

    if (unit === "KWH") return "INCLUDED";

    if (unit === "MWH") return "CONVERTED";

    return "EXCLUDED";

  }

  if (utilityType === "NG") {

    if (unit === "MMBTU" || unit === "MBTU") return "INCLUDED";

    if (unit === "THERM" || unit === "THERMS") return "CONVERTED";

    return "EXCLUDED";

  }

  if (utilityType === "PW" || utilityType === "SS") {

    if (unit === "KGAL" || unit === "KGL") return "INCLUDED";

    if (unit === "GAL" || unit === "GALLON" || unit === "GALLONS") {

      return "CONVERTED";

    }

    return "EXCLUDED";

  }

  return "EXCLUDED";

}

// ============================================================

// DYNAMODB HELPERS

// ============================================================

async function queryInvoicesByFY(

  fy: number,

): Promise<Item[]> {

  const items: Item[] = [];

  let exclusiveStartKey:

    | QueryCommandInput["ExclusiveStartKey"]

    | undefined;

  do {

    const result = await ddb.send(

      new QueryCommand({

        TableName: INVOICES_TABLE,

        IndexName: FY_INDEX,

        KeyConditionExpression: "#fy = :fy",

        ExpressionAttributeNames: {

          "#fy": "fy",

        },

        ExpressionAttributeValues: {

          ":fy": fy,

        },

        ProjectionExpression: [

          "fy",

          "billing_period_id",

          "utility_type_cd",

          "consumption",

          "consumption_um",

        ].join(", "),

        ExclusiveStartKey: exclusiveStartKey,

      }),

    );

    items.push(...((result.Items ?? []) as Item[]));

    exclusiveStartKey = result.LastEvaluatedKey;

  } while (exclusiveStartKey);

  return items;

}

async function queryEstimatesByBillingPeriod(

  billingPeriodId: number,

): Promise<Item[]> {

  const items: Item[] = [];

  let exclusiveStartKey:

    | QueryCommandInput["ExclusiveStartKey"]

    | undefined;

  do {

    const result = await ddb.send(

      new QueryCommand({

        TableName: ESTIMATES_TABLE,

        IndexName: BILLING_PERIOD_INDEX,

        KeyConditionExpression: "#bp = :bp",

        ExpressionAttributeNames: {

          "#bp": "billing_period_id",

        },

        ExpressionAttributeValues: {

          ":bp": billingPeriodId,

        },

        ProjectionExpression: [

          "billing_period_id",

          "FY",

          "UtilityType",

          "SpaceTypeID",

          "SpaceType",

          "AreaSF",

          "DataVersion",

        ].join(", "),

        ExclusiveStartKey: exclusiveStartKey,

      }),

    );

    items.push(...((result.Items ?? []) as Item[]));

    exclusiveStartKey = result.LastEvaluatedKey;

  } while (exclusiveStartKey);

  return filterActiveRealPropertyRecords(
    ESTIMATES_TABLE,
    billingPeriodId,
    items,
  );

}

async function scanIntensityValues(): Promise<

  IntensityValueRecord[]

> {

  const items: IntensityValueRecord[] = [];

  let exclusiveStartKey:

    | ScanCommandInput["ExclusiveStartKey"]

    | undefined;

  do {

    const result = await ddb.send(

      new ScanCommand({

        TableName: INTENSITY_VALUES_TABLE,

        ProjectionExpression: [

          "intensityid",

          "fy",

          "#index",

          "space_type",

          "space_type_id",

          "utility_type_cd",

        ].join(", "),

        ExpressionAttributeNames: {

          "#index": "index",

        },

        ExclusiveStartKey: exclusiveStartKey,

      }),

    );

    for (const raw of (result.Items ?? []) as Item[]) {

      const utilityType = text(

        raw.utility_type_cd,

      ).toUpperCase();

      const item: IntensityValueRecord = {

        intensityid: text(raw.intensityid),

        fy: numberValue(raw.fy),

        index: numberValue(raw.index),

        space_type: text(raw.space_type),

        space_type_id: numberValue(raw.space_type_id),

        utility_type_cd: utilityType,

      };

      if (

        item.intensityid &&

        Number.isInteger(item.fy) &&

        Number.isInteger(item.space_type_id) &&

        Number.isFinite(item.index)

      ) {

        items.push(item);

      }

    }

    exclusiveStartKey = result.LastEvaluatedKey;

  } while (exclusiveStartKey);

  return items;

}

// ============================================================

// TRAINING DATA

// ============================================================

function fiscalYearWeight(

  fy: number,

  trainingYears: number[],

): number {

  const sorted = [...trainingYears].sort((a, b) => a - b);

  const position = sorted.indexOf(fy);

  if (position < 0) return 1;

  // For the normal 3-FY window:

  // oldest = 0.50

  // middle = 0.75

  // newest = 1.00

  if (sorted.length === 1) return 1;

  if (sorted.length === 2) {

    return position === 0 ? 0.75 : 1;

  }

  const weights = [0.5, 0.75, 1];

  return weights[Math.min(position, 2)];

}

function aggregateInvoices(

  invoiceItems: Item[],

): {

  actualByPeriodUtility: Map<string, number>;

  ignoredUnitRows: number;

  unitDiagnostics: InvoiceUnitDiagnostic[];

} {

  const actualByPeriodUtility = new Map<string, number>();

  const unitGroups = new Map<string, {

    utilityType: UtilityType;

    consumptionUnit: string;

    rows: number;

    rawConsumptionTotal: number;

    normalizedConsumptionTotal: number;

    status: "INCLUDED" | "CONVERTED" | "EXCLUDED";

  }>();

  let ignoredUnitRows = 0;

  for (const item of invoiceItems) {

    const billingPeriodId = numberValue(item.billing_period_id);

    const utilityType = text(item.utility_type_cd).toUpperCase();

    if (

      !Number.isInteger(billingPeriodId) ||

      billingPeriodId <= 0 ||

      !isUtilityType(utilityType)

    ) {

      continue;

    }

    const rawConsumption = numberValue(item.consumption);

    const consumptionUnit =

      text(item.consumption_um).toUpperCase() || "(BLANK)";

    const status = invoiceUnitStatus(utilityType, item.consumption_um);

    const normalized = normalizeInvoiceConsumption(

      utilityType,

      rawConsumption,

      item.consumption_um,

    );

    const diagnosticKey = `${utilityType}#${consumptionUnit}`;

    const group = unitGroups.get(diagnosticKey) ?? {

      utilityType,

      consumptionUnit,

      rows: 0,

      rawConsumptionTotal: 0,

      normalizedConsumptionTotal: 0,

      status,

    };

    group.rows += 1;

    group.rawConsumptionTotal += rawConsumption;

    if (normalized !== null) {

      group.normalizedConsumptionTotal += normalized;

    }

    unitGroups.set(diagnosticKey, group);

    if (normalized === null) {

      ignoredUnitRows += 1;

      continue;

    }

    const key = `${billingPeriodId}#${utilityType}`;

    actualByPeriodUtility.set(

      key,

      (actualByPeriodUtility.get(key) ?? 0) + normalized,

    );

  }

  const unitDiagnostics: InvoiceUnitDiagnostic[] = [...unitGroups.values()]

    .map((item) => ({

      utilityType: item.utilityType,

      consumptionUnit: item.consumptionUnit,

      rows: item.rows,

      rawConsumptionTotal: roundValue(item.rawConsumptionTotal, 8),

      normalizedConsumptionTotal:

        item.status === "EXCLUDED"

          ? null

          : roundValue(item.normalizedConsumptionTotal, 8),

      status: item.status,

    }))

    .sort(

      (a, b) =>

        a.utilityType.localeCompare(b.utilityType) ||

        a.status.localeCompare(b.status) ||

        a.consumptionUnit.localeCompare(b.consumptionUnit),

    );

  return {

    actualByPeriodUtility,

    ignoredUnitRows,

    unitDiagnostics,

  };

}

function aggregateEstimateAreas(

  estimateItems: Item[],

): Map<string, Map<number, number>> {

  const areaByPeriodUtility =

    new Map<string, Map<number, number>>();

  for (const item of estimateItems) {

    const billingPeriodId = numberValue(

      item.billing_period_id,

    );

    const utilityType = text(

      item.UtilityType,

    ).toUpperCase();

    const spaceTypeId = numberValue(

      item.SpaceTypeID,

    );

    const area = numberValue(item.AreaSF);

    if (

      !Number.isInteger(billingPeriodId) ||

      billingPeriodId <= 0 ||

      !isUtilityType(utilityType) ||

      !Number.isInteger(spaceTypeId) ||

      spaceTypeId < 0 ||

      !Number.isFinite(area) ||

      area <= 0

    ) {

      continue;

    }

    const key = `${billingPeriodId}#${utilityType}`;

    let bySpaceType =

      areaByPeriodUtility.get(key);

    if (!bySpaceType) {

      bySpaceType = new Map<number, number>();

      areaByPeriodUtility.set(key, bySpaceType);

    }

    bySpaceType.set(

      spaceTypeId,

      (bySpaceType.get(spaceTypeId) ?? 0) + area,

    );

  }

  return areaByPeriodUtility;

}

// ============================================================

// MODEL / ERROR HELPERS

// ============================================================

function predictPeriod(

  row: PeriodRow,

  values: Map<number, number>,

): number {

  let predicted = 0;

  for (const [

    spaceTypeId,

    area,

  ] of row.areaBySpaceType.entries()) {

    const intensity = values.get(spaceTypeId);

    if (

      intensity !== undefined &&

      Number.isFinite(intensity)

    ) {

      predicted += area * intensity;

    }

  }

  return predicted;

}

function calculateMape(

  rows: PeriodRow[],

  valuesByUtility: Map<

    UtilityType,

    Map<number, number>

  >,

): number | null {

  let weightedError = 0;

  let totalWeight = 0;

  const trainingYears = [

    ...new Set(rows.map((row) => row.fy)),

  ].sort((a, b) => a - b);

  for (const row of rows) {

    if (row.actual <= 0) continue;

    const values =

      valuesByUtility.get(row.utilityType);

    if (!values) continue;

    const predicted =

      predictPeriod(row, values);

    const weight =

      fiscalYearWeight(row.fy, trainingYears);

    weightedError +=

      Math.abs(

        (row.actual - predicted) / row.actual,

      ) * weight;

    totalWeight += weight;

  }

  if (totalWeight === 0) {

    return null;

  }

  return (weightedError / totalWeight) * 100;

}

function percentageError(

  actual: number,

  predicted: number,

): number | null {

  if (!Number.isFinite(actual) || actual <= 0) return null;

  return ((predicted - actual) / actual) * 100;

}

function absolutePercentageError(

  actual: number,

  predicted: number,

): number | null {

  const value = percentageError(actual, predicted);

  return value === null ? null : Math.abs(value);

}

function determineBias(

  actual: number,

  predicted: number,

): "OVER" | "UNDER" | "BALANCED" {

  const error = percentageError(actual, predicted);

  if (error === null || Math.abs(error) <= 5) return "BALANCED";

  return error > 0 ? "OVER" : "UNDER";

}

function buildPeriodDiagnostics(

  rows: PeriodRow[],

  baselineValuesByUtility: Map<UtilityType, Map<number, number>>,

  suggestedValuesByUtility: Map<UtilityType, Map<number, number>>,

): PeriodDiagnostic[] {

  return rows

    .map((row) => {

      const currentValues =

        baselineValuesByUtility.get(row.utilityType);

      const suggestedValues =

        suggestedValuesByUtility.get(row.utilityType);

      const currentEstimate = currentValues

        ? predictPeriod(row, currentValues)

        : 0;

      const suggestedEstimate = suggestedValues

        ? predictPeriod(row, suggestedValues)

        : 0;

      return {

        fy: row.fy,

        billingPeriodId: row.billingPeriodId,

        utilityType: row.utilityType,

        actual: roundValue(row.actual, 8),

        currentEstimate: roundValue(currentEstimate, 8),

        suggestedEstimate: roundValue(suggestedEstimate, 8),

        currentErrorPct:

          row.actual > 0

            ? roundValue(

                absolutePercentageError(

                  row.actual,

                  currentEstimate,

                ) ?? 0,

                2,

              )

            : null,

        suggestedErrorPct:

          row.actual > 0

            ? roundValue(

                absolutePercentageError(

                  row.actual,

                  suggestedEstimate,

                ) ?? 0,

                2,

              )

            : null,

        currentVariance: roundValue(

          currentEstimate - row.actual,

          8,

        ),

        suggestedVariance: roundValue(

          suggestedEstimate - row.actual,

          8,

        ),

      };

    })

    .sort(

      (a, b) =>

        a.fy - b.fy ||

        a.billingPeriodId - b.billingPeriodId ||

        a.utilityType.localeCompare(b.utilityType),

    );

}

function buildUtilityDiagnostics(

  rows: PeriodRow[],

  periodDiagnostics: PeriodDiagnostic[],

  baselineValuesByUtility: Map<UtilityType, Map<number, number>>,

  suggestedValuesByUtility: Map<UtilityType, Map<number, number>>,

): UtilityDiagnostic[] {

  return UTILITIES.map((utilityType) => {

    const utilityRows = rows.filter(

      (row) => row.utilityType === utilityType,

    );

    const utilityPeriods = periodDiagnostics.filter(

      (item) => item.utilityType === utilityType,

    );

    const invoiceTotal = utilityPeriods.reduce(

      (sum, item) => sum + item.actual,

      0,

    );

    const currentEstimateTotal = utilityPeriods.reduce(

      (sum, item) => sum + item.currentEstimate,

      0,

    );

    const suggestedEstimateTotal = utilityPeriods.reduce(

      (sum, item) => sum + item.suggestedEstimate,

      0,

    );

    const currentMape = calculateMape(

      utilityRows,

      baselineValuesByUtility,

    );

    const suggestedMape = calculateMape(

      utilityRows,

      suggestedValuesByUtility,

    );

    return {

      utilityType,

      periods: utilityPeriods.length,

      invoiceTotal: roundValue(invoiceTotal, 8),

      currentEstimateTotal: roundValue(currentEstimateTotal, 8),

      suggestedEstimateTotal: roundValue(

        suggestedEstimateTotal,

        8,

      ),

      currentTotalVariance: roundValue(

        currentEstimateTotal - invoiceTotal,

        8,

      ),

      suggestedTotalVariance: roundValue(

        suggestedEstimateTotal - invoiceTotal,

        8,

      ),

      currentTotalErrorPct:

        invoiceTotal > 0

          ? roundValue(

              absolutePercentageError(

                invoiceTotal,

                currentEstimateTotal,

              ) ?? 0,

              2,

            )

          : null,

      suggestedTotalErrorPct:

        invoiceTotal > 0

          ? roundValue(

              absolutePercentageError(

                invoiceTotal,

                suggestedEstimateTotal,

              ) ?? 0,

              2,

            )

          : null,

      currentMape:

        currentMape === null ? null : roundValue(currentMape, 2),

      suggestedMape:

        suggestedMape === null

          ? null

          : roundValue(suggestedMape, 2),

      improvementPercentagePoints:

        currentMape !== null && suggestedMape !== null

          ? roundValue(currentMape - suggestedMape, 2)

          : null,

      currentBias: determineBias(

        invoiceTotal,

        currentEstimateTotal,

      ),

      suggestedBias: determineBias(

        invoiceTotal,

        suggestedEstimateTotal,

      ),

    };

  }).filter((item) => item.periods > 0);

}

function buildBoundaryDiagnostics(

  suggestions: Suggestion[],

): BoundaryDiagnostic[] {

  const boundaryPct = MAX_ADJUSTMENT * 100;

  const tolerance = 0.02;

  const hits: BoundaryDiagnostic[] = [];

  for (const item of suggestions) {

    if (item.method !== "CALIBRATED") continue;

    let boundary: "LOWER" | "UPPER" | null = null;

    if (Math.abs(item.change_pct - boundaryPct) <= tolerance) {

      boundary = "UPPER";

    } else if (

      Math.abs(item.change_pct + boundaryPct) <= tolerance

    ) {

      boundary = "LOWER";

    }

    if (boundary) {

      hits.push({

        intensityid: item.intensityid,

        utility_type_cd: item.utility_type_cd,

        space_type_id: item.space_type_id,

        space_type: item.space_type,

        previous_index: item.previous_index,

        suggested_index: item.suggested_index,

        change_pct: item.change_pct,

        boundary,

      });

    }

  }

  return hits;

}

// ============================================================

// CONSTRAINED CALIBRATION
// Coordinate descent fits invoice consumption using RP area by space type.
// Production suggestions remain bounded to +/-25% of the prior FY.

//

// Each utility is optimized independently.

//

// Starting point: previous FY intensity values.

// Bounds: +/- 25% from previous FY.

// Recent FYs receive more weight.

// Low-data space types are carried forward unchanged.

// ============================================================

function calibrateUtility(

  utilityType: UtilityType,

  rows: PeriodRow[],

  baselineRecords: IntensityValueRecord[],

  trainingYears: number[],

): {

  suggestions: Suggestion[];

  baselineValues: Map<number, number>;

  suggestedValues: Map<number, number>;

  unconstrainedValues: Map<number, number>;

} {

  const records = baselineRecords

    .filter(

      (item) =>

        item.utility_type_cd.toUpperCase() ===

        utilityType,

    )

    .sort(

      (a, b) =>

        a.space_type_id - b.space_type_id,

    );

  const baselineValues =

    new Map<number, number>();

  const suggestedValues =

    new Map<number, number>();

  const unconstrainedValues =

    new Map<number, number>();

  for (const record of records) {

    baselineValues.set(

      record.space_type_id,

      record.index,

    );

    suggestedValues.set(

      record.space_type_id,

      record.index,

    );

    unconstrainedValues.set(

      record.space_type_id,

      record.index,

    );

  }

  const periodsWithArea =

    new Map<number, number>();

  for (const record of records) {

    const count = rows.filter(

      (row) =>

        (row.areaBySpaceType.get(

          record.space_type_id,

        ) ?? 0) > 0,

    ).length;

    periodsWithArea.set(

      record.space_type_id,

      count,

    );

  }

  const calibratableIds = records

    .filter(

      (record) =>

        record.index > 0 &&

        (periodsWithArea.get(

          record.space_type_id,

        ) ?? 0) >=

          MIN_PERIODS_FOR_CALIBRATION,

    )

    .map((record) => record.space_type_id);

  for (

    let iteration = 0;

    iteration < MAX_OPTIMIZATION_ITERATIONS;

    iteration += 1

  ) {

    let largestChange = 0;

    for (const spaceTypeId of calibratableIds) {

      const baseline =

        baselineValues.get(spaceTypeId) ?? 0;

      const minimum =

        Math.max(0, baseline * (1 - MAX_ADJUSTMENT));

      const maximum =

        baseline * (1 + MAX_ADJUSTMENT);

      let numerator = 0;

      let denominator = 0;

      for (const row of rows) {

        if (row.actual <= 0) continue;

        const area =

          row.areaBySpaceType.get(spaceTypeId) ??

          0;

        if (area <= 0) continue;

        let predictionWithoutCurrent = 0;

        for (const [

          otherSpaceTypeId,

          otherArea,

        ] of row.areaBySpaceType.entries()) {

          if (otherSpaceTypeId === spaceTypeId) {

            continue;

          }

          predictionWithoutCurrent +=

            otherArea *

            (suggestedValues.get(

              otherSpaceTypeId,

            ) ??

              baselineValues.get(

                otherSpaceTypeId,

              ) ??

              0);

        }

        const weight =

          fiscalYearWeight(

            row.fy,

            trainingYears,

          );

        numerator +=

          weight *

          area *

          (row.actual -

            predictionWithoutCurrent);

        denominator +=

          weight * area * area;

      }

      if (denominator <= 0) continue;

      const unconstrained =

        numerator / denominator;

      const nextValue = clamp(

        unconstrained,

        minimum,

        maximum,

      );

      const previous =

        suggestedValues.get(spaceTypeId) ??

        baseline;

      largestChange = Math.max(

        largestChange,

        Math.abs(nextValue - previous),

      );

      suggestedValues.set(

        spaceTypeId,

        nextValue,

      );

    }

    if (

      largestChange <

      CONVERGENCE_TOLERANCE

    ) {

      break;

    }

  }

  // ============================================================

  // PW UNCONSTRAINED DIAGNOSTIC TEST

  //

  // Production suggestions remain constrained to +/-25%.

  // This second PW-only pass removes that percentage boundary so

  // we can measure how well the existing area-based model can fit

  // Produced Water invoices.

  //

  // Diagnostic only: these values are NOT saved to DynamoDB.

  // ============================================================

  if (utilityType === "PW") {

    for (

      let iteration = 0;

      iteration < MAX_OPTIMIZATION_ITERATIONS;

      iteration += 1

    ) {

      let largestChange = 0;

      for (const spaceTypeId of calibratableIds) {

        const baseline =

          baselineValues.get(spaceTypeId) ?? 0;

        let numerator = 0;

        let denominator = 0;

        for (const row of rows) {

          if (row.actual <= 0) continue;

          const area =

            row.areaBySpaceType.get(spaceTypeId) ?? 0;

          if (area <= 0) continue;

          let predictionWithoutCurrent = 0;

          for (const [

            otherSpaceTypeId,

            otherArea,

          ] of row.areaBySpaceType.entries()) {

            if (otherSpaceTypeId === spaceTypeId) {

              continue;

            }

            predictionWithoutCurrent +=

              otherArea *

              (

                unconstrainedValues.get(otherSpaceTypeId) ??

                baselineValues.get(otherSpaceTypeId) ??

                0

              );

          }

          const weight =

            fiscalYearWeight(

              row.fy,

              trainingYears,

            );

          numerator +=

            weight *

            area *

            (row.actual - predictionWithoutCurrent);

          denominator +=

            weight * area * area;

        }

        if (denominator <= 0) continue;

        // Intensity cannot be negative. There is intentionally no

        // +/- percentage adjustment limit in this diagnostic pass.

        const nextValue =

          Math.max(0, numerator / denominator);

        const previous =

          unconstrainedValues.get(spaceTypeId) ??

          baseline;

        largestChange = Math.max(

          largestChange,

          Math.abs(nextValue - previous),

        );

        unconstrainedValues.set(

          spaceTypeId,

          nextValue,

        );

      }

      if (

        largestChange <

        CONVERGENCE_TOLERANCE

      ) {

        break;

      }

    }

  }

  const suggestions: Suggestion[] =

    records.map((record) => {

      const periods =

        periodsWithArea.get(

          record.space_type_id,

        ) ?? 0;

      const canCalibrate =

        record.index > 0 &&

        periods >= MIN_PERIODS_FOR_CALIBRATION;

      const rawSuggested = canCalibrate

        ? suggestedValues.get(

            record.space_type_id,

          ) ?? record.index

        : record.index;

      const suggestedIndex =

        roundValue(rawSuggested, 8);

      const previousIndex =

        roundValue(record.index, 8);

      const changePct =

        previousIndex === 0

          ? 0

          : roundValue(

              ((suggestedIndex -

                previousIndex) /

                previousIndex) *

                100,

              2,

            );

      let confidence:

        | "HIGH"

        | "MEDIUM"

        | "LOW" = "LOW";

      if (canCalibrate && periods >= 18) {

        confidence = "HIGH";

      } else if (canCalibrate) {

        confidence = "MEDIUM";

      }

      const unconstrainedIndex =

        utilityType === "PW" && canCalibrate

          ? roundValue(

              unconstrainedValues.get(record.space_type_id) ??

                record.index,

              8,

            )

          : undefined;

      const unconstrainedChangePct =

        unconstrainedIndex !== undefined &&

        previousIndex !== 0

          ? roundValue(

              ((unconstrainedIndex - previousIndex) /

                previousIndex) *

                100,

              2,

            )

          : undefined;

      return {

        intensityid: `${record.fy + 1}#${utilityType}#${record.space_type_id}`,

        fy: record.fy + 1,

        utility_type_cd: utilityType,

        space_type_id: record.space_type_id,

        space_type: record.space_type,

        previous_index: previousIndex,

        suggested_index: suggestedIndex,

        change_pct: changePct,

        method: canCalibrate

          ? "CALIBRATED"

          : "CARRY_FORWARD",

        confidence,

        periods_with_area: periods,

        ...(utilityType === "PW"

          ? {

              unconstrained_index:

                unconstrainedIndex,

              unconstrained_change_pct:

                unconstrainedChangePct,

            }

          : {}),

      };

    });

  return {

    suggestions,

    baselineValues,

    suggestedValues,

    unconstrainedValues,

  };

}

// ============================================================

// POST

//

// Body:

// {

//   "targetFy": 2027

// }

//

// This route ONLY generates a preview.

// It never writes intensity values to DynamoDB.

//

// IMPORTANT:

// If even one intensity value already exists for targetFy,

// generation is blocked.

// ============================================================

export async function POST(

  request: Request,

) {

  try {

    // Production authentication - uncomment the auth import and block.
    const session = await getAppSession();
    if (!session?.user) {
      return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }

    const body = (await request.json()) as {

      targetFy?: unknown;

    };

    const targetFy = numberValue(

      body.targetFy,

    );

    if (

      !Number.isInteger(targetFy) ||

      targetFy < 2000 ||

      targetFy > 2200

    ) {

      return Response.json(

        {

          ok: false,

          error:

            "targetFy must be a valid fiscal year.",

        },

        { status: 400 },

      );

    }

    const allIntensityValues =

      await scanIntensityValues();

    // --------------------------------------------------------

    // NEW FY ONLY

    // --------------------------------------------------------

    const targetFyExists =

      allIntensityValues.some(

        (item) => item.fy === targetFy,

      );

    if (targetFyExists) {

      return Response.json(

        {

          ok: false,

          error:

            `FY${targetFy} already has intensity values. ` +

            "Suggested values can only be generated for a new fiscal year.",

        },

        { status: 409 },

      );

    }

    const baselineFy = targetFy - 1;

    const baselineRecords =

      allIntensityValues.filter(

        (item) => item.fy === baselineFy,

      );

    if (baselineRecords.length === 0) {

      return Response.json(

        {

          ok: false,

          error:

            `FY${baselineFy} intensity values were not found. ` +

            `CUBE needs the previous FY as the baseline for FY${targetFy}.`,

        },

        { status: 400 },

      );

    }

    // --------------------------------------------------------

    // TRAINING WINDOW

    //

    // Use up to the three FYs immediately before the target FY.

    // Years with no usable invoice records are automatically

    // excluded below.

    // --------------------------------------------------------

    const candidateTrainingYears = [

      targetFy - 3,

      targetFy - 2,

      targetFy - 1,

    ];

    const invoiceResults =

      await Promise.all(

        candidateTrainingYears.map(

          async (fy) => ({

            fy,

            items: await queryInvoicesByFY(fy),

          }),

        ),

      );

    const invoiceItems =

      invoiceResults.flatMap(

        (result) => result.items,

      );

    const {

      actualByPeriodUtility,

      ignoredUnitRows,

      unitDiagnostics,

    } = aggregateInvoices(invoiceItems);

    if (actualByPeriodUtility.size === 0) {

      return Response.json(

        {

          ok: false,

          error:

            "No usable invoice consumption was found in the historical training window.",

        },

        { status: 400 },

      );

    }

    // Determine which FYs actually contributed invoice data.

    const billingPeriodToFy =

      new Map<number, number>();

    for (const result of invoiceResults) {

      for (const item of result.items) {

        const bp = numberValue(

          item.billing_period_id,

        );

        if (

          Number.isInteger(bp) &&

          bp > 0

        ) {

          billingPeriodToFy.set(

            bp,

            result.fy,

          );

        }

      }

    }

    const billingPeriodIds = [

      ...billingPeriodToFy.keys(),

    ].sort((a, b) => a - b);

    // --------------------------------------------------------

    // LOAD ESTIMATES BY BILLING PERIOD

    //

    // This intentionally uses billing-period-index instead of

    // scanning the large p72-CUBE-ESTIMATES table.

    // --------------------------------------------------------

    const estimateResults =

      await Promise.all(

        billingPeriodIds.map(

          async (billingPeriodId) => ({

            billingPeriodId,

            items:

              await queryEstimatesByBillingPeriod(

                billingPeriodId,

              ),

          }),

        ),

      );

    const estimateItems =

      estimateResults.flatMap(

        (result) => result.items,

      );

    const areaByPeriodUtility =

      aggregateEstimateAreas(

        estimateItems,

      );

    // --------------------------------------------------------

    // BUILD USABLE PERIOD ROWS

    // --------------------------------------------------------

    const rows: PeriodRow[] = [];

    for (const [

      key,

      actual,

    ] of actualByPeriodUtility.entries()) {

      const [bpText, utilityText] =

        key.split("#");

      const billingPeriodId =

        Number(bpText);

      const utilityType =

        utilityText as UtilityType;

      const fy =

        billingPeriodToFy.get(

          billingPeriodId,

        );

      const areaBySpaceType =

        areaByPeriodUtility.get(key);

      // Zero actuals are not useful for percentage-error

      // calibration. Periods with no RP/estimate area are also

      // excluded.

      if (

        !fy ||

        actual <= 0 ||

        !areaBySpaceType ||

        areaBySpaceType.size === 0

      ) {

        continue;

      }

      rows.push({

        fy,

        billingPeriodId,

        utilityType,

        actual,

        areaBySpaceType,

      });

    }

    if (rows.length === 0) {

      return Response.json(

        {

          ok: false,

          error:

            "Invoices were found, but no billing periods had both usable invoice consumption and matching estimate area.",

        },

        { status: 400 },

      );

    }

    const trainingYears = [

      ...new Set(

        rows.map((row) => row.fy),

      ),

    ].sort((a, b) => a - b);

    // --------------------------------------------------------

    // CALIBRATE EACH UTILITY INDEPENDENTLY

    // --------------------------------------------------------

    const suggestions: Suggestion[] = [];

    const baselineValuesByUtility =

      new Map<

        UtilityType,

        Map<number, number>

      >();

    const suggestedValuesByUtility =

      new Map<

        UtilityType,

        Map<number, number>

      >();

    const unconstrainedValuesByUtility =

      new Map<

        UtilityType,

        Map<number, number>

      >();

    for (const utilityType of UTILITIES) {

      const utilityRows =

        rows.filter(

          (row) =>

            row.utilityType ===

            utilityType,

        );

      const result = calibrateUtility(

        utilityType,

        utilityRows,

        baselineRecords,

        trainingYears,

      );

      suggestions.push(

        ...result.suggestions.map(

          (suggestion) => ({

            ...suggestion,

            fy: targetFy,

            intensityid:

              `${targetFy}#${suggestion.utility_type_cd}#${suggestion.space_type_id}`,

          }),

        ),

      );

      baselineValuesByUtility.set(

        utilityType,

        result.baselineValues,

      );

      suggestedValuesByUtility.set(

        utilityType,

        result.suggestedValues,

      );

      unconstrainedValuesByUtility.set(

        utilityType,

        result.unconstrainedValues,

      );

    }

    if (suggestions.length === 0) {

      return Response.json(

        {

          ok: false,

          error:

            `FY${baselineFy} does not contain usable EL, NG, PW, or SS intensity records.`,

        },

        { status: 400 },

      );

    }

    // --------------------------------------------------------

    // MODEL PERFORMANCE

    // --------------------------------------------------------

    const currentMape =

      calculateMape(

        rows,

        baselineValuesByUtility,

      );

    const suggestedMape =

      calculateMape(

        rows,

        suggestedValuesByUtility,

      );

    const improvement =

      currentMape !== null &&

      suggestedMape !== null

        ? currentMape - suggestedMape

        : null;

    const calibratedCount =

      suggestions.filter(

        (item) =>

          item.method === "CALIBRATED",

      ).length;

    const carryForwardCount =

      suggestions.length -

      calibratedCount;

    const usableBillingPeriods =

      new Set(

        rows.map(

          (row) => row.billingPeriodId,

        ),

      ).size;

    // --------------------------------------------------------

    // CALIBRATION DIAGNOSTICS

    // --------------------------------------------------------

    const periodDiagnostics = buildPeriodDiagnostics(

      rows,

      baselineValuesByUtility,

      suggestedValuesByUtility,

    );

    const utilityDiagnostics = buildUtilityDiagnostics(

      rows,

      periodDiagnostics,

      baselineValuesByUtility,

      suggestedValuesByUtility,

    );

    const boundaryDiagnostics =

      buildBoundaryDiagnostics(suggestions);

    // ============================================================

    // PW UNCONSTRAINED MODEL DIAGNOSTICS

    // ============================================================

    const pwRows =

      rows.filter(

        (row) => row.utilityType === "PW",

      );

    const pwBaselineValues =

      baselineValuesByUtility.get("PW") ??

      new Map<number, number>();

    const pwConstrainedValues =

      suggestedValuesByUtility.get("PW") ??

      new Map<number, number>();

    const pwUnconstrainedValues =

      unconstrainedValuesByUtility.get("PW") ??

      new Map<number, number>();

    const pwInvoiceTotal =

      pwRows.reduce(

        (sum, row) => sum + row.actual,

        0,

      );

    const pwCurrentEstimateTotal =

      pwRows.reduce(

        (sum, row) =>

          sum +

          predictPeriod(row, pwBaselineValues),

        0,

      );

    const pwConstrainedEstimateTotal =

      pwRows.reduce(

        (sum, row) =>

          sum +

          predictPeriod(row, pwConstrainedValues),

        0,

      );

    const pwUnconstrainedEstimateTotal =

      pwRows.reduce(

        (sum, row) =>

          sum +

          predictPeriod(row, pwUnconstrainedValues),

        0,

      );

    const pwCurrentMape =

      calculateMape(

        pwRows,

        new Map<UtilityType, Map<number, number>>([

          ["PW", pwBaselineValues],

        ]),

      );

    const pwConstrainedMape =

      calculateMape(

        pwRows,

        new Map<UtilityType, Map<number, number>>([

          ["PW", pwConstrainedValues],

        ]),

      );

    const pwUnconstrainedMape =

      calculateMape(

        pwRows,

        new Map<UtilityType, Map<number, number>>([

          ["PW", pwUnconstrainedValues],

        ]),

      );

    const pwModelDiagnostic: PwModelDiagnostic = {

      periods: pwRows.length,

      invoiceTotal:

        roundValue(pwInvoiceTotal, 8),

      currentEstimateTotal:

        roundValue(pwCurrentEstimateTotal, 8),

      constrainedEstimateTotal:

        roundValue(pwConstrainedEstimateTotal, 8),

      unconstrainedEstimateTotal:

        roundValue(pwUnconstrainedEstimateTotal, 8),

      currentMape:

        pwCurrentMape === null

          ? null

          : roundValue(pwCurrentMape, 2),

      constrainedMape:

        pwConstrainedMape === null

          ? null

          : roundValue(pwConstrainedMape, 2),

      unconstrainedMape:

        pwUnconstrainedMape === null

          ? null

          : roundValue(pwUnconstrainedMape, 2),

      currentTotalErrorPct:

        pwInvoiceTotal > 0

          ? roundValue(

              absolutePercentageError(

                pwInvoiceTotal,

                pwCurrentEstimateTotal,

              ) ?? 0,

              2,

            )

          : null,

      constrainedTotalErrorPct:

        pwInvoiceTotal > 0

          ? roundValue(

              absolutePercentageError(

                pwInvoiceTotal,

                pwConstrainedEstimateTotal,

              ) ?? 0,

              2,

            )

          : null,

      unconstrainedTotalErrorPct:

        pwInvoiceTotal > 0

          ? roundValue(

              absolutePercentageError(

                pwInvoiceTotal,

                pwUnconstrainedEstimateTotal,

              ) ?? 0,

              2,

            )

          : null,

      currentBias:

        determineBias(

          pwInvoiceTotal,

          pwCurrentEstimateTotal,

        ),

      constrainedBias:

        determineBias(

          pwInvoiceTotal,

          pwConstrainedEstimateTotal,

        ),

      unconstrainedBias:

        determineBias(

          pwInvoiceTotal,

          pwUnconstrainedEstimateTotal,

        ),

    };

    const pwUnconstrainedSuggestions: PwUnconstrainedDiagnostic[] =

      suggestions

        .filter(

          (item) =>

            item.utility_type_cd === "PW",

        )

        .map((item) => ({

          space_type_id:

            item.space_type_id,

          space_type:

            item.space_type,

          previous_index:

            item.previous_index,

          constrained_index:

            item.suggested_index,

          unconstrained_index:

            item.unconstrained_index ??

            item.previous_index,

          constrained_change_pct:

            item.change_pct,

          unconstrained_change_pct:

            item.unconstrained_change_pct ??

            0,

          periods_with_area:

            item.periods_with_area,

        }));

    const worstPeriods = [...periodDiagnostics]

      .sort(

        (a, b) =>

          (b.suggestedErrorPct ?? -1) -

          (a.suggestedErrorPct ?? -1),

      )

      .slice(0, 20);

    return Response.json({

      ok: true,

      targetFy,

      baselineFy,

      trainingYears,

      settings: {

        maximumAdjustmentPct:

          MAX_ADJUSTMENT * 100,

        minimumPeriodsForCalibration:

          MIN_PERIODS_FOR_CALIBRATION,

      },

      summary: {

        billingPeriodsAnalyzed:

          usableBillingPeriods,

        invoicePeriodUtilityPairs:

          rows.length,

        ignoredInvoiceRowsUnknownUnit:

          ignoredUnitRows,

        currentModelMape:

          currentMape === null

            ? null

            : roundValue(

                currentMape,

                2,

              ),

        suggestedModelMape:

          suggestedMape === null

            ? null

            : roundValue(

                suggestedMape,

                2,

              ),

        improvementPercentagePoints:

          improvement === null

            ? null

            : roundValue(

                improvement,

                2,

              ),

        totalSuggestions:

          suggestions.length,

        calibratedSuggestions:

          calibratedCount,

        carryForwardSuggestions:

          carryForwardCount,

      },

      diagnostics: {

        utilities: utilityDiagnostics,

        periods: periodDiagnostics,

        worstPeriods,

        boundaryHits: boundaryDiagnostics,

        boundaryHitCount: boundaryDiagnostics.length,

        ignoredInvoiceRowsUnknownUnit: ignoredUnitRows,

        invoiceUnits: unitDiagnostics,

        pwUnconstrainedTest: {

          model: pwModelDiagnostic,

          intensities:

            pwUnconstrainedSuggestions,

        },

        zeroBaselineCarryForwardCount: suggestions.filter(

          (item) =>

            item.previous_index === 0 &&

            item.method === "CARRY_FORWARD",

        ).length,

      },

      suggestions: suggestions.sort(

        (a, b) =>

          a.space_type_id -

            b.space_type_id ||

          a.utility_type_cd.localeCompare(

            b.utility_type_cd,

          ),

      ),

    });

  } catch (error) {

    console.error(

      "Generate intensity suggestions failed:",

      error,

    );

    return Response.json(

      {

        ok: false,

        error:

          error instanceof Error

            ? error.message

            : "Unable to generate suggested intensity values.",

      },

      { status: 500 },

    );

  }

}
