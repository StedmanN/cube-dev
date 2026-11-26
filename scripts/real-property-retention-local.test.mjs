import assert from "node:assert/strict";
import { CreateTableCommand, DeleteTableCommand, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  ScanCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { retainRealPropertySnapshots } from "../lib/real-property-retention.ts";

const prefix = `CUBE-RP-IT-RETENTION-${Date.now()}`;
const tables = {
  control: `${prefix}-CONTROL`,
  monthly: `${prefix}-MONTHLY`,
  estimates: `${prefix}-ESTIMATES`,
  propQ: `${prefix}-PROPQ`,
};
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
  { name: "localOnly", step: "finalizeRequest", priority: "high" },
);
const db = DynamoDBDocumentClient.from(client);
const created = [];
const hash = (AttributeName) => ({ AttributeName, KeyType: "HASH" });
try {
  for (const [name, TableName] of Object.entries(tables)) {
    const id = { control: "PK", monthly: "MonthlyRPID", estimates: "EstimateID", propQ: "PropQID" }[
      name
    ];
    await client.send(
      new CreateTableCommand({
        TableName,
        BillingMode: "PAY_PER_REQUEST",
        AttributeDefinitions: [
          { AttributeName: id, AttributeType: "S" },
          {
            AttributeName: name === "control" ? "SK" : "billing_period_id",
            AttributeType: name === "control" ? "S" : "N",
          },
        ],
        KeySchema:
          name === "control" ? [hash("PK"), { AttributeName: "SK", KeyType: "RANGE" }] : [hash(id)],
        ...(name === "control"
          ? {}
          : {
              GlobalSecondaryIndexes: [
                {
                  IndexName: "billing-period-index",
                  KeySchema: [hash("billing_period_id")],
                  Projection: { ProjectionType: "ALL" },
                },
              ],
            }),
      }),
    );
    created.push(TableName);
  }
  const put = (TableName, Item) => db.send(new PutCommand({ TableName, Item }));
  for (let i = 0; i < 9; i++) {
    await put(tables.control, {
      PK: "RP_AUDIT#182",
      SK: `audit-${i}`,
      NewDataVersion: `v${i}`,
      PriorDataVersion: i ? `v${i - 1}` : "UNVERSIONED",
    });
    for (const [name, id] of [
      ["monthly", "MonthlyRPID"],
      ["estimates", "EstimateID"],
      ["propQ", "PropQID"],
    ]) {
      await put(tables[name], {
        [id]: `row-v${i}`,
        billing_period_id: 182,
        DataVersion: `v${i}`,
        value: i,
      });
    }
  }
  await put(tables.control, { PK: "RP_PERIOD#182", SK: "ACTIVE", ActiveDataVersion: "v8" });
  for (const [name, id] of [
    ["monthly", "MonthlyRPID"],
    ["estimates", "EstimateID"],
    ["propQ", "PropQID"],
  ]) {
    await put(tables[name], { [id]: "february", billing_period_id: 175, value: "legacy" });
    await put(tables[name], { [id]: "staging", billing_period_id: 182, DataVersion: "pending" });
    await put(tables[name], { [id]: "unversioned", billing_period_id: 182 });
  }
  // Exercise the full 100-action transaction limit on DynamoDB Local.
  for (let i = 0; i < 100; i++)
    await put(tables.monthly, {
      MonthlyRPID: `extra-old-${i}`,
      billing_period_id: 182,
      DataVersion: "v0",
    });
  const read = async (TableName) =>
    (await db.send(new ScanCommand({ TableName, ConsistentRead: true }))).Items;
  const canonical = (rows) =>
    rows.map((row) => JSON.stringify(Object.fromEntries(Object.entries(row).sort()))).sort();
  const before = await read(tables.control);
  assert.equal((await retainRealPropertySnapshots(db, tables, 182)).remove.length, 3);
  assert.equal((await retainRealPropertySnapshots(db, tables, 175, true)).deleted, 0);
  assert.equal((await retainRealPropertySnapshots(db, tables, 182, true)).deleted, 109);
  for (const name of ["monthly", "estimates", "propQ"]) {
    const rows = await read(tables[name]);
    assert.equal(rows.length, 9);
    assert.deepEqual(
      rows
        .filter((x) => /^v/.test(x.DataVersion ?? ""))
        .map((x) => x.DataVersion)
        .sort(),
      ["v3", "v4", "v5", "v6", "v7", "v8"],
    );
    assert.equal(rows.find((x) => x.billing_period_id === 175).value, "legacy");
  }
  assert.deepEqual(canonical(await read(tables.control)), canonical(before));
  assert.equal((await retainRealPropertySnapshots(db, tables, 182, true)).deleted, 0);
  // Simulate activation between planning and the delete transaction.
  await put(tables.monthly, { MonthlyRPID: "late-old", billing_period_id: 182, DataVersion: "v0" });
  let changed = false;
  const racing = {
    send: async (command) => {
      if (command.constructor.name === "TransactWriteCommand" && !changed) {
        changed = true;
        await db.send(
          new UpdateCommand({
            TableName: tables.control,
            Key: { PK: "RP_PERIOD#182", SK: "ACTIVE" },
            UpdateExpression: "SET ActiveDataVersion = :v",
            ExpressionAttributeValues: { ":v": "v9" },
          }),
        );
      }
      return db.send(command);
    },
  };
  await assert.rejects(retainRealPropertySnapshots(racing, tables, 182, true), /Transaction/);
  assert.ok((await read(tables.monthly)).some((x) => x.MonthlyRPID === "late-old"));
  console.log(
    "PASS local retention: active + five, legacy/staging protection, audit preservation, idempotence, activation race",
  );
} finally {
  for (const TableName of created.reverse())
    await client.send(new DeleteTableCommand({ TableName }));
  client.destroy();
}
