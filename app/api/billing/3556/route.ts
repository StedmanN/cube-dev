// app/api/billing/3556/route.ts

/**
 * CUBE | 3556 Utility Sales Rates Worksheet API
 * Path: app/api/billing/3556/route.ts
 *
 * PURPOSE
 *   Store, retrieve, finalize, and archive Form 3556 worksheets used to
 *   establish utility billing rates. Each Utility Group + Utility System
 *   combination has its own worksheet history (e.g. WWYK/Electricity and
 *   TAC/Electricity are separate).
 *
 * SECURITY
 *   Each handler includes a commented-out NextAuth authentication block.
 *   Uncomment it before production deployment to enforce HTTP 401 for
 *   unauthenticated callers. RBAC is intentionally not included.
 *
 * DATA OWNERSHIP
 *   The form/client supplies worksheet inputs and calculated rate snapshots.
 *   This API persists those values; it does not independently recalculate the
 *   3556 formulas. Keep the client calculations and any future server-side
 *   validation consistent before relying on a finalized rate for billing.
 */
import { NextRequest, NextResponse } from "next/server";

import {

  PutCommand,

  ScanCommand,

} from "@aws-sdk/lib-dynamodb";

import { ddb } from "@/lib/dynamo";
import { getAppSession } from "@/lib/app-session";

// Read live worksheet state on each request; do not cache mutable rate history.
export const dynamic = "force-dynamic";

// Allow deployment-specific table names while retaining the GovCloud default.
// DynamoDB records are addressed by composite PK/SK keys.
const TABLE_NAME =

  process.env.CUBE_3556_TABLE_NAME ||

  "p72-CUBE-3556";

/** Worksheet lifecycle:
 * DRAFT: editable; FINAL: approved and immutable through PUT;
 * ARCHIVED: retained for history, excluded from FINAL baseline lookups.
 */
type RecordStatus =

  | "DRAFT"

  | "FINAL"

  | "ARCHIVED";

/** Data contract sent by the 3556 form for creating/updating a worksheet.
 * `unknown` payload sections are preserved as submitted so the UI can evolve
 * without changing this API's TypeScript shape on every worksheet field edit.
 */
type Save3556Request = {

  id?: string;

  PK?: string;

  SK?: string;

  fiscalYear: string;

  utilityGroup: string;

  utilitySystem: string;

  uom?: string;

  effectiveDate?: string;

  status?: RecordStatus;

  preparedDate?: string;

  worksheet: unknown;

  rateInputs: unknown;

  otherUtilityWorksheet: unknown;

  calculatedRates: unknown;

  calculatedSalesRates: unknown;

};

// Convert optional request/key fields to trimmed strings for comparisons.
function clean(value: unknown): string {

  return String(value ?? "").trim();

}

// Reject non-finite numeric snapshots (NaN/Infinity) during approval checks.
function finiteNumber(value: unknown): number | null {

  const parsed = Number(value);

  return Number.isFinite(parsed) ? parsed : null;

}

/** Read the already-calculated A-3 Basic Cost from a saved worksheet.
 * IMPORTANT: This is NOT the A-3 formula implementation. The form currently
 * calculates A-3 from (C22 - UESC - ESPC - Utility Priv) / D21, subject to
 * its denominator/cost guards. Finalization only verifies the saved result.
 */
function getA3BasicCost(calculatedRates: unknown): number | null {

  if (!calculatedRates || typeof calculatedRates !== "object") return null;

  return finiteNumber((calculatedRates as Record<string, unknown>).a3BasicCost);

}

// Normalize a fiscal-year label into the FYxx identifier used in record IDs.
function normalizeFiscalYear(value: string): string {

  const digits = clean(value)

    .replace(/D/g, "")

    .slice(-2);

  return digits

    ? `FY${digits}`

    : "";

}

// Sanitize utility names for stable uppercase DynamoDB key components.
function keySafe(value: string): string {

  return clean(value)

    .toUpperCase()

    .replace(/[^A-Z0-9]+/g, "_")

    .replace(/^_+|_+$/g, "");

}

/** Partition key: groups all revisions/history for one Utility Group and
 * Utility System, keeping distinct utilities and groups separate.
 */
