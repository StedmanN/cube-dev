import {

  BatchWriteCommand,

  QueryCommand,

  ScanCommand,

  type QueryCommandInput,

  type ScanCommandInput,

} from "@aws-sdk/lib-dynamodb";

import { ddb } from "@/lib/dynamo";

import {
  activateRealPropertySnapshot,
  buildPropQRecords,
  filterActiveRealPropertyRecords,
  getRealPropertyPeriodState,
  REAL_PROPERTY_TABLE,
} from "@/lib/real-property-snapshot";
import { REAL_PROPERTY_TABLES } from "@/lib/real-property-tables";
import { refreshEstimatesForRealPropertyRecords } from "@/lib/real-property-crud";

// Production authentication (currently disabled):
import { getAppSession } from "@/lib/app-session";

export const dynamic = "force-dynamic";

export const revalidate = 0;

const ESTIMATES_TABLE = REAL_PROPERTY_TABLES.estimates;

const PROPQ_TABLE = REAL_PROPERTY_TABLES.propQ;

const CATEGORY_TABLE = REAL_PROPERTY_TABLES.categories;

const INTENSITY_TABLE = REAL_PROPERTY_TABLES.intensities;

const BILLING_PERIOD_INDEX =

  "billing-period-index";


type Item = Record<string, unknown>;

function text(value: unknown): string {

  return value === undefined || value === null

    ? ""

    : String(value).trim();

}

function numberOrNull(value: unknown): number | null {

  const normalized =

    text(value).replace(/[$,]/g, "");

  if (!normalized) return null;

  const parsed = Number(normalized);

  return Number.isFinite(parsed)

    ? parsed

    : null;

}

// Query all pages for one numeric billing period using the shared GSI.
async function queryPeriod(

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

    items.push(

      ...((result.Items ?? []) as Item[]),

    );

    exclusiveStartKey =

      result.LastEvaluatedKey;

  } while (exclusiveStartKey);

  return filterActiveRealPropertyRecords(tableName, billingPeriodId, items);

}

async function scanAll(tableName: string): Promise<Item[]> {
  const items: Item[] = [];
  let exclusiveStartKey: ScanCommandInput["ExclusiveStartKey"] | undefined;
  do {
    const result = await ddb.send(
      new ScanCommand({ TableName: tableName, ExclusiveStartKey: exclusiveStartKey }),
    );
    items.push(...((result.Items ?? []) as Item[]));
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);
  return items;
}

// DynamoDB BatchWrite is limited to 25 items per request.
// Retry any unprocessed writes until DynamoDB accepts them.
async function batchPut(

  tableName: string,

  items: Item[],

) {

  for (

    let offset = 0;

    offset < items.length;

    offset += 25

  ) {

    let requests = items

      .slice(offset, offset + 25)

      .map((Item) => ({

        PutRequest: {

          Item,

        },

      }));

    while (requests.length > 0) {

      const result = await ddb.send(

        new BatchWriteCommand({

          RequestItems: {

            [tableName]: requests,

          },

        }),

      );

      const unprocessed =

        result.UnprocessedItems?.[tableName] ?? [];

      requests = unprocessed

        .filter(

          (request) =>

            request.PutRequest?.Item !== undefined,

        )

        .map((request) => ({

          PutRequest: {

            Item: request.PutRequest!.Item!,

          },

        }));

    }

  }

}

// Delete existing PropQ items in batches when regeneration is requested.
// Uses PropQID as the partition key and retries unprocessed deletes.
async function batchDeletePropQ(

  items: Item[],

) {

  for (

    let offset = 0;

    offset < items.length;

    offset += 25

  ) {

    let requests = items

      .slice(offset, offset + 25)

      .map((item) => ({

        DeleteRequest: {

          Key: {

            PropQID: text(item.PropQID),

          },

        },

      }))

      .filter(

        (request) =>

          request.DeleteRequest.Key.PropQID !== "",

      );

    while (requests.length > 0) {

      const result = await ddb.send(

        new BatchWriteCommand({

          RequestItems: {

            [PROPQ_TABLE]: requests,

          },

        }),

      );

      const unprocessed =

        result.UnprocessedItems?.[PROPQ_TABLE] ?? [];

      requests = unprocessed

        .filter(

          (request) =>

            request.DeleteRequest?.Key !== undefined,

        )

        .map((request) => ({

          DeleteRequest: {

            Key: {

              PropQID: text(

                request.DeleteRequest!.Key!.PropQID,

              ),

            },

          },

        }))

        .filter(

          (request) =>

            request.DeleteRequest.Key.PropQID !== "",

        );

    }

  }

}

