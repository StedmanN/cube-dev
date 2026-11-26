import {

  BatchWriteCommand,

  type BatchWriteCommandInput,

  DeleteCommand,

  PutCommand,

} from "@aws-sdk/lib-dynamodb";

import { NextResponse } from "next/server";

import { getAppSession } from "@/lib/app-session";

import { ddb } from "@/lib/dynamo";

// ============================================================

// TABLE

// ============================================================

const METERS_TABLE =

  "p72-CUBE-METERS";

// ============================================================

// AUTHENTICATION

//

// Production authentication is prepared using the application's Auth.js

// authentication configuration in "@/lib/auth".

//

// When enabled, every operation must validate the server-side session

// BEFORE processing request data or accessing DynamoDB.

//

// A valid authenticated request must contain session.user.

//

// If authentication is missing or invalid, the API immediately

// returns HTTP 401 Unauthorized.

//

// IMPORTANT:

// Authentication is currently COMMENTED OUT. UI/page-level

// authentication should not be relied upon to protect DynamoDB.

// ============================================================

// ============================================================

// METER FIELDS

// ============================================================

const METER_FIELDS = [

  "meterid",

  "sub_inst_cd",

  "site_cd",

  "facility_nbr",

  "utility_type_cd",

  "meter_type_cd",

  "amp",

  "device_id",

  "zone",

  "floor",

  "serial_nbr",

  "rollover",

  "expr1015",

  "multiplier",

  "utm_x",

  "utm_y",

  "vendor_id",

  "model_nbr",

  "install_date",

  "in_service_date",

  "inv_survey_date",

  "inv_tagged",

  "outside",

  "inv_read_method_id",

  "network_ip_address",

  "meter_ip_address",

  "xmit_ip_address",

  "subnet_mask",

  "default_gateway",

  "mac_id",

  "analog_link",

  "digital_link",

  "eng_assessment_tx",

  "narrative",

  "meter_status_id",

  "owner_id",

] as const;

// ============================================================

// TYPES

// ============================================================

type MeterField =

  (typeof METER_FIELDS)[number];

type MeterItem = Record<

  MeterField,

  string

>;

// ============================================================

// NORMALIZE METER

//

// Ensures every expected meter field exists and is represented

// as a trimmed string before being written to DynamoDB.

// ============================================================

function normalizeMeter(

  value: unknown,

): MeterItem {

  const source =

    typeof value === "object" &&

    value !== null

      ? (

          value as Record<

            string,

            unknown

          >

        )

      : {};

  const meter =

    {} as MeterItem;

  for (

    const field of

    METER_FIELDS

  ) {

    const raw =

      source[field];

    meter[field] =

      raw === undefined ||

      raw === null

        ? ""

        : String(raw).trim();

  }

  return meter;

}

// ============================================================

// CREATE METER

//

// POST /api/meters

//

// Authentication:

// Production session check is included but currently commented out.

//

// DynamoDB:

// Creates a new meter but will not overwrite an existing meter

// with the same meterid.

// ============================================================

