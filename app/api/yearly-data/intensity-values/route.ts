import { DeleteCommand, PutCommand, ScanCommand, UpdateCommand, type ScanCommandInput, } from "@aws-sdk/lib-dynamodb";
import { getAppSession } from "@/lib/app-session";
import { ddb } from "@/lib/dynamo";
export const dynamic = "force-dynamic";
export const revalidate = 0;
// ============================================================
// DYNAMODB TABLE
// ============================================================
const INTENSITY_VALUES_TABLE = "p72-CUBE-INTENSITY-VALUES";
// ============================================================
// AUTHENTICATION
//
// Auth.js authentication is configured in "@/lib/auth".
//
// Production authentication can be enabled for each handler below.
//
// Protected operations:
//
//   GET    - Read Intensity Values
//   POST   - Create Intensity Value
//   PUT    - Update Intensity Value
//   DELETE - Delete Intensity Value
//
// When enabled, authentication runs before DynamoDB access.
//
// When enabled, a valid session must contain session.user.
// When enabled, unauthenticated requests return HTTP 401.
//
// Authentication is currently disabled for local development.
// ============================================================
// ============================================================
// TYPES
// ============================================================
type IntensityValueRecord = {
    intensityid: string;
    fy: number;
    index: number;
    space_type: string;
    space_type_id: number;
    utility_type_cd: string;
};
// ============================================================
// SPACE TYPES
// ============================================================
const SPACE_TYPES: Record<number, string> = {
    0: "NA",
    1: "Office",
    2: "Warehouse",
    3: "Hangar",
    4: "Industrial",
    5: "Residential",
    6: "Retail",
    7: "Data Center",
};
// ============================================================
// HELPERS
// ============================================================
function text(value: unknown): string {
    if (value === undefined ||
        value === null) {
        return "";
    }
    return String(value).trim();
}
function numberValue(value: unknown): number {
    if (typeof value === "number") {
        return value;
    }
    const parsed = Number(value);
    return Number.isFinite(parsed)
        ? parsed
        : Number.NaN;
}
// ============================================================
// MAP DYNAMODB ITEM
// ============================================================
function mapItem(item: Record<string, unknown>): IntensityValueRecord {
    return {
        intensityid: text(item.intensityid),
        fy: numberValue(item.fy),
        index: numberValue(item.index),
        space_type: text(item.space_type),
        space_type_id: numberValue(item.space_type_id),
        utility_type_cd: text(item.utility_type_cd).toUpperCase(),
    };
}
// ============================================================
// NORMALIZE REQUEST BODY
//
// intensityid is generated from:
//
// FY + Utility Type + Space Type
//
// Example: 2026#EL#1
//
// space_type is derived server-side from space_type_id so the
// ID and display name remain synchronized.
// ============================================================
function normalizeBody(body: Record<string, unknown>): IntensityValueRecord {
    const fy = numberValue(body.fy);
    const spaceTypeId = numberValue(body.space_type_id);
    const utilityType = text(body.utility_type_cd).toUpperCase();
    return {
        intensityid: `${fy}#${utilityType}#${spaceTypeId}`,
        fy,
        index: numberValue(body.index),
        space_type: SPACE_TYPES[spaceTypeId] ?? "",
        space_type_id: spaceTypeId,
        utility_type_cd: utilityType,
    };
}
// ============================================================
// VALIDATION
// ============================================================
function validate(item: IntensityValueRecord): string {
    if (!Number.isInteger(item.fy) ||
        item.fy <= 0) {
        return ("fy must be a valid fiscal year.");
    }
    if (!item.utility_type_cd) {
        return ("utility_type_cd is required.");
    }
    if (!Number.isInteger(item.space_type_id) ||
        !(item.space_type_id in
            SPACE_TYPES)) {
        return ("space_type_id must be an integer between 0 and 7.");
    }
    if (!Number.isFinite(item.index)) {
        return ("index must be a valid number.");
    }
    return "";
}
// ============================================================
// SCAN ALL INTENSITY VALUES
//
// Handles DynamoDB pagination using LastEvaluatedKey.
// ============================================================
async function scanAll(): Promise<IntensityValueRecord[]> {
    const items: IntensityValueRecord[] = [];
    let exclusiveStartKey: ScanCommandInput["ExclusiveStartKey"] | undefined;
    do {
        const result = await ddb.send(new ScanCommand({
            TableName: INTENSITY_VALUES_TABLE,
            ExclusiveStartKey: exclusiveStartKey,
        }));
        items.push(...((result.Items ??
            []) as Record<string, unknown>[])
            .map(mapItem)
            .filter((item) => item.intensityid));
        exclusiveStartKey =
            result.LastEvaluatedKey;
    } while (exclusiveStartKey);
    return items.sort((a, b) => b.fy - a.fy ||
        a.intensityid.localeCompare(b.intensityid));
}
// ============================================================
// READ
//
// GET
//
// Returns all Intensity Value records.
//
// When enabled, authentication is checked before DynamoDB is scanned.
// ============================================================
export async function GET() {
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
        // AUTHENTICATED REQUEST
        // ========================================================
        const items = await scanAll();
        return Response.json({
            ok: true,
            count: items.length,
            items,
        });
    }
    catch (error) {
        console.error("Intensity Values GET failed:", error);
        return Response.json({
            ok: false,
            error: error instanceof Error
                ? error.message
                : "Unable to load Intensity Values.",
        }, {
            status: 500,
        });
    }
}
// ============================================================
// CREATE
//
// POST
//
// Creates a new Intensity Value.
//
// When enabled, authentication is checked before the request body is read or
// DynamoDB is accessed.
// ============================================================
export async function POST(request: Request) {
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
        // AUTHENTICATED REQUEST
        // ========================================================
        const body = (await request.json()) as Record<string, unknown>;
        const item = normalizeBody(body);
        const validationError = validate(item);
        if (validationError) {
            return Response.json({
                ok: false,
                error: validationError,
            }, {
                status: 400,
            });
        }
        // ========================================================
        // DYNAMODB CREATE
        //
        // Prevent creation when an Intensity Value already exists
        // for this generated intensityid.
        // ========================================================
        await ddb.send(new PutCommand({
            TableName: INTENSITY_VALUES_TABLE,
            Item: item,
            ConditionExpression: "attribute_not_exists(#intensityid)",
            ExpressionAttributeNames: {
                "#intensityid": "intensityid",
            },
        }));
        return Response.json({
            ok: true,
            item,
        }, {
            status: 201,
        });
    }
    catch (error) {
        console.error("Intensity Values POST failed:", error);
        if (error instanceof Error &&
            error.name ===
                "ConditionalCheckFailedException") {
            return Response.json({
                ok: false,
                error: "An Intensity Value already exists for that FY, Utility Type, and Space Type.",
            }, {
                status: 409,
            });
        }
        return Response.json({
            ok: false,
            error: error instanceof Error
                ? error.message
                : "Unable to create Intensity Value.",
        }, {
            status: 500,
        });
    }
}
// ============================================================
// UPDATE
//
// PUT
//
// Updates the index value for an existing Intensity Value.
//
// The existing intensityid remains authoritative. FY, utility
// type, and space type are not changed by this operation.
//
// When enabled, authentication is checked before the request body is read or
// DynamoDB is accessed.
// ============================================================
export async function PUT(request: Request) {
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
        // AUTHENTICATED REQUEST
        // ========================================================
        const body = (await request.json()) as Record<string, unknown>;
        const suppliedId = text(body.intensityid);
        const item = normalizeBody(body);
        if (!suppliedId) {
            return Response.json({
                ok: false,
                error: "intensityid is required.",
            }, {
                status: 400,
            });
        }
        // ========================================================
        // EXISTING KEY
        //
        // The existing key is authoritative on update.
        //
        // FY, utility type, and space type are locked in the UI and
        // are not changed by this API operation.
        // ========================================================
        const existingParts = suppliedId.split("#");
        if (existingParts.length !==
            3) {
            return Response.json({
                ok: false,
                error: "Invalid intensityid.",
            }, {
                status: 400,
            });
        }
        const fy = Number(existingParts[0]);
        const utilityType = existingParts[1];
        const spaceTypeId = Number(existingParts[2]);
        const updateItem: IntensityValueRecord = {
            intensityid: suppliedId,
            fy,
            index: item.index,
            space_type: SPACE_TYPES[spaceTypeId] ?? "",
            space_type_id: spaceTypeId,
            utility_type_cd: utilityType,
        };
        const validationError = validate(updateItem);
        if (validationError) {
            return Response.json({
                ok: false,
                error: validationError,
            }, {
                status: 400,
            });
        }
        // ========================================================
        // DYNAMODB UPDATE
        //
        // Only the index field is modified.
        //
        // ConditionExpression prevents PUT from silently creating
        // a record when intensityid does not already exist.
        // ========================================================
        const result = await ddb.send(new UpdateCommand({
            TableName: INTENSITY_VALUES_TABLE,
            Key: {
                intensityid: suppliedId,
            },
            UpdateExpression: "SET #index = :index",
            ConditionExpression: "attribute_exists(#intensityid)",
            ExpressionAttributeNames: {
                "#intensityid": "intensityid",
                "#index": "index",
            },
            ExpressionAttributeValues: {
                ":index": updateItem.index,
            },
            ReturnValues: "ALL_NEW",
        }));
        return Response.json({
            ok: true,
            item: mapItem((result.Attributes ??
                {}) as Record<string, unknown>),
        });
    }
    catch (error) {
        console.error("Intensity Values PUT failed:", error);
        if (error instanceof Error &&
            error.name ===
                "ConditionalCheckFailedException") {
            return Response.json({
                ok: false,
                error: "Intensity Value was not found.",
            }, {
                status: 404,
            });
        }
        return Response.json({
            ok: false,
            error: error instanceof Error
                ? error.message
                : "Unable to update Intensity Value.",
        }, {
            status: 500,
        });
    }
}
// ============================================================
// DELETE
//
// DELETE ?intensityid=...
//
// Deletes an existing Intensity Value.
//
// When enabled, authentication is checked before query parameters are read or
// DynamoDB is accessed.
// ============================================================
export async function DELETE(request: Request) {
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
        // AUTHENTICATED REQUEST
        // ========================================================
        const url = new URL(request.url);
        const intensityid = url.searchParams
            .get("intensityid")
            ?.trim() ?? "";
        if (!intensityid) {
            return Response.json({
                ok: false,
                error: "intensityid is required.",
            }, {
                status: 400,
            });
        }
        // ========================================================
        // DYNAMODB DELETE
        //
        // ConditionExpression ensures the record exists before
        // DynamoDB performs the delete.
        // ========================================================
        await ddb.send(new DeleteCommand({
            TableName: INTENSITY_VALUES_TABLE,
            Key: {
                intensityid,
            },
            ConditionExpression: "attribute_exists(#intensityid)",
            ExpressionAttributeNames: {
                "#intensityid": "intensityid",
            },
        }));
        return Response.json({
            ok: true,
            intensityid,
        });
    }
    catch (error) {
        console.error("Intensity Values DELETE failed:", error);
        if (error instanceof Error &&
            error.name ===
                "ConditionalCheckFailedException") {
            return Response.json({
                ok: false,
                error: "Intensity Value was not found.",
            }, {
                status: 404,
            });
        }
        return Response.json({
            ok: false,
            error: error instanceof Error
                ? error.message
                : "Unable to delete Intensity Value.",
        }, {
            status: 500,
        });
    }
}
