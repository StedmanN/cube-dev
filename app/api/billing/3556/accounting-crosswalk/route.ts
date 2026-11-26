import { randomUUID } from "node:crypto";
import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { NextRequest, NextResponse } from "next/server";
import { ddb } from "@/lib/dynamo";
import { getAppSession } from "@/lib/app-session";
import {
  ACCOUNTING_CROSSWALK_PK,
  ACCOUNTING_CROSSWALK_RECORD_TYPE,
  resolveAccountingCrosswalkRecord,
  validateAccountingCrosswalk,
} from "@/lib/reporting-crosswalk";

export const dynamic = "force-dynamic";
const TABLE = process.env.CUBE_3556_TABLE_NAME || "p72-CUBE-3556";

/** Explicitly opt in to authorized editors; no authenticated-user blanket write permission. */
function mayEdit(session: Awaited<ReturnType<typeof getAppSession>>): boolean {
  if (!session?.user) return false;
  const groupList = (process.env.CUBE_REPORTING_CROSSWALK_EDITOR_GROUPS ?? "")
    .split(",").map(name => name.trim().toLowerCase()).filter(Boolean);
  const emailList = (process.env.CUBE_REPORTING_CROSSWALK_EDITOR_EMAILS ?? "")
    .split(",").map(name => name.trim().toLowerCase()).filter(Boolean);
  const groups = (session.user.groups ?? []).map(name => name.toLowerCase());
  const email = String(session.user.email ?? "").trim().toLowerCase();
  return groups.some(group => groupList.includes(group)) || (Boolean(email) && emailList.includes(email));
}

async function current() {
  const result = await ddb.send(new GetCommand({TableName: TABLE, Key: {PK: ACCOUNTING_CROSSWALK_PK, SK: "CURRENT"}, ConsistentRead: true}));
  return result.Item ?? null;
}

export async function GET() {
  const session = await getAppSession();
  if (!session?.user) return NextResponse.json({error: "Unauthorized"}, {status: 401});
  try {
    const active = resolveAccountingCrosswalkRecord(await current());
    return NextResponse.json({...active, canEdit: mayEdit(session), accountingApproved: false});
  } catch {
    return NextResponse.json({error: "Accounting crosswalk configuration cannot be loaded or validated."}, {status: 500});
  }
}

export async function POST(request: NextRequest) {
  const session = await getAppSession();
  if (!session?.user) return NextResponse.json({error: "Unauthorized"}, {status: 401});
  if (!mayEdit(session)) return NextResponse.json({error: "Accounting crosswalk edits are restricted to explicitly authorized users."}, {status: 403});
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") return NextResponse.json({error: "Invalid request."}, {status: 400});
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (reason.length < 8 || reason.length > 500) return NextResponse.json({error: "A documented reason (8 to 500 characters) is required."}, {status: 400});
  let codes;
  try { codes = validateAccountingCrosswalk(body.codes); }
  catch (error) { return NextResponse.json({error: error instanceof Error ? error.message : "Invalid crosswalk."}, {status: 400}); }
  const expected = body.expectedUpdatedAt;
  if (expected !== null && (typeof expected !== "string" || expected.length > 100)) return NextResponse.json({error: "Invalid revision token."}, {status: 400});
  try {
    const previous = await current();
    if ((previous?.UpdatedAt ?? null) !== expected) return NextResponse.json({error: "Crosswalk changed; reload before saving."}, {status: 409});
    const stamp = new Date().toISOString();
    const actor = String(session.user.email || session.user.name || session.user.id || "UNKNOWN").slice(0, 200);
    const shared = {RecordType: ACCOUNTING_CROSSWALK_RECORD_TYPE, Codes: codes, UpdatedAt: stamp, UpdatedBy: actor, Reason: reason};
    const pointer = {
      Put: {
        TableName: TABLE,
        Item: {PK: ACCOUNTING_CROSSWALK_PK, SK: "CURRENT", ...shared},
        ConditionExpression: previous ? "UpdatedAt = :old" : "attribute_not_exists(PK)",
        ...(previous ? {ExpressionAttributeValues: {":old": expected}} : {}),
      },
    };
    const history = {
      Put: {
        TableName: TABLE,
        Item: {PK: ACCOUNTING_CROSSWALK_PK, SK: `AUDIT#${stamp}#${randomUUID()}`, ...shared},
        ConditionExpression: "attribute_not_exists(PK)",
      },
    };
    await ddb.send(new TransactWriteCommand({TransactItems: [pointer, history]}));
    return NextResponse.json({ok: true, updatedAt: stamp, source: "CONFIGURED", accountingApproved: false});
  } catch {
    return NextResponse.json({error: "Crosswalk was not saved. Reload and retry; no partial configuration was applied."}, {status: 409});
  }
}
