import {

  PutCommand,

  ScanCommand,

  UpdateCommand,

} from "@aws-sdk/lib-dynamodb";

import { NextResponse } from "next/server";

import { ddb } from "@/lib/dynamo";

// ============================================================

// PRODUCTION AUTHENTICATION

// Uncomment before deploying to production.

// ============================================================

import { getAppSession } from "@/lib/app-session";

// ============================================================

// TABLE
// Registry records are stored in DynamoDB; FacilityID is the primary key.

// ============================================================

const FACILITIES_TABLE =

  "p72-CUBE-FACILITIES";

// ============================================================

// TYPES

// ============================================================

type FacilityItem = {

  FacilityID: string;

  SUB_INST_CD: string;

  SITE_CD: string;

  FacilityNumber: string;

  FacilityType: string;

  FacilityName: string;

  AreaQty: string;

  AreaUM: string;

  OtherQty: string;

  OtherUM: string;

  Active: boolean;

  CreatedDate: string;

  InactiveDate: string;

};

// ============================================================

// HELPERS

// ============================================================

function stringValue(

  value: unknown,

): string {

  if (

    value === undefined ||

    value === null

  ) {

    return "";

  }

  return String(value).trim();

}

function booleanValue(

  value: unknown,

  defaultValue = true,

): boolean {

  if (

    typeof value === "boolean"

  ) {

    return value;

  }

  if (

    value === undefined ||

    value === null ||

    value === ""

  ) {

    return defaultValue;

  }

  const normalized =

    String(value)

      .trim()

      .toLowerCase();

  if (

    normalized === "true" ||

    normalized === "1" ||

    normalized === "yes"

  ) {

    return true;

  }

  if (

    normalized === "false" ||

    normalized === "0" ||

    normalized === "no"

  ) {

    return false;

  }

  return defaultValue;

}

// ============================================================

// DATE

//

// Store lifecycle dates as YYYY-MM-DD.

// ============================================================

function today(): string {

  return new Date()

    .toISOString()

    .slice(0, 10);

}

// ============================================================

// NORMALIZE FACILITY

// ============================================================

function normalizeFacility(

  value: unknown,

): FacilityItem {

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

  return {

    FacilityID:

      stringValue(

        source.FacilityID,

      ),

    SUB_INST_CD:

      stringValue(

        source.SUB_INST_CD,

      ),

    SITE_CD:

      stringValue(

        source.SITE_CD,

      ),

    FacilityNumber:

      stringValue(

        source.FacilityNumber,

      ),

    FacilityType:

      stringValue(

        source.FacilityType,

      ),

    FacilityName:

      stringValue(

        source.FacilityName,

      ),

    AreaQty:

      stringValue(

        source.AreaQty,

      ),

    AreaUM:

      stringValue(

        source.AreaUM,

      ),

    OtherQty:

      stringValue(

        source.OtherQty,

      ),

    OtherUM:

      stringValue(

        source.OtherUM,

      ),

    Active:

      booleanValue(

        source.Active,

        true,

      ),

    CreatedDate:

      stringValue(

        source.CreatedDate,

      ),

    InactiveDate:

      stringValue(

        source.InactiveDate,

      ),

  };

}

// ============================================================

// VALIDATE REQUIRED FIELDS

// ============================================================

function validateFacility(

  facility: FacilityItem,

): string | null {

  if (

    !facility.SUB_INST_CD

  ) {

    return (

      "Sub Installation Code is required."

    );

  }

  if (

    !facility.SITE_CD

  ) {

    return (

      "Site Code is required."

    );

  }

  if (

    !facility.FacilityNumber

  ) {

    return (

      "Facility Number is required."

    );

  }

  return null;

}

// ============================================================

// DYNAMODB ITEM

//

// Numeric quantities are stored as DynamoDB numbers when

// supplied. Empty values are omitted.

// ============================================================

function buildFacilityItem(

  facility: FacilityItem,

) {

  const item:

    Record<

      string,

      string | number | boolean

    > = {

      FacilityID:

        facility.FacilityID,

      SUB_INST_CD:

        facility.SUB_INST_CD,

      SITE_CD:

        facility.SITE_CD,

      FacilityNumber:

        facility.FacilityNumber,

      FacilityType:

        facility.FacilityType,

      FacilityName:

        facility.FacilityName,

      AreaUM:

        facility.AreaUM,

      OtherUM:

        facility.OtherUM,

      Active:

        facility.Active,

      CreatedDate:

        facility.CreatedDate,

  };

  // ----------------------------------------------------------

  // AREA QUANTITY

  // ----------------------------------------------------------

  if (

    facility.AreaQty !== ""

  ) {

    const area =

      Number(

        facility.AreaQty,

      );

    if (

      Number.isFinite(area)

    ) {

      item.AreaQty =

        area;

    }

  }

  // ----------------------------------------------------------

  // OTHER QUANTITY

  // ----------------------------------------------------------

  if (

    facility.OtherQty !== ""

  ) {

    const other =

      Number(

        facility.OtherQty,

      );

    if (

      Number.isFinite(other)

    ) {

      item.OtherQty =

        other;

    }

  }

  // ----------------------------------------------------------

  // INACTIVE DATE

  // ----------------------------------------------------------

  if (

    facility.InactiveDate

  ) {

    item.InactiveDate =

      facility.InactiveDate;

  }

  return item;

}

