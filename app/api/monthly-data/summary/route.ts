import {

  QueryCommand,

  ScanCommand,

  type QueryCommandInput,

  type ScanCommandInput,

} from "@aws-sdk/lib-dynamodb";

import { getAppSession } from "@/lib/app-session";

import { ddb } from "@/lib/dynamo";
import { usesPeriodSnapshot } from "@/lib/real-property-effective-core";
import { filterActiveRealPropertyRecords } from "@/lib/real-property-snapshot";
import { getRealPropertyPeriodState } from "@/lib/real-property-snapshot";

export const dynamic = "force-dynamic";

export const revalidate = 0;

const INVOICES_TABLE = "p72-CUBE-INVOICES";

const METER_READINGS_TABLE = "p72-CUBE-METER-READINGS";

const METERS_TABLE = "p72-CUBE-METERS";

const FACILITIES_TABLE = "p72-CUBE-FACILITIES";

const LEGACY_RP_TABLE = "p72-CUBE-RP-LEGACY";

const MONTHLY_RP_TABLE = "p72-CUBE-RP-MONTHLY";

const PROPQ_TABLE = "p72-CUBE-RP-PROPQ";

const BILLING_PERIOD_INDEX = "billing-period-index";

const FIRST_MONTHLY_RP_BILLING_PERIOD_ID = 182;

const FY26_FIRST_BILLING_PERIOD_ID = 171;

const FY26 = 2026;

const LEGACY_AREA_MATCH_TOLERANCE = 0.10; // +/-10% through BP181

const MONTHLY_AREA_MATCH_TOLERANCE = 0.01; // +/-1% from BP182 forward

type Item = Record<string, unknown>;

function value(item: Record<string, unknown>, name: string): string {

  const raw = item[name];

  if (raw === undefined || raw === null) return "";

  return String(raw).trim();

}

function text(raw: unknown): string {

  if (raw === undefined || raw === null) return "";

  return String(raw).trim();

}

function numeric(raw: unknown): number {

  const parsed = Number(text(raw).replace(/[$,]/g, ""));

  return Number.isFinite(parsed) ? parsed : 0;

}

function isTruthyFlag(raw: unknown): boolean {

  if (raw === true || raw === 1) return true;

  const normalized = String(raw ?? "").trim().toUpperCase();

  return (

    normalized === "1" ||

    normalized === "TRUE" ||

    normalized === "YES" ||

    normalized === "Y"

  );

}

function isReadingQuarantined(item: Record<string, unknown>): boolean {

  const validationRequired = isTruthyFlag(item.validation_required);

  const validationStatus = value(item, "validation_status").toUpperCase();

  const validationAction = value(item, "validation_action").toUpperCase();

  const usedInCalculation = isTruthyFlag(item.used_in_calculation);

  return (

    !usedInCalculation ||

    validationRequired ||

    validationStatus === "PENDING" ||

    validationAction.includes("QUARANTINED") ||

    validationAction.includes("INSUFFICIENT_HISTORY") ||

    validationAction.includes("POSSIBLE_METER_RESET")

  );

}

async function queryBillingPeriod(

  tableName: string,

  billingPeriodId: number,

): Promise<Record<string, unknown>[]> {

  const items: Record<string, unknown>[] = [];

  let exclusiveStartKey: QueryCommandInput["ExclusiveStartKey"] | undefined;

  do {

    const result = await ddb.send(

      new QueryCommand({

        TableName: tableName,

        IndexName: BILLING_PERIOD_INDEX,

        KeyConditionExpression: "#bp = :bp",

        ExpressionAttributeNames: { "#bp": "billing_period_id" },

        ExpressionAttributeValues: { ":bp": billingPeriodId },

        ExclusiveStartKey: exclusiveStartKey,

      }),

    );

    items.push(...((result.Items ?? []) as Record<string, unknown>[]));

    exclusiveStartKey = result.LastEvaluatedKey;

  } while (exclusiveStartKey);

  return filterActiveRealPropertyRecords(tableName, billingPeriodId, items);

}

async function scanAll(

  tableName: string,

  projectionExpression?: string,

): Promise<Item[]> {

  const items: Item[] = [];

  let exclusiveStartKey: ScanCommandInput["ExclusiveStartKey"] | undefined;

  do {

    const result = await ddb.send(

      new ScanCommand({

        TableName: tableName,

        ...(projectionExpression

          ? { ProjectionExpression: projectionExpression }

          : {}),

        ExclusiveStartKey: exclusiveStartKey,

      }),

    );

    items.push(...((result.Items ?? []) as Item[]));

    exclusiveStartKey = result.LastEvaluatedKey;

  } while (exclusiveStartKey);

  return items;

}

