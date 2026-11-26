import { randomUUID } from "node:crypto";

import {
  QueryCommand,
  ScanCommand,
  type QueryCommandInput,
  type ScanCommandInput,
} from "@aws-sdk/lib-dynamodb";

import { getAppSession } from "@/lib/app-session";
import { ddb } from "@/lib/dynamo";
import {
  normalizeLegacyRealPropertyRecord,
  usesPeriodSnapshot,
} from "@/lib/real-property-effective-core";
import {
  buildEstimatesForRealPropertyRecord,
  buildRealPropertyRecord,
  replaceRecordDependents,
  validateRealPropertyEditorInput,
  type RealPropertyEditorInput,
} from "@/lib/real-property-crud";
import {
  activateRealPropertySnapshot,
  buildPropQRecords,
  ESTIMATES_TABLE,
  filterActiveRealPropertyRecords,
  getRealPropertyPeriodState,
  logicalMonthlyRpId,
  REAL_PROPERTY_TABLE,
  type RealPropertyItem,
} from "@/lib/real-property-snapshot";
import { REAL_PROPERTY_TABLES } from "@/lib/real-property-tables";
import { validateRealPropertyCategoryCode } from "@/lib/real-property-category-code";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const CUSTOMERS_TABLE = REAL_PROPERTY_TABLES.customers;
const FACILITIES_TABLE = REAL_PROPERTY_TABLES.facilities;
const CATEGORY_TABLE = REAL_PROPERTY_TABLES.categories;
const INTENSITY_TABLE = REAL_PROPERTY_TABLES.intensities;
const LEGACY_RP_TABLE = REAL_PROPERTY_TABLES.legacy;
const BILLING_PERIOD_INDEX = "billing-period-index";

type MutationBody = {
  action?: "create" | "update" | "delete" | "delete_all";
  billing_period_id?: unknown;
  fy?: unknown;
  billing_month_nm?: unknown;
  monthly_rp_id?: unknown;
  record?: RealPropertyEditorInput;
  confirmation_month?: unknown;
  confirmation_count?: unknown;
  confirmation_phrase?: unknown;
  confirmed?: unknown;
};

function text(value: unknown): string {
  return value === undefined || value === null ? "" : String(value).trim();
}

async function queryPeriod(tableName: string, billingPeriodId: number) {
  const items: RealPropertyItem[] = [];
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
    items.push(...((result.Items ?? []) as RealPropertyItem[]));
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);
  return filterActiveRealPropertyRecords(tableName, billingPeriodId, items);
}

async function scanAll(tableName: string) {
  const items: RealPropertyItem[] = [];
  let exclusiveStartKey: ScanCommandInput["ExclusiveStartKey"] | undefined;
  do {
    const result = await ddb.send(
      new ScanCommand({ TableName: tableName, ExclusiveStartKey: exclusiveStartKey }),
    );
    items.push(...((result.Items ?? []) as RealPropertyItem[]));
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);
  return items;
}

