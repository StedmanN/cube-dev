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
const CATEGORY_CODES_TABLE =
  "p72-CUBE-CATEGORY-CODES";
// ============================================================
// AUTHENTICATION
//
// Auth.js authentication is configured in "@/lib/auth".
//
// Every API operation can validate the current
// server-side session when the commented auth blocks are enabled, before
// processing request data or performing a DynamoDB operation.
//
// Protected operations:
//   GET    - Read Category Codes
//   POST   - Create Category Code
//   PUT    - Update Category Code
//   DELETE - Delete Category Code
//
// A valid authenticated request must contain session.user.
// Requests without an authenticated user return HTTP 401.
//
// Authentication should be enabled at the API layer so the data
// remains protected even if someone attempts to call this
// route directly instead of using the CUBE UI.
// ============================================================
// ============================================================
// TYPES
// ============================================================
type CategoryCodeRecord = {
  category_cd: string;
  category_nm: string;
  category_desc: string;
  area_um: string;
  space_type_id: string;
  space_type: string;
};
// ============================================================
// SPACE TYPES
// ============================================================
const SPACE_TYPES: Record<
  string,
  string
> = {
  "0": "NA",
  "1": "Office",
  "2": "Warehouse",
  "3": "Hangar",
  "4": "Industrial",
  "5": "Residential",
  "6": "Retail",
  "7": "Data Center",
};
// ============================================================
// TEXT HELPER
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
  return String(
    value,
  ).trim();
}
// ============================================================
// MAP DYNAMODB ITEM
// ============================================================
function mapItem(
  item: Record<
    string,
    unknown
  >,
): CategoryCodeRecord {
  return {
    category_cd:
      text(
        item.category_cd,
      ),
    category_nm:
      text(
        item.category_nm,
      ),
    category_desc:
      text(
        item.category_desc,
      ),
    area_um:
      text(
        item.area_um,
      ),
    space_type_id:
      text(
        item.space_type_id,
      ) || "0",
    space_type:
      text(
        item.space_type,
      ),
  };
}
// ============================================================
// NORMALIZE REQUEST BODY
//
// space_type is intentionally derived server-side from
// space_type_id so the ID and display value cannot drift.
// ============================================================
function normalizeBody(
  body: Record<
    string,
    unknown
  >,
): CategoryCodeRecord {
  const spaceTypeId =
    text(
      body.space_type_id,
    ) || "0";
  return {
    category_cd:
      text(
        body.category_cd,
      ),
    category_nm:
      text(
        body.category_nm,
      ),
    category_desc:
      text(
        body.category_desc,
      ),
    area_um:
      text(
        body.area_um,
      ),
    space_type_id:
      spaceTypeId,
    space_type:
      SPACE_TYPES[
        spaceTypeId
      ] ?? "",
  };
}
// ============================================================
// VALIDATION
// ============================================================
function validate(
  item:
    CategoryCodeRecord,
): string {
  if (
    !item.category_cd
  ) {
    return (
      "category_cd is required."
    );
  }
  if (
    !SPACE_TYPES[
      item.space_type_id
    ]
  ) {
    return (
      "space_type_id must be between 0 and 7."
    );
  }
  return "";
}
// ============================================================
// SCAN ALL CATEGORY CODES
//
// Handles DynamoDB pagination using LastEvaluatedKey.
// ============================================================
async function scanAll(): Promise<
  CategoryCodeRecord[]