export async function POST(

  request: Request,

) {

  try {

    // ========================================================

    // AUTHENTICATION

    //

    // Validate the current Auth.js session before reading the

    // request body or performing any DynamoDB operation.

    // ========================================================

    const session =

      await getAppSession();

    if (!session?.user) {

      return NextResponse.json(

        {

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

    // When authentication is enabled, a valid session permits

    // processing the meter creation request.

    // ========================================================

    const body =

      await request.json();

    const meter =

      normalizeMeter(

        body,

      );

    // ========================================================

    // VALIDATION

    // ========================================================

    if (!meter.meterid) {

      return NextResponse.json(

        {

          error:

            "Meter ID is required.",

        },

        {

          status: 400,

        },

      );

    }

    // ========================================================

    // DYNAMODB CREATE

    //

    // ConditionExpression prevents POST from accidentally

    // replacing an existing meter.

    // ========================================================

    await ddb.send(

      new PutCommand({

        TableName:

          METERS_TABLE,

        Item:

          meter,

        ConditionExpression:

          "attribute_not_exists(meterid)",

      }),

    );

    return NextResponse.json(

      {

        success: true,

        meter,

      },

      {

        status: 201,

      },

    );

  } catch (error) {

    console.error(

      "Create meter error:",

      error,

    );

    // ========================================================

    // DUPLICATE METER

    // ========================================================

    if (

      error instanceof Error &&

      error.name ===

        "ConditionalCheckFailedException"

    ) {

      return NextResponse.json(

        {

          error:

            "A meter with that Meter ID already exists.",

        },

        {

          status: 409,

        },

      );

    }

    return NextResponse.json(

      {

        error:

          "Unable to create meter.",

      },

      {

        status: 500,

      },

    );

  }

}

// ============================================================

// UPDATE METER

//

// PUT /api/meters

//

// Authentication:

// Production session check is included but currently commented out.

//

// DynamoDB:

// Updates an existing meter. PUT is not allowed to silently

// create a meter that does not already exist.

// ============================================================

export async function PUT(

  request: Request,

) {

  try {

    // ========================================================

    // AUTHENTICATION

    //

    // Validate authentication before reading the request body

    // or performing the DynamoDB update.

    // ========================================================

    const session =

      await getAppSession();

    if (!session?.user) {

      return NextResponse.json(

        {

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

    const body =

      await request.json();

    const meter =

      normalizeMeter(

        body,

      );

    // ========================================================

    // VALIDATION

    // ========================================================

    if (!meter.meterid) {

      return NextResponse.json(

        {

          error:

            "Meter ID is required.",

        },

        {

          status: 400,

        },

      );

    }

    // ========================================================

    // DYNAMODB UPDATE

    //

    // The meter ID is the permanent key for this record.

    //

    // ConditionExpression prevents PUT from creating a new

    // record when the supplied meter ID does not exist.

    // ========================================================

    await ddb.send(

      new PutCommand({

        TableName:

          METERS_TABLE,

        Item:

          meter,

        ConditionExpression:

          "attribute_exists(meterid)",

      }),

    );

    return NextResponse.json({

      success: true,

      meter,

    });

  } catch (error) {

    console.error(

      "Update meter error:",

      error,

    );

    // ========================================================

    // METER NOT FOUND

    // ========================================================

    if (

      error instanceof Error &&

      error.name ===

        "ConditionalCheckFailedException"

    ) {

      return NextResponse.json(

        {

          error:

            "The meter no longer exists.",

        },

        {

          status: 404,

        },

      );

    }

    return NextResponse.json(

      {

        error:

          "Unable to update meter.",

      },

      {

        status: 500,

      },

    );

  }

}

// ============================================================

// DELETE METER

//

// DELETE /api/meters?meterid=E1666

//

// Authentication:

// Production session check is included but currently commented out.

//

// NOTE:

// This preserves your existing meter deletion behavior.

// ============================================================

export async function DELETE(

  request: Request,

) {

  try {

    // ========================================================
    // AUTHENTICATION
    //
    // When enabled, authenticate before reading meter IDs
    // or deleting individual/bulk meter records in DynamoDB.
    // ========================================================

    const session =
      await getAppSession();

    if (!session?.user) {
      return NextResponse.json(
        {
          error: "Unauthorized",
        },
        {
          status: 401,
        },
      );
    }

    const url = new URL(request.url);

    const queryMeterId =

      url.searchParams.get("meterid")?.trim() || "";

    // Preserve existing single-meter deletion.

    if (queryMeterId) {

      await ddb.send(

        new DeleteCommand({

          TableName: METERS_TABLE,

          Key: {

            meterid: queryMeterId,

          },

          ConditionExpression:

            "attribute_exists(meterid)",

        }),

      );

      return NextResponse.json({

        success: true,

        meterid: queryMeterId,

      });

    }

    // Bulk deletion from the registry multi-select.

    let body: unknown = null;

    try {

      body = await request.json();

    } catch {

      body = null;

    }

    const source =

      typeof body === "object" && body !== null

        ? (body as Record<string, unknown>)

        : {};

    const rawMeterIds =

      Array.isArray(source.meterids)

        ? source.meterids

        : [];

    const meterids = Array.from(

      new Set(

        rawMeterIds

          .map((value) =>

            String(value ?? "").trim(),

          )

          .filter(Boolean),

      ),

    );

    if (meterids.length === 0) {

      return NextResponse.json(

        {

          error:

            "Meter ID or meterids array is required.",

        },

        {

          status: 400,

        },

      );

    }

    // DynamoDB BatchWrite supports 25 requests at a time.

    for (

      let index = 0;

      index < meterids.length;

      index += 25

    ) {

      let pending: NonNullable<BatchWriteCommandInput["RequestItems"]>[string] = meterids

        .slice(index, index + 25)

        .map((meterid) => ({

          DeleteRequest: {

            Key: {

              meterid,

            },

          },

        }));

      let attempts = 0;

      while (pending.length > 0) {

        const response = await ddb.send(

          new BatchWriteCommand({

            RequestItems: {

              [METERS_TABLE]: pending,

            },

          }),

        );

        pending =

          response.UnprocessedItems?.[

            METERS_TABLE

          ] ?? [];

        if (pending.length === 0) break;

        attempts += 1;

        if (attempts >= 5) {

          throw new Error(

            `Unable to delete ${pending.length} meter record(s) after multiple DynamoDB retries.`,

          );

        }

        await new Promise((resolve) =>

          setTimeout(

            resolve,

            100 * 2 ** attempts,

          ),

        );

      }

    }

    return NextResponse.json({

      success: true,

      deletedCount: meterids.length,

      meterids,

    });

  } catch (error) {

    console.error("Delete meter error:", error);

    if (

      error instanceof Error &&

      error.name ===

        "ConditionalCheckFailedException"

    ) {

      return NextResponse.json(

        {

          error:

            "The meter no longer exists.",

        },

        {

          status: 404,

        },

      );

    }

    return NextResponse.json(

      {

        error:

          error instanceof Error

            ? error.message

            : "Unable to delete meter.",

      },

      {

        status: 500,

      },

    );

  }

}