// ============================================================

// GET NEXT FACILITY ID

//

// Existing imported records:

//

// FAC-000001

// FAC-000002

// ...

//

// Finds the highest current number and returns the next.

//

// NOTE:

// This is suitable for the current low-volume administrative

// registry. If CUBE eventually has many concurrent writers,

// replace this with an atomic DynamoDB counter.

// ============================================================

async function getNextFacilityID(): Promise<string> {

  let lastEvaluatedKey:

    | Record<string, unknown>

    | undefined;

  let highestNumber = 0;

  do {

    const result =

      await ddb.send(

        new ScanCommand({

          TableName:

            FACILITIES_TABLE,

          ProjectionExpression:

            "FacilityID",

          ExclusiveStartKey:

            lastEvaluatedKey,

        }),

      );

    for (

      const item of

      result.Items ?? []

    ) {

      const facilityID =

        stringValue(

          item.FacilityID,

        );

      const match =

        /^FAC-(\d+)$/i.exec(

          facilityID,

        );

      if (!match) {

        continue;

      }

      const number =

        Number(

          match[1],

        );

      if (

        Number.isFinite(

          number,

        ) &&

        number >

          highestNumber

      ) {

        highestNumber =

          number;

      }

    }

    lastEvaluatedKey =

      result.LastEvaluatedKey;

  } while (

    lastEvaluatedKey

  );

  const nextNumber =

    highestNumber + 1;

  return `FAC-${String(

    nextNumber,

  ).padStart(

    6,

    "0",

  )}`;

}

// ============================================================

// CREATE

//

// POST /api/facilities

// ============================================================

export async function POST(

  request: Request,

) {

  try {

    // ========================================================

    // PRODUCTION AUTHENTICATION

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

    const body =

      await request.json();

    const facility =

      normalizeFacility(

        body,

      );

    // --------------------------------------------------------

    // VALIDATE

    // --------------------------------------------------------

    const validationError =

      validateFacility(

        facility,

      );

    if (

      validationError

    ) {

      return NextResponse.json(

        {

          error:

            validationError,

        },

        {

          status: 400,

        },

      );

    }

    // --------------------------------------------------------

    // NEW FACILITY LIFECYCLE

    // --------------------------------------------------------

    facility.FacilityID =

      await getNextFacilityID();

    facility.Active =

      true;

    facility.CreatedDate =

      today();

    facility.InactiveDate =

      "";

    // --------------------------------------------------------

    // BUILD ITEM

    // --------------------------------------------------------

    const item =

      buildFacilityItem(

        facility,

      );

    // --------------------------------------------------------

    // WRITE

    //

    // Condition protects against replacing an existing ID.

    // --------------------------------------------------------

    await ddb.send(

      new PutCommand({

        TableName:

          FACILITIES_TABLE,

        Item:

          item,

        ConditionExpression:

          "attribute_not_exists(FacilityID)",

      }),

    );

    return NextResponse.json(

      {

        success: true,

        facility:

          item,

      },

      {

        status: 201,

      },

    );

  } catch (error) {

    console.error(

      "Create facility error:",

      error,

    );

    if (

      error instanceof Error &&

      error.name ===

        "ConditionalCheckFailedException"

    ) {

      return NextResponse.json(

        {

          error:

            "The generated Facility ID already exists. Please try again.",

        },

        {

          status: 409,

        },

      );

    }

    return NextResponse.json(

      {

        error:

          "Unable to create facility.",

      },

      {

        status: 500,

      },

    );

  }

}

// ============================================================

// UPDATE FACILITY DATA

//

// PUT /api/facilities

//

// Important:

// FacilityID

// Active

// CreatedDate

// InactiveDate

//

// are NOT changed through normal editing.

// ============================================================

