import {

  QueryCommand,

  ScanCommand,

  type QueryCommandInput,

  type ScanCommandInput,

} from "@aws-sdk/lib-dynamodb";

import { getAppSession } from "@/lib/app-session";

import { ddb } from "@/lib/dynamo";

// ============================================================

// NEXT.JS ROUTE CONFIGURATION

//

// Facility Summary data is dynamic and must be retrieved from

// DynamoDB for each request.

// ============================================================

export const dynamic =

  "force-dynamic";

export const revalidate = 0;

// ============================================================

// DYNAMODB TABLES / INDEXES

// ============================================================

const METER_READINGS_TABLE =

  "p72-CUBE-METER-READINGS";

const METERS_TABLE =

  "p72-CUBE-METERS";

const BILLING_PERIOD_INDEX =

  "billing-period-index";

// ============================================================

// AUTHENTICATION

//

// Auth.js authentication is configured in "@/lib/auth".

//

// This API route contains CUBE Facility Summary data and is

// protected server-side.

//

// When enabled, GET validates the Auth.js session before processing

// query parameters or accessing DynamoDB.

//

// A valid authenticated request must contain session.user.

// Requests without an authenticated user return HTTP 401.

//

// When enabled, authentication is enforced at the API layer.

// Page/UI authentication alone must never be relied upon to

// protect application data or DynamoDB operations.

// ============================================================

// ============================================================

// VALUE HELPER

// ============================================================

function value(

  item: Record<string, unknown>,

  name: string,

): string {

  const raw =

    item[name];

  if (

    raw === undefined ||

    raw === null

  ) {

    return "";

  }

  return String(raw).trim();

}

// ============================================================

// QUERY BILLING PERIOD
// Uses the GSI rather than a table-wide scan for period readings.

//

// Queries meter readings using the billing-period-index.

//

// Pagination is handled with LastEvaluatedKey so all records

// belonging to the billing period are returned.

// ============================================================

async function queryBillingPeriod(

  billingPeriodId: number,

): Promise<

  Record<string, unknown>[]

> {

  const items:

    Record<string, unknown>[] =

      [];

  let exclusiveStartKey:

    | QueryCommandInput["ExclusiveStartKey"]

    | undefined;

  do {

    const result =

      await ddb.send(

        new QueryCommand({

          TableName:

            METER_READINGS_TABLE,

          IndexName:

            BILLING_PERIOD_INDEX,

          KeyConditionExpression:

            "#bp = :bp",

          ExpressionAttributeNames: {

            "#bp":

              "billing_period_id",

          },

          ExpressionAttributeValues: {

            ":bp":

              billingPeriodId,

          },

          ExclusiveStartKey:

            exclusiveStartKey,

        }),

      );

    items.push(

      ...(

        (result.Items ??

          []) as Record<

          string,

          unknown

        >[]

      ),

    );

    exclusiveStartKey =

      result.LastEvaluatedKey;

  } while (

    exclusiveStartKey

  );

  return items;

}

// ============================================================

// LOAD METER MASTER

//

// Facility Summary needs a subset of fields from the Meter

// Master. ProjectionExpression limits the DynamoDB response to

// only the fields required by this feature.

//

// Scan pagination is handled with LastEvaluatedKey.

// ============================================================

async function scanMeterMaster(): Promise<

  Record<string, unknown>[]

> {

  const items:

    Record<string, unknown>[] =

      [];

  let exclusiveStartKey:

    | ScanCommandInput["ExclusiveStartKey"]

    | undefined;

  do {

    const result =

      await ddb.send(

        new ScanCommand({

          TableName:

            METERS_TABLE,

          ProjectionExpression:

            "meterid, facility_nbr, sub_inst_cd, utility_type_cd",

          ExclusiveStartKey:

            exclusiveStartKey,

        }),

      );

    items.push(

      ...(

        (result.Items ??

          []) as Record<

          string,

          unknown

        >[]

      ),

    );

    exclusiveStartKey =

      result.LastEvaluatedKey;

  } while (

    exclusiveStartKey

  );

  return items;

}

// ============================================================

// MAP METER READING

//

// Converts the DynamoDB meter-reading record into the shape

// expected by the Facility Summary client.

// ============================================================

function mapReading(

  item:

    Record<string, unknown>,

) {

  return {

    meterid:

      value(

        item,

        "meterid",

      ),

    period:

      value(

        item,

        "period",

      ),

    billing_period_id:

      value(

        item,

        "billing_period_id",

      ),

    fy:

      value(

        item,

        "fy",

      ),

    billing_month_nm:

      value(

        item,

        "billing_month_nm",

      ),

    utility_type_cd:

      value(

        item,

        "utility_type_cd",

      ),

    inst_cd:

      value(

        item,

        "inst_cd",

      ),

    sub_inst_cd:

      value(

        item,

        "sub_inst_cd",

      ),

    site_cd:

      value(

        item,

        "site_cd",

      ),

    facility_nbr:

      value(

        item,

        "facility_nbr",

      ),

    multiplier:

      value(

        item,

        "multiplier",

      ),

    previous_reading:

      value(

        item,

        "previous_reading",

      ),

    previous_adjusted_reading:

      value(

        item,

        "previous_adjusted_reading",

      ),

    reading:

      value(

        item,

        "reading",

      ),

    consumption:

      value(

        item,

        "consumption",

      ),

    meter_correction_rule_cd:

      value(

        item,

        "meter_correction_rule_cd",

      ),

    adjusted_consumption:

      value(

        item,

        "adjusted_consumption",

      ),

    used_in_calculation:

      value(

        item,

        "used_in_calculation",

      ),

  };

}

