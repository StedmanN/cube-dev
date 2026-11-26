import { randomUUID } from "node:crypto";
import { GetCommand, PutCommand, ScanCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { NextRequest, NextResponse } from "next/server";
import { ddb } from "@/lib/dynamo";
import { getAppSession } from "@/lib/app-session";
import { fingerprint3556, mappingPK } from "@/lib/reporting-classification";
import {
  read3556Rows,
  type Final3556,
  type ReportingAssignment,
} from "@/lib/3556-reporting";

export const dynamic = "force-dynamic";
const TABLE = process.env.CUBE_3556_TABLE_NAME || "p72-CUBE-3556";
const CODES = new Set(["REM", "CUBE", "SRM_LABOR", "SRM_MATERIALS", "UNCLASSIFIED"]);
const idText = (x: unknown) => String(x ?? "").trim();

async function findFinalWorksheet(id: string): Promise<Final3556 | null> {
  let key: Record<string, unknown> | undefined;
  do {
    const result = await ddb.send(new ScanCommand({TableName: TABLE, ExclusiveStartKey: key}));
    const record = result.Items?.find(row => row.id === id && row.status === "FINAL" && String(row.PK ?? "").startsWith("3556#"));
    if (record) return record as Final3556;
    key = result.LastEvaluatedKey;
  } while (key);
  return null;
}

export async function GET(request: NextRequest) {
  const session = await getAppSession();
  if (!session?.user) return NextResponse.json({error: "Unauthorized"}, {status: 401});
  const id = idText(request.nextUrl.searchParams.get("worksheet_id"));
  if (!id) return NextResponse.json({error:"worksheet_id is required"},{status:400});
  const worksheet = await findFinalWorksheet(id);
  if (!worksheet) return NextResponse.json({error:"FINAL 3556 not found"},{status:404});
  const row = await ddb.send(new GetCommand({TableName:TABLE,Key:{PK:mappingPK(id),SK:"CURRENT"},ConsistentRead:true}));
  const current = row.Item ?? null;
  const matched = current && current.SourceFingerprint === fingerprint3556(worksheet);
  const mappings = matched && current?.Assignments && typeof current.Assignments === "object" ? current.Assignments : {};
  const parsed = read3556Rows(worksheet, mappings as Record<string,ReportingAssignment>);
  return NextResponse.json({id, sourceFingerprint: fingerprint3556(worksheet), mappings, mapStatus: current ? (matched ? "CURRENT" : "STALE") : "NOT_CONFIGURED", updatedAt: current?.UpdatedAt ?? null, updatedBy: current?.UpdatedBy ?? null, rows: parsed.rows, errors: parsed.errors});
}

export async function POST(request: NextRequest) {
  const session = await getAppSession();
  if (!session?.user) return NextResponse.json({error:"Unauthorized"},{status:401});
  const body = await request.json().catch(() => ({}));
  const id = idText(body.worksheet_id);
  const reason = idText(body.reason);
  if (!id || !reason || reason.length < 8) return NextResponse.json({error:"FINAL worksheet ID and a documented mapping reason (8+ characters) are required."},{status:400});
  if (!body.assignments || typeof body.assignments !== "object" || Array.isArray(body.assignments)) return NextResponse.json({error:"assignments must be a mapping of section:rowId to component."},{status:400});
  const entries = Object.entries(body.assignments as Record<string,unknown>);
  if (entries.length > 100) return NextResponse.json({error:"Too many mapping entries."},{status:400});
  const assignments: Record<string,ReportingAssignment> = {};
  for (const [key, candidate] of entries) {
    if (!/^(purchased|purchasedServices|produced|distribution):[A-Za-z0-9_.-]{1,120}$/.test(key) || !CODES.has(idText(candidate))) return NextResponse.json({error:`Invalid mapping ${key}`},{status:400});
    assignments[key] = candidate as ReportingAssignment;
  }
  const worksheet = await findFinalWorksheet(id);
  if (!worksheet) return NextResponse.json({error:"FINAL worksheet not found"},{status:404});
  const fingerprint = fingerprint3556(worksheet);
  if (body.sourceFingerprint !== fingerprint) return NextResponse.json({error:"The 3556 changed. Reload before assigning reporting categories."},{status:409});
  const parsed = read3556Rows(worksheet, assignments);
  if (parsed.errors.length) return NextResponse.json({error:"Mapping does not match the FINAL 3556",details:parsed.errors},{status:400});
  const current = await ddb.send(new GetCommand({TableName:TABLE,Key:{PK:mappingPK(id),SK:"CURRENT"},ConsistentRead:true}));
  const expected = body.expectedUpdatedAt ?? null;
  if ((current.Item?.UpdatedAt ?? null) !== expected) return NextResponse.json({error:"The classification mapping was changed by someone else. Reload first."},{status:409});
  const stamp = new Date().toISOString();
  const actor = idText(session.user.email || session.user.name || session.user.id);
  const shared = {SourceWorksheetId:id,SourceFingerprint:fingerprint,Assignments:assignments,UpdatedBy:actor,UpdatedAt:stamp,Reason:reason,RecordType:"REPORTING_CLASSIFICATION"};
  const condition = current.Item ? "UpdatedAt = :old" : "attribute_not_exists(PK)";
  const pointer = {Put:{TableName:TABLE,Item:{PK:mappingPK(id),SK:"CURRENT",...shared},ConditionExpression:condition,...(current.Item ? {ExpressionAttributeValues:{":old":expected}} : {})}};
  const history = {Put:{TableName:TABLE,Item:{PK:mappingPK(id),SK:`AUDIT#${stamp}#${randomUUID()}`,...shared},ConditionExpression:"attribute_not_exists(PK)"}};
  try {
    await ddb.send(new TransactWriteCommand({TransactItems:[pointer,history]}));
    return NextResponse.json({ok:true,updatedAt:stamp,mappingCount:entries.length});
  } catch {
    return NextResponse.json({error:"Unable to save classification. Reload the worksheet and retry; no partial mapping was applied."},{status:409});
  }
}