async function scanMeterMaster(): Promise<Record<string, unknown>[]> {

  return scanAll(

    METERS_TABLE,

    "meterid, facility_nbr, sub_inst_cd, utility_type_cd, meter_status_id, in_service_date, inv_read_method_id",

  );

}

function billingPeriodToFiscalYear(billingPeriodId: number): number {

  return (

    FY26 +

    Math.floor(

      (billingPeriodId - FY26_FIRST_BILLING_PERIOD_ID) / 12,

    )

  );

}

const FEDERAL_FY_MONTHS = [

  "October",

  "November",

  "December",

  "January",

  "February",

  "March",

  "April",

  "May",

  "June",

  "July",

  "August",

  "September",

];

function billingPeriodLabel(billingPeriodId: number): string {

  const offset =

    billingPeriodId - FY26_FIRST_BILLING_PERIOD_ID;

  const normalizedMonthIndex =

    ((offset % 12) + 12) % 12;

  const fiscalYear =

    FY26 + Math.floor(offset / 12);

  return `${FEDERAL_FY_MONTHS[normalizedMonthIndex]} FY${fiscalYear}`;

}

function isUsableMeterActivity(item: Item | undefined): boolean {

  if (!item) return false;

  // A legitimate zero-consumption reading still proves the meter

  // is present. "Good" here means usable/not quarantined, not > 0.

  return !isReadingQuarantined(item);

}

function utilityFlag(raw: unknown): number {

  return numeric(raw) !== 0 ? 1 : 0;

}