export async function PUT(

  request: Request,

) {

  try {

    // ========================================================

    // PRODUCTION AUTHENTICATION

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

    const body =

      await request.json();

    const facility =

      normalizeFacility(

        body,

      );

    // --------------------------------------------------------

    // FACILITY ID

    // --------------------------------------------------------

    if (

      !facility.FacilityID

    ) {

      return NextResponse.json(

        {

          error:

            "Facility ID is required.",

        },

        {

          status: 400,

        },

      );

    }

    // --------------------------------------------------------

    // VALIDATE

    // --------------------------------------------------------

    const validationError =

      validateFacility(

        facility,

      );

    if (

      validationError

    ) {

      return NextResponse.json(

        {

          error:

            validationError,

        },

        {

          status: 400,

        },

      );

    }

    // --------------------------------------------------------

    // VALIDATE NUMBERS

    // --------------------------------------------------------

    if (

      facility.AreaQty &&

      !Number.isFinite(

        Number(

          facility.AreaQty,

        ),

      )

    ) {

      return NextResponse.json(

        {

          error:

            "Area Quantity must be a valid number.",

        },

        {

          status: 400,

        },

      );

    }

    if (

      facility.OtherQty &&

      !Number.isFinite(

        Number(

          facility.OtherQty,

        ),

      )

    ) {

      return NextResponse.json(

        {

          error:

            "Other Quantity must be a valid number.",

        },

        {

          status: 400,

        },

      );

    }

    // --------------------------------------------------------

    // UPDATE

    //

    // Lifecycle attributes are intentionally excluded.

    // --------------------------------------------------------

    await ddb.send(

      new UpdateCommand({

        TableName:

          FACILITIES_TABLE,

        Key: {

          FacilityID:

            facility.FacilityID,

        },

        UpdateExpression: `

          SET

            SUB_INST_CD = :subInst,

            SITE_CD = :site,

            FacilityNumber = :facilityNumber,

            FacilityType = :facilityType,

            FacilityName = :facilityName,

            AreaQty = :areaQty,

            AreaUM = :areaUM,

            OtherQty = :otherQty,

            OtherUM = :otherUM

        `,

        ExpressionAttributeValues: {

          ":subInst":

            facility.SUB_INST_CD,

          ":site":

            facility.SITE_CD,

          ":facilityNumber":

            facility.FacilityNumber,

          ":facilityType":

            facility.FacilityType,

          ":facilityName":

            facility.FacilityName,

          ":areaQty":

            facility.AreaQty

              ? Number(

                  facility.AreaQty,

                )

              : null,

          ":areaUM":

            facility.AreaUM,

          ":otherQty":

            facility.OtherQty

              ? Number(

                  facility.OtherQty,

                )

              : null,

          ":otherUM":

            facility.OtherUM,

        },

        ConditionExpression:

          "attribute_exists(FacilityID)",

        ReturnValues:

          "ALL_NEW",

      }),

    );

    return NextResponse.json({

      success: true,

    });

  } catch (error) {

    console.error(

      "Update facility error:",

      error,

    );

    if (

      error instanceof Error &&

      error.name ===

        "ConditionalCheckFailedException"

    ) {

      return NextResponse.json(

        {

          error:

            "The facility no longer exists.",

        },

        {

          status: 404,

        },

      );

    }

    return NextResponse.json(

      {

        error:

          "Unable to update facility.",

      },

      {

        status: 500,

      },

    );

  }

}

// ============================================================

// ACTIVATE / DEACTIVATE

//

// PATCH /api/facilities

//

// Request:

//

// {

//   "FacilityID": "FAC-000001",

//   "Active": false

// }

// ============================================================

export async function PATCH(

  request: Request,

) {

  try {

    // ========================================================

    // PRODUCTION AUTHENTICATION

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

    const body =

      (await request.json()) as Record<

        string,

        unknown

      >;

    const FacilityID =

      stringValue(

        body.FacilityID,

      );

    if (

      !FacilityID

    ) {

      return NextResponse.json(

        {

          error:

            "Facility ID is required.",

        },

        {

          status: 400,

        },

      );

    }

    if (

      typeof body.Active !==

      "boolean"

    ) {

      return NextResponse.json(

        {

          error:

            "Active must be true or false.",

        },

        {

          status: 400,

        },

      );

    }

    const active =

      body.Active;

    // ========================================================

    // ACTIVATE

    //

    // Active = true

    // Remove InactiveDate completely.

    // ========================================================

    if (active) {

      const result =

        await ddb.send(

          new UpdateCommand({

            TableName:

              FACILITIES_TABLE,

            Key: {

              FacilityID,

            },

            UpdateExpression:

              "SET Active = :active REMOVE InactiveDate",

            ExpressionAttributeValues: {

              ":active":

                true,

            },

            ConditionExpression:

              "attribute_exists(FacilityID)",

            ReturnValues:

              "ALL_NEW",

          }),

        );

      return NextResponse.json({

        success: true,

        facility:

          result.Attributes,

      });

    }

    // ========================================================

    // DEACTIVATE

    //

    // Active = false

    // InactiveDate = today

    // ========================================================

    const result =

      await ddb.send(

        new UpdateCommand({

          TableName:

            FACILITIES_TABLE,

          Key: {

            FacilityID,

          },

          UpdateExpression:

            "SET Active = :active, InactiveDate = :inactiveDate",

          ExpressionAttributeValues: {

            ":active":

              false,

            ":inactiveDate":

              today(),

          },

          ConditionExpression:

            "attribute_exists(FacilityID)",

          ReturnValues:

            "ALL_NEW",

        }),

      );

    return NextResponse.json({

      success: true,

      facility:

        result.Attributes,

    });

  } catch (error) {

    console.error(

      "Facility status error:",

      error,

    );

    if (

      error instanceof Error &&

      error.name ===

        "ConditionalCheckFailedException"

    ) {

      return NextResponse.json(

        {

          error:

            "The facility no longer exists.",

        },

        {

          status: 404,

        },

      );

    }

    return NextResponse.json(

      {

        error:

          "Unable to update facility status.",

      },

      {

        status: 500,

      },

    );

  }

}
