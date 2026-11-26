import {

  DeleteCommand,

  PutCommand,

  ScanCommand,

  UpdateCommand,

  type ScanCommandInput,

} from "@aws-sdk/lib-dynamodb";

import { getAppSession } from "@/lib/app-session";

import { ddb } from "@/lib/dynamo";

export const dynamic = "force-dynamic";

export const revalidate = 0;

// ============================================================

// DYNAMODB TABLE

// ============================================================

const SPACE_TYPES_TABLE =

  "p72-CUBE-SPACE-TYPES";

// ============================================================

// AUTHENTICATION

//

// Auth.js authentication is configured in "@/lib/auth".

//

// Every operation in this API route requires a valid

// authenticated server-side session.

//

// Protected operations:

//

//   GET    - Read Space Types

//   POST   - Create Space Type

//   PUT    - Update Space Type

//   DELETE - Delete Space Type

//

// Authentication is performed BEFORE request data is processed

// or DynamoDB is accessed.

//

// A valid authenticated request must contain session.user.

// When enabled, unauthenticated requests return HTTP 401.

//

// Authentication is enforced at the API layer so direct API

// requests cannot bypass authentication enforced by the UI.

// ============================================================

// ============================================================

// TYPES

// ============================================================

type SpaceTypeRecord = {

  space_type_id: string;

  description: string;

};

// ============================================================

// HELPERS

// ============================================================