// ============================================================

// MAP METER MASTER RECORD

// ============================================================

function mapMeter(

  item:

    Record<string, unknown>,

) {

  return {

    meterid:

      value(

        item,

        "meterid",

      ),

    facility_nbr:

      value(

        item,

        "facility_nbr",

      ),

    sub_inst_cd:

      value(

        item,

        "sub_inst_cd",

      ),

    utility_type_cd:

      value(

        item,

        "utility_type_cd",

      ),

  };

}

// ============================================================

// READING IDENTITY

//

// Creates a stable identity used to defensively deduplicate

// meter-reading records.

//

// Prefer "period" when available. Older records may not contain

// period, so billing_period_id is used as the fallback.

// ============================================================

function readingIdentity(

  reading:

    ReturnType<

      typeof mapReading

    >,

): string {

  const period =

    reading.period ||

    reading.billing_period_id;

  return `${reading.meterid}#${period}`;

}

// ============================================================

// FACILITY SUMMARY

//

// GET /api/...?...billing_period_id=

//

// Authentication:

// Auth.js session check is present but commented out.

//

// Data:

// Loads the requested billing period and the preceding periods

// needed for the Facility Summary one-year comparison.

// ============================================================

export async function GET(

  request: Request,

) {

  try {

    // ========================================================

    // AUTHENTICATION

    //

    // Validate the current Auth.js session BEFORE processing

    // query parameters or performing DynamoDB operations.

    //

    // This protects read access as well as write access.

    // ========================================================

    const session =

      await getAppSession();

    if (!session?.user) {

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

    //

    // When enabled, successful authentication allows the request

    // to continue to parameter validation and DynamoDB retrieval.

    // ========================================================

    const url =

      new URL(

        request.url,

      );

    const rawBillingPeriodId =

      url.searchParams

        .get(

          "billing_period_id",

        )

        ?.trim() ?? "";

    // ========================================================

    // BILLING PERIOD VALIDATION

    // ========================================================

    if (

      !/^\d+$/.test(

        rawBillingPeriodId,

      )

    ) {

      return Response.json(

        {

          ok: false,

          error:

            "billing_period_id is required and must be a numeric DynamoDB billing period ID.",

        },

        {

          status: 400,

        },

      );

    }

    const billingPeriodId =

      Number(

        rawBillingPeriodId,

      );

    if (

      !Number.isSafeInteger(

        billingPeriodId,

      ) ||

      billingPeriodId <= 0

    ) {

      return Response.json(

        {

          ok: false,

          error:

            "Invalid billing_period_id.",

        },

        {

          status: 400,

        },

      );

    }

    // ========================================================

    // FACILITY SUMMARY PERIOD WINDOW
// Billing period IDs are assumed to be sequential monthly identifiers.

    //

    // True 1-year deviation compares:

    //

    // latest 12 months

    //        vs.

    // preceding 12 months

    //

    // Facility Summary therefore needs up to 24 billing

    // periods ending with the requested billing period.

    // ========================================================

    const firstBillingPeriodId =

      Math.max(

        1,

        billingPeriodId -

          23,

      );

    const billingPeriodIds =

      Array.from(

        {

          length:

            billingPeriodId -

            firstBillingPeriodId +

            1,

        },

        (

          _,

          index,

        ) =>

          firstBillingPeriodId +

          index,

      );

    // ========================================================

    // LOAD DATA

    //

    // Billing-period queries and Meter Master retrieval run

    // concurrently to reduce total request time.

    // ========================================================

    const [

      readingGroups,

      meterItems,

    ] =

      await Promise.all([

        Promise.all(

          billingPeriodIds.map(

            (

              periodId,

            ) =>

              queryBillingPeriod(

                periodId,

              ),

          ),

        ),

        scanMeterMaster(),

      ]);

    // ========================================================

    // MAP READINGS

    // ========================================================

    const mappedReadings =

      readingGroups

        .flat()

        .map(

          mapReading,

        );

    // ========================================================

    // DEFENSIVE DEDUPLICATION

    //

    // Prefer period when present. Otherwise use

    // billing_period_id so older records without "period"

    // do not collapse into one meter record.

    // ========================================================

    const dedupedReadings =

      Array.from(

        new Map(

          mappedReadings.map(

            (reading) => [

              readingIdentity(

                reading,

              ),

              reading,

            ],

          ),

        ).values(),

      );

    // ========================================================

    // RESPONSE

    // ========================================================

    return Response.json({

      ok: true,

      billingPeriodId:

        String(

          billingPeriodId,

        ),

      firstBillingPeriodId:

        String(

          firstBillingPeriodId,

        ),

      billingPeriodIds:

        billingPeriodIds.map(

          String,

        ),

      readings:

        dedupedReadings,

      meterMaster:

        meterItems.map(

          mapMeter,

        ),

    });

  } catch (error) {

    console.error(

      "Facility Summary GET failed:",

      error,

    );

    return Response.json(

      {

        ok: false,

        error:

          error instanceof

          Error

            ? error.message

            : "Unable to load Facility Summary data.",

      },

      {

        status: 500,

      },

    );

  }

}