function buildPK(

  utilityGroup: string,

  utilitySystem: string,

): string {

  return `3556#${keySafe(

    utilityGroup,

  )}#${keySafe(

    utilitySystem,

  )}`;

}

/** Sort key: identifies the effective date, fiscal year, and revision.
 * New records get a new SK; edits retain the original SK to avoid duplicates.
 */
function buildSK(

  fiscalYear: string,

  effectiveDate: string,

  revision = 1,

): string {

  const date =

    clean(effectiveDate) ||

    "UNSET";

  return `EFFECTIVE#${date}#${normalizeFiscalYear(

    fiscalYear,

  )}#REV#${String(

    revision,

  ).padStart(3, "0")}`;

}

// Human-readable application identifier used by the UI and API lookups.
function build3556Id(

  fiscalYear: string,

  utilityGroup: string,

  utilitySystem: string,

  revision = 1,

): string {

  return [

    "3556",

    normalizeFiscalYear(

      fiscalYear,

    ),

    keySafe(

      utilityGroup,

    ),

    keySafe(

      utilitySystem,

    ),

    `REV${String(

      revision,

    ).padStart(3, "0")}`,

  ].join("#");

}

/** Validate the minimum required worksheet identity and content.
 * The full worksheet schema and arithmetic are currently managed by the UI.
 * Returns a user-facing error string, or null when the payload is acceptable.
 */
function validatePayload(

  body: Save3556Request,

) {

  if (

    !normalizeFiscalYear(

      body.fiscalYear,

    )

  ) {

    return "Fiscal Year is required.";

  }

  if (

    !clean(

      body.utilityGroup,

    )

  ) {

    return "Utility Group is required.";

  }

  if (

    !clean(

      body.utilitySystem,

    )

  ) {

    return "Utility System is required.";

  }

  if (

    !body.worksheet ||

    typeof body.worksheet !==

      "object"

  ) {

    return "Worksheet data is required.";

  }

  return null;

}

/** Scan every page of the 3556 table (DynamoDB Scan is paginated).
 * NOTE: This can become expensive as history grows. A future optimization is
 * to Query by PK or add a GSI for id/status instead of scanning all records.
 */
function is3556WorksheetRecord(
  record: Record<string, any>,
) {
  return (
    typeof record.PK === "string" &&
    record.PK.startsWith("3556#") &&
    record.worksheet !== null &&
    typeof record.worksheet === "object"
  );
}

async function scanAll() {

  const records: Record<

    string,

    any

  >[] = [];

  let ExclusiveStartKey:

    | Record<string, any>

    | undefined;

  do {

    const response =

      await ddb.send(

        new ScanCommand({

          TableName:

            TABLE_NAME,

          ExclusiveStartKey,

        }),

      );

    records.push(

      ...(

        response.Items ??

        []

      ),

    );

    ExclusiveStartKey =

      response.LastEvaluatedKey;

  } while (

    ExclusiveStartKey

  );

  // The 3556 table also stores Real Property snapshot control/audit items.
  // They are not worksheets and must not be returned to the 3556 history UI.
  return records.filter(is3556WorksheetRecord);

}

/** Locate a worksheet by its application-level id.
 * This currently uses scanAll() because id is not the DynamoDB primary key.
 */
async function getById(

  id: string,

) {

  const records =

    await scanAll();

  return (

    records.find(

      (record) =>

        record.id === id,

    ) ?? null

  );

}

// Show the newest fiscal years first, then most recently updated records.
function sortHistory(

  records: Record<

    string,

    any

  >[],

) {

  return records.sort(

    (a, b) => {

      const fyCompare =

        clean(

          b.fiscalYear,

        ).localeCompare(

          clean(

            a.fiscalYear,

          ),

        );

      if (

        fyCompare !== 0

      ) {

        return fyCompare;

      }

      return clean(

        b.updatedAt,

      ).localeCompare(

        clean(

          a.updatedAt,

        ),

      );

    },

  );

}

/**
 * 3556 worksheet API.
 * GET reads history, individual worksheets, or finalized rate baselines.
 * POST creates a worksheet revision; PUT edits an existing non-final record.
 * PATCH finalizes or archives a worksheet.
 *
 * Authentication is intentionally COMMENTED OUT for local development.
 * Uncomment the auth import and the authentication block in each handler
 * before production deployment. No role-based permissions are added.
 */