// GET reports whether PropQ has been generated for a billing period.
// It reads saved records but does not modify DynamoDB.
export async function GET(request: Request) {
  // ============================================================
  // PRODUCTION AUTHENTICATION (DISABLED)
  // Enable the auth import above and this check before deployment.
  // ============================================================
  const session = await getAppSession();
  if (!session?.user) {
    return Response.json(
      { ok: false, error: "Unauthorized" },
      { status: 401 },
    );
  }


  try {

    const url = new URL(request.url);

    const billingPeriodId =

      Number(

        url.searchParams.get(

          "billing_period_id",

        ),

      );

    if (!Number.isInteger(billingPeriodId)) {

      return Response.json(

        {

          ok: false,

          error:

            "billing_period_id is required.",

        },

        {

          status: 400,

        },

      );

    }

    const records =

      await queryPeriod(

        PROPQ_TABLE,

        billingPeriodId,

      );

    return Response.json({

      ok: true,

      billingPeriodId,

      generated: records.length > 0,

      recordCount: records.length,

      zeroProjectedUsage:

        records.filter(

          (record) =>

            text(record.PropQStatus) ===

            "ZERO_PROJECTED_USAGE",

        ).length,

      records,

    });

  } catch (error) {

    console.error(

      "PropQ status failed:",

      error,

    );

    return Response.json(

      {

        ok: false,

        error:

          error instanceof Error

            ? error.message

            : "Unable to load PropQ.",

      },

      {

        status: 500,

      },

    );

  }

}

