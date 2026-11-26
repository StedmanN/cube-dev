import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
  type QueryCommandInput,
  type ScanCommandInput,
} from "@aws-sdk/lib-dynamodb";

import { NextResponse } from "next/server";

import { getAppSession } from "@/lib/app-session";
import { ddb } from "@/lib/dynamo";

export const runtime = "nodejs";

const TABLE_NAME = "p72-CUBE-METER-READINGS";

function textValue(value: unknown) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

function optionalNumber(value: unknown) {
  const text = textValue(value);
  if (!text) return undefined;

  const numeric = Number(text.replace(/,/g, ""));
  return Number.isFinite(numeric) ? numeric : undefined;
}

function usedValue(value: unknown) {
  return textValue(value) === "1" ? 1 : 0;
}

// The original Used selection survives automatic validation quarantine.
// Legacy records without the new attribute fall back to their effective status.
function originalUsedValue(item: Record<string, unknown> | undefined): 0 | 1 {
  if (!item) return 0;
  const preserved = textValue(item.used_before_validation);
  if (preserved === "1") return 1;
  if (preserved === "0") return 0;
  return usedValue(item.used_in_calculation);
}

function isRawReadingMissing(item: Record<string, unknown> | undefined) {
  return item !== undefined && !textValue(item.reading);
}

function calculateZeroReadingStreak(
  currentReading: number | undefined,
  previous: Record<string, unknown> | undefined,
) {
  // ZeroReadingStreak is based ONLY on the immutable raw meter reading.
  // Adjusted consumption and correction rules never change this value.
  if (currentReading !== undefined && currentReading !== 0) {
    return 0;
  }

  const previousStreak =
    previous
      ? optionalNumber(previous.ZeroReadingStreak) ?? 0
      : 0;

  return previousStreak + 1;
}

async function updateMeterZeroReadingStreak(
  meterid: string,
  zeroReadingStreak: number,
  billingPeriodId?: number,
) {
  const names: Record<string, string> = {
    "#meterid": "meterid",
    "#zeroStreak": "ZeroReadingStreak",
  };
  const values: Record<string, unknown> = {
    ":zeroStreak": zeroReadingStreak,
  };
  const setParts = ["#zeroStreak = :zeroStreak"];

  if (billingPeriodId !== undefined) {
    names["#zeroStreakBp"] = "ZeroReadingStreakBillingPeriod";
    values[":zeroStreakBp"] = billingPeriodId;
    values[":missingBp"] = billingPeriodId;
    setParts.push("#zeroStreakBp = :zeroStreakBp");
  }

  try {
    await ddb.send(
      new UpdateCommand({
        TableName: "p72-CUBE-METERS",
        Key: { meterid },
        UpdateExpression: `SET ${setParts.join(", ")}`,
        ConditionExpression: billingPeriodId !== undefined
          ? "attribute_exists(#meterid) AND (attribute_not_exists(#zeroStreakBp) OR #zeroStreakBp <= :missingBp)"
          : "attribute_exists(#meterid)",
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
      }),
    );
  } catch (error) {
    const name =
      error && typeof error === "object" && "name" in error
        ? String((error as { name?: unknown }).name)
        : "";

    // A conditional failure can mean either the meter no longer exists or
    // this was an older billing period than the meter master already tracks.
    // In either case, do not roll the meter-master streak backward.
    if (name === "ConditionalCheckFailedException") {
      return;
    }

    throw error;
  }
}

// ============================================================
// EXISTING SINGLE-READING UPDATE
// ============================================================

export async function PUT(request: Request) {
  try {
    // ============================================================
  // AUTHENTICATION (PRODUCTION - CURRENTLY DISABLED)
  // Enable the auth import above and uncomment this block when
  // authenticated access is required for this endpoint.
  // ============================================================
  const session = await getAppSession();
  if (!session?.user) {
    return NextResponse.json(
      { error: "Unauthorized" },
      { status: 401 },
    );
  }


    const body = await request.json();
    const meterid = textValue(body.meterid);
    const period = textValue(body.period);
    const billingPeriodId = optionalNumber(body.billing_period_id);

    if (!meterid) {
      return NextResponse.json(
        { error: "meterid is required." },
        { status: 400 },
      );
    }

    if (!period && billingPeriodId === undefined) {
      return NextResponse.json(
        {
          error:
            "period or billing_period_id is required to identify the meter reading.",
        },
        { status: 400 },
      );
    }

    const requestedCorrectionRule = textValue(
      body.meter_correction_rule_cd,
    ).toLowerCase();
    let serverAdjustedConsumption: number | undefined;

    if (requestedCorrectionRule === "e") {
      if (billingPeriodId === undefined) {
        return NextResponse.json(
          { error: "billing_period_id is required for Rule E." },
          { status: 400 },
        );
      }

      const currentResult = await ddb.send(
        new GetCommand({
          TableName: TABLE_NAME,
          Key: { meterid, billing_period_id: billingPeriodId },
          ConsistentRead: true,
        }),
      );
      const current = currentResult.Item as Record<string, unknown> | undefined;
      const priorYearItems = await queryPriorYearBillingPeriod(
        current,
        billingPeriodId,
      );
      const priorYear = priorYearItems.find(
        (item) =>
          textValue(item.meterid).toUpperCase() === meterid.toUpperCase(),
      );
      const priorYearConsumption = effectiveStoredConsumption(priorYear);

      if (priorYearConsumption === undefined) {
        return NextResponse.json(
          {
            error:
              "Rule E requires same-month prior-fiscal-year consumption. The historical consumption is unavailable for this meter.",
            code: "RULE_E_HISTORY_REQUIRED",
            meterid,
            billing_period_id: billingPeriodId,
          },
          { status: 422 },
        );
      }

      // Rule E is automatic. Ignore any browser-supplied adjusted value.
      serverAdjustedConsumption =
        Math.round(priorYearConsumption * 10000) / 10000;
    }

    const setParts: string[] = [];
    const removeParts: string[] = [];
    const names: Record<string, string> = {
      "#meterid": "meterid",
    };
    const values: Record<string, unknown> = {};

    if (Object.prototype.hasOwnProperty.call(body, "used_in_calculation")) {
      names["#used"] = "used_in_calculation";
      names["#originalUsed"] = "used_before_validation";
      values[":used"] = usedValue(body.used_in_calculation);
      setParts.push("#used = :used", "#originalUsed = :used");
    }

    if (Object.prototype.hasOwnProperty.call(body, "meter_correction_rule_cd")) {
      names["#rule"] = "meter_correction_rule_cd";
      const rule = textValue(body.meter_correction_rule_cd);

      if (rule) {
        values[":rule"] = rule;
        setParts.push("#rule = :rule");
      } else {
        removeParts.push("#rule");
      }
    }

    if (
      Object.prototype.hasOwnProperty.call(body, "adjusted_consumption") ||
      serverAdjustedConsumption !== undefined
    ) {
      names["#adjusted"] = "adjusted_consumption";
      const adjusted =
        serverAdjustedConsumption ?? optionalNumber(body.adjusted_consumption);

      if (adjusted !== undefined) {
        values[":adjusted"] = adjusted;
        setParts.push("#adjusted = :adjusted");
      } else {
        removeParts.push("#adjusted");
      }
    }

    // Raw meter readings and calculated consumption are immutable through
    // the normal edit API. Corrections must use adjusted_consumption and/or
    // meter_correction_rule_cd.
    if (
      Object.prototype.hasOwnProperty.call(body, "reading") ||
      Object.prototype.hasOwnProperty.call(body, "consumption")
    ) {
      return NextResponse.json(
        {
          error:
            "reading and consumption cannot be edited after creation. Use adjusted_consumption or meter_correction_rule_cd for corrections.",
        },
        { status: 400 },
      );
    }

    if (setParts.length === 0 && removeParts.length === 0) {
      return NextResponse.json(
        { error: "No supported meter reading fields were supplied." },
        { status: 400 },
      );
    }

    const expressions: string[] = [];

    if (setParts.length) {
      expressions.push(`SET ${setParts.join(", ")}`);
    }

    if (removeParts.length) {
      expressions.push(`REMOVE ${removeParts.join(", ")}`);
    }

    const keyCandidates: Record<string, unknown>[] = [];

    if (period) {
      keyCandidates.push({
        meterid,
        period,
      });
    }

    if (billingPeriodId !== undefined) {
      keyCandidates.push({
        meterid,
        billing_period_id: billingPeriodId,
      });
    }

    let lastSchemaError: unknown = null;

    for (const key of keyCandidates) {
      try {
        await ddb.send(
          new UpdateCommand({
            TableName: TABLE_NAME,
            Key: key,
            UpdateExpression: expressions.join(" "),
            ConditionExpression:
              "attribute_exists(#meterid)",
            ExpressionAttributeNames: names,
            ExpressionAttributeValues:
              Object.keys(values).length > 0
                ? values
                : undefined,
          }),
        );

        const refreshed = await ddb.send(
          new GetCommand({
            TableName: TABLE_NAME,
            Key: key,
            ConsistentRead: true,
          }),
        );

        return NextResponse.json({
          ok: true,
          keyUsed: key,
          item: refreshed.Item ?? null,
        });
      } catch (error) {
        const name =
          error &&
          typeof error === "object" &&
          "name" in error
            ? String(
                (error as { name?: unknown }).name,
              )
            : "";

        const message =
          error instanceof Error
            ? error.message
            : String(error);

        // Try the other supported key shape only when DynamoDB says
        // the provided key does not match the table schema.
        if (
          name === "ValidationException" &&
          message
            .toLowerCase()
            .includes("key element does not match the schema")
        ) {
          lastSchemaError = error;
          continue;
        }

        if (name === "ConditionalCheckFailedException") {
          return NextResponse.json(
            {
              error:
                "The meter reading no longer exists.",
            },
            {
              status: 404,
            },
          );
        }

        throw error;
      }
    }

    throw (
      lastSchemaError ??
      new Error(
        "Unable to identify the DynamoDB key schema for this meter reading.",
      )
    );
  } catch (error) {
    console.error("Meter reading update failed:", error);

    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Unable to update meter reading.",
      },
      { status: 500 },
    );
  }
}

// ============================================================
// EXISTING SINGLE-READING CREATE
// ============================================================

async function handleSingleReadingPost(request: Request) {
  try {
    const body = await request.json();
    const meterid = textValue(body.meterid);
    const period = textValue(body.period);
    const billingPeriodId = optionalNumber(body.billing_period_id);

    if (!meterid || !period) {
      return NextResponse.json(
        { error: "meterid and period are required." },
        { status: 400 },
      );
    }

    if (billingPeriodId === undefined) {
      return NextResponse.json(
        { error: "billing_period_id is required." },
        { status: 400 },
      );
    }

    const meterMaster = await ddb.send(
      new GetCommand({
        TableName: "p72-CUBE-METERS",
        Key: { meterid },
        ProjectionExpression: "meterid",
      }),
    );

    if (!meterMaster.Item) {
      return NextResponse.json(
        {
          error:
            `Meter "${meterid}" does not exist in p72-CUBE-METERS.`,
        },
        { status: 400 },
      );
    }

    const previousResult = await ddb.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression:
          "#meterid = :meterid AND #billingPeriodId < :billingPeriodId",
        ExpressionAttributeNames: {
          "#meterid": "meterid",
          "#billingPeriodId": "billing_period_id",
        },
        ExpressionAttributeValues: {
          ":meterid": meterid,
          ":billingPeriodId": billingPeriodId,
        },
        ScanIndexForward: false,
        Limit: 1,
      }),
    );

    const previous = previousResult.Items?.[0] as
      | Record<string, unknown>
      | undefined;

    const suppliedUsed = textValue(body.used_in_calculation);
    const suppliedRule = textValue(body.meter_correction_rule_cd);
    const inheritedUsed = originalUsedValue(previous);
    const inheritedRule = previous
      ? textValue(previous.meter_correction_rule_cd)
      : "";

    const item: Record<string, unknown> = {
      ...body,
      meterid,
      period,
      used_in_calculation: suppliedUsed
        ? usedValue(suppliedUsed)
        : inheritedUsed,
      used_before_validation: suppliedUsed
        ? usedValue(suppliedUsed)
        : inheritedUsed,
    };

    const rule = suppliedRule || inheritedRule;
    if (rule) {
      item.meter_correction_rule_cd = rule;
    } else {
      delete item.meter_correction_rule_cd;
    }

    const numericFields = [
      "billing_period_id",
      "fy",
      "multiplier",
      "previous_reading",
      "previous_adjusted_reading",
      "reading",
      "consumption",
      "adjusted_consumption",
    ];

    for (const field of numericFields) {
      if (!Object.prototype.hasOwnProperty.call(item, field)) continue;
      const numeric = optionalNumber(item[field]);

      if (numeric === undefined) {
        delete item[field];
      } else {
        item[field] = numeric;
      }
    }

    for (const [key, value] of Object.entries(item)) {
      if (
        value === undefined ||
        value === null ||
        (typeof value === "string" && value.trim() === "")
      ) {
        delete item[key];
      }
    }

    item.ZeroReadingStreak =
      calculateZeroReadingStreak(
        optionalNumber(item.reading),
        previous,
      );

    await ddb.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: item,
        ConditionExpression:
          "attribute_not_exists(#meterid) AND attribute_not_exists(#billingPeriodId)",
        ExpressionAttributeNames: {
          "#meterid": "meterid",
          "#billingPeriodId": "billing_period_id",
        },
      }),
    );

    await updateMeterZeroReadingStreak(
      meterid,
      optionalNumber(item.ZeroReadingStreak) ?? 0,
      optionalNumber(item.billing_period_id),
    );

    return NextResponse.json(
      {
        ok: true,
        item,
        inherited: {
          used_in_calculation: !suppliedUsed && Boolean(previous),
          meter_correction_rule_cd:
            !suppliedRule && Boolean(previous && inheritedRule),
        },
      },
      { status: 201 },
    );
  } catch (error) {
    console.error("Meter reading create failed:", error);

    const name =
      error && typeof error === "object" && "name" in error
        ? String((error as { name?: unknown }).name)
        : "";

    if (name === "ConditionalCheckFailedException") {
      return NextResponse.json(
        { error: "A meter reading already exists for this meter and period." },
        { status: 409 },
      );
    }

    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Unable to create meter reading.",
      },
      { status: 500 },
    );
  }
}

// ============================================================
// SAVE A METER-ONLY MANUAL RECORD
//
// This stores a real meter-reading record even when no raw current register
// reading is available. The user can store the adjusted value and Used
// decision without creating a raw current-reading value.
// ============================================================