> {
  const items:
    CategoryCodeRecord[] =
      [];
  let exclusiveStartKey:
    | ScanCommandInput["ExclusiveStartKey"]
    | undefined;
  do {
    const result =
      await ddb.send(
        new ScanCommand({
          TableName:
            CATEGORY_CODES_TABLE,
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
        .map(
          mapItem,
        )
        .filter(
          (item) =>
            item.category_cd,
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
      a.category_cd.localeCompare(
        b.category_cd,
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
// GET /api/...
//
// Returns all Category Code records.
//
// Authentication:
// When enabled, requires a valid Auth.js session before DynamoDB is accessed.
// ============================================================
export async function GET() {
  try {
    // ========================================================
    // AUTHENTICATION
    //
    // Authenticate before scanning the Category Codes table.
    // When enabled, this protects read access as well as write access.
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
      "Category Codes GET failed:",
      error,
    );
    return Response.json(
      {
        ok: false,
        error:
          error instanceof
          Error
            ? error.message
            : "Unable to load Category Codes.",
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
// POST /api/...
//
// category_cd is supplied only when the record is created.
// A duplicate category_cd is rejected.
//
// Authentication:
// When enabled, requires a valid Auth.js session before the request body is
// processed or DynamoDB is accessed.
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
    if (
      validationError
    ) {
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
    // ConditionExpression prevents an existing Category Code
    // from being accidentally overwritten.
    // ========================================================
    await ddb.send(
      new PutCommand({
        TableName:
          CATEGORY_CODES_TABLE,
        Item:
          item,
        ConditionExpression:
          "attribute_not_exists(#category_cd)",
        ExpressionAttributeNames: {
          "#category_cd":
            "category_cd",
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
      "Category Codes POST failed:",
      error,
    );
    if (
      error instanceof
        Error &&
      error.name ===
        "ConditionalCheckFailedException"
    ) {
      return Response.json(
        {
          ok: false,
          error:
            "That Category Code already exists. Category Code numbers must be unique.",
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
          error instanceof
          Error
            ? error.message
            : "Unable to create Category Code.",
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
// PUT /api/...
//
// category_cd is used only as the DynamoDB key.
//
// It is intentionally NOT part of the UpdateExpression, so the
// Category Code number cannot be modified.
//
// Authentication:
// When enabled, requires a valid Auth.js session before the request body is
// processed or DynamoDB is accessed.
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
    if (
      validationError
    ) {
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
    // category_cd remains the permanent DynamoDB key and is
    // intentionally excluded from UpdateExpression.
    // ========================================================
    const result =
      await ddb.send(
        new UpdateCommand({
          TableName:
            CATEGORY_CODES_TABLE,
          Key: {
            category_cd:
              item.category_cd,
          },
          UpdateExpression: `
            SET
              #category_nm = :category_nm,
              #category_desc = :category_desc,
              #area_um = :area_um,
              #space_type_id = :space_type_id,
              #space_type = :space_type
          `,
          ConditionExpression:
            "attribute_exists(#category_cd)",
          ExpressionAttributeNames: {
            "#category_cd":
              "category_cd",
            "#category_nm":
              "category_nm",
            "#category_desc":
              "category_desc",
            "#area_um":
              "area_um",
            "#space_type_id":
              "space_type_id",
            "#space_type":
              "space_type",
          },
          ExpressionAttributeValues: {
            ":category_nm":
              item.category_nm,
            ":category_desc":
              item.category_desc,
            ":area_um":
              item.area_um,
            ":space_type_id":
              item.space_type_id,
            ":space_type":
              item.space_type,
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
      "Category Codes PUT failed:",
      error,
    );
    if (
      error instanceof
        Error &&
      error.name ===
        "ConditionalCheckFailedException"
    ) {
      return Response.json(
        {
          ok: false,
          error:
            "Category Code was not found.",
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
          error instanceof
          Error
            ? error.message
            : "Unable to update Category Code.",
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
// DELETE /api/...?category_cd=...
//
// Authentication:
// When enabled, requires a valid Auth.js session before query parameters are
// processed or DynamoDB is accessed.
// ============================================================
export async function DELETE(
  request: Request,
) {
  try {
    // ========================================================
    // AUTHENTICATION
    //
    // Authenticate before reading category_cd from the request
    // or deleting anything from DynamoDB.
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
    const url =
      new URL(
        request.url,
      );
    const categoryCd =
      url.searchParams
        .get(
          "category_cd",
        )
        ?.trim() ?? "";
    if (
      !categoryCd
    ) {
      return Response.json(
        {
          ok: false,
          error:
            "category_cd is required.",
        },
        {
          status: 400,
        },
      );
    }
    // ========================================================
    // DYNAMODB DELETE
    //
    // ConditionExpression ensures the Category Code exists
    // before DynamoDB performs the delete.
    // ========================================================
    await ddb.send(
      new DeleteCommand({
        TableName:
          CATEGORY_CODES_TABLE,
        Key: {
          category_cd:
            categoryCd,
        },
        ConditionExpression:
          "attribute_exists(#category_cd)",
        ExpressionAttributeNames: {
          "#category_cd":
            "category_cd",
        },
      }),
    );
    return Response.json({
      ok: true,
      category_cd:
        categoryCd,
    });
  } catch (error) {
    console.error(
      "Category Codes DELETE failed:",
      error,
    );
    if (
      error instanceof
        Error &&
      error.name ===
        "ConditionalCheckFailedException"
    ) {
      return Response.json(
        {
          ok: false,
          error:
            "Category Code was not found.",
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
          error instanceof
          Error
            ? error.message
            : "Unable to delete Category Code.",
      },
      {
        status: 500,
      },
    );
  }
}
