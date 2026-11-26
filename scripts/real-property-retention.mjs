import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { retainRealPropertySnapshots } from "../lib/real-property-retention.ts";

const args = process.argv.slice(2);
if (
  args.length < 1 ||
  args.length > 2 ||
  !(args[0] === "--all" || /^\d+$/.test(args[0])) ||
  (args[1] && args[1] !== "--apply")
) {
  throw Error("Usage: node scripts/real-property-retention.mjs BILLING_PERIOD_ID|--all [--apply]");
}
const client = new DynamoDBClient({
  endpoint: "http://127.0.0.1:8000",
  region: "local",
  credentials: { accessKeyId: "DUMMYLOCALACCESSKEY", secretAccessKey: "DUMMYLOCALSECRETKEY" },
  maxAttempts: 1,
});
client.middlewareStack.add(
  (next) => async (args) => {
    const r = args.request;
    if (r.protocol !== "http:" || r.hostname !== "127.0.0.1" || r.port !== 8000)
      throw Error("Local only");
    return next(args);
  },
  { name: "retentionLocalOnly", step: "finalizeRequest", priority: "high" },
);
const db = DynamoDBDocumentClient.from(client);
const tables = {
  control: "p72-CUBE-3556",
  monthly: "p72-CUBE-RP-MONTHLY",
  estimates: "p72-CUBE-ESTIMATES",
  propQ: "p72-CUBE-RP-PROPQ",
};
async function scan(TableName, visit) {
  let cursor;
  do {
    const page = await db.send(
      new ScanCommand({ TableName, ConsistentRead: true, ExclusiveStartKey: cursor }),
    );
    for (const row of page.Items ?? []) visit(row);
    cursor = page.LastEvaluatedKey;
  } while (cursor);
}
function stable(x) {
  if (Array.isArray(x)) return x.map(stable);
  if (x && typeof x === "object")
    return Object.fromEntries(
      Object.entries(x)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, stable(v)]),
    );
  return x;
}
const digest = (x) =>
  createHash("sha256")
    .update(JSON.stringify(stable(x)))
    .digest("hex");
try {
  const periods = [];
  if (args[0] === "--all") {
    await scan(tables.control, (row) => {
      if (row.SK === "ACTIVE" && /^RP_PERIOD#\d+$/.test(row.PK ?? ""))
        periods.push(Number(row.PK.split("#")[1]));
    });
  } else periods.push(Number(args[0]));
  const plans = new Map();
  for (const bp of periods) plans.set(bp, await retainRealPropertySnapshots(db, tables, bp));
  console.log(JSON.stringify({ plans: [...plans].map(([bp, p]) => ({ bp, ...p })) }));
  if (args[1] === "--apply") {
    const sourceTables = [tables.monthly, tables.estimates, tables.propQ];
    const before = new Map();
    const key = (bp, table) => `${bp}|${table}`;
    const isObsolete = (bp, row) => plans.get(bp)?.remove.includes(String(row.DataVersion ?? ""));
    async function readPeriod(TableName, bp, visit) {
      let cursor;
      do {
        const page = await db.send(
          new QueryCommand({
            TableName,
            IndexName: "billing-period-index",
            KeyConditionExpression: "billing_period_id = :bp",
            ExpressionAttributeValues: { ":bp": bp },
            ExclusiveStartKey: cursor,
          }),
        );
        for (const row of page.Items ?? []) visit(row);
        cursor = page.LastEvaluatedKey;
      } while (cursor);
    }
    const controlBefore = [];
    const controlRows = [];
    await scan(tables.control, (row) => {
      controlBefore.push(digest(row));
      controlRows.push(row);
    });
    // Compare February and snapshot months that do not require pruning separately.
    const unchanged = [...new Set([175, ...periods.filter((bp) => !plans.get(bp).remove.length)])];
    for (const bp of unchanged)
      for (const table of sourceTables) {
        const hashes = [];
        await readPeriod(table, bp, (row) => hashes.push(digest(row)));
        before.set(key(bp, table), hashes);
      }
    for (const [bp, plan] of plans) {
      assert.deepEqual(await retainRealPropertySnapshots(db, tables, bp), plan);
      if (!plan.remove.length) continue;
      let seen = 0;
      // Capture protected records while reading the cleanup pages; avoid scanning every other month.
      const result = await retainRealPropertySnapshots(db, tables, bp, true, (table, row) => {
        seen++;
        if (!isObsolete(bp, row)) {
          const k = key(bp, table);
          if (!before.has(k)) before.set(k, []);
          before.get(k).push(digest(row));
        }
        if (seen % 20000 === 0) console.log(JSON.stringify({ bp, rowsExamined: seen }));
      });
      console.log(JSON.stringify({ bp, deleted: result.deleted }));
    }
    const summaries = [];
    for (const bp of new Set([...periods, ...unchanged]))
      for (const table of sourceTables) {
        const hashes = [];
        const versions = {};
        await readPeriod(table, bp, (row) => {
          assert.ok(!isObsolete(bp, row), `${table}: obsolete rows remain; retry cleanup`);
          hashes.push(digest(row));
          if (row.DataVersion) versions[row.DataVersion] = (versions[row.DataVersion] ?? 0) + 1;
        });
        assert.deepEqual(
          hashes.sort(),
          (before.get(key(bp, table)) ?? []).sort(),
          `${table} BP ${bp}: retained data changed`,
        );
        for (const version of plans.get(bp)?.keep ?? []) {
          const audit = controlRows.find(
            (row) => row.PK === `RP_AUDIT#${bp}` && row.NewDataVersion === version,
          );
          const countField =
            table === tables.monthly
              ? "RecordCount"
              : table === tables.estimates
                ? "EstimateCount"
                : "PropQCount";
          if (typeof audit?.[countField] === "number")
            assert.equal(
              versions[version] ?? 0,
              audit[countField],
              `${table}: retained snapshot ${version} incomplete`,
            );
        }
        summaries.push({ bp, table, rows: hashes.length, versions });
      }
    const controlAfter = [];
    await scan(tables.control, (row) => controlAfter.push(digest(row)));
    assert.deepEqual(
      controlAfter.sort(),
      controlBefore.sort(),
      "Control/audit records changed during cleanup",
    );
    console.log(JSON.stringify({ verified: true, summaries }));
  }
} finally {
  client.destroy();
}