async function handleManualEntryPost(body: Record<string, unknown>) {
  const meterid = textValue(body.meterid);
  const period = textValue(body.period);
  const billingPeriodId = optionalNumber(body.billing_period_id);
  const fy = optionalNumber(body.fy);
  const billingMonth = textValue(body.billing_month_nm);

  if (
    !meterid ||
    !period ||
    billingPeriodId === undefined ||
    fy === undefined ||
    !billingMonth
  ) {
    return NextResponse.json(
      {
        error:
          "meterid, period, billing_period_id, fy, and billing_month_nm are required.",
      },
      { status: 400 },
    );
  }

  const meterResult = await ddb.send(
    new GetCommand({
      TableName: "p72-CUBE-METERS",
      Key: { meterid },
    }),
  );

  const master = meterResult.Item as Record<string, unknown> | undefined;

  if (!master) {
    return NextResponse.json(
      {
        error: `Meter "${meterid}" does not exist in p72-CUBE-METERS.`,
      },
      { status: 400 },
    );
  }

  const existing = await getCurrentReadingByPrimaryKey(
    meterid,
    period,
    billingPeriodId,
  );

  if (existing && !isRawReadingMissing(existing)) {
    return NextResponse.json(
      {
        error:
          "This meter already has a current reading. Use the normal Update action.",
      },
      { status: 409 },
    );
  }

  const rule = textValue(body.meter_correction_rule_cd);
  let adjusted = optionalNumber(body.adjusted_consumption);
  const used = usedValue(body.used_in_calculation);

  if (rule.toLowerCase() === "e") {
    const priorYearItems = await queryPriorYearBillingPeriod(
      existing ?? {
        fy,
        billing_month_nm: billingMonth,
      },
      billingPeriodId,
    );
    const priorYear = priorYearItems.find(
      (candidate) =>
        textValue(candidate.meterid).toUpperCase() === meterid.toUpperCase(),
    );
    const priorYearConsumption = effectiveStoredConsumption(priorYear);

    if (priorYearConsumption === undefined) {
      return NextResponse.json(
        {
          error:
            "Rule E requires same-month prior-fiscal-year consumption. The historical consumption is unavailable for this meter.",
          code: "RULE_E_HISTORY_REQUIRED",
          meterid,
          billing_period_id: billingPeriodId,
        },
        { status: 422 },
      );
    }

    // Rule E is automatic. Ignore any blank or conflicting browser value.
    adjusted = Math.round(priorYearConsumption * 10000) / 10000;
  }

  const item: Record<string, unknown> = {
    meterid,
    period,
    billing_period_id: billingPeriodId,
    fy,
    billing_month_nm: billingMonth,
    used_in_calculation: used,
    used_before_validation: used,
    reading_source: "MANUAL",
  };

  [
    "facility_nbr",
    "sub_inst_cd",
    "site_cd",
    "utility_type_cd",
    "inst_cd",
  ].forEach((field) => {
    if (master[field] !== undefined && master[field] !== null) {
      item[field] = master[field];
    }
  });

  if (rule) item.meter_correction_rule_cd = rule;
  if (adjusted !== undefined) item.adjusted_consumption = adjusted;

  if (!existing) {
    await ddb.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: item,
        ConditionExpression:
          "attribute_not_exists(#meterid) AND attribute_not_exists(#bp)",
        ExpressionAttributeNames: {
          "#meterid": "meterid",
          "#bp": "billing_period_id",
        },
      }),
    );

    return NextResponse.json({ ok: true, created: true, item });
  }

  const names: Record<string, string> = {
    "#meterid": "meterid",
    "#bp": "billing_period_id",
    "#used": "used_in_calculation",
    "#originalUsed": "used_before_validation",
    "#reading": "reading",
  };
  const values: Record<string, unknown> = {
    ":used": used,
    ":readingTypeString": "S",
    ":readingTypeNull": "NULL",
    ":emptyReading": "",
  };
  const setParts = ["#used = :used", "#originalUsed = :used"];
  const removeParts: string[] = [];

  if (rule) {
    names["#rule"] = "meter_correction_rule_cd";
    values[":rule"] = rule;
    setParts.push("#rule = :rule");
  } else {
    names["#rule"] = "meter_correction_rule_cd";
    removeParts.push("#rule");
  }

  if (adjusted !== undefined) {
    names["#adjusted"] = "adjusted_consumption";
    values[":adjusted"] = adjusted;
    setParts.push("#adjusted = :adjusted");
  } else {
    names["#adjusted"] = "adjusted_consumption";
    removeParts.push("#adjusted");
  }

  await ddb.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      // Live CUBE meter readings are keyed by meterid + billing_period_id.
      Key: { meterid, billing_period_id: billingPeriodId },
      UpdateExpression: [
        `SET ${setParts.join(", ")}`,
        removeParts.length ? `REMOVE ${removeParts.join(", ")}` : "",
      ].filter(Boolean).join(" "),
      ConditionExpression:
        "attribute_exists(#meterid) AND attribute_exists(#bp) AND (attribute_not_exists(#reading) OR attribute_type(#reading, :readingTypeNull) OR (attribute_type(#reading, :readingTypeString) AND #reading = :emptyReading))",
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    }),
  );

  const refreshed = await ddb.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: { meterid, billing_period_id: billingPeriodId },
      ConsistentRead: true,
    }),
  );

  return NextResponse.json({
    ok: true,
    created: false,
    item: refreshed.Item ?? null,
  });
}

// ============================================================
// AMR IMPORT SUPPORT
// ============================================================

const READINGS_TABLE = TABLE_NAME;
const METERS_TABLE = "p72-CUBE-METERS";
const MAPPINGS_TABLE = "p72-CUBE-METER-MAPPINGS";
const INV_READ_METHODS_TABLE = "p72-CUBE-INV-READ-METHODS";
const BILLING_PERIOD_INDEX = "billing-period-index";
const FY_INDEX = "fy-index";

const MAX_CONCURRENT_WRITES = 8;

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

