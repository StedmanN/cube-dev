import { NextRequest, NextResponse } from "next/server";
import { DeleteCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "@/lib/dynamo";

// Production authentication (disabled until authentication is enabled).
import { getAppSession } from "@/lib/app-session";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const TABLE_NAME = "p72-CUBE-PLANT-UNIT";
const BILLING_PERIOD_INDEX = "billing-period-index";

// Convert optional DynamoDB / request values into trimmed strings.
function text(value: unknown): string {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

// Parse numeric inputs, allowing commas in formatted numbers.
function numberValue(value: unknown): number | null {
  const parsed = Number(String(value ?? "").replace(/,/g, "").trim());
  return Number.isFinite(parsed) ? parsed : null;
}

// Stable DynamoDB partition key for a billing period, group, utility, and plant.
function plantUnitId(
  billingPeriodId: number,
  utilityGroupId: string,
  utilityType: string,
  plantId: string,
) {
  return [billingPeriodId, utilityGroupId, utilityType.toUpperCase(), plantId].join("#");
}

// ============================================================
// GET - Read Plant Unit records for one billing period.
//
// billing_period_id is stored as a DynamoDB NUMBER. The GSI
// billing-period-index expects the same numeric key type.
// ============================================================
export async function GET(request: NextRequest) {
  // ========================================================
  // AUTHENTICATION - Uncomment when production auth is enabled.
  // ========================================================
  const session = await getAppSession();
  if (!session?.user) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  try {
    const billingPeriodId = numberValue(request.nextUrl.searchParams.get("billing_period_id"));
    if (billingPeriodId === null || billingPeriodId <= 0) {
      return NextResponse.json(
        { error: "billing_period_id is required and must be a valid number." },
        { status: 400 },
      );
    }

    const result = await ddb.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        IndexName: BILLING_PERIOD_INDEX,
        KeyConditionExpression: "#bp = :bp",
        ExpressionAttributeNames: { "#bp": "billing_period_id" },
        ExpressionAttributeValues: { ":bp": billingPeriodId },
      }),
    );

    // Preserve existing sorting: numeric-aware group order, then utility code.
    const records = (result.Items ?? []).sort((a, b) => {
      const groupCompare = text(a.utility_group_id).localeCompare(
        text(b.utility_group_id),
        undefined,
        { numeric: true },
      );
      if (groupCompare !== 0) return groupCompare;
      return text(a.produced_utility_type_cd).localeCompare(text(b.produced_utility_type_cd));
    });

    return NextResponse.json({ ok: true, records });
  } catch (error) {
    console.error("Plant Unit GET failed:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unable to load Plant Unit data." },
      { status: 500 },
    );
  }
}

// ============================================================
// POST - Create or replace a Plant Unit production record.
//
// A deterministic PlantUnitID means PutCommand overwrites an
// existing record with the same billing period/group/type/plant.
// Only PW in KGAL is currently supported for manual entry.
// ============================================================
export async function POST(request: NextRequest) {
  // ========================================================
  // AUTHENTICATION - Uncomment when production auth is enabled.
  // ========================================================
  const session = await getAppSession();
  if (!session?.user) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = (await request.json()) as Record<string, unknown>;
    const billingPeriodId = numberValue(body.billing_period_id);
    const fy = text(body.fy);
    const billingMonth = text(body.billing_month_nm);
    const plantId = text(body.plant_id) || "16";
    const plantUnit = text(body.plant_unit) || "WATER WELLS COMBINED";
    const utilityType = text(body.produced_utility_type_cd).toUpperCase() || "PW";
    const unitCapacityUm = text(body.unit_capacity_um).toUpperCase() || "KGAL";
    const utilityGroupId = text(body.utility_group_id);
    const distributionSystem = text(body.distribution_system) || "WATER WELLS COMBINED";
    const totalProduction = numberValue(body.total_production);

    // Validate required identifiers and the PW/KGAL production constraint.
    if (billingPeriodId === null || billingPeriodId <= 0) {
      return NextResponse.json(
        { error: "billing_period_id is required and must be a valid number." },
        { status: 400 },
      );
    }
    if (!fy || !billingMonth) {
      return NextResponse.json({ error: "fy and billing_month_nm are required." }, { status: 400 });
    }
    if (!utilityGroupId) {
      return NextResponse.json({ error: "utility_group_id is required." }, { status: 400 });
    }
    if (utilityType !== "PW") {
      return NextResponse.json(
        { error: "Plant Unit manual entry currently supports PW only." },
        { status: 400 },
      );
    }
    if (unitCapacityUm !== "KGAL") {
      return NextResponse.json(
        { error: "PW Plant Unit production must be entered in KGAL." },
        { status: 400 },
      );
    }
    if (totalProduction === null || totalProduction < 0) {
      return NextResponse.json(
        { error: "total_production must be a valid number of KGAL." },
        { status: 400 },
      );
    }

    // Example ID: 181#1#PW#16. The partition key is a string,
    // while billing_period_id remains a DynamoDB Number for the GSI.
    const id = plantUnitId(billingPeriodId, utilityGroupId, utilityType, plantId);
    const now = new Date().toISOString();
    const item = {
      PlantUnitID: id,
      billing_period_id: billingPeriodId,
      fy,
      billing_month_nm: billingMonth,
      plant_id: plantId,
      plant_unit: plantUnit,
      produced_utility_type_cd: utilityType,
      total_production: totalProduction,
      unit_capacity_um: unitCapacityUm,
      utility_group_id: utilityGroupId,
      distribution_system: distributionSystem,
      updated_at: now,
    };

    await ddb.send(new PutCommand({ TableName: TABLE_NAME, Item: item }));
    return NextResponse.json({ ok: true, record: item });
  } catch (error) {
    console.error("Plant Unit POST failed:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unable to save Plant Unit production." },
      { status: 500 },
    );
  }
}

// ============================================================
// DELETE - Remove one Plant Unit record by its string PK.
// Example: 181#1#PW#16.
// ============================================================
export async function DELETE(request: NextRequest) {
  // ========================================================
  // AUTHENTICATION - Uncomment when production auth is enabled.
  // ========================================================
  const session = await getAppSession();
  if (!session?.user) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  try {
    const plantUnitIdValue = text(request.nextUrl.searchParams.get("plant_unit_id"));
    if (!plantUnitIdValue) {
      return NextResponse.json({ error: "plant_unit_id is required." }, { status: 400 });
    }

    await ddb.send(
      new DeleteCommand({ TableName: TABLE_NAME, Key: { PlantUnitID: plantUnitIdValue } }),
    );
    return NextResponse.json({ ok: true, deleted: plantUnitIdValue });
  } catch (error) {
    console.error("Plant Unit DELETE failed:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unable to delete Plant Unit production." },
      { status: 500 },
    );
  }
}
