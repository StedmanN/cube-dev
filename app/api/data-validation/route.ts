// app/api/data-validation/route.ts
import {
  QueryCommand,
  ScanCommand,
  UpdateCommand,
  type QueryCommandInput,
  type ScanCommandInput,
} from "@aws-sdk/lib-dynamodb";
import { NextRequest, NextResponse } from "next/server";
import { getAppSession } from "@/lib/app-session";
import { ddb } from "@/lib/dynamo";
export const dynamic = "force-dynamic";
const READINGS_TABLE = "p72-CUBE-METER-READINGS";
const METERS_TABLE = "p72-CUBE-METERS";
const INV_READ_METHODS_TABLE = "p72-CUBE-INV-READ-METHODS";
const CORRECTION_RULES_TABLE = "p72-CUBE-METER-CORRECTION-RULES";
const BILLING_PERIOD_INDEX = "billing-period-index";
const FY_INDEX = "fy-index";
// A reading requires review only when both prior-year and prior-month comparisons fail.
const DEVIATION_THRESHOLD_PERCENT = 50;
// Keep DIVA recalculation consistent with the Manual importer.
const MANUAL_READING_TOLERANCE = 0.5;
const ROLLOVER_HIGH_BOUNDARY = 0.90;
const ROLLOVER_LOW_BOUNDARY = 0.10;
const RULE_PREVIOUS_MONTH = "READING_PREV_MONTH_50";
const RULE_PREVIOUS_YEAR = "READING_PREV_YEAR_50";
type Item = Record<string, unknown>;
function text(value: unknown) {
  return value === undefined || value === null ? "" : String(value).trim();
}
function numeric(value: unknown): number | null {
  if (value === undefined || value === null || text(value) === "") return null;
  const parsed = Number(String(value).replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}
function validationRules(item: Item) {
  return Array.isArray(item.validation_rule_ids)
    ? item.validation_rule_ids.map(text).filter(Boolean)
    : [];
}
function isValidationRequired(item: Item) {
  return numeric(item.validation_required) === 1;
}
function isAutoCorrected(item: Item) {
  return (
    text(item.validation_status).toUpperCase() === "AUTO_CORRECTED" ||
    numeric(item.validation_auto_corrected) === 1
  );
}
function isBulkCorrected(item: Item) {
  return text(item.validation_status).toUpperCase() === "BULK_CORRECTED";
}
function isDivaReportItem(item: Item) {
  // Display only historically Used meters; unknown legacy statuses remain
  // visible until separately classified, so exceptions are not hidden.
  if (numeric(item.used_before_validation) === 0) return false;
  return isValidationRequired(item) || isAutoCorrected(item) || isBulkCorrected(item);
}
function effectiveConsumption(item: Item | undefined) {
  if (!item) return null;
  const adjusted = numeric(item.adjusted_consumption);
  return adjusted !== null ? adjusted : numeric(item.consumption);
}
// Query only the selected year; the FY index already projects all attributes.
async function queryFiscalYear(fy: number): Promise<Item[]> {
  const items: Item[] = [];
  let ExclusiveStartKey: QueryCommandInput["ExclusiveStartKey"];
  do {
    const result = await ddb.send(new QueryCommand({
      TableName: READINGS_TABLE,
      IndexName: FY_INDEX,
      KeyConditionExpression: "#fy = :fy",
      ExpressionAttributeNames: { "#fy": "fy" },
      ExpressionAttributeValues: { ":fy": fy },
      ExclusiveStartKey,
    }));
    items.push(...((result.Items ?? []) as Item[]));
    ExclusiveStartKey = result.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

// A one-item FY index query discovers a populated year without reading its
// readings. Cache the list briefly so switching years does not repeat discovery.
let yearListCache: { expiresAt: number; years: number[] } | null = null;
async function availableFiscalYears(selectedYear: number): Promise<number[]> {
  const now = Date.now();
  if (yearListCache && yearListCache.expiresAt > now) {
    return Array.from(new Set([...yearListCache.years, selectedYear, new Date().getFullYear()])).sort((a, b) => b - a);
  }
  const currentYear = new Date().getFullYear();
  const candidates = Array.from({ length: currentYear - 1999 + 2 }, (_, index) => 2000 + index);
  const years: number[] = [];
  // Bound concurrent requests so discovery does not swamp DynamoDB Local.
  for (let offset = 0; offset < candidates.length; offset += 8) {
    const found = await Promise.all(candidates.slice(offset, offset + 8).map(async (fy) => {
      const result = await ddb.send(new QueryCommand({
        TableName: READINGS_TABLE,
        IndexName: FY_INDEX,
        KeyConditionExpression: "#fy = :fy",
        ExpressionAttributeNames: { "#fy": "fy" },
        ExpressionAttributeValues: { ":fy": fy },
        ProjectionExpression: "fy",
        Limit: 1,
      }));
      return result.Items?.length ? fy : null;
    }));
    years.push(...found.filter((fy): fy is number => fy !== null));
  }
  yearListCache = { expiresAt: now + 5 * 60_000, years };
  return Array.from(new Set([...years, selectedYear, currentYear])).sort((a, b) => b - a);
}
async function scanTable(tableName: string): Promise<Item[]> {
  const items: Item[] = [];
  let ExclusiveStartKey: ScanCommandInput["ExclusiveStartKey"];
  do {
    const result = await ddb.send(
      new ScanCommand({ TableName: tableName, ExclusiveStartKey }),
    );
    items.push(...((result.Items ?? []) as Item[]));
    ExclusiveStartKey = result.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}
// Query the billing-period GSI and follow DynamoDB pagination.
async function queryBillingPeriod(billingPeriodId: number): Promise<Item[]> {
  const items: Item[] = [];
  let ExclusiveStartKey: QueryCommandInput["ExclusiveStartKey"];
  do {
    const result = await ddb.send(
      new QueryCommand({
        TableName: READINGS_TABLE,
        IndexName: BILLING_PERIOD_INDEX,
        KeyConditionExpression: "#bp = :bp",
        ExpressionAttributeNames: { "#bp": "billing_period_id" },
        ExpressionAttributeValues: { ":bp": billingPeriodId },
        ExclusiveStartKey,
      }),
    );
    items.push(...((result.Items ?? []) as Item[]));
    ExclusiveStartKey = result.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

// Resolve a billing period from the same fiscal-year/month fields used by
// Monthly Data. This avoids assuming that billing_period_id arithmetic is
// always the same as moving one fiscal year while retaining a legacy fallback
// when an older record does not contain FY/month metadata.
async function findBillingPeriodIdByFiscalMonth(
  fy: number,
  month: string,
): Promise<number | null> {
  let ExclusiveStartKey: QueryCommandInput["ExclusiveStartKey"];

  do {
    const result = await ddb.send(
      new QueryCommand({
        TableName: READINGS_TABLE,
        IndexName: FY_INDEX,
        KeyConditionExpression: "#fy = :fy",
        FilterExpression: "#month = :month",
        ExpressionAttributeNames: {
          "#fy": "fy",
          "#month": "billing_month_nm",
        },
        ExpressionAttributeValues: {
          ":fy": fy,
          ":month": month,
        },
        ProjectionExpression: "billing_period_id",
        ExclusiveStartKey,
      }),
    );

    const match = result.Items?.find((item) => numeric(item.billing_period_id) !== null);
    const billingPeriodId = match ? numeric(match.billing_period_id) : null;
    if (billingPeriodId !== null) return billingPeriodId;

    ExclusiveStartKey = result.LastEvaluatedKey;
  } while (ExclusiveStartKey);

  return null;
}

async function queryPriorYearBillingPeriod(
  currentItems: Item[],
  currentBillingPeriodId: number,
): Promise<Item[]> {
  const current = currentItems.find(
    (item) => numeric(item.fy) !== null && text(item.billing_month_nm),
  );
  const currentFY = current ? numeric(current.fy) : null;
  const currentMonth = current ? text(current.billing_month_nm) : "";

  if (currentFY !== null && currentMonth) {
    const priorYearBillingPeriodId = await findBillingPeriodIdByFiscalMonth(
      currentFY - 1,
      currentMonth,
    );

    if (priorYearBillingPeriodId === null) return [];
    return queryBillingPeriod(priorYearBillingPeriodId);
  }

  return queryBillingPeriod(currentBillingPeriodId - 12);
}
function readingMap(items: Item[]) {
  const map = new Map<string, Item>();
  for (const item of items) {
    const meterid = text(item.meterid);
    if (meterid) map.set(meterid, item);
  }
  return map;
}
function percentageDeviation(currentValue: number, baselineValue: number | null) {
  if (baselineValue === null || !Number.isFinite(currentValue)) return undefined;
  if (baselineValue === 0) return currentValue === 0 ? 0 : undefined;
  return ((currentValue - baselineValue) / Math.abs(baselineValue)) * 100;
}
// Evaluate prior-year first; prior-month is considered only after a year failure.
function evaluateValidation(
  currentConsumption: number,
  previousMonth: Item | undefined,
  priorYear: Item | undefined,
) {
  const ruleIds: string[] = [];
  const previousMonthConsumption = effectiveConsumption(previousMonth);
  const previousYearConsumption = effectiveConsumption(priorYear);
  const previousMonthPct = percentageDeviation(
    currentConsumption,
    previousMonthConsumption,
  );
  const previousYearPct = percentageDeviation(
    currentConsumption,
    previousYearConsumption,
  );
  const yearFailed =
    previousYearPct !== undefined &&
    Math.abs(previousYearPct) >= DEVIATION_THRESHOLD_PERCENT;
  if (yearFailed) ruleIds.push(RULE_PREVIOUS_YEAR);
  const monthFailed =
    yearFailed &&
    previousMonthPct !== undefined &&
    Math.abs(previousMonthPct) >= DEVIATION_THRESHOLD_PERCENT;
  if (monthFailed) ruleIds.push(RULE_PREVIOUS_MONTH);
  const bothFailed = yearFailed && monthFailed;
  return {
    validationRequired: bothFailed ? 1 : 0,
    validationStatus: bothFailed ? "PENDING" : "CLEAR",
    ruleIds,
    previousMonthPct,
    previousYearPct,
    previousYearConsumption,
    bothFailed,
  };
}
const MANUAL_CORRECTION_RULES = new Set(["f", "g", "h", "i", "k", "m"]);
function normalizeRule(rule: unknown) {
  return text(rule).toLowerCase();
}
// Compute supported automatic correction rules; manual-only rules require user input.
function calculateCorrectionRule(
  ruleValue: unknown,
  current: Item,
  previous: Item | undefined,
  previous2: Item | undefined,
  previous3: Item | undefined,
  next: Item | undefined,
  priorYear: Item | undefined,
) {
  const rule = normalizeRule(ruleValue);
  const consumption = numeric(current.consumption);
  if (!rule) {
    return consumption === null
      ? { eligible: false, value: null, reason: "Current consumption is missing." }
      : { eligible: true, value: consumption, reason: "No correction." };
  }
  if (MANUAL_CORRECTION_RULES.has(rule)) {
    return {
      eligible: false,
      value: null,
      reason: `Rule ${rule.toUpperCase()} requires a manual adjusted-consumption value.`,
    };
  }
  const p1 = effectiveConsumption(previous);
  const p2 = effectiveConsumption(previous2);
  const p3 = effectiveConsumption(previous3);
  const n1 = effectiveConsumption(next);
  const py = effectiveConsumption(priorYear);
  switch (rule) {
    case "a":
      return p1 !== null && n1 !== null
        ? { eligible: true, value: (p1 + n1) / 2, reason: "Average previous and next month." }
        : { eligible: false, value: null, reason: "Rule A requires previous and next month." };
    case "b":
      return p1 !== null && p2 !== null && p3 !== null
        ? { eligible: true, value: (p1 + p2 + p3) / 3, reason: "Average previous three months." }
        : { eligible: false, value: null, reason: "Rule B requires the previous three months." };
    case "c":
      return p1 !== null
        ? { eligible: true, value: p1, reason: "Previous month." }
        : { eligible: false, value: null, reason: "Rule C requires previous-month consumption." };
    case "d":
      return n1 !== null
        ? { eligible: true, value: n1, reason: "Next month." }
        : { eligible: false, value: null, reason: "Rule D requires next-month consumption." };
    case "e":
      return py !== null
        ? { eligible: true, value: py, reason: "Same month prior FY." }
        : { eligible: false, value: null, reason: "Rule E requires same-month prior-FY consumption." };
    case "j":
    case "l":
      return { eligible: true, value: 0, reason: `Rule ${rule.toUpperCase()} sets adjusted consumption to 0.` };
    default:
      return {
        eligible: false,
        value: null,
        reason: `Rule ${rule.toUpperCase()} does not have an automatic calculation configured.`,
      };
  }
}
function currentCalendarYear(date = new Date()) {
  return date.getFullYear();
}
function fiscalMonthOrder(month: string) {
  const normalized = month.trim().toUpperCase().slice(0, 3);
  const order: Record<string, number> = {
    OCT: 1,
    NOV: 2,
    DEC: 3,
    JAN: 4,
    FEB: 5,
    MAR: 6,
    APR: 7,
    MAY: 8,
    JUN: 9,
    JUL: 10,
    AUG: 11,
    SEP: 12,
  };
  return order[normalized] ?? 99;
}
// Return only fiscal-year months containing DIVA exceptions.
function periodSummary(items: Item[], selectedFy: number) {
  const periods = new Map<
    number,
    {
      billingPeriodId: number;
      fy: number;
      month: string;
      totalReadings: number;
      deviations: number;
      monthDeviations: number;
      yearDeviations: number;
      autoCorrected: number;
      reviewRequired: number;
    }
  >();
  for (const item of items) {
    // Keep the Total Readings column consistent with Used-only Data Validation.
    if (numeric(item.used_before_validation) === 0) continue;
    const billingPeriodId = numeric(item.billing_period_id);
    const fy = numeric(item.fy);
    const month = text(item.billing_month_nm);
    if (
      billingPeriodId === null ||
      fy === null ||
      !month ||
      fy !== selectedFy
    ) {
      continue;
    }
    let summary = periods.get(billingPeriodId);
    if (!summary) {
      summary = {
        billingPeriodId,
        fy,
        month,
        totalReadings: 0,
        deviations: 0,
        monthDeviations: 0,
        yearDeviations: 0,
        autoCorrected: 0,
        reviewRequired: 0,
      };
      periods.set(billingPeriodId, summary);
    }
    summary.totalReadings++;
    if (isDivaReportItem(item)) {
      summary.deviations++;
      if (isAutoCorrected(item)) summary.autoCorrected++;
      if (isValidationRequired(item)) summary.reviewRequired++;
      const previousMonthPct = numeric(item.validation_prev_month_pct);
      const previousYearPct = numeric(item.validation_prev_year_pct);
      if (
        previousYearPct !== null &&
        Math.abs(previousYearPct) >= DEVIATION_THRESHOLD_PERCENT
      ) {
        summary.yearDeviations++;
      }
      if (
        previousMonthPct !== null &&
        Math.abs(previousMonthPct) >= DEVIATION_THRESHOLD_PERCENT
      ) {
        summary.monthDeviations++;
      }
    }
  }
  // DIVA report: only return months with an automatic correction or an exception requiring review.
  return Array.from(periods.values())
    .filter((period) => period.deviations > 0)
    .sort((a, b) => {
      const monthDifference =
        fiscalMonthOrder(a.month) - fiscalMonthOrder(b.month);
      if (monthDifference !== 0) return monthDifference;
      return a.billingPeriodId - b.billingPeriodId;
    });
}
// GET: Return a fiscal-year summary or detailed exceptions for a billing period.
export async function GET(request: NextRequest) {
  try {
    // ========================================================
    // AUTHENTICATION
    //
    // Authenticate before reading request parameters or accessing
    // meter readings and validation data in DynamoDB.
    // Uncomment the auth import and this block for production.
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

    // REQUEST
    // ========================================================
    const requestedBillingPeriodId = numeric(
      request.nextUrl.searchParams.get("billing_period_id"),
    );
    // Summary reads the validation state already stored by AMR/Manual import.
    // It does not recalculate the deviation rules.
    if (requestedBillingPeriodId === null) {
      const requestedFy = numeric(request.nextUrl.searchParams.get("fy"));
      const selectedFy = requestedFy ?? currentCalendarYear();
      if (!Number.isSafeInteger(selectedFy) || selectedFy < 2000 || selectedFy > currentCalendarYear() + 2) {
        return NextResponse.json({ error: "Invalid year." }, { status: 400 });
      }
      const [readings, fiscalYears] = await Promise.all([
        queryFiscalYear(selectedFy),
        availableFiscalYears(selectedFy),
      ]);
      return NextResponse.json({
        success: true,
        thresholdPercent: DEVIATION_THRESHOLD_PERCENT,
        selectedFy,
        fiscalYears,
        periods: periodSummary(readings, selectedFy),
      });
    }
    const [
      currentItems,
      previousItems,
      previous2Items,
      previous3Items,
      nextItems,
      correctionRuleItems,
    ] = await Promise.all([
      queryBillingPeriod(requestedBillingPeriodId),
      queryBillingPeriod(requestedBillingPeriodId - 1),
      queryBillingPeriod(requestedBillingPeriodId - 2),
      queryBillingPeriod(requestedBillingPeriodId - 3),
      queryBillingPeriod(requestedBillingPeriodId + 1),
      scanTable(CORRECTION_RULES_TABLE),
    ]);
    const priorYearItems = await queryPriorYearBillingPeriod(
      currentItems,
      requestedBillingPeriodId,
    );
    if (currentItems.length === 0) {
      return NextResponse.json(
        { error: `Billing Period ${requestedBillingPeriodId} was not found.` },
        { status: 404 },
      );
    }
    const flaggedItems = currentItems.filter(isDivaReportItem);
    const meterIds = new Set(flaggedItems.map((item) => text(item.meterid)));
    const meterItems = meterIds.size ? await scanTable(METERS_TABLE) : [];
    const meterMap = new Map(
      meterItems
        .filter((item) => meterIds.has(text(item.meterid)))
        .map((item) => [text(item.meterid), item]),
    );
    const previousMap = readingMap(previousItems);
    const previous2Map = readingMap(previous2Items);
    const previous3Map = readingMap(previous3Items);
    const nextMap = readingMap(nextItems);
    const priorYearMap = readingMap(priorYearItems);
    const correctionRules = correctionRuleItems
      .map((item) => ({
        correction_rule_cd: text(
          item.correction_rule_cd ?? item.CORRECTION_RULE_CD,
        ),
        correction_rule_name: text(
          item.correction_rule_name ?? item.CORRECTION_RULE_NAME,
        ),
        correction_rule_description: text(
          item.correction_rule_description ??
            item.CORRECTION_RULE_DESCRIPTION,
        ),
      }))
      .filter((rule) => rule.correction_rule_cd)
      .sort((a, b) =>
        a.correction_rule_cd.localeCompare(
          b.correction_rule_cd,
          undefined,
          { sensitivity: "base" },
        ),
      );
    const rows = flaggedItems
      .map((current) => {
        const meterid = text(current.meterid);
        const master = meterMap.get(meterid);
        const previous = previousMap.get(meterid);
        const previous2 = previous2Map.get(meterid);
        const previous3 = previous3Map.get(meterid);
        const next = nextMap.get(meterid);
        const priorYear = priorYearMap.get(meterid);
        const rules = validationRules(current);
        const previousMonthPercent = numeric(current.validation_prev_month_pct);
        const previousYearPercent = numeric(current.validation_prev_year_pct);
        const yearFlag =
          previousYearPercent !== null &&
          Math.abs(previousYearPercent) >= DEVIATION_THRESHOLD_PERCENT;
        // Rule 2 is part of the sequential review only after Rule 1 fails.
        const monthFlag =
          yearFlag &&
          previousMonthPercent !== null &&
          Math.abs(previousMonthPercent) >= DEVIATION_THRESHOLD_PERCENT;
        const reason =
          monthFlag && yearFlag
            ? "Previous month + prior year"
            : monthFlag
              ? "Previous month"
              : yearFlag
                ? "Prior year"
                : "Validation required";
        return {
          meterid,
          period: text(current.period),
          billingPeriodId: numeric(current.billing_period_id) ?? requestedBillingPeriodId,
          fy: numeric(current.fy) ?? 0,
          month: text(current.billing_month_nm),
          facilityNbr: text(current.facility_nbr) || text(master?.facility_nbr),
          utilityType: text(current.utility_type_cd) || text(master?.utility_type_cd),
          currentReading: numeric(current.reading) ?? 0,
          previousMonthReading: previous ? numeric(previous.reading) : null,
          previousYearReading: priorYear ? numeric(priorYear.reading) : null,
          currentConsumption: effectiveConsumption(current),
          previousMonthConsumption: effectiveConsumption(previous),
          previous2MonthConsumption: effectiveConsumption(previous2),
          previous3MonthConsumption: effectiveConsumption(previous3),
          nextMonthConsumption: effectiveConsumption(next),
          previousYearConsumption: effectiveConsumption(priorYear),
          previousMonthPercent,
          previousYearPercent,
          monthFlag,
          yearFlag,
          reason,
          consumption: numeric(current.consumption),
          adjustedConsumption: numeric(current.adjusted_consumption),
          correctionRule: text(current.meter_correction_rule_cd),
          usedInCalculation: numeric(current.used_in_calculation) ?? 1,
          validationStatus: text(current.validation_status) || "PENDING",
          validationCheckedAt: text(current.validation_checked_at),
          validationRuleIds: rules,
          autoCorrected: isAutoCorrected(current),
          validationAction: text(current.validation_action),
          recommendedCorrectionRule:
            ["AMR_", "MANUAL_"].some((prefix) =>
              text(current.validation_action).toUpperCase().startsWith(prefix),
            )
              ? ""
              : text(current.validation_recommended_correction_rule) ||
                (yearFlag && monthFlag ? "e" : ""),
        };
      })
      .sort((a, b) => {
        const aMagnitude = Math.max(
          Math.abs(a.previousMonthPercent ?? 0),
          Math.abs(a.previousYearPercent ?? 0),
        );
        const bMagnitude = Math.max(
          Math.abs(b.previousMonthPercent ?? 0),
          Math.abs(b.previousYearPercent ?? 0),
        );
        return bMagnitude - aMagnitude;
      });
    const first = currentItems[0];
    const rulesForPeriod = currentItems.filter(isDivaReportItem);
    const evaluatedItems = currentItems.filter(
      (item) => numeric(item.used_before_validation) !== 0,
    );
    const summary = {
      billingPeriodId: requestedBillingPeriodId,
      fy: numeric(first.fy) ?? 0,
      month: text(first.billing_month_nm),
      // Match the "Readings Evaluated" label and exception population:
      // explicit Originally Unused records are not evaluated. Missing legacy
      // history remains included so old exceptions are not hidden.
      totalReadings: evaluatedItems.length,
      deviations: rulesForPeriod.length,
      monthDeviations: rulesForPeriod.filter((item) =>
        validationRules(item).includes(RULE_PREVIOUS_MONTH),
      ).length,
      yearDeviations: rulesForPeriod.filter((item) =>
        validationRules(item).includes(RULE_PREVIOUS_YEAR),
      ).length,
      autoCorrected: rulesForPeriod.filter(isAutoCorrected).length,
      reviewRequired: rulesForPeriod.filter(isValidationRequired).length,
    };
    return NextResponse.json({
      success: true,
      thresholdPercent: DEVIATION_THRESHOLD_PERCENT,
      summary,
      rows,
      correctionRules,
    });
  } catch (error) {
    console.error("Data validation GET failed:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Unable to load data validation.",
      },
      { status: 500 },
    );
  }
}
// PATCH: Apply single-meter corrections or a bulk correction rule.
export async function PATCH(request: NextRequest) {
  try {
    // ========================================================
    // AUTHENTICATION
    //
    // Authenticate before reading request parameters or accessing
    // meter readings and validation data in DynamoDB.
    // Uncomment the auth import and this block for production.
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

    // REQUEST BODY
    // ========================================================
    const body = (await request.json()) as Item;
    if (body.bulk === true) {
      const billingPeriodId = numeric(body.billing_period_id);
      const correctionRule = normalizeRule(body.meter_correction_rule_cd);
      const requestedItems = Array.isArray(body.items) ? (body.items as Item[]) : [];
      if (billingPeriodId === null || !correctionRule || requestedItems.length === 0) {
        return NextResponse.json(
          {
            error:
              "billing_period_id, meter_correction_rule_cd, and at least one bulk item are required.",
          },
          { status: 400 },
        );
      }
      if (MANUAL_CORRECTION_RULES.has(correctionRule)) {
        return NextResponse.json(
          {
            error: `Rule ${correctionRule.toUpperCase()} requires manual values and cannot be bulk calculated.`,
          },
          { status: 400 },
        );
      }
      const [
        currentItems,
        previousItems,
        previous2Items,
        previous3Items,
        nextItems,
      ] = await Promise.all([
        queryBillingPeriod(billingPeriodId),
        queryBillingPeriod(billingPeriodId - 1),
        queryBillingPeriod(billingPeriodId - 2),
        queryBillingPeriod(billingPeriodId - 3),
        queryBillingPeriod(billingPeriodId + 1),
      ]);
      const priorYearItems = await queryPriorYearBillingPeriod(
        currentItems,
        billingPeriodId,
      );
      const currentMap = new Map(
        currentItems.map((item) => [`${text(item.meterid)}::${text(item.period)}`, item]),
      );
      const previousMap = readingMap(previousItems);
      const previous2Map = readingMap(previous2Items);
      const previous3Map = readingMap(previous3Items);
      const nextMap = readingMap(nextItems);
      const priorYearMap = readingMap(priorYearItems);
      const checkedAt = new Date().toISOString();
      let updated = 0;
      const failures: Array<{ meterid: string; period: string; reason: string }> = [];
      for (const requested of requestedItems) {
        const meterid = text(requested.meterid);
        const period = text(requested.period);
        const current = currentMap.get(`${meterid}::${period}`);
        if (!meterid || !period || !current) {
          failures.push({
            meterid,
            period,
            reason: "Reading was not found in this billing period.",
          });
          continue;
        }
        if (!isValidationRequired(current)) {
          failures.push({
            meterid,
            period,
            reason: "Reading no longer requires review.",
          });
          continue;
        }
        const previous = previousMap.get(meterid);
        // DIVA exceptions must be resolved chronologically.
        if (previous && isValidationRequired(previous)) {
          failures.push({
            meterid,
            period,
            reason:
              `Cannot resolve ${text(current.billing_month_nm) || period} for ${meterid} because ` +
              `${text(previous.billing_month_nm) || "the previous billing period"} still requires validation. ` +
              "Resolve the previous billing period first.",
          });
          continue;
        }
        const calculation = calculateCorrectionRule(
          correctionRule,
          current,
          previous,
          previous2Map.get(meterid),
          previous3Map.get(meterid),
          nextMap.get(meterid),
          priorYearMap.get(meterid),
        );
        if (!calculation.eligible || calculation.value === null) {
          failures.push({ meterid, period, reason: calculation.reason });
          continue;
        }
        const adjustedConsumption =
          Math.round(calculation.value * 10000) / 10000;
        // Prefer the original selection; prior months may be quarantined to 0.
        const inheritedUsedInCalculation =
          numeric(current.used_before_validation) ??
          (previous
            ? (numeric(previous.used_before_validation) ?? numeric(previous.used_in_calculation) ?? 1)
            : (numeric(current.used_in_calculation) ?? 0));
        try {
          await ddb.send(
            new UpdateCommand({
              TableName: READINGS_TABLE,
              Key: {
                meterid,
                billing_period_id: billingPeriodId,
              },
              UpdateExpression:
                "SET adjusted_consumption = :adjusted, meter_correction_rule_cd = :rule, used_in_calculation = :used, validation_required = :validationRequired, validation_status = :validationStatus, validation_checked_at = :checkedAt, validation_action = :action, validation_recommended_correction_rule = :recommended",
              ExpressionAttributeValues: {
                ":adjusted": adjustedConsumption,
                ":rule": correctionRule,
                ":used": inheritedUsedInCalculation,
                ":validationRequired": 0,
                ":validationStatus": "BULK_CORRECTED",
                ":checkedAt": checkedAt,
                ":action": `Bulk Rule ${correctionRule.toUpperCase()}`,
                ":recommended": "",
              },
              ConditionExpression:
                "attribute_exists(meterid) AND attribute_exists(billing_period_id)",
            }),
          );
          updated++;
        } catch (error) {
          failures.push({
            meterid,
            period,
            reason: error instanceof Error ? error.message : "Update failed.",
          });
        }
      }
      return NextResponse.json({
        success: failures.length === 0,
        requested: requestedItems.length,
        updated,
        failed: failures.length,
        failures,
        correctionRule,
        validation_status: "BULK_CORRECTED",
        validation_action: `Bulk Rule ${correctionRule.toUpperCase()}`,
        validation_checked_at: checkedAt,
      });
    }
    const meterid = text(body.meterid);
    const period = text(body.period);
    const billingPeriodId = numeric(body.billing_period_id);
    const newReading = numeric(body.reading);
    let adjustedConsumption =
      body.adjusted_consumption === null
        ? null
        : numeric(body.adjusted_consumption);
    const requestedCorrectionRule = text(
      body.meter_correction_rule_cd,
    );
    const requestedUsedInCalculation = numeric(body.used_in_calculation);
    if (
      !meterid ||
      !period ||
      billingPeriodId === null ||
      newReading === null
    ) {
      return NextResponse.json(
        {
          error:
            "meterid, period, billing_period_id, and reading are required.",
        },
        {
          status: 400,
        },
      );
    }
    const [currentItems, previousItems, meterItems, methodItems] =
      await Promise.all([
        queryBillingPeriod(billingPeriodId),
        queryBillingPeriod(billingPeriodId - 1),
        scanTable(METERS_TABLE),
        scanTable(INV_READ_METHODS_TABLE),
      ]);
    const current = currentItems.find(
      (item) => text(item.meterid) === meterid && text(item.period) === period,
    );
    if (!current) {
      return NextResponse.json(
        { error: `Meter reading ${meterid} / ${period} was not found.` },
        { status: 404 },
      );
    }
    const priorYearItems = await queryPriorYearBillingPeriod(
      currentItems,
      billingPeriodId,
    );
    // Rule M lives on the meter-reading record and rolls forward.
    // A blank DIVA submission must not erase the inherited direction rule.
    const inheritedCorrectionRule = text(current.meter_correction_rule_cd);
    const correctionRule =
      requestedCorrectionRule || inheritedCorrectionRule;
    const previous = previousItems.find((item) => text(item.meterid) === meterid);
    const priorYear = priorYearItems.find((item) => text(item.meterid) === meterid);
    if (normalizeRule(correctionRule) === "e") {
      const calculation = calculateCorrectionRule(
        correctionRule,
        current,
        previous,
        undefined,
        undefined,
        undefined,
        priorYear,
      );

      if (!calculation.eligible || calculation.value === null) {
        return NextResponse.json(
          {
            error: calculation.reason,
            code: "RULE_E_HISTORY_REQUIRED",
            meterid,
            billing_period_id: billingPeriodId,
          },
          { status: 422 },
        );
      }

      // Rule E is automatic. The server value is authoritative, even if the
      // browser sent a blank or different adjusted_consumption value.
      adjustedConsumption =
        Math.round(calculation.value * 10000) / 10000;
    }
    const previousReading = previous ? numeric(previous.reading) : null;
    // Restore the original selection, not the previous effective state, which
    // automatic validation may have quarantined to zero.
    const inheritedUsedInCalculation =
      numeric(current.used_before_validation) ??
      (previous
        ? (numeric(previous.used_before_validation) ?? numeric(previous.used_in_calculation) ?? 1)
        : (numeric(current.used_in_calculation) ?? 0));
    const master = meterItems.find((item) => text(item.meterid) === meterid);
    if (!master) {
      return NextResponse.json(
        { error: `Meter ${meterid} was not found in ${METERS_TABLE}.` },
        { status: 400 },
      );
    }
    const multiplier = numeric(master.multiplier);
    if (multiplier === null) {
      return NextResponse.json(
        { error: `Meter ${meterid} does not have a valid multiplier.` },
        { status: 400 },
      );
    }
    const methodId = numeric(master.inv_read_method_id);
    const method = methodItems.find(
      (item) =>
        numeric(item.inv_read_method_id ?? item.INV_READ_METHOD_ID) === methodId,
    );
    const rolloverUsed =
      numeric(method?.rollover_used ?? method?.ROLLOVER_USED) === 1;
    const rollover = numeric(master.rollover);
    // Rule M identifies a reverse/count-down meter. Honor it BEFORE
    // evaluating normal/up-counting rollover behavior.
    const reverseMeter = normalizeRule(correctionRule) === "m";
    let consumption = numeric(current.consumption) ?? 0;
    if (newReading === 0) {
      consumption = 0;
    } else {
      if (previousReading === null) {
        return NextResponse.json(
          {
            error: `Cannot recalculate meter ${meterid}: the previous-month reading is missing.`,
          },
          { status: 400 },
        );
      }
      const readingDifference = newReading - previousReading;
      const readingsEffectivelyEqual =
        Math.abs(readingDifference) <= MANUAL_READING_TOLERANCE;
      if (readingsEffectivelyEqual) {
        // Example: 1000.25 -> 1000.00 is precision noise, not rollover.
        consumption = 0;
      } else if (reverseMeter) {
        if (newReading < previousReading) {
          // Normal Rule M behavior.
          consumption = (previousReading - newReading) * multiplier;
        } else {
          // Reverse rollover must cross BOTH boundaries.
          const reverseRolloverEligible =
            rolloverUsed &&
            rollover !== null &&
            rollover > 0 &&
            previousReading <= rollover * ROLLOVER_LOW_BOUNDARY &&
            newReading >= rollover * ROLLOVER_HIGH_BOUNDARY;
          if (!reverseRolloverEligible) {
            return NextResponse.json(
              {
                error:
                  `Rule M meter ${meterid} increased from ${previousReading} to ${newReading}, ` +
                  "but the readings do not satisfy the reverse-rollover boundaries. " +
                  "Review the reading or enter an adjusted consumption value.",
              },
              { status: 400 },
            );
          }
          consumption =
            (previousReading + (rollover - newReading)) * multiplier;
        }
      } else if (newReading < previousReading) {
        // Normal/up-counting rollover must cross BOTH boundaries.
        const normalRolloverEligible =
          rolloverUsed &&
          rollover !== null &&
          rollover > 0 &&
          previousReading >= rollover * ROLLOVER_HIGH_BOUNDARY &&
          newReading <= rollover * ROLLOVER_LOW_BOUNDARY;
        if (!normalRolloverEligible) {
          return NextResponse.json(
            {
              error:
                `Meter ${meterid} decreased from ${previousReading} to ${newReading}, ` +
                "but the readings do not satisfy the rollover boundaries. " +
                "Review the reading or enter an adjusted consumption value.",
            },
            { status: 400 },
          );
        }
        consumption =
          ((rollover - previousReading) + newReading) * multiplier;
      } else {
        consumption = (newReading - previousReading) * multiplier;
      }
    }
    consumption = Math.round(consumption * 10000) / 10000;
    const effectiveCurrentConsumption = adjustedConsumption ?? consumption;
    const validation = evaluateValidation(
      effectiveCurrentConsumption,
      previous,
      priorYear,
    );
    const currentValidationAction = text(current.validation_action).toUpperCase();
    const isSourceQuarantine =
      currentValidationAction === "AMR_QUARANTINED" ||
      currentValidationAction === "AMR_INSUFFICIENT_HISTORY" ||
      currentValidationAction === "MANUAL_QUARANTINED" ||
      currentValidationAction === "MANUAL_INSUFFICIENT_HISTORY" ||
      currentValidationAction === "MANUAL_POSSIBLE_METER_RESET" ||
      currentValidationAction === "MANUAL_READING_GAP" ||
      currentValidationAction === "MANUAL_EXTREME_CONSUMPTION";
    const quarantineSource =
      currentValidationAction.startsWith("MANUAL_") ? "MANUAL" : "AMR";
    // AMR and Manual quarantine records preserve their source values.
    // DIVA may resolve the exception, but it must not silently recommend
    // or apply Rule E.
    const hasResolution =
      Boolean(correctionRule) || adjustedConsumption !== null;
    const resolvedValidationRequired =
      isSourceQuarantine && hasResolution ? 0 : validation.validationRequired;
    const resolvedValidationStatus =
      isSourceQuarantine && hasResolution
        ? "CORRECTED"
        : validation.validationStatus;
    const isResolvingCurrentException =
      isValidationRequired(current) &&
      resolvedValidationRequired === 0;
    if (
      isResolvingCurrentException &&
      previous &&
      isValidationRequired(previous)
    ) {
      return NextResponse.json(
        {
          error:
            `Cannot resolve ${text(current.billing_month_nm) || period} for ${meterid} because ` +
            `${text(previous.billing_month_nm) || "the previous billing period"} still requires validation. ` +
            "Resolve the previous billing period first.",
          code: "PREVIOUS_PERIOD_VALIDATION_REQUIRED",
          meterid,
          billing_period_id: billingPeriodId,
          previous_billing_period_id: numeric(previous.billing_period_id),
        },
        { status: 409 },
      );
    }
    const resolvedUsedInCalculation =
      isSourceQuarantine && !hasResolution
        ? 0
        : isResolvingCurrentException
          ? inheritedUsedInCalculation
          : requestedUsedInCalculation ??
            numeric(current.used_in_calculation) ??
            inheritedUsedInCalculation;
    const resolvedValidationAction =
      isSourceQuarantine
        ? hasResolution
          ? `${quarantineSource}_RESOLVED${correctionRule ? `_${correctionRule.toUpperCase()}` : "_MANUAL"}`
          : currentValidationAction
        : "";
    const recommendedCorrectionRule =
      isSourceQuarantine ? "" : validation.bothFailed ? "e" : "";
    const checkedAt = new Date().toISOString();
    const names: Record<string, string> = {
      "#reading": "reading",
      "#consumption": "consumption",
      "#adjusted": "adjusted_consumption",
      "#rule": "meter_correction_rule_cd",
      "#used": "used_in_calculation",
      "#validationRequired": "validation_required",
      "#validationStatus": "validation_status",
      "#validationRules": "validation_rule_ids",
      "#validationCheckedAt": "validation_checked_at",
      "#validationRecommended": "validation_recommended_correction_rule",
      "#validationAction": "validation_action",
    };
    const values: Record<string, unknown> = {
      ":reading": newReading,
      ":consumption": consumption,
      ":adjusted": adjustedConsumption,
      ":rule": correctionRule,
      ":used": resolvedUsedInCalculation,
      ":validationRequired": resolvedValidationRequired,
      ":validationStatus": resolvedValidationStatus,
      ":validationRules": validation.ruleIds,
      ":validationCheckedAt": checkedAt,
      ":validationRecommended": recommendedCorrectionRule,
      ":validationAction": resolvedValidationAction,
    };
    const setParts = [
      "#reading = :reading",
      "#consumption = :consumption",
      "#adjusted = :adjusted",
      "#rule = :rule",
      "#used = :used",
      "#validationRequired = :validationRequired",
      "#validationStatus = :validationStatus",
      "#validationRules = :validationRules",
      "#validationCheckedAt = :validationCheckedAt",
      "#validationRecommended = :validationRecommended",
      "#validationAction = :validationAction",
    ];
    const removeParts: string[] = [];
    if (validation.previousMonthPct !== undefined) {
      names["#validationPrevMonthPct"] = "validation_prev_month_pct";
      values[":validationPrevMonthPct"] = validation.previousMonthPct;
      setParts.push("#validationPrevMonthPct = :validationPrevMonthPct");
    } else {
      names["#validationPrevMonthPct"] = "validation_prev_month_pct";
      removeParts.push("#validationPrevMonthPct");
    }
    if (validation.previousYearPct !== undefined) {
      names["#validationPrevYearPct"] = "validation_prev_year_pct";
      values[":validationPrevYearPct"] = validation.previousYearPct;
      setParts.push("#validationPrevYearPct = :validationPrevYearPct");
    } else {
      names["#validationPrevYearPct"] = "validation_prev_year_pct";
      removeParts.push("#validationPrevYearPct");
    }
    const updateExpression = [
      `SET ${setParts.join(", ")}`,
      removeParts.length ? `REMOVE ${removeParts.join(", ")}` : "",
    ]
      .filter(Boolean)
      .join(" ");
    await ddb.send(
      new UpdateCommand({
        TableName: READINGS_TABLE,
        Key: {
          meterid,
          billing_period_id: billingPeriodId,
        },
        UpdateExpression: updateExpression,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
        ConditionExpression:
          "attribute_exists(meterid) AND attribute_exists(billing_period_id)",
      }),
    );
    return NextResponse.json({
      success: true,
      meterid,
      period,
      reading: newReading,
      consumption,
      adjustedConsumption,
      correctionRule,
      usedInCalculation: resolvedUsedInCalculation,
      rolloverUsed,
      validation_required: resolvedValidationRequired,
      validation_status: resolvedValidationStatus,
      validation_rule_ids: validation.ruleIds,
      validation_prev_month_pct: validation.previousMonthPct ?? null,
      validation_prev_year_pct: validation.previousYearPct ?? null,
      validation_checked_at: checkedAt,
      validation_action: resolvedValidationAction,
      validation_recommended_correction_rule: recommendedCorrectionRule,
    });
  } catch (error) {
    console.error("Data validation PATCH failed:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Unable to save meter correction.",
      },
      { status: 500 },
    );
  }
}