async function loadLegacyBaseline(
  billingPeriodId: number,
  fy: number,
  billingMonth: string,
) {
  const items: RealPropertyItem[] = [];
  let exclusiveStartKey: ScanCommandInput["ExclusiveStartKey"] | undefined;
  do {
    const result = await ddb.send(
      new ScanCommand({
        TableName: LEGACY_RP_TABLE,
        FilterExpression: "#fy = :fy",
        ExpressionAttributeNames: { "#fy": "FY" },
        ExpressionAttributeValues: { ":fy": fy },
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );
    items.push(...((result.Items ?? []) as RealPropertyItem[]));
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);
  return items.map((item) =>
    normalizeLegacyRealPropertyRecord(item, { billingPeriodId, billingMonth }),
  );
}

function badRequest(error: string, details?: string[]) {
  return Response.json({ ok: false, error, details }, { status: 400 });
}

export async function POST(request: Request) {
  const session = await getAppSession();
  if (!session?.user) {
    return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = (await request.json()) as MutationBody;
    const action = body.action;
    const billingPeriodId = Number(body.billing_period_id);
    const fy = Number(body.fy);
    const billingMonth = text(body.billing_month_nm);

    if (!action || !["create", "update", "delete", "delete_all"].includes(action)) {
      return badRequest("A valid Real Property action is required.");
    }
    if (body.confirmed !== true) {
      return badRequest("Final confirmation is required before changing Real Property data.");
    }
    if (
      !Number.isSafeInteger(billingPeriodId) ||
      billingPeriodId <= 0 ||
      !Number.isSafeInteger(fy) ||
      !billingMonth
    ) {
      return badRequest(
        "A Real Property billing period, FY, and billing month are required.",
      );
    }

    const initialState = await getRealPropertyPeriodState(billingPeriodId);
    const useSnapshot = usesPeriodSnapshot(billingPeriodId, initialState !== null);
    const [currentRp, currentEstimates] = await Promise.all([
      useSnapshot
        ? queryPeriod(REAL_PROPERTY_TABLE, billingPeriodId)
        : loadLegacyBaseline(billingPeriodId, fy, billingMonth),
      queryPeriod(ESTIMATES_TABLE, billingPeriodId),
    ]);
    const targetId = text(body.monthly_rp_id);
    const actor = text(session.user.email ?? session.user.name) || "authenticated-user";

    let nextRp = [...currentRp];
    let nextEstimates = [...currentEstimates];
    let operation: "CREATE" | "UPDATE" | "DELETE" | "DELETE_ALL";

    if (action === "delete_all") {
      if (
        text(body.confirmation_phrase) !== "DELETE" ||
        text(body.confirmation_month) !== billingMonth ||
        Number(body.confirmation_count) !== currentRp.length
      ) {
        return badRequest(
          `Full-month deletion confirmation must include DELETE, name ${billingMonth}, and match the current ${currentRp.length} record count.`,
        );
      }
      nextRp = [];
      nextEstimates = [];
      operation = "DELETE_ALL";
    } else if (action === "delete") {
      if (!targetId) return badRequest("monthly_rp_id is required.");
      if (!currentRp.some((item) => logicalMonthlyRpId(item) === targetId)) {
        return Response.json(
          { ok: false, error: `Real Property record ${targetId} was not found.` },
          { status: 404 },
        );
      }
      nextRp = currentRp.filter((item) => logicalMonthlyRpId(item) !== targetId);
      nextEstimates = replaceRecordDependents(currentEstimates, targetId, []);
      operation = "DELETE";
    } else {
      if (!body.record) return badRequest("A Real Property record is required.");
      const editor = body.record;
      const validationErrors = validateRealPropertyEditorInput(editor);
      if (validationErrors.length > 0) {
        return badRequest("Real Property validation failed.", validationErrors);
      }

      const existing =
        action === "update"
          ? currentRp.find((item) => logicalMonthlyRpId(item) === targetId)
          : undefined;
      if (action === "update" && !existing) {
        return Response.json(
          { ok: false, error: `Real Property record ${targetId} was not found.` },
          { status: 404 },
        );
      }

      const [customers, facilities, categories, intensities] = await Promise.all([
        scanAll(CUSTOMERS_TABLE),
        scanAll(FACILITIES_TABLE),
        scanAll(CATEGORY_TABLE),
        scanAll(INTENSITY_TABLE),
      ]);
      const categoryCodeError = validateRealPropertyCategoryCode(
        editor.CategoryCode,
        categories,
      );
      if (categoryCodeError) {
        return badRequest("Real Property validation failed.", [categoryCodeError]);
      }
      const customer = customers.find(
        (item) => text(item.CustomerID) === text(editor.CustomerID),
      );
      const facility = facilities.find(
        (item) => text(item.FacilityID) === text(editor.FacilityID),
      );
      if (!customer || !facility) {
        return badRequest("Customer or facility assignment is not valid.", [
          ...(!customer ? [`Customer ${editor.CustomerID} was not found.`] : []),
          ...(!facility ? [`Facility ${editor.FacilityID} was not found.`] : []),
        ]);
      }

      const logicalId = existing
        ? logicalMonthlyRpId(existing)
        : `MRP-MANUAL-${billingPeriodId}-${randomUUID()}`;
      const record = buildRealPropertyRecord({
        monthlyRpId: logicalId,
        editor,
        customer,
        facility,
        fy,
        billingMonth,
        billingPeriodId,
        existing,
      });
      const estimateResult = buildEstimatesForRealPropertyRecord({
        record,
        categories,
        intensities,
        fy,
        billingMonth,
        billingPeriodId,
      });
      if (estimateResult.errors.length > 0) {
        return badRequest("Estimate validation failed. Nothing was changed.", estimateResult.errors);
      }

      nextRp = existing
        ? currentRp.map((item) =>
            logicalMonthlyRpId(item) === logicalId ? record : item,
          )
        : [...currentRp, record];
      nextEstimates = replaceRecordDependents(
        currentEstimates,
        logicalId,
        estimateResult.estimates,
      );
      operation = existing ? "UPDATE" : "CREATE";
    }

    const nextPropQ = buildPropQRecords(nextEstimates, {
      billingPeriodId,
      fy,
      billingMonth,
    });
    const result = await activateRealPropertySnapshot({
      billingPeriodId,
      fy,
      billingMonth,
      realProperty: nextRp,
      estimates: nextEstimates,
      propQ: nextPropQ,
      operation,
      actor,
      targetMonthlyRpId: targetId,
      details: {
        priorRecordCount: currentRp.length,
        newRecordCount: nextRp.length,
        sourceMode: useSnapshot ? "PERIOD_SNAPSHOT" : "LEGACY_ANNUAL_BASELINE",
        legacyBaselinePreserved: !useSnapshot,
      },
      expectedDataVersion: initialState?.ActiveDataVersion ?? null,
    });

    return Response.json({
      ok: true,
      operation,
      billingPeriodId,
      recordCount: nextRp.length,
      estimateCount: nextEstimates.length,
      propQCount: nextPropQ.length,
      dataVersion: result.dataVersion,
      reconciliationPotentiallyStale: true,
      billsPotentiallyStale: true,
      message:
        operation === "DELETE_ALL"
          ? `Deleted all ${currentRp.length} active Real Property records for ${billingMonth} FY ${fy}.`
          : `Real Property ${operation.toLowerCase()} completed. Estimates and PropQ were updated in the same active snapshot.`,
    });
  } catch (error) {
    console.error("Real Property mutation failed:", error);
    return Response.json(
      {
        ok: false,
        error:
          error instanceof Error ? error.message : "Unable to update Real Property.",
      },
      { status: 500 },
    );
  }
}