function text(

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

// ============================================================

// MAP DYNAMODB ITEM

// ============================================================

function mapItem(

  item: Record<string, unknown>,

): SpaceTypeRecord {

  return {

    space_type_id:

      text(

        item.space_type_id,

      ),

    description:

      text(

        item.description,

      ),

  };

}

// ============================================================

// NORMALIZE REQUEST BODY

// ============================================================

function normalizeBody(

  body: Record<string, unknown>,

): SpaceTypeRecord {

  return {

    space_type_id:

      text(

        body.space_type_id,

      ),

    description:

      text(

        body.description,

      ),

  };

}

// ============================================================

// VALIDATION

// ============================================================

function validate(

  item: SpaceTypeRecord,

): string {

  if (

    !item.space_type_id

  ) {

    return (

      "space_type_id is required."

    );

  }

  if (

    !item.description

  ) {

    return (

      "description is required."

    );

  }

  return "";

}

// ============================================================

// SCAN ALL SPACE TYPES

//

// Handles DynamoDB pagination using LastEvaluatedKey.

// ============================================================

async function scanAll(): Promise<

  SpaceTypeRecord[]

> {

  const items:

    SpaceTypeRecord[] =

      [];

  let exclusiveStartKey:

    | ScanCommandInput["ExclusiveStartKey"]

    | undefined;

  do {

    const result =

      await ddb.send(

        new ScanCommand({

          TableName:

            SPACE_TYPES_TABLE,

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

      )

        .map(mapItem)

        .filter(

          (item) =>

            item.space_type_id,

        ),

    );

    exclusiveStartKey =

      result.LastEvaluatedKey;

  } while (

    exclusiveStartKey

  );

  return items.sort(

    (

      a,

      b,

    ) =>

      a.space_type_id.localeCompare(

        b.space_type_id,

        undefined,

        {

          numeric: true,

          sensitivity:

            "base",

        },

      ),

  );

}

// ============================================================

// READ

//

// GET

//

// Returns all Space Type records.

//

// Authentication guard is present but disabled.

// ============================================================

export async function GET() {

  try {

    // ========================================================

    // AUTHENTICATION

    //

    // Authenticate before scanning the Space Types table.

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

    // REQUEST HANDLING (AUTHENTICATION CURRENTLY DISABLED)

    // ========================================================

    const items =

      await scanAll();

    return Response.json({

      ok: true,

      count:

        items.length,

      items,

    });

  } catch (error) {

    console.error(

      "Space Types GET failed:",

      error,

    );

    return Response.json(

      {

        ok: false,

        error:

          error instanceof Error

            ? error.message

            : "Unable to load Space Types.",

      },

      {

        status: 500,

      },

    );

  }

}

// ============================================================

// CREATE

//

// POST

//

// Creates a new Space Type.

//

// Authentication is checked before the request body is read or

// DynamoDB is accessed.

// ============================================================

export async function POST(

  request: Request,

) {

  try {

    // ========================================================

    // AUTHENTICATION

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

    // REQUEST HANDLING (AUTHENTICATION CURRENTLY DISABLED)

    // ========================================================

    const body =

      (await request.json()) as Record<

        string,

        unknown

      >;

    const item =

      normalizeBody(

        body,

      );

    const validationError =

      validate(

        item,

      );

    if (validationError) {

      return Response.json(

        {

          ok: false,

          error:

            validationError,

        },

        {

          status: 400,

        },

      );

    }

    // ========================================================

    // DYNAMODB CREATE

    //

    // Prevent accidentally replacing an existing Space Type.

    // ========================================================

    await ddb.send(

      new PutCommand({

        TableName:

          SPACE_TYPES_TABLE,

        Item:

          item,

        ConditionExpression:

          "attribute_not_exists(#id)",

        ExpressionAttributeNames: {

          "#id":

            "space_type_id",

        },

      }),

    );

    return Response.json(

      {

        ok: true,

        item,

      },

      {

        status: 201,

      },

    );

  } catch (error) {

    console.error(

      "Space Types POST failed:",

      error,

    );

    if (

      error instanceof Error &&

      error.name ===

        "ConditionalCheckFailedException"

    ) {

      return Response.json(

        {

          ok: false,

          error:

            "That Space Type ID already exists. Space Type IDs must be unique.",

        },

        {

          status: 409,

        },

      );

    }

    return Response.json(

      {

        ok: false,

        error:

          error instanceof Error

            ? error.message

            : "Unable to create Space Type.",

      },

      {

        status: 500,

      },

    );

  }

}

// ============================================================

// UPDATE

//

// PUT

//

// Updates the description of an existing Space Type.

//

// space_type_id remains the DynamoDB key and is not changed.

//

// Authentication is checked before the request body is read or

// DynamoDB is accessed.

// ============================================================

export async function PUT(

  request: Request,

) {

  try {

    // ========================================================

    // AUTHENTICATION

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

    // REQUEST HANDLING (AUTHENTICATION CURRENTLY DISABLED)

    // ========================================================

    const body =

      (await request.json()) as Record<

        string,

        unknown

      >;

    const item =

      normalizeBody(

        body,

      );

    const validationError =

      validate(

        item,

      );

    if (validationError) {

      return Response.json(

        {

          ok: false,

          error:

            validationError,

        },

        {

          status: 400,

        },

      );

    }

    // ========================================================

    // DYNAMODB UPDATE

    //

    // Only description is updated.

    //

    // ConditionExpression prevents PUT from silently creating

    // a Space Type that does not already exist.

    // ========================================================

    const result =

      await ddb.send(

        new UpdateCommand({

          TableName:

            SPACE_TYPES_TABLE,

          Key: {

            space_type_id:

              item.space_type_id,

          },

          UpdateExpression:

            "SET #description = :description",

          ConditionExpression:

            "attribute_exists(#id)",

          ExpressionAttributeNames: {

            "#id":

              "space_type_id",

            "#description":

              "description",

          },

          ExpressionAttributeValues: {

            ":description":

              item.description,

          },

          ReturnValues:

            "ALL_NEW",

        }),

      );

    return Response.json({

      ok: true,

      item:

        mapItem(

          (

            result.Attributes ??

            {}

          ) as Record<

            string,

            unknown

          >,

        ),

    });

  } catch (error) {

    console.error(

      "Space Types PUT failed:",

      error,

    );

    if (

      error instanceof Error &&

      error.name ===

        "ConditionalCheckFailedException"

    ) {

      return Response.json(

        {

          ok: false,

          error:

            "Space Type was not found.",

        },

        {

          status: 404,

        },

      );

    }

    return Response.json(

      {

        ok: false,

        error:

          error instanceof Error

            ? error.message

            : "Unable to update Space Type.",

      },

      {

        status: 500,

      },

    );

  }

}

// ============================================================

// DELETE

//

// DELETE ?space_type_id=...

//

// Deletes an existing Space Type.

//

// Authentication is checked before query parameters are read or

// DynamoDB is accessed.

// ============================================================

export async function DELETE(

  request: Request,

) {

  try {

    // ========================================================

    // AUTHENTICATION

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

    // REQUEST HANDLING (AUTHENTICATION CURRENTLY DISABLED)

    // ========================================================

    const url =

      new URL(

        request.url,

      );

    const spaceTypeId =

      url.searchParams

        .get(

          "space_type_id",

        )

        ?.trim() ?? "";

    if (!spaceTypeId) {

      return Response.json(

        {

          ok: false,

          error:

            "space_type_id is required.",

        },

        {

          status: 400,

        },

      );

    }

    // ========================================================

    // DYNAMODB DELETE

    //

    // ConditionExpression ensures the Space Type exists before

    // DynamoDB performs the delete.

    // ========================================================

    await ddb.send(

      new DeleteCommand({

        TableName:

          SPACE_TYPES_TABLE,

        Key: {

          space_type_id:

            spaceTypeId,

        },

        ConditionExpression:

          "attribute_exists(#id)",

        ExpressionAttributeNames: {

          "#id":

            "space_type_id",

        },

      }),

    );

    return Response.json({

      ok: true,

      space_type_id:

        spaceTypeId,

    });

  } catch (error) {

    console.error(

      "Space Types DELETE failed:",

      error,

    );

    if (

      error instanceof Error &&

      error.name ===

        "ConditionalCheckFailedException"

    ) {

      return Response.json(

        {

          ok: false,

          error:

            "Space Type was not found.",

        },

        {

          status: 404,

        },

      );

    }

    return Response.json(

      {

        ok: false,

        error:

          error instanceof Error

            ? error.message

            : "Unable to delete Space Type.",

      },

      {

        status: 500,

      },

    );

  }

}
