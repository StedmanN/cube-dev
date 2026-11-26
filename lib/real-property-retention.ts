import {
  type DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  type QueryCommandOutput,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";

export type RetentionRow = Record<string, unknown>;
export type RetentionTables = {
  control: string;
  monthly: string;
  estimates: string;
  propQ: string;
};

/** Follow successful activations, never timestamps on individual data rows.
 * An incomplete/ambiguous audit chain is a hard stop: do not guess what is old.
 * Audit records themselves are retained, including for already-pruned versions.
 */
export function planSnapshotRetention(active: string, audits: RetentionRow[]) {
  if (!active) throw new Error("Retention requires an active snapshot.");
  const byVersion = new Map<string, RetentionRow>();
  for (const audit of audits) {
    const version = String(audit.NewDataVersion ?? "");
    if (!version) continue;
    if (byVersion.has(version)) throw new Error("Ambiguous snapshot activation history.");
    byVersion.set(version, audit);
  }
  const chain: string[] = [];
  let version = active;
  while (version && version !== "UNVERSIONED") {
    if (chain.includes(version)) throw new Error("Cyclic snapshot activation history.");
    const audit = byVersion.get(version);
    if (!audit) throw new Error(`Missing activation audit for ${version}; cleanup stopped.`);
    chain.push(version);
    if (typeof audit.PriorDataVersion !== "string" || !audit.PriorDataVersion) {
      throw new Error("Missing prior snapshot version; cleanup stopped.");
    }
    version = audit.PriorDataVersion;
  }
  return { keep: chain.slice(0, 6), remove: chain.slice(6) };
}

export async function retainRealPropertySnapshots(
  client: DynamoDBDocumentClient,
  tables: RetentionTables,
  billingPeriodId: number,
  apply = false,
  onRead?: (tableName: string, row: RetentionRow) => void,
) {
  if (!Number.isSafeInteger(billingPeriodId) || billingPeriodId <= 0)
    throw new Error("Invalid billing period.");
  const controlKey = { PK: `RP_PERIOD#${billingPeriodId}`, SK: "ACTIVE" };
  const { Item: state } = await client.send(
    new GetCommand({
      TableName: tables.control,
      Key: controlKey,
      ConsistentRead: true,
    }),
  );
  if (!state)
    return {
      skipped: "No active snapshot; period left unchanged.",
      keep: [],
      remove: [],
      deleted: 0,
    };
  const active = String(state.ActiveDataVersion ?? "");
  const audits: RetentionRow[] = [];
  let cursor: Record<string, unknown> | undefined;
  do {
    const page: QueryCommandOutput = await client.send(
      new QueryCommand({
        TableName: tables.control,
        ConsistentRead: true,
        KeyConditionExpression: "PK = :pk",
        ExpressionAttributeValues: { ":pk": `RP_AUDIT#${billingPeriodId}` },
        ExclusiveStartKey: cursor,
      }),
    );
    audits.push(...(page.Items ?? []));
    cursor = page.LastEvaluatedKey;
  } while (cursor);
  const plan = planSnapshotRetention(active, audits);
  let deleted = 0;
  if (!apply || !plan.remove.length) return { ...plan, deleted };
  const obsolete = new Set(plan.remove);
  for (const [TableName, id] of [
    [tables.monthly, "MonthlyRPID"],
    [tables.estimates, "EstimateID"],
    [tables.propQ, "PropQID"],
  ]) {
    cursor = undefined;
    do {
      const page: QueryCommandOutput = await client.send(
        new QueryCommand({
          TableName,
          IndexName: "billing-period-index",
          KeyConditionExpression: "billing_period_id = :bp",
          ExpressionAttributeValues: { ":bp": billingPeriodId },
          ...(onRead
            ? {}
            : {
                ProjectionExpression: "#id, DataVersion, billing_period_id",
                ExpressionAttributeNames: { "#id": id },
              }),
          ExclusiveStartKey: cursor,
        }),
      );
      // Save the page cursor before deleting anything. Re-running is safe after a partial failure.
      cursor = page.LastEvaluatedKey;
      for (const row of page.Items ?? []) onRead?.(TableName, row);
      const rows = (page.Items ?? []).filter((row) => obsolete.has(String(row.DataVersion ?? "")));
      // DynamoDB permits 100 transaction actions: 99 deletes plus the pointer check.
      for (let offset = 0; offset < rows.length; offset += 99) {
        const batch = rows.slice(offset, offset + 99);
        await client.send(
          new TransactWriteCommand({
            TransactItems: [
              {
                ConditionCheck: {
                  TableName: tables.control,
                  Key: controlKey,
                  ConditionExpression: "ActiveDataVersion = :active",
                  ExpressionAttributeValues: { ":active": active },
                },
              },
              ...batch.map((row) => ({
                Delete: {
                  TableName,
                  Key: { [id]: row[id] },
                  // Also reject replaced/misidentified rows. Missing rows allow idempotent retries.
                  ConditionExpression:
                    "attribute_not_exists(#id) OR (DataVersion = :version AND billing_period_id = :bp)",
                  ExpressionAttributeNames: { "#id": id },
                  ExpressionAttributeValues: {
                    ":version": row.DataVersion,
                    ":bp": billingPeriodId,
                  },
                },
              })),
            ],
          }),
        );
        deleted += batch.length;
      }
    } while (cursor);
  }
  return { ...plan, deleted };
}