const FISCAL_MONTH_ORDER = [
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

type CsvSourceRow = {
  fileName: string;
  sourceRow: number;
  interval: string;
  meterUnit: string;
  dataValueText: string;
};

type ParsedCandidate = CsvSourceRow & {
  fy: number;
  month: string;
  meterid: string;
  csvFacilityNbr: string;
  dataValue: number | null;
};

type PreviewRow = {
  status: "ready" | "error" | "existing" | "mapping";
  sourceMeterid: string;
  meterid: string;
  mappedBy: "direct" | "saved" | "";
  mappingAllowed: boolean;
  sourceFile: string;
  sourceRow: number;
  csvFacilityNbr: string;
  masterFacilityNbr: string;
  dataValue: number | null;
  adjustedConsumption: number | null;
  existingReading: number | null;
  existingConsumption: number | null;
  correctionRule: string;
  usedInCalculation: number;
  reason: string;
  warnings: string[];
};

type MeterOption = {
  meterid: string;
  facility_nbr: string;
  utility_type_cd: string;
  site_cd: string;
  sub_inst_cd: string;
  meter_type_cd: string;
  serial_nbr: string;
  narrative: string;
};

type PreparedItem = {
  item: Record<string, unknown>;
  preview: PreviewRow;
  mode: "create" | "overwrite" | "completeMissingRaw";
};

function amrTextValue(value: unknown) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

function numericValue(value: unknown): number | null {
  const raw = amrTextValue(value);

  // Preserve blank/non-numeric AMR values as null. Treating them as zero can
  // create a false rollover or a false zero reading.
  if (!raw) return null;

  const parsed = Number(raw.replace(/[$,]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function convertAMRDataValue(
  meterid: string,
  value: number | null,
): number | null {
  if (value === null) return null;

  // G* AMR meters are reported in MCF.
  // CUBE stores gas readings/consumption in CF.
  return meterid.toUpperCase().startsWith("G")
    ? value * 1000
    : value;
}

function normalizeMonth(value: unknown) {
  const raw = amrTextValue(value).toLowerCase();

  return (
    MONTHS.find((month) => month.toLowerCase() === raw) ??
    ""
  );
}

function expectedBillingPeriodId(fy: number, month: string) {
  const anchorFY = 2025;
  const anchorMonth = "September";
  const anchorBillingPeriodId = 170;

  const targetIndex = FISCAL_MONTH_ORDER.indexOf(month);
  const anchorIndex = FISCAL_MONTH_ORDER.indexOf(anchorMonth);

  if (!Number.isInteger(fy) || targetIndex < 0 || anchorIndex < 0) {
    return null;
  }

  return (
    anchorBillingPeriodId +
    (fy - anchorFY) * 12 +
    (targetIndex - anchorIndex)
  );
}

function periodFromFiscalMonth(fy: number, month: string) {
  const monthIndex = MONTHS.indexOf(month);

  if (monthIndex < 0 || !Number.isInteger(fy)) {
    return "";
  }

  const calendarYear =
    monthIndex >= 9
      ? fy - 1
      : fy;

  return `${calendarYear}-${String(monthIndex + 1).padStart(2, "0")}`;
}

function parseInterval(value: string) {
  const match = amrTextValue(value).match(
    /^(\d{4})\s*-\s*([A-Za-z]+)\s*$/,
  );

  if (!match) {
    return null;
  }

  const fy = Number(match[1]);
  const month = normalizeMonth(match[2]);

  if (!Number.isInteger(fy) || !month) {
    return null;
  }

  return {
    fy,
    month,
  };
}

// Meter ID is preserved exactly.
// ONLY the facility/building portion has leading zeroes removed.
//
// Examples:
//   G0129_1055 (mcf) -> meterid G0129, facility 1055
//   E1770_0477 (kWh) -> meterid E1770, facility 477
function sourceMeterKeyFromMeterUnit(
  value: string,
) {
  const raw = amrTextValue(value);

  if (!raw) {
    return "";
  }

  const unitMarker =
    raw.indexOf(" (");

  const core =
    (unitMarker >= 0
      ? raw.slice(0, unitMarker)
      : raw
    ).trim();

  if (!core) {
    return "";
  }

  const underscore =
    core.indexOf("_");

  if (underscore > 0) {
    return core
      .slice(0, underscore)
      .trim();
  }

  // If the export did not contain the normal meter_facility pattern,
  // preserve the full source label as the mapping key so the user can
  // still map it once and reuse that mapping on future imports.
  return core;
}

function parseMeterUnit(value: string) {
  const raw = amrTextValue(value);

  if (!raw) {
    return null;
  }

  // Remove the displayed engineering unit by cutting at the
  // first " (" rather than trying to parse nested parentheses
  // such as "(gal (US))".
  const unitMarker = raw.indexOf(" (");

  const core =
    (unitMarker >= 0
      ? raw.slice(0, unitMarker)
      : raw
    ).trim();

  const underscore = core.indexOf("_");

  if (underscore <= 0 || underscore >= core.length - 1) {
    return null;
  }

  const meterid =
    core.slice(0, underscore).trim();

  const facilityRaw =
    core.slice(underscore + 1).trim();

  const csvFacilityNbr =
    facilityRaw.replace(/^0+(?=\d)/, "");

  if (!meterid || !csvFacilityNbr) {
    return null;
  }

  return {
    meterid,
    csvFacilityNbr,
  };
}

function parseCSV(csv: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let index = 0; index < csv.length; index++) {
    const char = csv[index];
    const next = csv[index + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        field += '"';
        index++;
        continue;
      }

      inQuotes = !inQuotes;
      continue;
    }

    if (char === "," && !inQuotes) {
      row.push(field);
      field = "";
      continue;
    }

    if ((char === "\r" || char === "\n") && !inQuotes) {
      if (char === "\r" && next === "\n") {
        index++;
      }

      row.push(field);
      field = "";

      if (row.some((value) => value.trim() !== "")) {
        rows.push(row);
      }

      row = [];
      continue;
    }

    field += char;
  }

  row.push(field);

  if (row.some((value) => value.trim() !== "")) {
    rows.push(row);
  }

  return rows;
}

function normalizeHeader(value: unknown) {
  return amrTextValue(value)
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function extractAMRRows(
  csv: string,
  fileName: string,
): CsvSourceRow[] {
  const rows = parseCSV(csv.replace(/^\uFEFF/, ""));

  const headerRowIndex = rows.findIndex((row) => {
    const normalized = row.map(normalizeHeader);

    return (
      normalized.includes("interval") &&
      normalized.includes("meter_unit") &&
      normalized.includes("datavalue")
    );
  });

  if (headerRowIndex < 0) {
    throw new Error(
      `${fileName}: could not find Interval, Meter_Unit, and DataValue headers.`,
    );
  }

  const normalizedHeaders =
    rows[headerRowIndex].map(normalizeHeader);

  const intervalIndex =
    normalizedHeaders.indexOf("interval");

  const meterUnitIndex =
    normalizedHeaders.indexOf("meter_unit");

  const dataValueIndex =
    normalizedHeaders.indexOf("datavalue");

  const maxIndex = Math.max(
    intervalIndex,
    meterUnitIndex,
    dataValueIndex,
  );

  const sourceRows: CsvSourceRow[] = [];

  rows
    .slice(headerRowIndex + 1)
    .forEach((row, relativeIndex) => {
      if (row.length <= maxIndex) {
        return;
      }

      const interval =
        amrTextValue(row[intervalIndex]);

      const meterUnit =
        amrTextValue(row[meterUnitIndex]);

      // Footer/weather rows do not have an Interval in the
      // "YYYY - Month" format and are ignored.
      if (!parseInterval(interval)) {
        return;
      }

      sourceRows.push({
        fileName,
        sourceRow: headerRowIndex + relativeIndex + 2,
        interval,
        meterUnit,
        dataValueText: amrTextValue(row[dataValueIndex]),
      });
    });

  return sourceRows;
}

async function scanMeters() {
  const items: Record<string, unknown>[] = [];

  let exclusiveStartKey:
    | ScanCommandInput["ExclusiveStartKey"]
    | undefined;

  do {
    const result = await ddb.send(
      new ScanCommand({
        TableName: METERS_TABLE,
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );

    items.push(
      ...((result.Items ?? []) as Record<string, unknown>[]),
    );

    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);

  return items;
}


async function scanInvReadMethods() {
  const items: Record<string, unknown>[] = [];
  let exclusiveStartKey: ScanCommandInput["ExclusiveStartKey"] | undefined;

  do {
    const result = await ddb.send(
      new ScanCommand({
        TableName: INV_READ_METHODS_TABLE,
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );
    items.push(...((result.Items ?? []) as Record<string, unknown>[]));
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);

  return items;
}

type ReadingSource = "AMR" | "MANUAL";

type InvReadMethodConfig = {
  methodId: number;
  methodName: string;
  rolloverUsed: boolean;
  source: ReadingSource;
};

function readMethodField(
  item: Record<string, unknown>,
  ...names: string[]
) {
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(item, name)) {
      return item[name];
    }
  }
  return undefined;
}

function buildInvReadMethodMap(
  items: Record<string, unknown>[],
) {
  const map = new Map<number, InvReadMethodConfig>();

  for (const item of items) {
    const methodId = optionalNumber(
      readMethodField(item, "inv_read_method_id", "INV_READ_METHOD_ID"),
    );

    if (methodId === undefined) continue;

    const methodName = amrTextValue(
      readMethodField(item, "inv_read_method", "INV_READ_METHOD"),
    );

    const rolloverValue = optionalNumber(
      readMethodField(item, "rollover_used", "ROLLOVER_USED"),
    );

    // Import authority follows the CUBE inventory-read-method definition:
    //   1 AMR, 6 ESPC AMR                  -> AMR import
    //   2 Manual, 3 TBD, 4 Removed, 5 NONE,
    //   8 Virtual Meter, 9 AMR/ESPC Manual -> Manual import
    const source: ReadingSource =
      methodId === 1 || methodId === 6 ? "AMR" : "MANUAL";

    map.set(methodId, {
      methodId,
      methodName,
      rolloverUsed: rolloverValue === 1,
      source,
    });
  }

  return map;
}

function authoritativeReadingSource(
  meter: Record<string, unknown>,
  readMethodMap: Map<number, InvReadMethodConfig>,
) {
  const methodId = optionalNumber(meter.inv_read_method_id);

  if (methodId === undefined || !readMethodMap.has(methodId)) {
    return {
      source: null as ReadingSource | null,
      methodId: methodId ?? null,
      methodName: "",
      rolloverUsed: false,
      valid: false,
      reason: `Meter ${amrTextValue(meter.meterid)} has a missing or invalid inv_read_method_id in ${METERS_TABLE}.`,
    };
  }

  const config = readMethodMap.get(methodId)!;

  return {
    source: config.source,
    methodId,
    methodName: config.methodName,
    rolloverUsed: config.rolloverUsed,
    valid: true,
    reason: "",
  };
}

async function scanMappings() {
  const items: Record<string, unknown>[] = [];

  let exclusiveStartKey:
    | ScanCommandInput["ExclusiveStartKey"]
    | undefined;

  do {
    const result = await ddb.send(
      new ScanCommand({
        TableName: MAPPINGS_TABLE,
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );

    items.push(
      ...((result.Items ?? []) as Record<string, unknown>[]),
    );

    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);

  return items;
}

function toMeterOption(
  meter: Record<string, unknown>,
): MeterOption {
  return {
    meterid: amrTextValue(meter.meterid),
    facility_nbr: amrTextValue(meter.facility_nbr),
    utility_type_cd: amrTextValue(meter.utility_type_cd),
    site_cd: amrTextValue(meter.site_cd),
    sub_inst_cd: amrTextValue(meter.sub_inst_cd),
    meter_type_cd: amrTextValue(meter.meter_type_cd),
    serial_nbr: amrTextValue(meter.serial_nbr),
    narrative: amrTextValue(meter.narrative),
  };
}

async function queryBillingPeriod(
  billingPeriodId: number,
) {
  const items: Record<string, unknown>[] = [];

  let exclusiveStartKey:
    | QueryCommandInput["ExclusiveStartKey"]
    | undefined;

  do {
    const result = await ddb.send(
      new QueryCommand({
        TableName: READINGS_TABLE,
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

    items.push(
      ...((result.Items ?? []) as Record<string, unknown>[]),
    );

    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);

  return items;
}

function effectiveStoredConsumption(
  item: Record<string, unknown> | undefined,
) {
  if (!item) return undefined;
  return optionalNumber(item.adjusted_consumption) ?? optionalNumber(item.consumption);
}

async function findBillingPeriodIdByFiscalMonth(
  fy: number,
  month: string,
): Promise<number | undefined> {
  let exclusiveStartKey: QueryCommandInput["ExclusiveStartKey"];

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
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );

    const match = result.Items?.find(
      (item) => optionalNumber(item.billing_period_id) !== undefined,
    );
    const billingPeriodId = match
      ? optionalNumber(match.billing_period_id)
      : undefined;
    if (billingPeriodId !== undefined) return billingPeriodId;

    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);

  return undefined;
}

async function queryPriorYearBillingPeriod(
  current: Record<string, unknown> | undefined,
  currentBillingPeriodId: number,
) {
  const currentFY = current ? optionalNumber(current.fy) : undefined;
  const currentMonth = textValue(current?.billing_month_nm);

  if (currentFY !== undefined && currentMonth) {
    const priorYearBillingPeriodId = await findBillingPeriodIdByFiscalMonth(
      currentFY - 1,
      currentMonth,
    );

    if (priorYearBillingPeriodId === undefined) return [];
    return queryBillingPeriod(priorYearBillingPeriodId);
  }

  return queryBillingPeriod(currentBillingPeriodId - 12);
}

function recordByMeter(
  items: Record<string, unknown>[],
) {
  const map =
    new Map<string, Record<string, unknown>>();

  for (const item of items) {
    const meterid =
      amrTextValue(item.meterid);

    if (meterid) {
      map.set(meterid, item);
    }
  }

  return map;
}

function chooseCandidate(
  candidates: ParsedCandidate[],
  masterFacilityNbr: string,
) {
  const exactFacility =
    candidates.filter(
      (candidate) =>
        candidate.csvFacilityNbr === masterFacilityNbr,
    );

  // The meter master is authoritative. If one AMR row names the
  // facility exactly like the master, prefer that row. This also
  // resolves cases where the same meter appears in multiple AMR
  // reports under different building labels.
  const pool =
    exactFacility.length > 0
      ? exactFacility
      : candidates;

  const usable =
    pool.filter(
      (candidate) =>
        candidate.dataValue !== null,
    );

  if (usable.length === 0) {
    return {
      candidate: pool[0] ?? candidates[0],
      conflict: false,
      missingDataValue: true,
    };
  }

  const distinctValues =
    new Set(
      usable.map(
        (candidate) =>
          String(candidate.dataValue),
      ),
    );

  if (distinctValues.size > 1) {
    return {
      candidate: usable[0],
      conflict: true,
      missingDataValue: false,
    };
  }

  return {
    candidate: usable[0],
    conflict: false,
    missingDataValue: false,
  };
}

function addOptionalText(
  item: Record<string, unknown>,
  name: string,
  value: unknown,
) {
  const normalized = amrTextValue(value);

  if (normalized) {
    item[name] = normalized;
  }
}

function addOptionalNumber(
  item: Record<string, unknown>,
  name: string,
  value: unknown,
) {
  const normalized = numericValue(value);

  if (normalized !== null) {
    item[name] = normalized;
  }
}


const MANUAL_CORRECTION_RULES =
  new Set(["f", "g", "h", "i", "k"]);

function normalizedCorrectionRule(value: unknown) {
  return amrTextValue(value).toLowerCase();
}

function usableServerConsumption(
  item: Record<string, unknown> | undefined,
) {
  if (!item) {
    return null;
  }

  const adjusted =
    optionalNumber(item.adjusted_consumption);

  if (adjusted !== undefined) {
    return adjusted;
  }

  const consumption =
    optionalNumber(item.consumption);

  return consumption ?? null;
}

function calculateImportedAdjustedConsumption(
  ruleValue: unknown,
  rawConsumption: number,
  previous1: Record<string, unknown> | undefined,
  previous2: Record<string, unknown> | undefined,
  previous3: Record<string, unknown> | undefined,
  next1: Record<string, unknown> | undefined,
  priorYear: Record<string, unknown> | undefined,
) {
  const rule =
    normalizedCorrectionRule(ruleValue);

  if (!rule) {
    return rawConsumption;
  }

  if (MANUAL_CORRECTION_RULES.has(rule)) {
    return undefined;
  }

  const p1 =
    usableServerConsumption(previous1);

  const p2 =
    usableServerConsumption(previous2);

  const p3 =
    usableServerConsumption(previous3);

  const n1 =
    usableServerConsumption(next1);

  const py =
    usableServerConsumption(priorYear);

  switch (rule) {
    case "a":
      return p1 !== null && n1 !== null
        ? (p1 + n1) / 2
        : undefined;

    case "b":
      return (
        p1 !== null &&
        p2 !== null &&
        p3 !== null
      )
        ? (p1 + p2 + p3) / 3
        : undefined;

    case "c":
      return p1 !== null
        ? p1
        : undefined;

    case "d":
      return n1 !== null
        ? n1
        : undefined;

    case "e":
      return py !== null
        ? py
        : undefined;

    case "j":
    case "l":
      return 0;

    default:
      return undefined;
  }
}


const VALIDATION_DEVIATION_THRESHOLD_PCT = 50;

// Manual-reading safety gates.
// A tiny source/DB precision difference must never manufacture a rollover.
const MANUAL_READING_TOLERANCE = 0.5;

// A Manual monthly consumption greater than 3x the median of available
// recent/prior-year valid consumptions is quarantined for DIVA review.
const MANUAL_EXTREME_CONSUMPTION_MULTIPLIER = 3;


type ImportValidationResult = {
  validation_required: 0 | 1;
  validation_status: "PENDING" | "CLEAR";
  validation_rule_ids: string[];
  validation_prev_month_pct?: number;
  validation_prev_year_pct?: number;
  validation_checked_at: string;
  validation_action?: string;
};

function percentageDeviation(
  currentValue: number,
  baselineValue: number | null,
) {
  if (
    baselineValue === null ||
    !Number.isFinite(currentValue) ||
    !Number.isFinite(baselineValue)
  ) {
    return undefined;
  }

  if (baselineValue === 0) {
    return currentValue === 0 ? 0 : undefined;
  }

  return ((currentValue - baselineValue) / Math.abs(baselineValue)) * 100;
}

function evaluateImportValidation(
  effectiveConsumption: number,
  previousMonth: Record<string, unknown> | undefined,
  priorYear: Record<string, unknown> | undefined,
  _allowAutoCorrection = true,
  zeroToPositiveQuarantine = false,
): ImportValidationResult {
  const ruleIds: string[] = [];
  const previousMonthConsumption = usableServerConsumption(previousMonth);
  const priorYearConsumption = usableServerConsumption(priorYear);

  // AMR zero-baseline safety must inspect the PREVIOUS RAW PERIOD CONSUMPTION,
  // not adjusted_consumption. usableServerConsumption() intentionally prefers
  // adjusted_consumption for normal DIVA comparisons, but that can hide a raw
  // 0 -> positive AMR jump when the previous record has a correction rule.
  //
  // Example: previous raw consumption = 0, previous adjusted_consumption > 0,
  // current AMR DataValue = 97,119,984. This must still be quarantined.
  const previousRawConsumption =
    previousMonth === undefined
      ? null
      : optionalNumber(previousMonth.consumption) ?? null;

  if (
    zeroToPositiveQuarantine &&
    previousMonth !== undefined &&
    previousRawConsumption === 0 &&
    effectiveConsumption > 0
  ) {
    return {
      validation_required: 1,
      validation_status: "PENDING",
      validation_rule_ids: ["READING_PREV_MONTH_ZERO_TO_POSITIVE"],
      validation_action: "AMR_QUARANTINED",
      validation_checked_at: new Date().toISOString(),
    };
  }

  const previousMonthPct = percentageDeviation(
    effectiveConsumption,
    previousMonthConsumption,
  );
  const priorYearPct = percentageDeviation(
    effectiveConsumption,
    priorYearConsumption,
  );

  // DIVA Rule 1: Previous Year.
  // PASS is strictly inside (-50%, +50%). Exactly +/-50% is a FAIL.
  const priorYearFailed =
    priorYearPct !== undefined &&
    Math.abs(priorYearPct) >= VALIDATION_DEVIATION_THRESHOLD_PCT;

  if (priorYearFailed) {
    ruleIds.push("READING_PREV_YEAR_50");
  }

  // DIVA Rule 2: Previous Month. Only evaluated after Rule 1 fails.
  const previousMonthFailed =
    priorYearFailed &&
    previousMonthPct !== undefined &&
    Math.abs(previousMonthPct) >= VALIDATION_DEVIATION_THRESHOLD_PCT;

  if (previousMonthFailed) {
    ruleIds.push("READING_PREV_MONTH_50");
  }

  const bothRulesFailed = priorYearFailed && previousMonthFailed;

  // Failed DIVA validation is review-only. Do not automatically apply Rule E
  // or change Adjusted Consumption during upload. The reading is quarantined
  // for Data Validation so a correction can be selected deliberately.
  return {
    validation_required: bothRulesFailed ? 1 : 0,
    validation_status: bothRulesFailed ? "PENDING" : "CLEAR",
    validation_rule_ids: ruleIds,
    ...(previousMonthPct !== undefined
      ? { validation_prev_month_pct: previousMonthPct }
      : {}),
    ...(priorYearPct !== undefined
      ? { validation_prev_year_pct: priorYearPct }
      : {}),
    validation_checked_at: new Date().toISOString(),
  };
}

function applyValidationFields(
  item: Record<string, unknown>,
  effectiveConsumption: number,
  previousMonth: Record<string, unknown> | undefined,
  priorYear: Record<string, unknown> | undefined,
  _allowAutoCorrection = true,
  zeroToPositiveQuarantine = false,
) {
  const validation = evaluateImportValidation(
    effectiveConsumption,
    previousMonth,
    priorYear,
    _allowAutoCorrection,
    zeroToPositiveQuarantine,
  );

  Object.assign(item, validation);

  // Any unresolved validation is a hard billing gate. This is especially
  // important for AMR zero -> positive quarantine: preserve the source reading
  // and consumption for review, but exclude it from Monthly Summary/billing.
  if (validation.validation_required === 1) {
    item.used_in_calculation = 0;
  }
}

async function buildPreview(
  files: File[],
  selectedFY: number,
  selectedMonth: string,
  billingPeriodId: number,
  overwriteMeterIds: Set<string> = new Set(),
) {
  const [
    meterItems,
    mappingItems,
    readMethodItems,
    previousPeriodItems,
    previous2PeriodItems,
    previous3PeriodItems,
    currentPeriodItems,
    nextPeriodItems,
    priorYearPeriodItems,
  ] = await Promise.all([
    scanMeters(),
    scanMappings(),
    scanInvReadMethods(),
    queryBillingPeriod(billingPeriodId - 1),
    queryBillingPeriod(billingPeriodId - 2),
    queryBillingPeriod(billingPeriodId - 3),
    queryBillingPeriod(billingPeriodId),
    queryBillingPeriod(billingPeriodId + 1),
    queryBillingPeriod(billingPeriodId - 12),
  ]);

  const meterMap =
    new Map<string, Record<string, unknown>>();

  for (const meter of meterItems) {
    const meterid =
      amrTextValue(meter.meterid);

    if (meterid) {
      meterMap.set(meterid, meter);
    }
  }

  const mappingMap =
    new Map<string, Record<string, unknown>>();

  for (const mapping of mappingItems) {
    const sourceMeterid =
      amrTextValue(mapping.source_meterid);

    if (sourceMeterid) {
      mappingMap.set(sourceMeterid, mapping);
    }
  }

  const readMethodMap = buildInvReadMethodMap(readMethodItems);

  const meterOptions =
    meterItems
      .map(toMeterOption)
      .filter((meter) => meter.meterid)
      .sort((a, b) => {
        const facility =
          a.facility_nbr.localeCompare(
            b.facility_nbr,
            undefined,
            {
              numeric: true,
              sensitivity: "base",
            },
          );

        if (facility !== 0) return facility;

        return a.meterid.localeCompare(
          b.meterid,
          undefined,
          {
            numeric: true,
            sensitivity: "base",
          },
        );
      });

  const previousMap =
    recordByMeter(previousPeriodItems);

  const previous2Map =
    recordByMeter(previous2PeriodItems);

  const previous3Map =
    recordByMeter(previous3PeriodItems);

  const currentMap =
    recordByMeter(currentPeriodItems);

  const nextMap =
    recordByMeter(nextPeriodItems);

  const priorYearMap =
    recordByMeter(priorYearPeriodItems);

  const parsedCandidates: ParsedCandidate[] = [];
  const directErrors: PreviewRow[] = [];

  let sourceRows = 0;

  for (const file of files) {
    const csv =
      await file.text();

    const source =
      extractAMRRows(csv, file.name);

    sourceRows += source.length;

    for (const row of source) {
      const interval =
        parseInterval(row.interval);

      const meterUnit =
        parseMeterUnit(row.meterUnit);

      if (!interval) {
        directErrors.push({
          status: "error",
          sourceMeterid: "",
          meterid: "",
          mappedBy: "",
          mappingAllowed: false,
          sourceFile: row.fileName,
          sourceRow: row.sourceRow,
          csvFacilityNbr: "",
          masterFacilityNbr: "",
          dataValue: null,
          adjustedConsumption: null,
          existingReading: null,
          existingConsumption: null,
          correctionRule: "",
          usedInCalculation: 0,
          reason: "Invalid Interval value.",
          warnings: [],
        });

        continue;
      }

      if (
        interval.fy !== selectedFY ||
        interval.month !== selectedMonth
      ) {
        directErrors.push({
          status: "error",
          sourceMeterid: meterUnit?.meterid ?? "",
          meterid: "",
          mappedBy: "",
          mappingAllowed: false,
          sourceFile: row.fileName,
          sourceRow: row.sourceRow,
          csvFacilityNbr: meterUnit?.csvFacilityNbr ?? "",
          masterFacilityNbr: "",
          dataValue: numericValue(row.dataValueText),
          adjustedConsumption: null,
          existingReading: null,
          existingConsumption: null,
          correctionRule: "",
          usedInCalculation: 0,
          reason:
            `CSV row is ${interval.month} FY${interval.fy}; selected period is ${selectedMonth} FY${selectedFY}.`,
          warnings: [],
        });

        continue;
      }

      if (!meterUnit) {
        const fallbackSourceMeterid =
          sourceMeterKeyFromMeterUnit(
            row.meterUnit,
          );

        directErrors.push({
          status: "error",
          sourceMeterid: fallbackSourceMeterid,
          meterid: "",
          mappedBy: "",
          mappingAllowed: Boolean(fallbackSourceMeterid),
          sourceFile: row.fileName,
          sourceRow: row.sourceRow,
          csvFacilityNbr: "",
          masterFacilityNbr: "",
          dataValue: numericValue(row.dataValueText),
          adjustedConsumption: null,
          existingReading: null,
          existingConsumption: null,
          correctionRule: "",
          usedInCalculation: 0,
          reason: fallbackSourceMeterid
            ? `Unable to parse Meter_Unit "${row.meterUnit}" into the normal meter/facility format. You can map source "${fallbackSourceMeterid}" to an existing CUBE meter.`
            : `Unable to split Meter_Unit "${row.meterUnit}".`,
          warnings: [],
        });

        continue;
      }

      parsedCandidates.push({
        ...row,
        fy: interval.fy,
        month: interval.month,
        meterid: meterUnit.meterid,
        csvFacilityNbr: meterUnit.csvFacilityNbr,
        dataValue: convertAMRDataValue(
          meterUnit.meterid,
          numericValue(row.dataValueText),
        ),
      });
    }
  }

  const grouped =
    new Map<string, ParsedCandidate[]>();

  for (const candidate of parsedCandidates) {
    const list =
      grouped.get(candidate.meterid) ?? [];

    list.push(candidate);
    grouped.set(candidate.meterid, list);
  }

  const prepared: PreparedItem[] = [];
  const previewRows: PreviewRow[] = [...directErrors];

  let duplicateRowsRemoved = 0;
  let facilityWarnings = 0;
  let conflicts = 0;
  let missingMeters = 0;
  let blankDataValues = 0;
  let existingReadings = 0;
  let mappingsNeeded = 0;
  let savedMappingsUsed = 0;
  let authoritySkipped = 0;
  let invalidReadMethod = 0;

  // Prevent two different source meter IDs from silently resolving to the
  // same target CUBE meter in one upload.
  const claimedTargets =
    new Map<string, string>();

  for (const [sourceMeterid, candidates] of grouped) {
    duplicateRowsRemoved += Math.max(0, candidates.length - 1);

    let resolvedMeterid = sourceMeterid;
    let mappedBy: "direct" | "saved" | "" = "";
    let master = meterMap.get(sourceMeterid);

    if (master) {
      mappedBy = "direct";
    } else {
      const savedMapping =
        mappingMap.get(sourceMeterid);

      const savedTarget =
        savedMapping
          ? amrTextValue(savedMapping.mapped_meterid)
          : "";

      if (savedTarget) {
        const mappedMaster =
          meterMap.get(savedTarget);

        if (mappedMaster) {
          resolvedMeterid = savedTarget;
          master = mappedMaster;
          mappedBy = "saved";
          savedMappingsUsed++;
        } else {
          mappingsNeeded++;

          const candidate = candidates[0];

          previewRows.push({
            status: "mapping",
            sourceMeterid,
            meterid: savedTarget,
            mappedBy: "",
            mappingAllowed: true,
            sourceFile: candidate.fileName,
            sourceRow: candidate.sourceRow,
            csvFacilityNbr: candidate.csvFacilityNbr,
            masterFacilityNbr: "",
            dataValue: candidate.dataValue,
            adjustedConsumption: null,
            existingReading: null,
            existingConsumption: null,
            correctionRule: "",
            usedInCalculation: 0,
            reason:
              `Saved mapping points to "${savedTarget}", but that meter no longer exists in ${METERS_TABLE}. Select a replacement meter.`,
            warnings: [],
          });

          continue;
        }
      } else {
        mappingsNeeded++;
        missingMeters++;

        const candidate = candidates[0];

        previewRows.push({
            status: "mapping",
            sourceMeterid,
            meterid: "",
            mappedBy: "",
            mappingAllowed: true,
            sourceFile: candidate.fileName,
            sourceRow: candidate.sourceRow,
            csvFacilityNbr: candidate.csvFacilityNbr,
            masterFacilityNbr: "",
            dataValue: candidate.dataValue,
            adjustedConsumption: null,
            existingReading: null,
            existingConsumption: null,
            correctionRule: "",
            usedInCalculation: 0,
            reason:
                `Meter ${sourceMeterid} does not directly match a CUBE meter. Select the correct meter and save the mapping.`,
            warnings: [],
            });

        continue;
      }
    }

    if (!master) {
      continue;
    }

    const authority = authoritativeReadingSource(master, readMethodMap);
    if (!authority.valid || authority.source !== "AMR") {
      const candidate = candidates[0];
      if (!authority.valid) invalidReadMethod++;
      else authoritySkipped++;

      previewRows.push({
        status: "error",
        sourceMeterid,
        meterid: resolvedMeterid,
        mappedBy,
        mappingAllowed: false,
        sourceFile: candidate.fileName,
        sourceRow: candidate.sourceRow,
        csvFacilityNbr: candidate.csvFacilityNbr,
        masterFacilityNbr: amrTextValue(master.facility_nbr),
        dataValue: candidate.dataValue,
        adjustedConsumption: null,
        existingReading: null,
        existingConsumption: null,
        correctionRule: "",
        usedInCalculation: 0,
        reason: !authority.valid
          ? authority.reason
          : authority.source === "MANUAL"
            ? `Skipped: meter ${resolvedMeterid} uses ${authority.methodName || `inventory read method ${authority.methodId}`}, which is Manual-authoritative. AMR cannot replace its reading.`
            : authority.reason,
        warnings: [],
      });
      continue;
    }

    const alreadyClaimedBy =
      claimedTargets.get(resolvedMeterid);

    if (
      alreadyClaimedBy &&
      alreadyClaimedBy !== sourceMeterid
    ) {
      conflicts++;

      const candidate = candidates[0];

      previewRows.push({
        status: "error",
        sourceMeterid,
        meterid: resolvedMeterid,
        mappedBy,
        mappingAllowed: true,
        sourceFile: candidate.fileName,
        sourceRow: candidate.sourceRow,
        csvFacilityNbr: candidate.csvFacilityNbr,
        masterFacilityNbr: amrTextValue(master.facility_nbr),
        dataValue: candidate.dataValue,
        adjustedConsumption: null,
        existingReading: null,
        existingConsumption: null,
        correctionRule: "",
        usedInCalculation: 0,
        reason:
          `Source meter "${sourceMeterid}" and "${alreadyClaimedBy}" both resolve to CUBE meter "${resolvedMeterid}" in this upload. Resolve the duplicate mapping before importing.`,
        warnings: [],
      });

      continue;
    }

    claimedTargets.set(
      resolvedMeterid,
      sourceMeterid,
    );

    const masterFacilityNbr =
      amrTextValue(master.facility_nbr);

    const selected =
      chooseCandidate(
        candidates,
        masterFacilityNbr,
      );

    const candidate =
      selected.candidate;

    if (selected.missingDataValue) {
      blankDataValues++;

      previewRows.push({
        status: "error",
        sourceMeterid,
        meterid: resolvedMeterid,
        mappedBy,
        mappingAllowed: false,
        sourceFile: candidate.fileName,
        sourceRow: candidate.sourceRow,
        csvFacilityNbr: candidate.csvFacilityNbr,
        masterFacilityNbr,
        dataValue: null,
        adjustedConsumption: null,
        existingReading: null,
        existingConsumption: null,
        correctionRule: "",
        usedInCalculation: 0,
        reason: "DataValue is blank or is not numeric.",
        warnings: [],
      });

      continue;
    }

    if (selected.conflict) {
      conflicts++;

      previewRows.push({
        status: "error",
        sourceMeterid,
        meterid: resolvedMeterid,
        mappedBy,
        mappingAllowed: false,
        sourceFile: candidate.fileName,
        sourceRow: candidate.sourceRow,
        csvFacilityNbr: candidate.csvFacilityNbr,
        masterFacilityNbr,
        dataValue: candidate.dataValue,
        adjustedConsumption: null,
        existingReading: null,
        existingConsumption: null,
        correctionRule: "",
        usedInCalculation: 0,
        reason:
          "Multiple AMR rows for this source meter match the preferred facility but contain different DataValue values.",
        warnings: [],
      });

      continue;
    }

    const previous =
      previousMap.get(resolvedMeterid);

    const storedCurrent =
      currentMap.get(resolvedMeterid);

    const existingWithoutRaw =
      isRawReadingMissing(storedCurrent)
        ? storedCurrent
        : undefined;

    const current =
      existingWithoutRaw ? undefined : storedCurrent;

    const inheritedRule =
      existingWithoutRaw
        ? amrTextValue(existingWithoutRaw.meter_correction_rule_cd)
        : previous
        ? amrTextValue(previous.meter_correction_rule_cd)
        : "";

    const normalizedInheritedRule =
      normalizedCorrectionRule(inheritedRule);

    const reverseMeter =
      normalizedInheritedRule === "m";

    // Preserve the prior decision when one exists. A meter with no prior
    // reading has no prior decision, so it must start unused and require a
    // deliberate review in the Review Readings table.
    const inheritedUsed =
      existingWithoutRaw
        ? originalUsedValue(existingWithoutRaw)
        : originalUsedValue(previous);

    const warnings: string[] = [];

    if (
      mappedBy === "saved" &&
      sourceMeterid !== resolvedMeterid
    ) {
      warnings.push(
        `Saved mapping applied: ${sourceMeterid} -> ${resolvedMeterid}.`,
      );
    }

    if (
      masterFacilityNbr &&
      candidate.csvFacilityNbr !== masterFacilityNbr
    ) {
      facilityWarnings++;

      warnings.push(
        `CSV facility "${candidate.csvFacilityNbr}" differs from meter master facility "${masterFacilityNbr}". Meter master value will be used.`,
      );
    }

    const candidateReading = candidate.dataValue;

    // chooseCandidate already flags this, but keep a hard guard here so a
    // blank/non-numeric DataValue can never be written as zero.
    if (candidateReading === null) {
      blankDataValues++;
      previewRows.push({
        status: "error",
        sourceMeterid,
        meterid: resolvedMeterid,
        mappedBy,
        mappingAllowed: false,
        sourceFile: candidate.fileName,
        sourceRow: candidate.sourceRow,
        csvFacilityNbr: candidate.csvFacilityNbr,
        masterFacilityNbr,
        dataValue: null,
        adjustedConsumption: null,
        existingReading: null,
        existingConsumption: null,
        correctionRule: inheritedRule,
        usedInCalculation: inheritedUsed,
        reason: "DataValue is blank or is not numeric.",
        warnings,
      });
      continue;
    }

    if (current) {
      existingReadings++;

      const currentRule =
        amrTextValue(current.meter_correction_rule_cd);

      const currentUsed =
        Number(current.used_in_calculation) === 1
          ? 1
          : 0;

      const existingReading =
        numericValue(current.reading);

      const existingConsumption =
        numericValue(current.consumption);

      const existingPreview: PreviewRow = {
        status: "existing",
        sourceMeterid,
        meterid: resolvedMeterid,
        mappedBy,
        mappingAllowed: false,
        sourceFile: candidate.fileName,
        sourceRow: candidate.sourceRow,
        csvFacilityNbr: candidate.csvFacilityNbr,
        masterFacilityNbr,
        dataValue: candidateReading,
        adjustedConsumption:
          optionalNumber(current.adjusted_consumption) ?? null,
        existingReading,
        existingConsumption,
        correctionRule: currentRule,
        usedInCalculation: currentUsed,
        reason:
          `An existing raw reading is already stored for Billing Period ${billingPeriodId}. Raw readings are locked; this upload will only refresh validation fields.`,
        warnings,
      };

      previewRows.push(existingPreview);

      const overwriteItem: Record<string, unknown> = {
        meterid: resolvedMeterid,
        period: periodFromFiscalMonth(
          selectedFY,
          selectedMonth,
        ),
        billing_period_id: billingPeriodId,
      };

      // Existing raw reading/consumption/source/ZeroReadingStreak are immutable.
      applyValidationFields(
        overwriteItem,
        optionalNumber(current.adjusted_consumption) ??
          optionalNumber(current.consumption) ??
          0,
        previous,
        priorYearMap.get(resolvedMeterid),
        true,
        true,
      );

      prepared.push({
        item: overwriteItem,
        preview: existingPreview,
        mode: "overwrite",
      });

      continue;
    }

    // AMR DataValue is already the authoritative consumption for this
    // billing period. It is not a cumulative register reading and must never
    // require, subtract, roll over, or otherwise calculate from a previous
    // meter reading.
    const consumption = candidateReading;

    const item: Record<string, unknown> = {
      meterid: resolvedMeterid,
      period: periodFromFiscalMonth(
        selectedFY,
        selectedMonth,
      ),
      billing_period_id: billingPeriodId,
      fy: selectedFY,
      billing_month_nm: selectedMonth,
      reading: candidateReading,
      consumption,
      ZeroReadingStreak:
        calculateZeroReadingStreak(
          candidateReading,
          previous,
        ),
      used_in_calculation: inheritedUsed,
      // Persist the decision before validation may quarantine the reading.
      used_before_validation: inheritedUsed,
      reading_source: "AMR",
    };

    addOptionalText(
      item,
      "facility_nbr",
      master.facility_nbr,
    );

    addOptionalText(
      item,
      "sub_inst_cd",
      master.sub_inst_cd,
    );

    addOptionalText(
      item,
      "site_cd",
      master.site_cd,
    );

    addOptionalText(
      item,
      "utility_type_cd",
      master.utility_type_cd,
    );

    addOptionalNumber(
      item,
      "multiplier",
      master.multiplier,
    );

    const instCd =
      amrTextValue(master.inst_cd) ||
      amrTextValue(master.sub_inst_cd);

    if (instCd) {
      item.inst_cd = instCd;
    }

    if (inheritedRule) {
      item.meter_correction_rule_cd =
        inheritedRule;

      // AMR DataValue is already period consumption. Rule M must not reverse
      // or delta the AMR source value. Other correction rules operate on that
      // authoritative consumption value.
      const calculatedAdjusted =
        normalizedInheritedRule === "m"
          ? consumption
          : calculateImportedAdjustedConsumption(
              inheritedRule,
              consumption,
              previous,
              previous2Map.get(resolvedMeterid),
              previous3Map.get(resolvedMeterid),
              nextMap.get(resolvedMeterid),
              priorYearMap.get(resolvedMeterid),
            );

      if (calculatedAdjusted !== undefined) {
        item.adjusted_consumption =
          calculatedAdjusted;
      } else {
        warnings.push(
          MANUAL_CORRECTION_RULES.has(
            normalizedCorrectionRule(inheritedRule),
          )
            ? `Correction rule "${inheritedRule}" was carried forward, but it requires a manual adjusted-consumption value.`
            : `Correction rule "${inheritedRule}" was carried forward, but the supporting historical meter data needed to calculate Adjusted Consumption is not available.`,
        );
      }
    } else {
      item.adjusted_consumption = consumption;
    }

    if (
      existingWithoutRaw &&
      existingWithoutRaw.adjusted_consumption !== undefined
    ) {
      item.adjusted_consumption =
        existingWithoutRaw.adjusted_consumption;
    }

    if (previous) {
      addOptionalNumber(
        item,
        "previous_reading",
        previous.reading,
      );

      addOptionalNumber(
        item,
        "previous_adjusted_reading",
        previous.adjusted_consumption,
      );
    }

    applyValidationFields(
      item,
      optionalNumber(item.adjusted_consumption) ??
        consumption,
      previous,
      priorYearMap.get(resolvedMeterid),
      true,
      true,
    );

    const preview: PreviewRow = {
      status: "ready",
      sourceMeterid,
      meterid: resolvedMeterid,
      mappedBy,
      mappingAllowed: false,
      sourceFile: candidate.fileName,
      sourceRow: candidate.sourceRow,
      csvFacilityNbr: candidate.csvFacilityNbr,
      masterFacilityNbr,
      dataValue: candidateReading,
      adjustedConsumption:
        optionalNumber(item.adjusted_consumption) ?? null,
      existingReading: null,
      existingConsumption: null,
      correctionRule: inheritedRule,
      usedInCalculation:
        Number(item.used_in_calculation) === 1 ? 1 : 0,
      reason:
        Number(item.validation_required) === 1
          ? "Validation required; reading is quarantined from billing calculations."
          : "",
      warnings,
    };

    prepared.push({
      item,
      preview,
      mode: existingWithoutRaw ? "completeMissingRaw" : "create",
    });

    previewRows.push(preview);
  }

  previewRows.sort((a, b) => {
    const statusOrder = {
      mapping: 0,
      error: 1,
      existing: 2,
      ready: 3,
    };

    const status =
      statusOrder[a.status] -
      statusOrder[b.status];

    if (status !== 0) {
      return status;
    }

    return (
      a.sourceMeterid ||
      a.meterid
    ).localeCompare(
      b.sourceMeterid ||
      b.meterid,
      undefined,
      {
        numeric: true,
        sensitivity: "base",
      },
    );
  });

  return {
    prepared,
    previewRows,
    meterOptions,
    summary: {
      files: files.length,
      sourceRows,
      uniqueMeters: grouped.size,
      ready: prepared.length,
      errors:
        previewRows.filter(
          (row) => row.status === "error",
        ).length,
      existing: existingReadings,
      duplicateRowsRemoved,
      missingMeters,
      mappingsNeeded,
      savedMappingsUsed,
      blankDataValues,
      conflicts,
      facilityWarnings,
      authoritySkipped,
      invalidReadMethod,
    },
  };
}

async function writePreparedItems(
  prepared: PreparedItem[],
) {
  let nextIndex = 0;
  let imported = 0;
  let overwritten = 0;
  let alreadyExists = 0;
  let missingDuringOverwrite = 0;

  async function worker() {
    while (true) {
      const index = nextIndex++;
      if (index >= prepared.length) return;

      const { item, mode } = prepared[index];

      if (mode === "completeMissingRaw") {
        try {
          await ddb.send(
            new PutCommand({
              TableName: READINGS_TABLE,
              Item: item,
              ConditionExpression:
                "attribute_exists(#meterid) AND attribute_exists(#period) AND attribute_not_exists(#reading)",
              ExpressionAttributeNames: {
                "#meterid": "meterid",
                "#period": "period",
                "#reading": "reading",
              },
            }),
          );
          overwritten++;
          await updateMeterZeroReadingStreak(
            amrTextValue(item.meterid),
            optionalNumber(item.ZeroReadingStreak) ?? 0,
            optionalNumber(item.billing_period_id),
          );
        } catch (error) {
          const name =
            error && typeof error === "object" && "name" in error
              ? String((error as { name?: unknown }).name)
              : "";

          if (name === "ConditionalCheckFailedException") {
            missingDuringOverwrite++;
            continue;
          }

          throw error;
        }

        continue;
      }

      if (mode === "overwrite") {
        const meterid = amrTextValue(item.meterid);
        const billingPeriodId = optionalNumber(item.billing_period_id);
        if (billingPeriodId === undefined) {
          throw new Error(`Missing billing_period_id for AMR overwrite of ${meterid}`);
        }

        const names: Record<string, string> = {
          "#meterid": "meterid",
          "#bp": "billing_period_id",
        };

        const values: Record<string, unknown> = {};
        const setParts: string[] = [];

        const validationFields = [
          "validation_required",
          "validation_status",
          "validation_rule_ids",
          "validation_prev_month_pct",
          "validation_prev_year_pct",
          "validation_recommended_correction_rule",
          "validation_auto_corrected",
          "validation_action",
          "validation_checked_at",
        ];

        validationFields.forEach((field, fieldIndex) => {
          if (!Object.prototype.hasOwnProperty.call(item, field)) return;
          const nameKey = `#validation_${fieldIndex}`;
          const valueKey = `:validation_${fieldIndex}`;
          names[nameKey] = field;
          values[valueKey] = item[field];
          setParts.push(`${nameKey} = ${valueKey}`);
        });

        // Existing raw reading, consumption, source and ZeroReadingStreak
        // are deliberately left untouched.
        if (!setParts.length) {
          continue;
        }

        try {
          await ddb.send(
            new UpdateCommand({
              TableName: READINGS_TABLE,
              Key: { meterid, billing_period_id: billingPeriodId },
              UpdateExpression: `SET ${setParts.join(", ")}`,
              ConditionExpression:
                "attribute_exists(#meterid) AND attribute_exists(#bp)",
              ExpressionAttributeNames: names,
              ExpressionAttributeValues: values,
            }),
          );
          overwritten++;
        } catch (error) {
          const name =
            error && typeof error === "object" && "name" in error
              ? String((error as { name?: unknown }).name)
              : "";
          if (name === "ConditionalCheckFailedException") {
            missingDuringOverwrite++;
            continue;
          }
          throw error;
        }
        continue;
      }

      try {
        await ddb.send(
          new PutCommand({
            TableName: READINGS_TABLE,
            Item: item,
            ConditionExpression:
              "attribute_not_exists(#meterid) AND attribute_not_exists(#period)",
            ExpressionAttributeNames: {
              "#meterid": "meterid",
              "#period": "period",
            },
          }),
        );
        imported++;
        await updateMeterZeroReadingStreak(
          amrTextValue(item.meterid),
          optionalNumber(item.ZeroReadingStreak) ?? 0,
          optionalNumber(item.billing_period_id),
        );
      } catch (error) {
        const name =
          error && typeof error === "object" && "name" in error
            ? String((error as { name?: unknown }).name)
            : "";
        if (name === "ConditionalCheckFailedException") {
          alreadyExists++;
          continue;
        }
        throw error;
      }
    }
  }

  const workerCount = Math.min(
    MAX_CONCURRENT_WRITES,
    Math.max(1, prepared.length),
  );

  await Promise.all(
    Array.from({ length: workerCount }, () => worker()),
  );

  return {
    imported,
    overwritten,
    alreadyExists,
    missingDuringOverwrite,
  };
}

async function handleAMRPost(request: Request) {
  try {
    const formData =
      await request.formData();

    const files =
      formData
        .getAll("files")
        .filter(
          (value): value is File =>
            value instanceof File,
        );

    if (!files.length) {
      return NextResponse.json(
        {
          error:
            "At least one AMR CSV file is required.",
        },
        {
          status: 400,
        },
      );
    }

    const invalidFile =
      files.find(
        (file) =>
          !file.name
            .toLowerCase()
            .endsWith(".csv"),
      );

    if (invalidFile) {
      return NextResponse.json(
        {
          error:
            `${invalidFile.name} is not a CSV file.`,
        },
        {
          status: 400,
        },
      );
    }

    const selectedFY =
      Number(
        amrTextValue(
          formData.get("fy"),
        ),
      );

    const selectedMonth =
      normalizeMonth(
        formData.get("billing_month_nm"),
      );

    const billingPeriodId =
      Number(
        amrTextValue(
          formData.get("billing_period_id"),
        ),
      );

    const action =
      amrTextValue(
        formData.get("action"),
      ).toLowerCase() || "preview";

    const overwriteMeterIds =
      new Set(
        formData
          .getAll("overwrite_meterid")
          .map((value) => amrTextValue(value))
          .filter(Boolean),
      );

    if (
      !Number.isInteger(selectedFY) ||
      !selectedMonth ||
      !Number.isInteger(billingPeriodId) ||
      billingPeriodId <= 0
    ) {
      return NextResponse.json(
        {
          error:
            "Valid FY, Billing Month, and Billing Period ID are required.",
        },
        {
          status: 400,
        },
      );
    }

    const expected =
      expectedBillingPeriodId(
        selectedFY,
        selectedMonth,
      );

    if (
      expected === null ||
      expected !== billingPeriodId
    ) {
      return NextResponse.json(
        {
          error:
            `${selectedMonth} FY${selectedFY} should use Billing Period ${expected}, but the page supplied ${billingPeriodId}.`,
        },
        {
          status: 400,
        },
      );
    }

    if (
      action !== "preview" &&
      action !== "import"
    ) {
      return NextResponse.json(
        {
          error:
            "Invalid AMR upload action.",
        },
        {
          status: 400,
        },
      );
    }

    const result =
      await buildPreview(
        files,
        selectedFY,
        selectedMonth,
        billingPeriodId,
        overwriteMeterIds,
      );

    if (action === "preview") {
      return NextResponse.json({
        success: true,
        billingPeriodId,
        period:
          periodFromFiscalMonth(
            selectedFY,
            selectedMonth,
          ),
        summary: result.summary,
        rows:
          result.previewRows.slice(0, 1000),
        meterOptions:
          result.meterOptions,
        rowsTruncated:
          result.previewRows.length > 1000,
      });
    }

    if (!result.prepared.length) {
      return NextResponse.json(
        {
          error:
            "No AMR readings are eligible for import after validation.",
          summary:
            result.summary,
          rows:
            result.previewRows.slice(0, 1000),
        },
        {
          status: 400,
        },
      );
    }

    const writeResult =
      await writePreparedItems(
        result.prepared,
      );

    return NextResponse.json({
      success: true,
      billingPeriodId,
      period:
        periodFromFiscalMonth(
          selectedFY,
          selectedMonth,
        ),
      imported:
        writeResult.imported,
      overwritten:
        writeResult.overwritten,
      alreadyExistsDuringImport:
        writeResult.alreadyExists,
      missingDuringOverwrite:
        writeResult.missingDuringOverwrite,
      summary:
        result.summary,
    });
  } catch (error) {
    console.error(
      "AMR import failed:",
      error,
    );

    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Unable to import AMR CSV files.",
      },
      {
        status: 500,
      },
    );
  }
}

async function handleSaveMappingPost(
  body: Record<string, unknown>,
) {
  const sourceMeterid =
    textValue(body.source_meterid);

  const mappedMeterid =
    textValue(body.mapped_meterid);

  const sourceFacilityNbr =
    textValue(body.source_facility_nbr);

  if (!sourceMeterid || !mappedMeterid) {
    return NextResponse.json(
      {
        error:
          "source_meterid and mapped_meterid are required.",
      },
      {
        status: 400,
      },
    );
  }

  const meterResult =
    await ddb.send(
      new GetCommand({
        TableName: METERS_TABLE,
        Key: {
          meterid: mappedMeterid,
        },
      }),
    );

  if (!meterResult.Item) {
    return NextResponse.json(
      {
        error:
          `CUBE meter "${mappedMeterid}" does not exist in ${METERS_TABLE}.`,
      },
      {
        status: 400,
      },
    );
  }

  const now =
    new Date().toISOString();

  let createdAt = now;

  try {
    const existing =
      await ddb.send(
        new GetCommand({
          TableName: MAPPINGS_TABLE,
          Key: {
            source_meterid: sourceMeterid,
          },
        }),
      );

    const existingCreatedAt =
      existing.Item
        ? textValue(
            existing.Item.created_at,
          )
        : "";

    if (existingCreatedAt) {
      createdAt =
        existingCreatedAt;
    }
  } catch (error) {
    console.error(
      "Unable to read existing meter mapping:",
      error,
    );

    throw error;
  }

  const mappingItem: Record<string, unknown> = {
    source_meterid: sourceMeterid,
    mapped_meterid: mappedMeterid,
    source_system: "AMR",
    created_at: createdAt,
    updated_at: now,
  };

  if (sourceFacilityNbr) {
    mappingItem.source_facility_nbr =
      sourceFacilityNbr;
  }

  await ddb.send(
    new PutCommand({
      TableName: MAPPINGS_TABLE,
      Item: mappingItem,
    }),
  );

  return NextResponse.json({
    ok: true,
    mapping: mappingItem,
    meter: toMeterOption(
      meterResult.Item as Record<string, unknown>,
    ),
  });
}

async function handleUpdateMeterFacilityPost(
  body: Record<string, unknown>,
) {
  const meterid =
    textValue(body.meterid);

  const facilityNbr =
    textValue(body.facility_nbr);

  if (!meterid || !facilityNbr) {
    return NextResponse.json(
      {
        error:
          "meterid and facility_nbr are required.",
      },
      {
        status: 400,
      },
    );
  }

  try {
    await ddb.send(
      new UpdateCommand({
        TableName: METERS_TABLE,
        Key: {
          meterid,
        },
        UpdateExpression:
          "SET #facility = :facility",
        ConditionExpression:
          "attribute_exists(#meterid)",
        ExpressionAttributeNames: {
          "#meterid": "meterid",
          "#facility": "facility_nbr",
        },
        ExpressionAttributeValues: {
          ":facility": facilityNbr,
        },
      }),
    );
  } catch (error) {
    const name =
      error &&
      typeof error === "object" &&
      "name" in error
        ? String(
            (error as { name?: unknown }).name,
          )
        : "";

    if (name === "ConditionalCheckFailedException") {
      return NextResponse.json(
        {
          error:
            `Meter "${meterid}" no longer exists in ${METERS_TABLE}.`,
        },
        {
          status: 404,
        },
      );
    }

    throw error;
  }

  return NextResponse.json({
    ok: true,
    meterid,
    facility_nbr: facilityNbr,
  });
}

// ============================================================
// DELETE ONE OR MULTIPLE METER READINGS
//
// Request body:
// {
//   "items": [
//     {
//       "meterid": "G1707",
//       "period": "2026-02",
//       "billing_period_id": 175
//     }
//   ]
// }
//
// The route supports either known meter-reading table key shape:
//   meterid + period
//   meterid + billing_period_id
//
// Each delete is conditional, so a missing record is not created
// or otherwise modified.
// ============================================================

// DELETE removes selected meter readings using conditional DynamoDB deletes.
export async function DELETE(request: Request) {
  // ============================================================
  // AUTHENTICATION (PRODUCTION - CURRENTLY DISABLED)
  // Enable the auth import above and uncomment this block when
  // authenticated access is required for this endpoint.
  // ============================================================
  const session = await getAppSession();
  if (!session?.user) {
    return NextResponse.json(
      { error: "Unauthorized" },
      { status: 401 },
    );
  }

  try {
    const body =
      (await request.json()) as {
        items?: Array<Record<string, unknown>>;
      };

    const items =
      Array.isArray(body.items)
        ? body.items
        : [];

    if (!items.length) {
      return NextResponse.json(
        {
          error:
            "At least one meter reading is required for deletion.",
        },
        {
          status: 400,
        },
      );
    }

    const normalized = items
      .map((item) => ({
        meterid: textValue(item.meterid),
        period: textValue(item.period),
        billingPeriodId:
          optionalNumber(item.billing_period_id),
      }))
      .filter(
        (item) =>
          item.meterid &&
          (item.period ||
            item.billingPeriodId !== undefined),
      );

    if (!normalized.length) {
      return NextResponse.json(
        {
          error:
            "No valid meter-reading keys were supplied.",
        },
        {
          status: 400,
        },
      );
    }

    let deleted = 0;
    let notFound = 0;

    async function deleteOne(
      item: (typeof normalized)[number],
    ) {
      const keyCandidates:
        Record<string, unknown>[] = [];

      if (item.period) {
        keyCandidates.push({
          meterid: item.meterid,
          period: item.period,
        });
      }

      if (
        item.billingPeriodId !== undefined
      ) {
        keyCandidates.push({
          meterid: item.meterid,
          billing_period_id:
            item.billingPeriodId,
        });
      }

      let lastSchemaError:
        unknown = null;

      for (const key of keyCandidates) {
        try {
          await ddb.send(
            new DeleteCommand({
              TableName: TABLE_NAME,
              Key: key,
              ConditionExpression:
                "attribute_exists(#meterid)",
              ExpressionAttributeNames: {
                "#meterid": "meterid",
              },
            }),
          );

          deleted++;
          return;
        } catch (error) {
          const name =
            error &&
            typeof error === "object" &&
            "name" in error
              ? String(
                  (error as {
                    name?: unknown;
                  }).name,
                )
              : "";

          const message =
            error instanceof Error
              ? error.message
              : String(error);

          if (
            name === "ValidationException" &&
            message
              .toLowerCase()
              .includes(
                "key element does not match the schema",
              )
          ) {
            lastSchemaError = error;
            continue;
          }

          if (
            name ===
            "ConditionalCheckFailedException"
          ) {
            notFound++;
            return;
          }

          throw error;
        }
      }

      if (lastSchemaError) {
        throw lastSchemaError;
      }

      notFound++;
    }

    let nextIndex = 0;

    async function worker() {
      while (true) {
        const index = nextIndex++;

        if (index >= normalized.length) {
          return;
        }

        await deleteOne(
          normalized[index],
        );
      }
    }

    const workerCount =
      Math.min(
        8,
        normalized.length,
      );

    await Promise.all(
      Array.from(
        {
          length:
            Math.max(
              1,
              workerCount,
            ),
        },
        () => worker(),
      ),
    );

    return NextResponse.json({
      ok: true,
      requested: normalized.length,
      deleted,
      notFound,
    });
  } catch (error) {
    console.error(
      "Meter reading delete failed:",
      error,
    );

    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Unable to delete meter reading(s).",
      },
      {
        status: 500,
      },
    );
  }
}

// ============================================================
// MANUAL METER READING CSV IMPORT
//
// Expected CSV columns are matched case-insensitively. Supported names:
//   Meter ID / MeterID
//   Current Reading / Reading
// Optional:
//   FY, Month / Billing Month, Billing Period / Billing Period ID,
//   Building / Facility / Facility Nbr
//
// Authoritative values come from DynamoDB:
//   - previous reading, used_in_calculation, correction rule: prior period
//   - rollover, multiplier, facility/site/sub-installation/utility: meter master
//
// Consumption:
//   normal    = (current - previous) * multiplier
//   rule M    = (previous - current) * multiplier
//   rollover  = ((rollover - previous) + current) * multiplier
//   reverse rollover (M) = (previous + (rollover - current)) * multiplier
//
// Rollover is controlled by p72-CUBE-INV-READ-METHODS.ROLLOVER_USED.
// A lower current reading only triggers rollover when ROLLOVER_USED = 1.
// ============================================================

type ManualCsvRow = {
  fileName: string;
  sourceRow: number;
  meterid: string;
  csvFacilityNbr: string;
  currentReadingText: string;
  csvFY: string;
  csvMonth: string;
  csvBillingPeriodId: string;
};

type ManualPreviewRow = {
  status: "ready" | "error" | "existing" | "mapping";
  sourceMeterid: string;
  meterid: string;
  sourceFile: string;
  sourceRow: number;
  facilityNbr: string;
  previousReading: number | null;
  currentReading: number | null;
  rollover: number | null;
  multiplier: number | null;
  consumption: number | null;
  adjustedConsumption: number | null;
  correctionRule: string;
  usedInCalculation: number;
  rolloverApplied: boolean;
  rolloverUsed?: boolean;
  existingReading: number | null;
  existingConsumption: number | null;
  existingAdjustedConsumption: number | null;
  overwriteAllowed: boolean;
  reason: string;
  warnings: string[];
};

type ManualPreparedItem = {
  item: Record<string, unknown>;
  preview: ManualPreviewRow;
  mode: "create" | "overwrite" | "completeMissingRaw";
};

function strictNumber(value: unknown): number | undefined {
  const raw = amrTextValue(value);
  if (!raw) return undefined;
  const parsed = Number(raw.replace(/[$,]/g, ""));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizeManualHeader(value: unknown) {
  return amrTextValue(value)
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function findHeaderIndex(headers: string[], aliases: string[]) {
  const normalizedAliases = aliases.map(normalizeManualHeader);
  return headers.findIndex((header) => normalizedAliases.includes(header));
}

function extractManualRows(csv: string, fileName: string): ManualCsvRow[] {
  const rows = parseCSV(csv.replace(/^\uFEFF/, ""));

  const headerRowIndex = rows.findIndex((row) => {
    const headers = row.map(normalizeManualHeader);
    const meterIndex = findHeaderIndex(headers, [
      "meter id", "meterid", "meter number", "meter nbr",
    ]);
    const readingIndex = findHeaderIndex(headers, [
      "current reading", "reading", "current meter reading",
    ]);
    return meterIndex >= 0 && readingIndex >= 0;
  });

  if (headerRowIndex < 0) {
    throw new Error(
      `${fileName}: could not find Meter ID and Current Reading columns.`,
    );
  }

  const headers = rows[headerRowIndex].map(normalizeManualHeader);

  const meterIndex = findHeaderIndex(headers, [
    "meter id", "meterid", "meter number", "meter nbr",
  ]);
  const readingIndex = findHeaderIndex(headers, [
    "current reading", "reading", "current meter reading",
  ]);
  const facilityIndex = findHeaderIndex(headers, [
    "building", "facility", "facility nbr", "facility number", "facility num",
  ]);
  const fyIndex = findHeaderIndex(headers, ["fy", "fiscal year"]);
  const monthIndex = findHeaderIndex(headers, [
    "month", "billing month", "billing month nm",
  ]);
  const bpIndex = findHeaderIndex(headers, [
    "billing period", "billing period id", "billing period id#",
  ]);

  const result: ManualCsvRow[] = [];

  rows.slice(headerRowIndex + 1).forEach((row, relativeIndex) => {
    const meterid = amrTextValue(row[meterIndex]);
    const currentReadingText = amrTextValue(row[readingIndex]);

    // Completely empty lines are ignored. A meter with a blank reading is
    // retained so Preview can explicitly show that it was skipped.
    if (!meterid && !currentReadingText) return;

    result.push({
      fileName,
      sourceRow: headerRowIndex + relativeIndex + 2,
      meterid,
      csvFacilityNbr:
        facilityIndex >= 0
          ? amrTextValue(row[facilityIndex]).replace(/^0+(?=\d)/, "")
          : "",
      currentReadingText,
      csvFY: fyIndex >= 0 ? amrTextValue(row[fyIndex]) : "",
      csvMonth: monthIndex >= 0 ? amrTextValue(row[monthIndex]) : "",
      csvBillingPeriodId: bpIndex >= 0 ? amrTextValue(row[bpIndex]) : "",
    });
  });

  return result;
}

function median(values: number[]): number | undefined {
  const finite = values
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);

  if (finite.length === 0) return undefined;

  const middle = Math.floor(finite.length / 2);

  return finite.length % 2 === 0
    ? (finite[middle - 1] + finite[middle]) / 2
    : finite[middle];
}

function sameNumericValue(left: number | null, right: number | null) {
  if (left === null || right === null) return left === right;
  const scale = Math.max(1, Math.abs(left), Math.abs(right));
  return Math.abs(left - right) <= 1e-9 * scale;
}

type ManualEditOverride = {
  meterid: string;
  currentReading?: number;
  adjustedConsumption?: number | null;
  correctionRule?: string;
  usedInCalculation?: number;
};

function parseManualEditOverrides(formData: FormData) {
  const edits = new Map<string, ManualEditOverride>();

  for (const raw of formData.getAll("manual_edit")) {
    try {
      const parsed = JSON.parse(String(raw)) as {
        meterid?: unknown;
        current_reading?: unknown;
        adjusted_consumption?: unknown;
        correction_rule?: unknown;
        used_in_calculation?: unknown;
      };

      const meterid = amrTextValue(parsed.meterid);
      if (!meterid) continue;

      const edit: ManualEditOverride = { meterid };

      if (Object.prototype.hasOwnProperty.call(parsed, "current_reading")) {
        const currentText = amrTextValue(parsed.current_reading);
        const currentReading = strictNumber(currentText);
        if (currentReading !== undefined) {
          edit.currentReading = currentReading;
        }
      }

      if (Object.prototype.hasOwnProperty.call(parsed, "adjusted_consumption")) {
        const adjustedText = amrTextValue(parsed.adjusted_consumption);
        // null means the user intentionally cleared Adjusted Consumption.
        edit.adjustedConsumption =
          adjustedText === "" ? null : strictNumber(adjustedText);
      }

      if (Object.prototype.hasOwnProperty.call(parsed, "correction_rule")) {
        edit.correctionRule = amrTextValue(parsed.correction_rule);
      }

      if (Object.prototype.hasOwnProperty.call(parsed, "used_in_calculation")) {
        edit.usedInCalculation =
          amrTextValue(parsed.used_in_calculation) === "1" ? 1 : 0;
      }

      edits.set(meterid.toUpperCase(), edit);
    } catch {
      // Ignore malformed edit payloads; normal preview validation still applies.
    }
  }

  return edits;
}

async function getCurrentReadingByPrimaryKey(
  meterid: string,
  period: string,
  billingPeriodId: number,
): Promise<Record<string, unknown> | undefined> {
  const keyCandidates: Record<string, unknown>[] = [
    { meterid, period },
    { meterid, billing_period_id: billingPeriodId },
  ];

  for (const key of keyCandidates) {
    try {
      const result = await ddb.send(
        new GetCommand({
          TableName: READINGS_TABLE,
          Key: key,
          ConsistentRead: true,
        }),
      );

      if (result.Item) {
        return result.Item as Record<string, unknown>;
      }
    } catch (error) {
      const name =
        error && typeof error === "object" && "name" in error
          ? String((error as { name?: unknown }).name)
          : "";
      const message = error instanceof Error ? error.message : String(error);

      if (
        name === "ValidationException" &&
        message.toLowerCase().includes("key element does not match the schema")
      ) {
        continue;
      }

      throw error;
    }
  }

  return undefined;
}

async function buildManualPreview(
  files: File[],
  selectedFY: number,
  selectedMonth: string,
  billingPeriodId: number,
  overwriteMeterIds: Set<string> = new Set(),
  manualEdits: Map<string, ManualEditOverride> = new Map(),
) {
  const [
    meterItems,
    mappingItems,
    readMethodItems,
    previousPeriodItems,
    previous2PeriodItems,
    previous3PeriodItems,
    currentPeriodItems,
    nextPeriodItems,
    priorYearPeriodItems,
  ] = await Promise.all([
    scanMeters(),
    scanMappings(),
    scanInvReadMethods(),
    queryBillingPeriod(billingPeriodId - 1),
    queryBillingPeriod(billingPeriodId - 2),
    queryBillingPeriod(billingPeriodId - 3),
    queryBillingPeriod(billingPeriodId),
    queryBillingPeriod(billingPeriodId + 1),
    queryBillingPeriod(billingPeriodId - 12),
  ]);

  const meterMap = new Map<string, Record<string, unknown>>();
  for (const meter of meterItems) {
    const meterid = amrTextValue(meter.meterid);
    if (meterid) meterMap.set(meterid.toUpperCase(), meter);
  }

  const mappingMap = new Map<string, Record<string, unknown>>();
  for (const mapping of mappingItems) {
    const source = amrTextValue(mapping.source_meterid);
    if (source) mappingMap.set(source.toUpperCase(), mapping);
  }

  const readMethodMap = buildInvReadMethodMap(readMethodItems);

  const previousMap = recordByMeter(previousPeriodItems);
  const previous2Map = recordByMeter(previous2PeriodItems);
  const previous3Map = recordByMeter(previous3PeriodItems);
  const currentMap = recordByMeter(currentPeriodItems);
  const nextMap = recordByMeter(nextPeriodItems);
  const priorYearMap = recordByMeter(priorYearPeriodItems);

  // Case-insensitive reading lookup without changing stored meter IDs.
  function readingFor(
    map: Map<string, Record<string, unknown>>,
    meterid: string,
  ) {
    return (
      map.get(meterid) ??
      Array.from(map.entries()).find(
        ([key]) => key.toUpperCase() === meterid.toUpperCase(),
      )?.[1]
    );
  }

  const sourceRows: ManualCsvRow[] = [];
  for (const file of files) {
    sourceRows.push(...extractManualRows(await file.text(), file.name));
  }

  const previewRows: ManualPreviewRow[] = [];
  const prepared: ManualPreparedItem[] = [];
  const seenSourceMeters = new Set<string>();

  let blankReadings = 0;
  let missingMeters = 0;
  let missingPrevious = 0;
  let rolloverCount = 0;
  let missingRollover = 0;
  let existingReadings = 0;
  let duplicates = 0;
  let authoritySkipped = 0;
  let invalidReadMethod = 0;

  for (const row of sourceRows) {
    const sourceMeterid = row.meterid;
    const sourceKey = sourceMeterid.toUpperCase();

    if (!sourceMeterid) {
      previewRows.push({
        status: "error", sourceMeterid: "", meterid: "",
        sourceFile: row.fileName, sourceRow: row.sourceRow,
        facilityNbr: row.csvFacilityNbr, previousReading: null,
        currentReading: strictNumber(row.currentReadingText) ?? null,
        rollover: null, multiplier: null, consumption: null,
        adjustedConsumption: null, correctionRule: "",
        usedInCalculation: 0, rolloverApplied: false,
        existingReading: null, existingConsumption: null,
        existingAdjustedConsumption: null, overwriteAllowed: false, reason: "Meter ID is blank.", warnings: [],
      });
      continue;
    }

    if (seenSourceMeters.has(sourceKey)) {
      duplicates++;
      previewRows.push({
        status: "error", sourceMeterid, meterid: sourceMeterid,
        sourceFile: row.fileName, sourceRow: row.sourceRow,
        facilityNbr: row.csvFacilityNbr, previousReading: null,
        currentReading: strictNumber(row.currentReadingText) ?? null,
        rollover: null, multiplier: null, consumption: null,
        adjustedConsumption: null, correctionRule: "",
        usedInCalculation: 0, rolloverApplied: false,
        existingReading: null, existingConsumption: null,
        existingAdjustedConsumption: null, overwriteAllowed: false,
        reason: "Duplicate Meter ID in the manual upload. Keep one row per meter.",
        warnings: [],
      });
      continue;
    }
    seenSourceMeters.add(sourceKey);

    // Keep the raw CSV value separate from the effective reading used for math.
    // A blank reading is handled like zero after we load the previous reading and
    // rollover configuration. This lets CUBE carry the prior reading forward when
    // a manual reader did not supply a usable value.
    const currentReading = strictNumber(row.currentReadingText);
    const sourceReadingMissing = currentReading === undefined;
    if (sourceReadingMissing) blankReadings++;

    // If the CSV supplies period fields, they must agree with the selected page.
    if (row.csvFY) {
      const csvFY = Number(row.csvFY.replace(/[^\d]/g, ""));
      if (Number.isFinite(csvFY) && csvFY !== selectedFY) {
        previewRows.push({
          status: "error", sourceMeterid, meterid: sourceMeterid,
          sourceFile: row.fileName, sourceRow: row.sourceRow,
          facilityNbr: row.csvFacilityNbr, previousReading: null,
          currentReading: currentReading ?? null, rollover: null, multiplier: null, consumption: null,
          adjustedConsumption: null, correctionRule: "", usedInCalculation: 0,
          rolloverApplied: false, existingReading: null,
          existingConsumption: null, existingAdjustedConsumption: null, overwriteAllowed: false,
          reason: `CSV FY ${csvFY} does not match selected FY ${selectedFY}.`,
          warnings: [],
        });
        continue;
      }
    }

    if (row.csvMonth) {
      const csvMonth = normalizeMonth(row.csvMonth);
      if (csvMonth && csvMonth !== selectedMonth) {
        previewRows.push({
          status: "error", sourceMeterid, meterid: sourceMeterid,
          sourceFile: row.fileName, sourceRow: row.sourceRow,
          facilityNbr: row.csvFacilityNbr, previousReading: null,
          currentReading: currentReading ?? null, rollover: null, multiplier: null, consumption: null,
          adjustedConsumption: null, correctionRule: "", usedInCalculation: 0,
          rolloverApplied: false, existingReading: null,
          existingConsumption: null, existingAdjustedConsumption: null, overwriteAllowed: false,
          reason: `CSV month ${csvMonth} does not match selected month ${selectedMonth}.`,
          warnings: [],
        });
        continue;
      }
    }

    if (row.csvBillingPeriodId) {
      const csvBP = strictNumber(row.csvBillingPeriodId);
      if (csvBP !== undefined && csvBP !== billingPeriodId) {
        previewRows.push({
          status: "error", sourceMeterid, meterid: sourceMeterid,
          sourceFile: row.fileName, sourceRow: row.sourceRow,
          facilityNbr: row.csvFacilityNbr, previousReading: null,
          currentReading: currentReading ?? null, rollover: null, multiplier: null, consumption: null,
          adjustedConsumption: null, correctionRule: "", usedInCalculation: 0,
          rolloverApplied: false, existingReading: null,
          existingConsumption: null, existingAdjustedConsumption: null, overwriteAllowed: false,
          reason: `CSV Billing Period ${csvBP} does not match selected Billing Period ${billingPeriodId}.`,
          warnings: [],
        });
        continue;
      }
    }

    let master = meterMap.get(sourceKey);
    let resolvedMeterid = master ? amrTextValue(master.meterid) : sourceMeterid;

    if (!master) {
      const mapping = mappingMap.get(sourceKey);
      const mappedMeterid = mapping ? amrTextValue(mapping.mapped_meterid) : "";
      if (mappedMeterid) {
        master = meterMap.get(mappedMeterid.toUpperCase());
        if (master) resolvedMeterid = amrTextValue(master.meterid);
      }
    }

    if (!master) {
      missingMeters++;
      previewRows.push({
        status: "mapping", sourceMeterid, meterid: "",
        sourceFile: row.fileName, sourceRow: row.sourceRow,
        facilityNbr: row.csvFacilityNbr, previousReading: null,
        currentReading: currentReading ?? null, rollover: null, multiplier: null, consumption: null,
        adjustedConsumption: null, correctionRule: "", usedInCalculation: 0,
        rolloverApplied: false, existingReading: null,
        existingConsumption: null, existingAdjustedConsumption: null, overwriteAllowed: false,
        reason: `Meter ${sourceMeterid} was not found in ${METERS_TABLE}. Add/fix the meter or save a meter mapping before importing.`,
        warnings: [],
      });
      continue;
    }

    const authority = authoritativeReadingSource(master, readMethodMap);
    if (!authority.valid || authority.source !== "MANUAL") {
      if (!authority.valid) invalidReadMethod++;
      else authoritySkipped++;

      previewRows.push({
        status: "error", sourceMeterid, meterid: resolvedMeterid,
        sourceFile: row.fileName, sourceRow: row.sourceRow,
        facilityNbr: amrTextValue(master.facility_nbr), previousReading: null,
        currentReading: currentReading ?? null, rollover: strictNumber(master.rollover) ?? null,
        multiplier: strictNumber(master.multiplier) ?? null, consumption: null,
        adjustedConsumption: null, correctionRule: "", usedInCalculation: 0,
        rolloverApplied: false, existingReading: null, existingConsumption: null,
        existingAdjustedConsumption: null, overwriteAllowed: false,
        reason: !authority.valid
          ? authority.reason
          : authority.source === "AMR"
            ? `Skipped: meter ${resolvedMeterid} uses ${authority.methodName || `inventory read method ${authority.methodId}`}, which is AMR-authoritative. Manual upload cannot replace its reading.`
            : authority.reason,
        warnings: [],
      });
      continue;
    }

    const manualEdit = manualEdits.get(resolvedMeterid.toUpperCase());

    let storedCurrent = readingFor(currentMap, resolvedMeterid);

    if (!storedCurrent) {
      storedCurrent = await getCurrentReadingByPrimaryKey(
        resolvedMeterid,
        periodFromFiscalMonth(selectedFY, selectedMonth),
        billingPeriodId,
      );
    }

    const existingWithoutRaw =
      isRawReadingMissing(storedCurrent)
        ? storedCurrent
        : undefined;

    const current =
      existingWithoutRaw ? undefined : storedCurrent;

    // Manual calculations use DynamoDB/master data, not spreadsheet values.
    const previous = readingFor(previousMap, resolvedMeterid);
    const previousReading =
      previous ? strictNumber(previous.reading) : undefined;

    const masterMultiplier = strictNumber(master.multiplier);
    const masterRollover = strictNumber(master.rollover);
    // Correction rules are stored on the meter-reading record and roll
    // forward month-to-month. Read the immediately preceding billing-period
    // record and carry its rule into the new Manual record.
    const inheritedRule =
      manualEdit?.correctionRule !== undefined
        ? manualEdit.correctionRule
        : existingWithoutRaw
          ? amrTextValue(existingWithoutRaw.meter_correction_rule_cd)
        : previous
          ? amrTextValue(previous.meter_correction_rule_cd)
          : "";
    const normalizedInheritedRule = normalizedCorrectionRule(inheritedRule);
    const reverseMeter = normalizedInheritedRule === "m";

    // A valid current register reading can establish a new baseline even when
    // the immediately preceding billing period has no raw register reading.
    const noPreviousReading = previousReading === undefined;
    if (noPreviousReading) missingPrevious++;

    if (masterMultiplier === undefined) {
      previewRows.push({
        status: "error", sourceMeterid, meterid: resolvedMeterid,
        sourceFile: row.fileName, sourceRow: row.sourceRow,
        facilityNbr: amrTextValue(master.facility_nbr),
        previousReading: previousReading ?? null, currentReading: currentReading ?? null,
        rollover: masterRollover ?? null, multiplier: null,
        consumption: null, adjustedConsumption: null,
        correctionRule: inheritedRule,
        usedInCalculation: previous && Number(previous.used_in_calculation) === 1 ? 1 : 0,
        rolloverApplied: false, existingReading: null,
        existingConsumption: null, existingAdjustedConsumption: null, overwriteAllowed: false,
        reason: `Meter ${resolvedMeterid} does not have a valid multiplier in ${METERS_TABLE}.`,
        warnings: [],
      });
      continue;
    }

    // Manual-upload preview is the one place a raw reading may be corrected.
    // A user-entered preview correction wins over the CSV. Otherwise a blank CSV
    // value remains undefined until the missing/zero protection below decides
    // whether to carry the prior reading forward or use zero as a rollover point.
    const suppliedCurrentReading =
      manualEdit?.currentReading !== undefined
        ? manualEdit.currentReading
        : currentReading;

    const warnings: string[] = [];
    let effectiveCurrentReading: number;
    let consumption: number;
    let rolloverApplied = false;
    let possibleMeterReplacement = false;
    let carriedForwardMissingReading = false;

    const sourceIsBlankOrZero =
      suppliedCurrentReading === undefined || suppliedCurrentReading === 0;

    const readingDifference =
      suppliedCurrentReading === undefined
        ? undefined
        : suppliedCurrentReading - (previousReading ?? 0);

    const readingsEffectivelyEqual =
      !noPreviousReading &&
      readingDifference !== undefined &&
      Math.abs(readingDifference) <= MANUAL_READING_TOLERANCE;

    if (noPreviousReading && suppliedCurrentReading === undefined) {
      previewRows.push({
        status: "error", sourceMeterid, meterid: resolvedMeterid,
        sourceFile: row.fileName, sourceRow: row.sourceRow,
        facilityNbr: amrTextValue(master.facility_nbr),
        previousReading: null, currentReading: null,
        rollover: masterRollover ?? null, multiplier: masterMultiplier,
        consumption: null, adjustedConsumption: null,
        correctionRule: inheritedRule, usedInCalculation: 0,
        rolloverApplied: false, existingReading: null,
        existingConsumption: null, existingAdjustedConsumption: null,
        overwriteAllowed: false,
        reason: "No previous-month reading and no current reading supplied; cannot establish a baseline.",
        warnings: [],
      });
      continue;
    }

    if (noPreviousReading) {
      // No prior baseline: preserve the uploaded register reading, but never
      // turn its cumulative value into current-period consumption.
      effectiveCurrentReading = suppliedCurrentReading ?? 0;
      consumption = 0;
      warnings.push(
        `No valid previous-month reading: saved current register as the baseline; consumption and adjusted consumption are 0. Unmetered reconciliation retains the unmeasured usage.`,
      );
    } else if (sourceIsBlankOrZero) {
      // Blank/zero protection: do not infer rollover unless a normal-direction
      // meter is actually within 10% of its configured rollover value. Rule M
      // meters run backward, so blank/zero is carried forward rather than being
      // interpreted as a reverse rollover.
      const nearNormalRollover =
        !reverseMeter &&
        authority.rolloverUsed &&
        masterRollover !== undefined &&
        masterRollover > 0 &&
        previousReading >= masterRollover * 0.90;

      if (nearNormalRollover) {
        effectiveCurrentReading = 0;
        rolloverApplied = true;
        consumption =
          ((masterRollover! - (previousReading ?? 0)) + effectiveCurrentReading) *
          masterMultiplier;
        rolloverCount++;
        warnings.push(
          `Blank/zero Current Reading was accepted as rollover because the previous reading is within 10% of the configured rollover value.`,
        );
      } else {
        effectiveCurrentReading = previousReading ?? 0;
        consumption = 0;
        carriedForwardMissingReading = true;
        warnings.push(
          `Blank/zero Current Reading was not eligible for rollover. Current Reading was carried forward from ${previousReading} and Consumption was set to 0.`,
        );
      }
    } else {
      effectiveCurrentReading = suppliedCurrentReading;

      if (readingsEffectivelyEqual) {
        consumption = 0;

        if (effectiveCurrentReading !== previousReading) {
          warnings.push(
            `Current Reading differs from Previous Reading by ${Math.abs(
              effectiveCurrentReading - (previousReading ?? 0),
            )}, which is within the ${MANUAL_READING_TOLERANCE} reading tolerance. Consumption was set to 0 and rollover was not applied.`,
          );
        }
      } else if (reverseMeter) {
        if (effectiveCurrentReading <= previousReading) {
          // Rule M means the physical counter runs backward.
          consumption =
            ((previousReading ?? 0) - effectiveCurrentReading) * masterMultiplier;
        } else {
          // A reverse meter can wrap from near zero back to the configured max.
          const reverseRolloverEligible =
            authority.rolloverUsed &&
            masterRollover !== undefined &&
            masterRollover > 0 &&
            previousReading <= masterRollover * 0.10 &&
            effectiveCurrentReading >= masterRollover * 0.90;

          if (reverseRolloverEligible) {
            rolloverApplied = true;
            consumption =
              ((previousReading ?? 0) + (masterRollover! - effectiveCurrentReading)) *
              masterMultiplier;
            rolloverCount++;
          } else {
            // Unexpected direction for an M meter. Do not manufacture consumption.
            // Keep the new reading, set consumption to zero, and force review below.
            consumption = 0;
            possibleMeterReplacement = true;
            warnings.push(
              `Possible meter replacement/reset: Rule M meter reading increased from ${previousReading} to ${effectiveCurrentReading} and did not qualify for reverse rollover. Review is required.`,
            );
          }
        }
      } else if (effectiveCurrentReading >= previousReading) {
        consumption =
          (effectiveCurrentReading - (previousReading ?? 0)) * masterMultiplier;
      } else {
        const normalRolloverEligible =
          authority.rolloverUsed &&
          masterRollover !== undefined &&
          masterRollover > 0 &&
          (previousReading ?? 0) >= masterRollover * 0.90 &&
          effectiveCurrentReading <= masterRollover * 0.10;

        if (normalRolloverEligible) {
          rolloverApplied = true;
          consumption =
            ((masterRollover! - (previousReading ?? 0)) + effectiveCurrentReading) *
            masterMultiplier;
          rolloverCount++;
        } else {
          // A lower reading away from rollover is most likely a replaced/reset meter.
          // Do not apply rollover math automatically; require human review.
          consumption = 0;
          possibleMeterReplacement = true;
          warnings.push(
            `Possible meter replacement/reset: Current Reading ${effectiveCurrentReading} is below Previous Reading ${previousReading}, but the readings do not cross both rollover boundaries (previous >= 90% and current <= 10% of configured rollover). Review is required.`,
          );
        }
      }
    }

    const multiplier = masterMultiplier ?? null;
    const rollover = masterRollover;

    const inheritedUsed =
      manualEdit?.usedInCalculation !== undefined
        ? manualEdit.usedInCalculation
        : existingWithoutRaw
          ? originalUsedValue(existingWithoutRaw)
          : originalUsedValue(previous);

    if (row.csvFacilityNbr) {
      const masterFacility = amrTextValue(master.facility_nbr);
      if (masterFacility && row.csvFacilityNbr !== masterFacility) {
        warnings.push(
          `CSV facility "${row.csvFacilityNbr}" differs from meter master facility "${masterFacility}". Meter master value will be used.`,
        );
      }
    }

    let adjustedConsumption: number | undefined;

    // Rule M defines the physical direction of the meter. It has already been
    // applied to raw Consumption above and must not be sent through the
    // adjusted-consumption correction-rule engine.
    if (reverseMeter) {
      adjustedConsumption = consumption;
    } else if (inheritedRule) {
      adjustedConsumption = calculateImportedAdjustedConsumption(
        inheritedRule,
        consumption,
        previous,
        readingFor(previous2Map, resolvedMeterid),
        readingFor(previous3Map, resolvedMeterid),
        readingFor(nextMap, resolvedMeterid),
        readingFor(priorYearMap, resolvedMeterid),
      );

      if (adjustedConsumption === undefined) {
        warnings.push(
          MANUAL_CORRECTION_RULES.has(normalizedCorrectionRule(inheritedRule))
            ? `Correction rule "${inheritedRule}" was carried forward and requires a manual adjusted-consumption value.`
            : `Correction rule "${inheritedRule}" was carried forward, but the supporting periods needed to calculate Adjusted Consumption are unavailable.`,
        );
      }
    } else {
      adjustedConsumption = consumption;
    }

    if (manualEdit?.adjustedConsumption !== undefined) {
      adjustedConsumption =
        manualEdit.adjustedConsumption === null
          ? undefined
          : manualEdit.adjustedConsumption;
    }

    if (noPreviousReading) {
      // An inherited or user-entered correction must not manufacture usage
      // where no immediately previous register reading exists.
      adjustedConsumption = 0;
    }

    if (
      existingWithoutRaw &&
      existingWithoutRaw.adjusted_consumption !== undefined &&
      manualEdit?.adjustedConsumption === undefined
    ) {
      adjustedConsumption =
        strictNumber(existingWithoutRaw.adjusted_consumption);
    }

    const existingReading =
      current ? strictNumber(current.reading) ?? null : null;
    const existingConsumption =
      current ? strictNumber(current.consumption) ?? null : null;
    const existingAdjustedConsumption =
      current ? strictNumber(current.adjusted_consumption) ?? null : null;

    const readingChanged =
      Boolean(current) &&
      !sameNumericValue(existingReading, effectiveCurrentReading);

    const adjustedChanged =
  Boolean(current) &&
  manualEdit?.adjustedConsumption !== undefined &&
  !sameNumericValue(
    existingAdjustedConsumption,
    manualEdit.adjustedConsumption ?? null,
  );

    const overwriteAllowed =
      Boolean(current) && adjustedChanged;

    if (readingChanged) {
      warnings.push(
        `Uploaded Current Reading ${effectiveCurrentReading} differs from the existing immutable database reading ${existingReading}. The raw reading will NOT be changed. Use Adjusted Consumption or a correction rule.`,
      );
    }

    const preview: ManualPreviewRow = {
      status: current ? "existing" : "ready",
      sourceMeterid,
      meterid: resolvedMeterid,
      sourceFile: row.fileName,
      sourceRow: row.sourceRow,
      facilityNbr: amrTextValue(master.facility_nbr),
      previousReading: previousReading ?? null,
currentReading: effectiveCurrentReading ?? null,
      rollover: rollover ?? null,
      multiplier,
      consumption,
      adjustedConsumption: adjustedConsumption ?? null,
      correctionRule: current
        ? (amrTextValue(current.meter_correction_rule_cd) || inheritedRule)
        : inheritedRule,
      usedInCalculation: current
        ? (Number(current.used_in_calculation) === 1 ? 1 : 0)
        : inheritedUsed,
      rolloverApplied,
      rolloverUsed: authority.rolloverUsed,
      existingReading,
      existingConsumption,
      existingAdjustedConsumption,
      overwriteAllowed,
      reason: !current && noPreviousReading
        ? "No previous-month reading; current reading saved as baseline with zero consumption."
        : current
        ? overwriteAllowed
          ? `Adjusted Consumption will be updated. The existing raw reading remains locked.`
          : readingChanged
            ? `Uploaded Current Reading differs from the existing database reading, but raw readings are locked. No raw-reading overwrite will occur.`
            : `Uploaded reading matches the existing current-period reading; no write is needed.`
        : "",
      warnings,
    };

    previewRows.push(preview);

    const baseItem: Record<string, unknown> = {
      meterid: resolvedMeterid,
      period: periodFromFiscalMonth(selectedFY, selectedMonth),
      billing_period_id: billingPeriodId,
      fy: selectedFY,
      billing_month_nm: selectedMonth,
      reading: effectiveCurrentReading,
      consumption,
      ZeroReadingStreak:
        calculateZeroReadingStreak(
          suppliedCurrentReading,
          previous,
        ),
      used_in_calculation: inheritedUsed,
      // Validation can set used_in_calculation to 0, but not this selection.
      used_before_validation: inheritedUsed,
      reading_source: "MANUAL",
    };

    if (previousReading !== undefined) {
      baseItem.previous_reading = previousReading;
    }

    if (multiplier !== null) {
      baseItem.multiplier = multiplier;
    }

    addOptionalText(baseItem, "facility_nbr", master.facility_nbr);
    addOptionalText(baseItem, "sub_inst_cd", master.sub_inst_cd);
    addOptionalText(baseItem, "site_cd", master.site_cd);
    addOptionalText(baseItem, "utility_type_cd", master.utility_type_cd);

    const instCd = amrTextValue(master.inst_cd) || amrTextValue(master.sub_inst_cd);
    if (instCd) baseItem.inst_cd = instCd;

    if (inheritedRule) {
      // Preserve the exact stored rule (E, M, etc.) on the new month.
      // Do not depend on the spreadsheet to supply a correction rule.
      baseItem.meter_correction_rule_cd = inheritedRule;
    }

    if (adjustedConsumption !== undefined) {
      baseItem.adjusted_consumption = adjustedConsumption;
    }

    // previous_reading is the prior period's RAW meter-register reading.
    // Never map previous.adjusted_consumption into previous_adjusted_reading:
    // adjusted consumption is usage, not a meter-register value.

    // Manual imports are never auto-corrected. Failed validation is quarantined
    // for DIVA so the raw Reading and calculated Consumption remain auditable.
    if (!noPreviousReading) {
      applyValidationFields(
        baseItem,
        optionalNumber(baseItem.adjusted_consumption) ?? consumption,
        previous,
        readingFor(priorYearMap, resolvedMeterid),
        false,
      );
    } else {
      baseItem.validation_required = 0;
      baseItem.validation_status = "PASSED";
      baseItem.validation_action = "NO_PREVIOUS_READING";
      baseItem.validation_rule_ids = [];
    }

    const hardValidationRuleIds: string[] = [];
    let hardValidationAction = "";

    if (possibleMeterReplacement) {
      hardValidationRuleIds.push("POSSIBLE_METER_REPLACEMENT");
      hardValidationAction = "MANUAL_POSSIBLE_METER_RESET";
    }

    // If the immediately preceding record was carried forward (or has a zero
    // streak), the next real reading can represent multiple months of usage.
    // Preserve the reading/delta, but do not allow that accumulated consumption
    // into a single Monthly Summary period.
    const previousWasCarriedForward =
      Number(previous?.reading_carried_forward) === 1 ||
      Number(previous?.ZeroReadingStreak) >= 1;

    if (
      !sourceIsBlankOrZero &&
      !readingsEffectivelyEqual &&
      previousWasCarriedForward
    ) {
      hardValidationRuleIds.push("MANUAL_READING_GAP");
      hardValidationAction ||= "MANUAL_READING_GAP";
      warnings.push(
        `Reading gap detected: the previous period was carried forward or had a zero-reading streak. The calculated delta may represent multiple billing periods and is quarantined.`,
      );
    }

    // Compare against robust historical monthly consumption. We intentionally
    // use valid server-side consumption values, not spreadsheet consumption.
    const historicalConsumptions = [
      usableServerConsumption(previous),
      usableServerConsumption(readingFor(previous2Map, resolvedMeterid)),
      usableServerConsumption(readingFor(previous3Map, resolvedMeterid)),
      usableServerConsumption(readingFor(priorYearMap, resolvedMeterid)),
    ].filter(
      (value): value is number =>
        value !== null &&
        Number.isFinite(value) &&
        value > 0,
    );

    const historicalMedian = median(historicalConsumptions);
    const effectiveManualConsumption =
      optionalNumber(baseItem.adjusted_consumption) ?? consumption;

    if (
      historicalMedian !== undefined &&
      historicalMedian > 0 &&
      effectiveManualConsumption >
        historicalMedian * MANUAL_EXTREME_CONSUMPTION_MULTIPLIER
    ) {
      hardValidationRuleIds.push("MANUAL_EXTREME_CONSUMPTION");
      hardValidationAction ||= "MANUAL_EXTREME_CONSUMPTION";
      warnings.push(
        `Extreme consumption detected: ${effectiveManualConsumption} is greater than ${MANUAL_EXTREME_CONSUMPTION_MULTIPLIER}x the historical median ${historicalMedian}. Reading is quarantined for review.`,
      );
    }

    if (
      Number(baseItem.validation_required) === 1 &&
      !hardValidationAction
    ) {
      hardValidationAction = "MANUAL_QUARANTINED";
    }

    if (
      hardValidationRuleIds.length > 0 ||
      Number(baseItem.validation_required) === 1
    ) {
      const existingRuleIds = Array.isArray(baseItem.validation_rule_ids)
        ? (baseItem.validation_rule_ids as string[])
        : [];

      baseItem.validation_required = 1;
      baseItem.validation_status = "PENDING";
      baseItem.validation_action =
        hardValidationAction || "MANUAL_QUARANTINED";
      baseItem.validation_rule_ids = Array.from(
        new Set([...existingRuleIds, ...hardValidationRuleIds]),
      );

      // Quarantine is a hard billing gate.
      baseItem.used_in_calculation = 0;
      preview.usedInCalculation = 0;

      delete baseItem.validation_recommended_correction_rule;
      delete baseItem.validation_auto_corrected;
    }

    if (carriedForwardMissingReading) {
      baseItem.reading_carried_forward = 1;
    }

    if (existingWithoutRaw) {
      prepared.push({ item: baseItem, preview, mode: "completeMissingRaw" });
    } else if (!current) {
      prepared.push({ item: baseItem, preview, mode: "create" });
    } else if (overwriteAllowed) {
      // Existing current-period correction/used values remain authoritative.
      const overwriteItem: Record<string, unknown> = {
        meterid: resolvedMeterid,
        period: periodFromFiscalMonth(selectedFY, selectedMonth),
        billing_period_id: billingPeriodId,
      };

      // Existing raw reading/consumption/ZeroReadingStreak remain immutable.
      // Only an explicit adjusted-consumption edit is eligible here.

      if (manualEdit?.adjustedConsumption !== undefined) {
        if (manualEdit.adjustedConsumption === null) {
          overwriteItem.__remove_adjusted_consumption = true;
          delete overwriteItem.adjusted_consumption;
        } else {
          overwriteItem.adjusted_consumption =
            manualEdit.adjustedConsumption;
        }
      }

      applyValidationFields(
        overwriteItem,
        optionalNumber(overwriteItem.adjusted_consumption) ??
          optionalNumber(current.adjusted_consumption) ??
          optionalNumber(current.consumption) ??
          consumption,
        previous,
        readingFor(priorYearMap, resolvedMeterid),
        false,
      );

      if (Number(overwriteItem.validation_required) === 1) {
        overwriteItem.validation_status = "PENDING";
        overwriteItem.validation_action = "MANUAL_QUARANTINED";
        overwriteItem.used_in_calculation = 0;
        delete overwriteItem.validation_recommended_correction_rule;
        delete overwriteItem.validation_auto_corrected;
      }

      prepared.push({ item: overwriteItem, preview, mode: "overwrite" });
    }
  }

  previewRows.sort((a, b) => {
    const order = { mapping: 0, error: 1, existing: 2, ready: 3 };
    const status = order[a.status] - order[b.status];
    if (status !== 0) return status;
    return (a.meterid || a.sourceMeterid).localeCompare(
      b.meterid || b.sourceMeterid,
      undefined,
      { numeric: true, sensitivity: "base" },
    );
  });

  return {
    prepared,
    previewRows,
    summary: {
      files: files.length,
      sourceRows: sourceRows.length,
      ready: previewRows.filter((row) => row.status === "ready").length,
      errors: previewRows.filter((row) => row.status === "error").length,
      mappingsNeeded: previewRows.filter((row) => row.status === "mapping").length,
      existing: existingReadings +
        previewRows.filter((row) => row.status === "existing").length,
      blankReadings,
      missingMeters,
      missingPrevious,
      rolloverCount,
      missingRollover,
      duplicates,
      eligibleForWrite: prepared.length,
      authoritySkipped,
      invalidReadMethod,
    },
  };
}

async function writeManualPreparedItems(prepared: ManualPreparedItem[]) {
  let imported = 0;
  let overwritten = 0;
  let alreadyExists = 0;
  let missingDuringOverwrite = 0;
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const index = nextIndex++;
      if (index >= prepared.length) return;

      const { item, mode } = prepared[index];
      const meterid = amrTextValue(item.meterid);
      const period = amrTextValue(item.period);
      const billingPeriodId = strictNumber(item.billing_period_id);

      if (mode === "completeMissingRaw") {
        try {
          await ddb.send(
            new PutCommand({
              TableName: READINGS_TABLE,
              Item: item,
              ConditionExpression:
                "attribute_exists(#meterid) AND attribute_exists(#period) AND attribute_not_exists(#reading)",
              ExpressionAttributeNames: {
                "#meterid": "meterid",
                "#period": "period",
                "#reading": "reading",
              },
            }),
          );
          overwritten++;
          await updateMeterZeroReadingStreak(
            amrTextValue(item.meterid),
            optionalNumber(item.ZeroReadingStreak) ?? 0,
            optionalNumber(item.billing_period_id),
          );
        } catch (error) {
          const name =
            error && typeof error === "object" && "name" in error
              ? String((error as { name?: unknown }).name)
              : "";

          if (name === "ConditionalCheckFailedException") {
            missingDuringOverwrite++;
            continue;
          }

          throw error;
        }

        continue;
      }

      if (mode === "create") {
        try {
          await ddb.send(
            new PutCommand({
              TableName: READINGS_TABLE,
              Item: item,
              ConditionExpression:
                "attribute_not_exists(#meterid) AND attribute_not_exists(#period)",
              ExpressionAttributeNames: {
                "#meterid": "meterid",
                "#period": "period",
              },
            }),
          );
          imported++;
        await updateMeterZeroReadingStreak(
          amrTextValue(item.meterid),
          optionalNumber(item.ZeroReadingStreak) ?? 0,
          optionalNumber(item.billing_period_id),
        );
        } catch (error) {
          const name =
            error && typeof error === "object" && "name" in error
              ? String((error as { name?: unknown }).name)
              : "";

          if (name === "ConditionalCheckFailedException") {
            alreadyExists++;
            continue;
          }

          throw error;
        }

        continue;
      }

      const names: Record<string, string> = {
        "#meterid": "meterid",
      };

      const values: Record<string, unknown> = {};
      const setParts: string[] = [];

      // Raw reading, consumption, reading_source and ZeroReadingStreak are
      // immutable once the billing-period record exists.

      if (
        Object.prototype.hasOwnProperty.call(item, "adjusted_consumption") &&
        item.adjusted_consumption !== undefined
      ) {
        names["#adjusted"] = "adjusted_consumption";
        values[":adjusted"] = item.adjusted_consumption;
        setParts.push("#adjusted = :adjusted");
      }

      const validationFields = [
        "validation_required",
        "validation_status",
        "validation_rule_ids",
        "validation_prev_month_pct",
        "validation_prev_year_pct",
        "validation_recommended_correction_rule",
        "validation_auto_corrected",
        "validation_action",
        "validation_checked_at",
      ];

      validationFields.forEach((field, fieldIndex) => {
        if (!Object.prototype.hasOwnProperty.call(item, field)) return;
        const nameKey = `#validation_${fieldIndex}`;
        const valueKey = `:validation_${fieldIndex}`;
        names[nameKey] = field;
        values[valueKey] = item[field];
        setParts.push(`${nameKey} = ${valueKey}`);
      });

      const removeParts: string[] = [];
      if (item.__remove_adjusted_consumption === true) {
        names["#adjusted"] = "adjusted_consumption";
        removeParts.push("#adjusted");
      }

      const keyCandidates: Array<{
        key: Record<string, unknown>;
        condition: string;
        extraNames: Record<string, string>;
      }> = [];

      if (period) {
        keyCandidates.push({
          key: { meterid, period },
          condition:
            "attribute_exists(#meterid) AND attribute_exists(#period)",
          extraNames: {
            "#period": "period",
          },
        });
      }

      if (billingPeriodId !== undefined) {
        keyCandidates.push({
          key: {
            meterid,
            billing_period_id: billingPeriodId,
          },
          condition:
            "attribute_exists(#meterid) AND attribute_exists(#bp)",
          extraNames: {
            "#bp": "billing_period_id",
          },
        });
      }

      let completed = false;
      let sawMissingRecord = false;
      let lastSchemaError: unknown = null;

      for (const candidate of keyCandidates) {
        try {
          await ddb.send(
            new UpdateCommand({
              TableName: READINGS_TABLE,
              Key: candidate.key,
              UpdateExpression: [
                setParts.length ? `SET ${setParts.join(", ")}` : "",
                removeParts.length ? `REMOVE ${removeParts.join(", ")}` : "",
              ].filter(Boolean).join(" "),
              ConditionExpression: candidate.condition,
              ExpressionAttributeNames: {
                ...names,
                ...candidate.extraNames,
              },
              ExpressionAttributeValues: values,
            }),
          );

          overwritten++;
          completed = true;
          break;
        } catch (error) {
          const name =
            error && typeof error === "object" && "name" in error
              ? String((error as { name?: unknown }).name)
              : "";

          const message =
            error instanceof Error
              ? error.message
              : String(error);

          if (
            name === "ValidationException" &&
            message
              .toLowerCase()
              .includes("key element does not match the schema")
          ) {
            lastSchemaError = error;
            continue;
          }

          if (name === "ConditionalCheckFailedException") {
            sawMissingRecord = true;
            continue;
          }

          throw error;
        }
      }

      if (completed) {
        continue;
      }

      if (sawMissingRecord) {
        missingDuringOverwrite++;
        continue;
      }

      if (lastSchemaError) {
        throw lastSchemaError;
      }

      missingDuringOverwrite++;
    }
  }

  const count = Math.min(
    MAX_CONCURRENT_WRITES,
    Math.max(1, prepared.length),
  );

  await Promise.all(
    Array.from({ length: count }, () => worker()),
  );

  return {
    imported,
    overwritten,
    alreadyExists,
    missingDuringOverwrite,
  };
}

async function handleManualPost(request: Request) {
  try {
    const formData = await request.formData();
    const files = formData
      .getAll("files")
      .filter((value): value is File => value instanceof File);

    if (!files.length) {
      return NextResponse.json(
        { error: "A manual meter-reading CSV file is required." },
        { status: 400 },
      );
    }

    const invalid = files.find(
      (file) => !file.name.toLowerCase().endsWith(".csv"),
    );
    if (invalid) {
      return NextResponse.json(
        { error: `${invalid.name} is not a CSV file.` },
        { status: 400 },
      );
    }

    const selectedFY = Number(amrTextValue(formData.get("fy")));
    const selectedMonth = normalizeMonth(formData.get("billing_month_nm"));
    const billingPeriodId = Number(
      amrTextValue(formData.get("billing_period_id")),
    );
    const action =
      amrTextValue(formData.get("action")).toLowerCase() || "preview";
    const overwriteMeterIds = new Set(
      formData
        .getAll("overwrite_meterid")
        .map((value) => amrTextValue(value))
        .filter(Boolean),
    );

    const manualEdits = parseManualEditOverrides(formData);

    if (
      !Number.isInteger(selectedFY) ||
      !selectedMonth ||
      !Number.isInteger(billingPeriodId) ||
      billingPeriodId <= 0
    ) {
      return NextResponse.json(
        { error: "Valid FY, Billing Month, and Billing Period ID are required." },
        { status: 400 },
      );
    }

    const expected = expectedBillingPeriodId(selectedFY, selectedMonth);
    if (expected === null || expected !== billingPeriodId) {
      return NextResponse.json(
        {
          error:
            `${selectedMonth} FY${selectedFY} should use Billing Period ${expected}, but the page supplied ${billingPeriodId}.`,
        },
        { status: 400 },
      );
    }

    if (action !== "preview" && action !== "import") {
      return NextResponse.json(
        { error: "Invalid manual upload action." },
        { status: 400 },
      );
    }

    const result = await buildManualPreview(
      files,
      selectedFY,
      selectedMonth,
      billingPeriodId,
      overwriteMeterIds,
      manualEdits,
    );

    if (action === "preview") {
      return NextResponse.json({
        success: true,
        uploadType: "manual",
        billingPeriodId,
        period: periodFromFiscalMonth(selectedFY, selectedMonth),
        summary: result.summary,
        rows: result.previewRows.slice(0, 1000),
        rowsTruncated: result.previewRows.length > 1000,
      });
    }

    if (!result.prepared.length) {
      return NextResponse.json(
        {
          error: "No manual readings are eligible for import after validation.",
          summary: result.summary,
          rows: result.previewRows.slice(0, 1000),
        },
        { status: 400 },
      );
    }

    const writeResult = await writeManualPreparedItems(result.prepared);

    return NextResponse.json({
      success: true,
      uploadType: "manual",
      billingPeriodId,
      period: periodFromFiscalMonth(selectedFY, selectedMonth),
      imported: writeResult.imported,
      overwritten: writeResult.overwritten,
      alreadyExistsDuringImport: writeResult.alreadyExists,
      missingDuringOverwrite: writeResult.missingDuringOverwrite,
      summary: result.summary,
    });
  } catch (error) {
    console.error("Manual meter-reading import failed:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Unable to import manual meter-reading CSV.",
      },
      { status: 500 },
    );
  }
}


// ============================================================
// FINALIZE ZERO-READING STREAKS FOR A BILLING PERIOD
//
// Call this AFTER all AMR and Manual imports for the billing period are
// complete. Meters with no reading record at all for the period advance
// their streak by one. Meters with a reading use the streak stored on the
// immutable reading record.
// ============================================================

async function handleFinalizeZeroStreaksPost(
  body: Record<string, unknown>,
) {
  const billingPeriodId = optionalNumber(body.billing_period_id);

  if (billingPeriodId === undefined || !Number.isInteger(billingPeriodId)) {
    return NextResponse.json(
      { error: "A valid billing_period_id is required." },
      { status: 400 },
    );
  }

  const [meters, currentReadings] = await Promise.all([
    scanMeters(),
    queryBillingPeriod(billingPeriodId),
  ]);

  const currentMap = recordByMeter(currentReadings);
  let withReading = 0;
  let missingReading = 0;
  let updated = 0;

  let nextIndex = 0;
  async function worker() {
    while (true) {
      const index = nextIndex++;
      if (index >= meters.length) return;

      const meter = meters[index];
      const meterid = amrTextValue(meter.meterid);
      if (!meterid) continue;

      const current = currentMap.get(meterid);
      let streak: number;

      if (current) {
        withReading++;
        streak = optionalNumber(current.ZeroReadingStreak) ??
          calculateZeroReadingStreak(optionalNumber(current.reading), undefined);
      } else {
        missingReading++;
        const trackedBp = optionalNumber(meter.ZeroReadingStreakBillingPeriod);
        const existingStreak = optionalNumber(meter.ZeroReadingStreak) ?? 0;

        // Idempotent: finalizing the same period twice must not increment twice.
        if (trackedBp === billingPeriodId) {
          continue;
        }

        streak = existingStreak + 1;
      }

      await updateMeterZeroReadingStreak(
        meterid,
        streak,
        billingPeriodId,
      );
      updated++;
    }
  }

  const workerCount = Math.min(
    MAX_CONCURRENT_WRITES,
    Math.max(1, meters.length),
  );

  await Promise.all(
    Array.from({ length: workerCount }, () => worker()),
  );

  return NextResponse.json({
    success: true,
    billingPeriodId,
    meters: meters.length,
    withReading,
    missingReading,
    updated,
  });
}

// ============================================================
// POST ROUTER
//
// JSON POST keeps the existing single-record create behavior.
// multipart/form-data POST runs the AMR CSV preview/import.
// This avoids creating a second nested API route.
// ============================================================

// POST dispatches JSON reading operations and multipart AMR/manual uploads.
// Each handler below retains its original validation and DynamoDB behavior.
export async function POST(request: Request) {
  // ============================================================
  // AUTHENTICATION (PRODUCTION - CURRENTLY DISABLED)
  // Enable the auth import above and uncomment this block when
  // authenticated access is required for this endpoint.
  // ============================================================
  const session = await getAppSession();
  if (!session?.user) {
    return NextResponse.json(
      { error: "Unauthorized" },
      { status: 401 },
    );
  }


  const contentType =
    request.headers.get("content-type")?.toLowerCase() ?? "";

  if (contentType.includes("multipart/form-data")) {
    // Inspect a clone so the original request body remains available to
    // the selected upload handler.
    const probe = await request.clone().formData();
    const uploadType =
      textValue(probe.get("upload_type")).toLowerCase();

    if (uploadType === "manual") {
      return handleManualPost(request);
    }

    return handleAMRPost(request);
  }

  if (contentType.includes("application/json")) {
    const cloned =
      request.clone();

    const body =
      (await cloned.json()) as Record<string, unknown>;

    if (textValue(body.action) === "save_manual_entry") {
      return handleManualEntryPost(body);
    }

    if (textValue(body.action) === "finalize_zero_streaks") {
      return handleFinalizeZeroStreaksPost(body);
    }

    if (textValue(body.action) === "save_mapping") {
      return handleSaveMappingPost(body);
    }

    if (textValue(body.action) === "update_meter_facility") {
      return handleUpdateMeterFacilityPost(body);
    }
  }

  return handleSingleReadingPost(request);
}