// POST generates facility-and-utility allocation shares from estimates.
// PropQ = estimated usage / total estimated usage for the facility + utility.
// Sewer (SS) is excluded; downstream reconciliation derives its allocation.
// Regeneration deletes the previous set only after replacement data is built.
export async function POST(request: Request) {
  // ============================================================
  // PRODUCTION AUTHENTICATION (DISABLED)
  // Enable the auth import above and this check before deployment.
  // ============================================================
  const session = await getAppSession();
  if (!session?.user) {
    return Response.json(
      { ok: false, error: "Unauthorized" },
      { status: 401 },
    );
  }


  try {

    const body =

      (await request.json()) as {

        billing_period_id?: number;

        regenerate?: boolean;

      };

    const billingPeriodId =

      Number(body.billing_period_id);

    const regenerate =

      body.regenerate === true;

    if (!Number.isInteger(billingPeriodId)) {

      return Response.json(

        {

          ok: false,

          error:

            "billing_period_id is required.",

        },

        {

          status: 400,

        },

      );

    }

    const managedState = await getRealPropertyPeriodState(billingPeriodId);
    if (managedState) {
      if (!regenerate) {
        return Response.json(
          {
            ok: false,
            alreadyGenerated: true,
            canRegenerate: true,
            error: "Regenerate this period to rebuild Estimates and PropQ using the current category and intensity tables.",
          },
          { status: 409 },
        );
      }

      const [realProperty, existingEstimates, categories, intensities] = await Promise.all([
        queryPeriod(REAL_PROPERTY_TABLE, billingPeriodId),
        queryPeriod(ESTIMATES_TABLE, billingPeriodId),
        scanAll(CATEGORY_TABLE),
        scanAll(INTENSITY_TABLE),
      ]);
      if (realProperty.length === 0) {
        return Response.json(
          { ok: false, error: `No active Real Property records were found for billing period ${billingPeriodId}.` },
          { status: 404 },
        );
      }

      const fy = Number(managedState.FY);
      const billingMonth = text(managedState.BillingMonth);
      const refreshed = refreshEstimatesForRealPropertyRecords({
        realProperty,
        existingEstimates,
        categories,
        intensities,
        fy,
        billingMonth,
        billingPeriodId,
      });
      if (refreshed.errors.length > 0) {
        return Response.json(
          { ok: false, error: "Estimate refresh validation failed. Nothing was activated.", details: refreshed.errors },
          { status: 400 },
        );
      }
      if (refreshed.estimates.length === 0) {
        return Response.json(
          { ok: false, error: `No estimates were available to generate PropQ for billing period ${billingPeriodId}.` },
          { status: 404 },
        );
      }

      const nextPropQ = buildPropQRecords(refreshed.estimates, {
        billingPeriodId,
        fy,
        billingMonth,
      });
      const actor = text(session.user.email ?? session.user.name) || "authenticated-user";
      const activated = await activateRealPropertySnapshot({
        billingPeriodId,
        fy,
        billingMonth,
        realProperty,
        estimates: refreshed.estimates,
        propQ: nextPropQ,
        operation: "RECALCULATE",
        actor,
        details: {
          reason: "Regenerated Estimates and PropQ from current category and intensity data.",
          refreshedRecordCount: refreshed.refreshedRecordCount,
          estimateCount: refreshed.estimates.length,
          propQCount: nextPropQ.length,
        },
        expectedDataVersion: managedState.ActiveDataVersion,
      });
      return Response.json({
        ok: true,
        billingPeriodId,
        regenerated: true,
        estimatesRebuilt: true,
        realPropertyRecordsRefreshed: refreshed.refreshedRecordCount,
        estimateCount: refreshed.estimates.length,
        propQCreated: nextPropQ.length,
        dataVersion: activated.dataVersion,
        reconciliationPotentiallyStale: true,
        billsPotentiallyStale: true,
        ssPropQExcluded: true,
      });
    }

    const existing =

      await queryPeriod(

        PROPQ_TABLE,

        billingPeriodId,

      );

    if (

      existing.length > 0 &&

      !regenerate

    ) {

      return Response.json(

        {

          ok: false,

          alreadyGenerated: true,

          recordCount: existing.length,

          canRegenerate: true,

          error:

            `PropQ already exists for billing period ${billingPeriodId}. Send regenerate: true to rebuild it.`,

        },

        {

          status: 409,

        },

      );

    }

    const estimates =

      await queryPeriod(

        ESTIMATES_TABLE,

        billingPeriodId,

      );

    if (estimates.length === 0) {

      return Response.json(

        {

          ok: false,

          error:

            `No estimates were found for billing period ${billingPeriodId}.`,

        },

        {

          status: 404,

        },

      );

    }

    /*

     * SS is intentionally excluded from PropQ.

     *

     * Sewer consumption is derived later from each customer's

     * allocated PW consumption:

     *

     *   TAC SS rate =

     *     TAC invoice SS / TAC invoice PW

     *

     *   WWYK PW basis =

     *     WWYK invoice PW + WWYK Plant Unit well-water PW

     *

     *   WWYK SS rate =

     *     WWYK invoice SS / WWYK PW basis

     *

     *   Customer SS =

     *     Customer allocated PW * group SS rate

     *

     * PropQ therefore remains the source of the customer's PW

     * allocation share, while SS is a separately stored derived

     * allocation line item downstream.

     */

    const propQEstimates =

      estimates.filter(

        (estimate) =>

          text(

            estimate.UtilityType,

          ).toUpperCase() !== "SS",

      );

    if (propQEstimates.length === 0) {

      return Response.json(

        {

          ok: false,

          error:

            "No non-SS estimates were found for PropQ generation.",

        },

        {

          status: 400,

        },

      );

    }

    const totals =

      new Map<string, number>();

    for (const estimate of propQEstimates) {

      const facilityId =

        text(estimate.FacilityID);

      const utility =

        text(

          estimate.UtilityType,

        ).toUpperCase();

      const estimatedUsage =

        numberOrNull(

          estimate.EstimatedUsage,

        ) ?? 0;

      if (!facilityId || !utility) {

        continue;

      }

      const key =

        `${facilityId}|${utility}`;

      totals.set(

        key,

        (totals.get(key) ?? 0) +

          estimatedUsage,

      );

    }

    const now =

      new Date().toISOString();

    const propQItems: Item[] = [];

    for (const estimate of propQEstimates) {

      const estimateId =

        text(estimate.EstimateID);

      const facilityId =

        text(estimate.FacilityID);

      const utility =

        text(

          estimate.UtilityType,

        ).toUpperCase();

      if (

        !estimateId ||

        !facilityId ||

        !utility

      ) {

        continue;

      }

      const estimatedUsage =

        numberOrNull(

          estimate.EstimatedUsage,

        ) ?? 0;

      const key =

        `${facilityId}|${utility}`;

      const facilityEstimatedUsage =

        totals.get(key) ?? 0;

      const propQ =

        facilityEstimatedUsage > 0

          ? estimatedUsage /

            facilityEstimatedUsage

          : 0;

      const monthlyRpId =

        text(

          estimate.MonthlyRPID ??

            estimate.SourceMonthlyRPID,

        );

      const legacyRpId =

        text(estimate.LegacyRPID);

      const sourceRpId =

        monthlyRpId ||

        legacyRpId ||

        estimateId;

      propQItems.push({

        PropQID:

          `PROPQ#${billingPeriodId}#${sourceRpId}#${utility}`,

        EstimateID:

          estimateId,

        billing_period_id:

          billingPeriodId,

        FY:

          numberOrNull(

            estimate.FY ??

              estimate.fy,

          ),

        BillingMonth:

          text(estimate.BillingMonth),

        BillingMonthCode:

          text(

            estimate.BillingMonthCode,

          ),

        FacilityID:

          facilityId,

        CustomerID:

          text(estimate.CustomerID),

        CategoryCode:

          text(estimate.CategoryCode),

        AreaSF:

          numberOrNull(estimate.AreaSF) ?? 0,

        SpaceType:

          text(estimate.SpaceType),

        UtilityType:

          utility,

        EstimatedUsage:

          estimatedUsage,

        FacilityEstimatedUsage:

          facilityEstimatedUsage,

        PropQ:

          propQ,

        CalculationMethod:

          "ESTIMATED_USAGE_PROPQ",

        Source:

          "RP_ESTIMATE",

        CreatedDate:

          now,

        PropQStatus:

          facilityEstimatedUsage > 0

            ? "CALCULATED"

            : "ZERO_PROJECTED_USAGE",

        ...(monthlyRpId

          ? {

              MonthlyRPID: monthlyRpId,

            }

          : {}),

        ...(legacyRpId

          ? {

              LegacyRPID: legacyRpId,

            }

          : {}),

      });

    }

    if (propQItems.length === 0) {

      return Response.json(

        {

          ok: false,

          error:

            "No valid PropQ records could be produced.",

        },

        {

          status: 400,

        },

      );

    }

    /*

     * Regeneration is performed only after the new PropQ set has

     * been successfully built in memory. This prevents deleting

     * the existing period merely because estimates are missing or

     * invalid.

     */

    if (

      regenerate &&

      existing.length > 0

    ) {

      await batchDeletePropQ(existing);

    }

    await batchPut(

      PROPQ_TABLE,

      propQItems,

    );

    return Response.json({

      ok: true,

      billingPeriodId,

      regenerated: regenerate,

      previousRecordCount:

        regenerate ? existing.length : 0,

      propQCreated: propQItems.length,

      ssPropQExcluded: true,

      zeroProjectedUsage:

        propQItems.filter(

          (item) =>

            text(item.PropQStatus) ===

            "ZERO_PROJECTED_USAGE",

        ).length,

    });

  } catch (error) {

    console.error(

      "PropQ generation failed:",

      error,

    );

    return Response.json(

      {

        ok: false,

        error:

          error instanceof Error

            ? error.message

            : "Unable to generate PropQ.",

      },

      {

        status: 500,

      },

    );

  }

}
