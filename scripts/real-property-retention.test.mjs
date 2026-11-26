import assert from "node:assert/strict";
import test from "node:test";
import {
  planSnapshotRetention,
  retainRealPropertySnapshots,
} from "../lib/real-property-retention.ts";

const audits = Array.from({ length: 9 }, (_, i) => ({
  NewDataVersion: `v${i}`,
  PriorDataVersion: i ? `v${i - 1}` : "UNVERSIONED",
}));
const tables = { control: "control", monthly: "monthly", estimates: "estimates", propQ: "propq" };
test("keeps active plus five successful ancestors regardless of input order", () => {
  assert.deepEqual(planSnapshotRetention("v8", [...audits].reverse()), {
    keep: ["v8", "v7", "v6", "v5", "v4", "v3"],
    remove: ["v2", "v1", "v0"],
  });
  assert.deepEqual(planSnapshotRetention("v0", audits), { keep: ["v0"], remove: [] });
});
test("missing, duplicate, cyclic or absent active history stops deletion", () => {
  assert.throws(() => planSnapshotRetention("", audits));
  assert.throws(() => planSnapshotRetention("v8", audits.slice(1)));
  assert.throws(() => planSnapshotRetention("v8", [...audits, audits[0]]));
  assert.throws(() =>
    planSnapshotRetention("v0", [{ NewDataVersion: "v0", PriorDataVersion: "v0" }]),
  );
});
function fixture({ legacy = false, conflict = false } = {}) {
  const writes = [];
  const client = {
    send: async (command) => {
      const x = command.input;
      if (command.constructor.name === "GetCommand")
        return { Item: legacy ? undefined : { ActiveDataVersion: "v8" } };
      if (command.constructor.name === "QueryCommand") {
        if (x.TableName === "control") return { Items: audits };
        const id = { monthly: "MonthlyRPID", estimates: "EstimateID", propq: "PropQID" }[
          x.TableName
        ];
        return {
          Items: [
            ...Array.from({ length: 30 }, (_, i) => ({
              [id]: `old-${i}`,
              DataVersion: "v0",
              billing_period_id: 182,
            })),
            { [id]: "active", DataVersion: "v8", billing_period_id: 182 },
            { [id]: "keep", DataVersion: "v3", billing_period_id: 182 },
            { [id]: "staging", DataVersion: "unknown", billing_period_id: 182 },
            { [id]: "legacy", billing_period_id: 182 },
          ],
        };
      }
      if (conflict) throw Error("TransactionCanceledException");
      writes.push(x);
      return {};
    },
  };
  return { client, writes };
}
test("deletes only audited obsolete versions across all three tables, guarded per batch", async () => {
  const { client, writes } = fixture();
  const result = await retainRealPropertySnapshots(client, tables, 182, true);
  assert.equal(result.deleted, 90);
  assert.equal(writes.length, 3);
  for (const x of writes) {
    assert.ok(x.TransactItems.length <= 100);
    assert.equal(x.TransactItems[0].ConditionCheck.ExpressionAttributeValues[":active"], "v8");
    for (const { Delete: d } of x.TransactItems.slice(1)) {
      assert.equal(d.ExpressionAttributeValues[":version"], "v0");
      assert.equal(d.ExpressionAttributeValues[":bp"], 182);
      assert.match(d.ConditionExpression, /DataVersion = :version/);
    }
  }
});
test("legacy months and dry runs perform no writes", async () => {
  for (const legacy of [true, false]) {
    const { client, writes } = fixture({ legacy });
    await retainRealPropertySnapshots(client, tables, 175, !legacy ? false : true);
    assert.equal(writes.length, 0);
  }
});
test("activation conflict aborts cleanup immediately", async () => {
  const { client, writes } = fixture({ conflict: true });
  await assert.rejects(
    retainRealPropertySnapshots(client, tables, 182, true),
    /TransactionCanceled/,
  );
  assert.equal(writes.length, 0);
});

test("follows audit and data pagination even when the first data page has nothing obsolete", async () => {
  let deleted = 0;
  const client = {
    send: async (command) => {
      const x = command.input;
      if (command.constructor.name === "GetCommand") return { Item: { ActiveDataVersion: "v8" } };
      if (command.constructor.name === "TransactWriteCommand") {
        deleted += x.TransactItems.length - 1;
        return {};
      }
      if (x.TableName === "control")
        return x.ExclusiveStartKey
          ? { Items: audits.slice(4) }
          : { Items: audits.slice(0, 4), LastEvaluatedKey: { PK: "next" } };
      if (x.TableName !== "monthly") return { Items: [] };
      return x.ExclusiveStartKey
        ? { Items: [{ MonthlyRPID: "old", DataVersion: "v0", billing_period_id: 182 }] }
        : {
            Items: [{ MonthlyRPID: "active", DataVersion: "v8", billing_period_id: 182 }],
            LastEvaluatedKey: { MonthlyRPID: "active" },
          };
    },
  };
  await retainRealPropertySnapshots(client, tables, 182, true);
  assert.equal(deleted, 1);
});