function normalizeLegacyRealProperty(

  item: Item,

  billingPeriodId: number,

): Item {

  const legacyRpId = text(item.LegacyRPID);

  const customerQty = numeric(item.CustomerQty);

  return {

    ...item,

    MonthlyRPID: legacyRpId,

    LegacyRPID: legacyRpId,

    FY: numeric(item.FY),

    BillingMonth: "",

    billing_period_id: billingPeriodId,

    FacilityID: text(item.FacilityID),

    CustomerID: text(item.CustomerID),

    RPUID: "",

    SiteCode: text(item.SiteCode ?? item.site_cd ?? item.SITE_CD),

    FacilityNumber: text(

      item.FacilityNumber ??

        item.facility_nbr ??

        item.FACILITY_NBR,

    ),

    NextGenCustomerName: "",

    CUBECustomerName: text(

      item.LegacyCustomerName ?? item.CustomerName,

    ),

    LegacyCustomerName: text(item.LegacyCustomerName),

    CategoryCode: text(item.CategoryCode),

    CategoryDescription: text(item.CategoryDescription),

    AllocationQty: customerQty,

    AllocationUM: text(item.AllocationUM) || "SF",

    UtilityGroup: text(

      item.UtilityGroup ?? item.utility_group_id,

    ),

    EL: utilityFlag(item.ELUsage),

    NG: utilityFlag(item.NGUsage),

    PW: utilityFlag(item.PWUsage),

    SS: utilityFlag(item.SSUsage),

    RecordSource: "legacy",

  };

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

        TableName: LEGACY_RP_TABLE,

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

async function loadRealProperty(

  billingPeriodId: number,

): Promise<Item[]> {

  const periodState = await getRealPropertyPeriodState(billingPeriodId);

  if (!usesPeriodSnapshot(billingPeriodId, periodState !== null)) {

    return loadLegacyRealProperty(

      billingPeriodId,

      billingPeriodToFiscalYear(billingPeriodId),

    );

  }

  return queryBillingPeriod(

    MONTHLY_RP_TABLE,

    billingPeriodId,

  );

}

function mapInvoice(item: Record<string, unknown>) {

  return {

    invoiceid: value(item, "invoiceid"),

    billing_period_id: value(item, "billing_period_id"),

    fy: value(item, "fy"),

    billing_month_nm: value(item, "billing_month_nm"),

    utility_group_id: value(item, "utility_group_id"),

    utility_type_cd: value(item, "utility_type_cd"),

    utility_provider_cd: value(item, "utility_provider_cd"),

    primary_account_nbr: value(item, "primary_account_nbr"),

    account_nbr: value(item, "account_nbr"),

    distribution_system: value(item, "distribution_system"),

    billing_from_date: value(item, "billing_from_date"),

    billing_to_date: value(item, "billing_to_date"),

    consumption: value(item, "consumption"),

    consumption_um: value(item, "consumption_um"),

    charge: value(item, "charge"),

    account_detail: value(item, "account_detail"),

    entry_instruction: value(item, "entry_instruction"),

    invoice_comments: value(item, "invoice_comments"),

    period: value(item, "period"),

  };

}

function mapReading(item: Record<string, unknown>) {

  return {

    meterid: value(item, "meterid"),

    period: value(item, "period"),

    billing_period_id: value(item, "billing_period_id"),

    fy: value(item, "fy"),

    billing_month_nm: value(item, "billing_month_nm"),

    utility_type_cd: value(item, "utility_type_cd"),

    inst_cd: value(item, "inst_cd"),

    sub_inst_cd: value(item, "sub_inst_cd"),

    site_cd: value(item, "site_cd"),

    facility_nbr: value(item, "facility_nbr"),

    multiplier: value(item, "multiplier"),

    previous_reading: value(item, "previous_reading"),

    previous_adjusted_reading: value(

      item,

      "previous_adjusted_reading",

    ),

    reading: value(item, "reading"),

    consumption: value(item, "consumption"),

    meter_correction_rule_cd: value(

      item,

      "meter_correction_rule_cd",

    ),

    adjusted_consumption: value(

      item,

      "adjusted_consumption",

    ),

    used_in_calculation: value(item, "used_in_calculation"),

    validation_required: value(item, "validation_required"),

    validation_status: value(item, "validation_status"),

    validation_action: value(item, "validation_action"),

  };

}

function mapMeter(item: Record<string, unknown>) {

  return {

    meterid: value(item, "meterid"),

    facility_nbr: value(item, "facility_nbr"),

    sub_inst_cd: value(item, "sub_inst_cd"),

    utility_type_cd: value(item, "utility_type_cd"),

  };

}

function normalizeUtility(raw: unknown): string {

  const utility = text(raw).toUpperCase();

  if (utility === "ELECTRIC" || utility === "ELECTRICITY") {

    return "EL";

  }

  if (

    utility === "NATURAL GAS" ||

    utility === "NATURAL_GAS"

  ) {

    return "NG";

  }

  if (

    utility === "WATER" ||

    utility === "PRODUCED WATER" ||

    utility === "PRODUCED_WATER"

  ) {

    return "PW";

  }

  if (

    utility === "SEWER" ||

    utility === "WASTEWATER"

  ) {

    return "SS";

  }

  return utility;

}

function effectiveReadingConsumption(item: Item): number {

  const adjusted = text(item.adjusted_consumption);

  return adjusted

    ? numeric(adjusted)

    : numeric(item.consumption);

}

function areaToleranceForBillingPeriod(billingPeriodId: number): number {

  return billingPeriodId < FIRST_MONTHLY_RP_BILLING_PERIOD_ID

    ? LEGACY_AREA_MATCH_TOLERANCE

    : MONTHLY_AREA_MATCH_TOLERANCE;

}

function areaMatches(

  facilityArea: number,

  eligibleArea: number,

  tolerance: number,

): boolean {

  if (facilityArea <= 0 || eligibleArea <= 0) {

    return false;

  }

  return Math.abs(eligibleArea - facilityArea) / facilityArea <= tolerance;

}

function buildMeterCoverage({

  facilities,

  realProperty,

  propQ,

  meterItems,

  currentReadingItems,

  previousReadingItems,

  twoMonthsPriorReadingItems,

  billingPeriodId,

}: {

  facilities: Item[];

  realProperty: Item[];

  propQ: Item[];

  meterItems: Item[];

  currentReadingItems: Item[];

  previousReadingItems: Item[];

  twoMonthsPriorReadingItems: Item[];

  billingPeriodId: number;

}) {

  const facilityById = new Map<string, Item>();

  const facilityByNumber = new Map<string, Item>();

  facilities.forEach((facility) => {

    const id = text(facility.FacilityID);

    const number = text(facility.FacilityNumber);

    if (id) facilityById.set(id.toUpperCase(), facility);

    if (number) {

      facilityByNumber.set(number.toUpperCase(), facility);

    }

  });

  const rpByFacility = new Map<string, Item[]>();

  realProperty.forEach((rp) => {

    const facilityId = text(rp.FacilityID);

    const facilityNumber = text(

      rp.FacilityNumber ??

        rp.facility_nbr ??

        rp.FACILITY_NBR,

    );

    const facility =

      (facilityId

        ? facilityById.get(facilityId.toUpperCase())

        : undefined) ??

      (facilityNumber

        ? facilityByNumber.get(

            facilityNumber.toUpperCase(),

          )

        : undefined);

    const canonicalId =

      text(facility?.FacilityID) ||

      facilityId ||

      facilityNumber;

    if (!canonicalId) return;

    const key = canonicalId.toUpperCase();

    const list = rpByFacility.get(key) ?? [];

    list.push(rp);

    rpByFacility.set(key, list);

  });

  const propQByKey = new Map<string, Item[]>();

  propQ.forEach((record) => {

    const facilityId = text(record.FacilityID).toUpperCase();

    const utility = normalizeUtility(record.UtilityType);

    const customerId = text(record.CustomerID).toUpperCase();

    if (!facilityId || !utility) return;

    const key = `${facilityId}|${utility}|${customerId}`;

    const list = propQByKey.get(key) ?? [];

    list.push(record);

    propQByKey.set(key, list);

  });

  function readingMap(items: Item[]): Map<string, Item> {

    const map = new Map<string, Item>();

    items.forEach((reading) => {

      const meterId = text(reading.meterid).toUpperCase();

      if (!meterId) return;

      map.set(meterId, reading);

    });

    return map;

  }

  const currentReadingsByMeter =

    readingMap(currentReadingItems);

  const previousReadingsByMeter =

    readingMap(previousReadingItems);

  const twoMonthsPriorReadingsByMeter =

    readingMap(twoMonthsPriorReadingItems);

  const metersByFacilityUtility = new Map<string, Item[]>();

  meterItems.forEach((meter) => {

    const facilityNumber = text(meter.facility_nbr);

    const utility = normalizeUtility(meter.utility_type_cd);

    if (!facilityNumber || !utility) return;

    const facility = facilityByNumber.get(

      facilityNumber.toUpperCase(),

    );

    const canonicalId =

      text(facility?.FacilityID) || facilityNumber;

    const key = `${canonicalId.toUpperCase()}|${utility}`;

    const list = metersByFacilityUtility.get(key) ?? [];

    list.push(meter);

    metersByFacilityUtility.set(key, list);

  });

  const rows: Item[] = [];

  const utilities = ["EL", "NG", "PW", "SS"];

  for (const [facilityKey, rpRows] of rpByFacility) {

    const firstRp = rpRows[0];

    const facility =

      facilityById.get(facilityKey) ??

      facilityByNumber.get(

        text(

          firstRp.FacilityNumber ??

            firstRp.facility_nbr ??

            firstRp.FACILITY_NBR,

        ).toUpperCase(),

      );

    const facilityId =

      text(facility?.FacilityID) ||

      text(firstRp.FacilityID);

    const facilityNumber =

      text(facility?.FacilityNumber) ||

      text(

        firstRp.FacilityNumber ??

          firstRp.facility_nbr ??

          firstRp.FACILITY_NBR,

      );

    const facilityName = facility

      ? text(facility.FacilityName)

      : "";

    const facilityArea = facility

      ? numeric(facility.AreaQty)

      : 0;

    const facilityAreaUM = facility

      ? text(facility.AreaUM) || "SF"

      : "SF";

    for (const utility of utilities) {

      const eligibleRp = rpRows.filter(

        (rp) => utilityFlag(rp[utility]) === 1,

      );

      if (eligibleRp.length === 0) {

        continue;

      }

      const eligibleRpArea = eligibleRp.reduce(

        (sum, rp) =>

          sum +

          numeric(

            rp.AllocationQty ??

              rp.CustomerQty ??

              rp.AreaSF,

          ),

        0,

      );

      const allowedAreaTolerance = areaToleranceForBillingPeriod(billingPeriodId);

      const areaDifference = eligibleRpArea - facilityArea;

      const areaDifferencePercent =

        facilityArea > 0 ? (areaDifference / facilityArea) * 100 : null;

      const matchesArea = areaMatches(

        facilityArea,

        eligibleRpArea,

        allowedAreaTolerance,

      );

      const rpSource =

        billingPeriodId < FIRST_MONTHLY_RP_BILLING_PERIOD_ID

          ? "LEGACY"

          : "MONTHLY";

      const areaCoveragePercent =

        facilityArea > 0

          ? (eligibleRpArea / facilityArea) * 100

          : null;

      const meterKey = `${facilityKey}|${utility}`;

      const mappedMeters =

        metersByFacilityUtility.get(meterKey) ?? [];

      const expectedMeters = mappedMeters

        .map((meter) => text(meter.meterid).toUpperCase())

        .filter(Boolean)

        .sort();

      const goodMeters: string[] = [];

      const badMeters: string[] = [];

      const activeExpectedMeters: string[] = [];

      const possiblyRemovedMeters: string[] = [];

      const meterValidation: Item[] = [];

      let meterConsumption = 0;

      expectedMeters.forEach((meterId) => {

        const current =

          currentReadingsByMeter.get(meterId);

        const previous =

          previousReadingsByMeter.get(meterId);

        const twoPrior =

          twoMonthsPriorReadingsByMeter.get(meterId);

        const currentGood =

          isUsableMeterActivity(current);

        const previousGood =

          isUsableMeterActivity(previous);

        const twoPriorGood =

          isUsableMeterActivity(twoPrior);

        const active =

          currentGood || previousGood || twoPriorGood;

        if (active) {

          activeExpectedMeters.push(meterId);

        } else {

          possiblyRemovedMeters.push(meterId);

        }

        if (currentGood && current) {

          goodMeters.push(meterId);

          meterConsumption +=

            effectiveReadingConsumption(current);

        } else if (active) {

          badMeters.push(meterId);

        }

        let lastGoodBillingPeriodId: number | null = null;

        if (currentGood) {

          lastGoodBillingPeriodId = billingPeriodId;

        } else if (previousGood) {

          lastGoodBillingPeriodId =

            billingPeriodId - 1;

        } else if (twoPriorGood) {

          lastGoodBillingPeriodId =

            billingPeriodId - 2;

        }

        meterValidation.push({

          meterId,

          currentGood,

          previousGood,

          twoMonthsPriorGood: twoPriorGood,

          state: active ? "ACTIVE" : "POSSIBLY_REMOVED",

          lastGoodBillingPeriodId,

          lastGoodReading:

            lastGoodBillingPeriodId === null

              ? "No usable reading in 3-month window"

              : billingPeriodLabel(

                  lastGoodBillingPeriodId,

                ),

        });

      });

      let coverageStatus:

        | "FULL"

        | "PARTIAL"

        | "NONMETERED"

        | "REVIEW";

      let nonMeteredEligible:

        | "NO"

        | "YES"

        | "REVIEW";

      if (expectedMeters.length === 0) {

        coverageStatus = "NONMETERED";

        nonMeteredEligible = "YES";

      } else if (activeExpectedMeters.length === 0) {

        // Registry meters exist, but none has a usable reading in the

        // current or prior two billing periods. Treat them as possibly

        // removed for coverage analysis, but do not alter meter master.

        coverageStatus = "NONMETERED";

        nonMeteredEligible = "YES";

      } else if (

        matchesArea &&

        goodMeters.length === activeExpectedMeters.length

      ) {

        coverageStatus = "FULL";

        nonMeteredEligible = "NO";

      } else if (badMeters.length > 0) {

        coverageStatus = "REVIEW";

        nonMeteredEligible = "REVIEW";

      } else if (

        facilityArea > 0 &&

        eligibleRpArea > 0 &&

        eligibleRpArea < facilityArea

      ) {

        coverageStatus = "PARTIAL";

        nonMeteredEligible = "YES";

      } else {

        coverageStatus = "REVIEW";

        nonMeteredEligible = "REVIEW";

      }

      const customers = eligibleRp.map((rp) => {

        const customerId = text(rp.CustomerID);

        const customerName = text(

          rp.CUBECustomerName ??

            rp.NextGenCustomerName ??

            rp.LegacyCustomerName ??

            rp.CustomerName,

        );

        const pqKey = `${facilityId.toUpperCase()}|${utility}|${customerId.toUpperCase()}`;

        const pqRows = propQByKey.get(pqKey) ?? [];

        const propQValue =

          pqRows.length > 0

            ? pqRows.reduce(

                (sum, record) =>

                  sum + numeric(record.PropQ),

                0,

              )

            : null;

        const propQStatus =

          pqRows

            .map((record) => text(record.PropQStatus))

            .filter(Boolean)

            .join(", ") || "";

        return {

          customerId,

          customerName,

          facilityId,

          facilityNumber,

          utilityType: utility,

          allocatedArea: numeric(

            rp.AllocationQty ??

              rp.CustomerQty ??

              rp.AreaSF,

          ),

          allocationUM:

            text(rp.AllocationUM) || "SF",

          usageFlag: 1,

          propQ: propQValue,

          propQStatus,

        };

      });

      rows.push({

        facilityId,

        facilityNumber,

        facilityName,

        facilityArea,

        facilityAreaUM,

        utilityType: utility,

        eligibleRpArea,

        areaCoveragePercent,

        areaDifference,

        areaDifferencePercent,

        rpSource,

        allowedAreaTolerancePercent: allowedAreaTolerance * 100,

        areaToleranceStatus: matchesArea ? "PASS" : "FAIL",

        areaMatchesFacility: matchesArea,

        expectedMeters,

        activeExpectedMeters,

        possiblyRemovedMeters,

        goodMeters,

        badMeters,

        meterValidation,

        meterConsumption,

        coverageStatus,

        nonMeteredEligible,

        customers,

      });

    }

  }

  rows.sort((a, b) => {

    const facilityCompare = text(

      a.facilityNumber,

    ).localeCompare(

      text(b.facilityNumber),

      undefined,

      {

        numeric: true,

        sensitivity: "base",

      },

    );

    if (facilityCompare !== 0) {

      return facilityCompare;

    }

    return text(a.utilityType).localeCompare(

      text(b.utilityType),

    );

  });

  return rows;

}

export async function GET(request: Request) {
  // Authentication remains disabled during local development.
  // Enable the commented Auth.js guard before production deployment.

  try {

    const session = await getAppSession();

    if (!session?.user) {

      return Response.json(

        { ok: false, error: "Unauthorized" },

        { status: 401 },

      );

    }

    const url = new URL(request.url);

    const rawBillingPeriodId =

      url.searchParams.get("billing_period_id")?.trim() ?? "";

    const rawFY =

      url.searchParams.get("fy")?.trim() ?? "";

    const rawMonth =

      url.searchParams.get("month")?.trim() ?? "";

    function deriveBillingPeriodId(

      fyValue: string,

      monthValue: string,

    ): string {

      const cleanedFY = fyValue

        .replace(/^FY\s*/i, "")

        .trim();

      const fiscalYear =

        cleanedFY.length === 2

          ? 2000 + Number(cleanedFY)

          : Number(cleanedFY);

      const fiscalMonths = [

        "october",

        "november",

        "december",

        "january",

        "february",

        "march",

        "april",

        "may",

        "june",

        "july",

        "august",

        "september",

      ];

      const normalizedMonth =

        monthValue.trim().toLowerCase();

      const monthIndex = fiscalMonths.findIndex(

        (value) =>

          value === normalizedMonth ||

          value.slice(0, 3) ===

            normalizedMonth.slice(0, 3),

      );

      if (

        !Number.isInteger(fiscalYear) ||

        fiscalYear < 2026 ||

        monthIndex < 0

      ) {

        return "";

      }

      return String(

        171 +

          (fiscalYear - 2026) * 12 +

          monthIndex,

      );

    }

    const numericFromQuery =

      /^\d+$/.test(rawBillingPeriodId)

        ? rawBillingPeriodId

        : rawBillingPeriodId.match(

            /^BP\s*(\d+)$/i,

          )?.[1] ?? "";

    const normalizedBillingPeriodId =

      numericFromQuery ||

      deriveBillingPeriodId(

        rawFY,

        rawMonth,

      );

    if (!normalizedBillingPeriodId) {

      return Response.json(

        {

          ok: false,

          error:

            "Unable to resolve billing_period_id from the selected fiscal year and billing month.",

          received: {

            billing_period_id: rawBillingPeriodId,

            fy: rawFY,

            month: rawMonth,

          },

        },

        { status: 400 },

      );

    }

    const billingPeriodId =

      Number(normalizedBillingPeriodId);

    if (

      !Number.isSafeInteger(billingPeriodId) ||

      billingPeriodId <= 0

    ) {

      return Response.json(

        {

          ok: false,

          error: "Invalid billing_period_id.",

        },

        { status: 400 },

      );

    }

    const previousBillingPeriodId =

      billingPeriodId - 1;

    const twoMonthsPriorBillingPeriodId =

      billingPeriodId - 2;

    const [

      invoiceItems,

      currentReadingItems,

      previousReadingItems,

      twoMonthsPriorReadingItems,

      meterItems,

      facilityItems,

      realPropertyItems,

      propQItems,

    ] = await Promise.all([

      queryBillingPeriod(

        INVOICES_TABLE,

        billingPeriodId,

      ),

      queryBillingPeriod(

        METER_READINGS_TABLE,

        billingPeriodId,

      ),

      previousBillingPeriodId > 0

        ? queryBillingPeriod(

            METER_READINGS_TABLE,

            previousBillingPeriodId,

          )

        : Promise.resolve([]),

      twoMonthsPriorBillingPeriodId > 0

        ? queryBillingPeriod(

            METER_READINGS_TABLE,

            twoMonthsPriorBillingPeriodId,

          )

        : Promise.resolve([]),

      scanMeterMaster(),

      scanAll(

        FACILITIES_TABLE,

        "FacilityID, FacilityNumber, FacilityName, AreaQty, AreaUM, Active",

      ),

      loadRealProperty(billingPeriodId),

      queryBillingPeriod(

        PROPQ_TABLE,

        billingPeriodId,

      ),

    ]);

    const eligibleCurrentReadingItems =

      currentReadingItems.filter(

        (item) => !isReadingQuarantined(item),

      );

    const eligiblePreviousReadingItems =

      previousReadingItems.filter(

        (item) => !isReadingQuarantined(item),

      );

    const meterCoverage = buildMeterCoverage({

      facilities: facilityItems.filter(

        (item) =>

          item.Active === undefined ||

          isTruthyFlag(item.Active),

      ),

      realProperty: realPropertyItems,

      propQ: propQItems,

      meterItems,

      // IMPORTANT: use ALL current records here, not only the eligible

      // subset. buildMeterCoverage decides whether each mapped meter has

      // a good positive usable reading. This lets missing/zero/quarantined

      // meters appear as "not good" instead of disappearing.

      currentReadingItems,

      previousReadingItems,

      twoMonthsPriorReadingItems,

      billingPeriodId,

    });

    return Response.json({

      ok: true,

      billingPeriodId: String(billingPeriodId),

      previousBillingPeriodId:

        previousBillingPeriodId > 0

          ? String(previousBillingPeriodId)

          : "",

      invoices: invoiceItems.map(mapInvoice),

      readings: [

        ...eligibleCurrentReadingItems,

        ...eligiblePreviousReadingItems,

      ].map(mapReading),

      meterMaster: meterItems.map(mapMeter),

      // View-only meter coverage analysis. Nothing in this block writes

      // to DynamoDB or changes PropQ/reconciliation behavior.

      meterCoverage,

      meterCoverageDiagnostics: {

        facilityCount: facilityItems.length,

        realPropertyCount: realPropertyItems.length,

        propQCount: propQItems.length,

        coverageRowCount: meterCoverage.length,

      },

      excludedReadings: {

        current:

          currentReadingItems.length -

          eligibleCurrentReadingItems.length,

        previous:

          previousReadingItems.length -

          eligiblePreviousReadingItems.length,

      },

      readingDiagnostics: {

        current: {

          total: currentReadingItems.length,

          included: eligibleCurrentReadingItems.length,

          excluded:

            currentReadingItems.length -

            eligibleCurrentReadingItems.length,

          usedOn: currentReadingItems.filter((item) =>

            isTruthyFlag(item.used_in_calculation),

          ).length,

          usedOffOrMissing:

            currentReadingItems.filter(

              (item) =>

                !isTruthyFlag(

                  item.used_in_calculation,

                ),

            ).length,

        },

        previous: {

          total: previousReadingItems.length,

          included: eligiblePreviousReadingItems.length,

          excluded:

            previousReadingItems.length -

            eligiblePreviousReadingItems.length,

          usedOn: previousReadingItems.filter((item) =>

            isTruthyFlag(item.used_in_calculation),

          ).length,

          usedOffOrMissing:

            previousReadingItems.filter(

              (item) =>

                !isTruthyFlag(

                  item.used_in_calculation,

                ),

            ).length,

        },

      },

    });

  } catch (error) {

    console.error(

      "Monthly Summary GET failed:",

      error,

    );

    return Response.json(

      {

        ok: false,

        error:

          error instanceof Error

            ? error.message

            : "Unable to load Monthly Summary data.",

      },

      { status: 500 },

    );

  }

}