/** GET /api/billing/3556
 *   ?baseline=true&utilityGroup=...&utilitySystem=... : latest FINAL baseline
 *   ?id=...                                        : one worksheet
 *   (no query parameters)                          : sorted worksheet history
 * Baseline lookup sorts by effectiveDate, then approvedAt, newest first.
 */
export async function GET(

  request: NextRequest,

) {

  try {
    // ========================================================
    // AUTHENTICATION
    //
    // Authenticate before reading request data or accessing
    // DynamoDB. Uncomment this block for production.
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



    const id =

      request.nextUrl

        .searchParams

        .get("id");

    const baselineRequested = request.nextUrl.searchParams.get("baseline") === "true";

    const baselineUtilityGroup = clean(request.nextUrl.searchParams.get("utilityGroup"));

    const baselineUtilitySystem = clean(request.nextUrl.searchParams.get("utilitySystem"));

    // Billing/reconciliation uses only FINAL rates for the requested utility.
    if (baselineRequested) {

      if (!baselineUtilityGroup || !baselineUtilitySystem) {

        return NextResponse.json(

          { error: "utilityGroup and utilitySystem are required for baseline lookup." },

          { status: 400 },

        );

      }

      const matching = (await scanAll())

        .filter(

          (record) =>

            record.status === "FINAL" &&

            clean(record.utilityGroup).toUpperCase() === baselineUtilityGroup.toUpperCase() &&

            clean(record.utilitySystem).toUpperCase() === baselineUtilitySystem.toUpperCase(),

        )

        .sort((a, b) => {

          const effectiveCompare = clean(b.effectiveDate).localeCompare(clean(a.effectiveDate));

          if (effectiveCompare !== 0) return effectiveCompare;

          return clean(b.approvedAt).localeCompare(clean(a.approvedAt));

        });

      const record = matching[0] ?? null;

      if (!record) {

        return NextResponse.json(

          { error: "No FINAL 3556 baseline was found for this Utility Group and Utility System." },

          { status: 404 },

        );

      }

      return NextResponse.json({

        record,

        rateMonitoring: record.rateMonitoring ?? null,

      });

    }

    if (id) {

      const record =

        await getById(

          id,

        );

      if (!record) {

        return NextResponse.json(

          {

            error:

              "3556 record not found.",

          },

          {

            status: 404,

          },

        );

      }

      return NextResponse.json({

        record,

      });

    }

    const records =

      sortHistory(

        await scanAll(),

      );

    return NextResponse.json({

      records,

    });

  } catch (error) {

    console.error(

      "GET /api/billing/3556 failed:",

      error,

    );

    return NextResponse.json(

      {

        error:

          error instanceof

          Error

            ? error.message

            : "Unable to load 3556 records.",

      },

      {

        status: 500,

      },

    );

  }

}

/** POST /api/billing/3556
 * Create a new worksheet revision. Determine the next revision for the same
 * Utility Group/System, generate identity keys, and insert with a conditional
 * PutCommand so an existing PK/SK cannot be overwritten accidentally.
 */
export async function POST(

  request: NextRequest,

) {

  try {
    // ========================================================
    // AUTHENTICATION
    //
    // Authenticate before reading request data or accessing
    // DynamoDB. Uncomment this block for production.
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

      (await request.json()) as Save3556Request;

    const validationError =

      validatePayload(

        body,

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

    const fiscalYear =

      normalizeFiscalYear(

        body.fiscalYear,

      );

    const utilityGroup =

      clean(

        body.utilityGroup,

      );

    const utilitySystem =

      clean(

        body.utilitySystem,

      );

    const existingForUtility = (await scanAll()).filter(

      (record) =>

        clean(record.utilityGroup).toUpperCase() === utilityGroup.toUpperCase() &&

        clean(record.utilitySystem).toUpperCase() === utilitySystem.toUpperCase(),

    );

    // Revisions increment independently within each Utility Group/System.
    const revision =

      existingForUtility.reduce(

        (max, record) => Math.max(max, Number(record.revision) || 0),

        0,

      ) + 1;

    const id =

      clean(body.id) ||

      build3556Id(

        fiscalYear,

        utilityGroup,

        utilitySystem,

        revision,

      );

    const PK =

      buildPK(

        utilityGroup,

        utilitySystem,

      );

    const SK =

      buildSK(

        fiscalYear,

        clean(

          body.effectiveDate,

        ),

        revision,

      );

    // An explicit id must not overwrite an existing worksheet on creation.
    const existing =

      await getById(

        id,

      );

    if (existing) {

      return NextResponse.json(

        {

          error:

            "A 3556 with this identifier already exists. Open the existing draft to update it.",

          record:

            existing,

        },

        {

          status: 409,

        },

      );

    }

    const now =

      new Date()

        .toISOString();

    const record = {

      PK,

      SK,

      id,

      fiscalYear,

      utilityGroup,

      utilitySystem,

      revision,

      uom:

        clean(

          body.uom,

        ),

      effectiveDate:

        clean(

          body.effectiveDate,

        ),

      status:

        body.status ??

        "DRAFT",

      preparedDate:

        clean(

          body.preparedDate,

        ) ||

        now.slice(

          0,

          10,

        ),

      createdAt: now,

      updatedAt: now,

      worksheet:

        body.worksheet,

      rateInputs:

        body.rateInputs,

      otherUtilityWorksheet:

        body.otherUtilityWorksheet,

      calculatedRates:

        body.calculatedRates,

      calculatedSalesRates:

        body.calculatedSalesRates,

    };

    await ddb.send(

      new PutCommand({

        TableName:

          TABLE_NAME,

        Item:

          record,

        ConditionExpression:

          "attribute_not_exists(PK) AND attribute_not_exists(SK)",

      }),

    );

    return NextResponse.json(

      {

        record,

      },

      {

        status: 201,

      },

    );

  } catch (error) {

    console.error(

      "POST /api/billing/3556 failed:",

      error,

    );

    return NextResponse.json(

      {

        error:

          error instanceof

          Error

            ? error.message

            : "Unable to create 3556 record.",

      },

      {

        status: 500,

      },

    );

  }

}

/** PUT /api/billing/3556
 * Update an existing worksheet by id. FINAL worksheets cannot be edited.
 * The original PK/SK is preserved even when effectiveDate changes, preventing
 * an ordinary draft edit from silently creating another DynamoDB record.
 */
export async function PUT(

  request: NextRequest,

) {

  try {
    // ========================================================
    // AUTHENTICATION
    //
    // Authenticate before reading request data or accessing
    // DynamoDB. Uncomment this block for production.
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

      (await request.json()) as Save3556Request;

    const validationError =

      validatePayload(

        body,

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

    const id =

      clean(

        body.id,

      );

    if (!id) {

      return NextResponse.json(

        {

          error:

            "3556 id is required when updating a draft.",

        },

        {

          status: 400,

        },

      );

    }

    const existing =

      await getById(

        id,

      );

    if (!existing) {

      return NextResponse.json(

        {

          error:

            "3556 record not found.",

        },

        {

          status: 404,

        },

      );

    }

    if (

      existing.status ===

      "FINAL"

    ) {

      return NextResponse.json(

        {

          error:

            "This 3556 is FINAL and cannot be changed.",

        },

        {

          status: 409,

        },

      );

    }

    const now =

      new Date()

        .toISOString();

    /*

      IMPORTANT:

      PK and SK remain unchanged while editing a draft.

      That prevents an effective-date edit from accidentally

      creating a second DynamoDB item instead of updating the

      existing draft.

      When we add formal revision handling later, a new revision

      will intentionally receive a new SK.

    */

    const record = {

      ...existing,

      fiscalYear:

        normalizeFiscalYear(

          body.fiscalYear,

        ),

      utilityGroup:

        clean(

          body.utilityGroup,

        ),

      utilitySystem:

        clean(

          body.utilitySystem,

        ),

      uom:

        clean(

          body.uom,

        ),

      effectiveDate:

        clean(

          body.effectiveDate,

        ),

      status:

        body.status ??

        "DRAFT",

      updatedAt: now,

      worksheet:

        body.worksheet,

      rateInputs:

        body.rateInputs,

      otherUtilityWorksheet:

        body.otherUtilityWorksheet,

      calculatedRates:

        body.calculatedRates,

      calculatedSalesRates:

        body.calculatedSalesRates,

    };

    await ddb.send(

      new PutCommand({

        TableName:

          TABLE_NAME,

        Item:

          record,

        ConditionExpression:

          "attribute_exists(PK) AND attribute_exists(SK)",

      }),

    );

    return NextResponse.json({

      record,

    });

  } catch (error) {

    console.error(

      "PUT /api/billing/3556 failed:",

      error,

    );

    return NextResponse.json(

      {

        error:

          error instanceof

          Error

            ? error.message

            : "Unable to update 3556 record.",

      },

      {

        status: 500,

      },

    );

  }

}

/** PATCH /api/billing/3556
 * FINALIZE: require a positive saved A-3 Basic Cost, mark FINAL, and freeze a
 *           rate-monitoring baseline with the existing 5% threshold.
 * ARCHIVE:  mark ARCHIVED while retaining the worksheet for audit/history.
 * Both actions write the complete updated record with an existence condition.
 */
export async function PATCH(

  request: NextRequest,

) {

  try {
    // ========================================================
    // AUTHENTICATION
    //
    // Authenticate before reading request data or accessing
    // DynamoDB. Uncomment this block for production.
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

      (await request.json()) as {

        id?: string;

        action?:

          | "FINALIZE"

          | "ARCHIVE";

        approvedBy?: string;

      };

    const id =

      clean(

        body.id,

      );

    if (!id) {

      return NextResponse.json(

        {

          error:

            "3556 id is required.",

        },

        {

          status: 400,

        },

      );

    }

    const existing =

      await getById(

        id,

      );

    if (!existing) {

      return NextResponse.json(

        {

          error:

            "3556 record not found.",

        },

        {

          status: 404,

        },

      );

    }

    const now =

      new Date()

        .toISOString();

    if (

      body.action ===

      "FINALIZE"

    ) {

      if (existing.status === "FINAL") {

        return NextResponse.json({ record: existing });

      }

      // Freeze the approved A-3 snapshot; do not recalculate form inputs here.
      const approvedA3BasicCost = getA3BasicCost(existing.calculatedRates);

      if (approvedA3BasicCost === null || approvedA3BasicCost <= 0) {

        return NextResponse.json(

          { error: "Basic Cost A-3 must be greater than 0 before the 3556 can be finalized." },

          { status: 400 },

        );

      }

      const record = {

        ...existing,

        status:

          "FINAL",

        approvedAt:

          existing.approvedAt ??

          now,

        approvedBy:

          existing.approvedBy ??

          (

            clean(

              body.approvedBy,

            ) ||

            "CUBE User"

          ),

        // Used by downstream monitoring to detect deviations from the approved rate.
        rateMonitoring: {

          baselineType: "A3_BASIC_COST",

          baselineRate: approvedA3BasicCost,

          thresholdPercent: 5,

          effectiveDate: clean(existing.effectiveDate),

        },

        updatedAt:

          now,

      };

      await ddb.send(

        new PutCommand({

          TableName:

            TABLE_NAME,

          Item:

            record,

          ConditionExpression:

            "attribute_exists(PK) AND attribute_exists(SK)",

        }),

      );

      return NextResponse.json({

        record,

      });

    }

    if (

      body.action ===

      "ARCHIVE"

    ) {

      const record = {

        ...existing,

        status:

          "ARCHIVED",

        archivedAt:

          now,

        updatedAt:

          now,

      };

      await ddb.send(

        new PutCommand({

          TableName:

            TABLE_NAME,

          Item:

            record,

          ConditionExpression:

            "attribute_exists(PK) AND attribute_exists(SK)",

        }),

      );

      return NextResponse.json({

        record,

      });

    }

    return NextResponse.json(

      {

        error:

          "Unsupported action.",

      },

      {

        status: 400,

      },

    );

  } catch (error) {

    console.error(

      "PATCH /api/billing/3556 failed:",

      error,

    );

    return NextResponse.json(

      {

        error:

          error instanceof

          Error

            ? error.message

            : "Unable to update 3556 status.",

      },

      {

        status: 500,

      },

    );

  }

}
