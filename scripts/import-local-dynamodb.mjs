import {
  BatchWriteItemCommand,
  DescribeTableCommand,
  DynamoDBClient,
  ScanCommand,
} from "@aws-sdk/client-dynamodb";
import { createHash } from "node:crypto";
import { createReadStream, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { TABLE_NAMES } from "./dynamodb-local-table-definitions.mjs";

const LOCAL_ENDPOINT = "http://127.0.0.1:8000";
const LOCAL_HOST = "127.0.0.1";
const LOCAL_PORT = 8000;
const EXCLUDED_BILLING_PERIOD_ID = "175";
const REQUIRED_METER_READING_PERIODS = [163, 172, 173, 174, 175];
const EXCLUDED_PERIOD_TABLES = new Set([
  "p72-CUBE-MONTHLY-RECONCILIATION",
  "p72-CUBE-RCBL-SHORT",
  "p72-CUBE-RCBL-SHORT-HISTORY",
]);

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function safeSourceDirectory() {
  const supplied = argument("--source");
  if (!supplied) throw new Error("--source is required.");
  const dataRoot = resolve(".cube-data");
  const source = resolve(supplied);
  if (source !== dataRoot && !source.startsWith(`${dataRoot}${sep}`)) {
    throw new Error(`Import source must remain inside ${dataRoot}.`);
  }
  return source;
}

function localClient() {
  const client = new DynamoDBClient({
    endpoint: LOCAL_ENDPOINT,
    region: "local",
    credentials: {
      accessKeyId: "DUMMYLOCALACCESSKEY",
      secretAccessKey: "DUMMYLOCALSECRETKEY",
    },
    maxAttempts: 1,
  });

  client.middlewareStack.add(
    (next) => async (args) => {
      const { protocol, hostname, port } = args.request;
      if (protocol !== "http:" || hostname !== LOCAL_HOST || port !== LOCAL_PORT) {
        throw new Error(
          `Blocked unsafe import destination ${protocol}//${hostname}:${port}. ` +
            `Only ${LOCAL_ENDPOINT} is allowed.`,
        );
      }
      return next(args);
    },
    { name: "localImportHttpGuard", step: "finalizeRequest", priority: "high" },
  );

  return client;
}

async function forEachItem(filePath, callback) {
  const input = createReadStream(filePath, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  let lineNumber = 0;
  for await (const line of lines) {
    lineNumber += 1;
    if (!line.trim()) continue;
    let item;
    try {
      item = JSON.parse(line);
    } catch (cause) {
      throw new Error(`Invalid JSON at ${filePath}:${lineNumber}.`, { cause });
    }
    await callback(item, lineNumber);
  }
}

async function fileDigest(filePath) {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
    bytes += chunk.length;
  }
  return { sha256: hash.digest("hex"), bytes };
}

function assertManifest(manifest) {
  if (manifest.formatVersion !== 1) {
    throw new Error(`Unsupported manifest formatVersion ${manifest.formatVersion}.`);
  }
  if (
    manifest.source?.partition !== "aws-us-gov" ||
    manifest.source?.region !== "us-gov-west-1" ||
    manifest.source?.endpoint !== "https://dynamodb.us-gov-west-1.amazonaws.com"
  ) {
    throw new Error("Manifest is not the expected CUBE GovCloud export format.");
  }
  if (!Array.isArray(manifest.tables) || manifest.tables.length !== 20) {
    throw new Error("Manifest must contain exactly 20 CUBE tables.");
  }
  const names = manifest.tables.map((table) => table.tableName);
  if (new Set(names).size !== names.length) {
    throw new Error("Manifest contains duplicate table names.");
  }
  const expectedNames = [...TABLE_NAMES].sort();
  const actualNames = [...names].sort();
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
    throw new Error("Manifest table names do not match the exact CUBE table whitelist.");
  }
  for (const table of manifest.tables) {
    if (table.schema?.TableName !== table.tableName) {
      throw new Error(`Manifest schema/table mismatch for ${table.tableName}.`);
    }
  }
}

async function verifyExport(sourceDirectory, manifest) {
  const dependencyCounts = new Map();
  for (const table of manifest.tables) {
    const filePath = resolve(sourceDirectory, table.tableName, "items.ndjson");
    const digest = await fileDigest(filePath);
    if (digest.sha256 !== table.ndjsonSha256 || digest.bytes !== table.ndjsonBytes) {
      throw new Error(`Checksum or byte-count mismatch for ${table.tableName}.`);
    }

    let itemCount = 0;
    await forEachItem(filePath, (item, lineNumber) => {
      itemCount += 1;
      if (
        EXCLUDED_PERIOD_TABLES.has(table.tableName) &&
        item.billing_period_id?.N === EXCLUDED_BILLING_PERIOD_ID
      ) {
        throw new Error(
          `${table.tableName} contains excluded billing period 175 at line ${lineNumber}.`,
        );
      }
      if (table.tableName === "p72-CUBE-METER-READINGS") {
        const billingPeriodId = Number(item.billing_period_id?.N);
        if (Number.isInteger(billingPeriodId)) {
          dependencyCounts.set(
            billingPeriodId,
            (dependencyCounts.get(billingPeriodId) ?? 0) + 1,
          );
        }
      }
    });
    if (itemCount !== table.itemCount) {
      throw new Error(
        `Item-count mismatch for ${table.tableName}: found ${itemCount}, expected ${table.itemCount}.`,
      );
    }
  }

  for (const billingPeriodId of REQUIRED_METER_READING_PERIODS) {
    const actual = dependencyCounts.get(billingPeriodId) ?? 0;
    const recorded = Number(manifest.meterReadingDependencies?.[billingPeriodId] ?? 0);
    if (actual === 0 || recorded !== actual) {
      throw new Error(
        `Meter-reading dependency ${billingPeriodId} is missing or does not match the manifest.`,
      );
    }
  }
}

function keySignature(schema = []) {
  return schema
    .map(({ AttributeName, KeyType }) => `${KeyType}:${AttributeName}`)
    .sort()
    .join("|");
}

function assertCompatibleSchema(exported, local) {
  if (keySignature(exported.KeySchema) !== keySignature(local.KeySchema)) {
    throw new Error(
      `${exported.TableName} primary-key mismatch: export ${keySignature(exported.KeySchema)}, ` +
        `local ${keySignature(local.KeySchema)}.`,
    );
  }
  const exportedTypes = new Map(
    (exported.AttributeDefinitions ?? []).map(({ AttributeName, AttributeType }) => [
      AttributeName,
      AttributeType,
    ]),
  );
  const localTypes = new Map(
    (local.AttributeDefinitions ?? []).map(({ AttributeName, AttributeType }) => [
      AttributeName,
      AttributeType,
    ]),
  );
  for (const [name, type] of exportedTypes) {
    if (localTypes.get(name) !== type) {
      throw new Error(
        `${exported.TableName} key type mismatch for ${name}: export ${type}, ` +
          `local ${localTypes.get(name) ?? "missing"}.`,
      );
    }
  }
  for (const exportedIndex of exported.GlobalSecondaryIndexes ?? []) {
    const localIndex = (local.GlobalSecondaryIndexes ?? []).find(
      ({ IndexName }) => IndexName === exportedIndex.IndexName,
    );
    if (!localIndex) {
      throw new Error(`${exported.TableName} is missing local GSI ${exportedIndex.IndexName}.`);
    }
    if (keySignature(exportedIndex.KeySchema) !== keySignature(localIndex.KeySchema)) {
      throw new Error(`${exported.TableName} GSI ${exportedIndex.IndexName} key mismatch.`);
    }
  }
}

async function assertEmpty(client, TableName) {
  const result = await client.send(new ScanCommand({ TableName, Limit: 1 }));
  if ((result.Items ?? []).length > 0) {
    throw new Error(
      `Local table ${TableName} is not empty. Import aborted before writing any table.`,
    );
  }
}

async function countItems(client, TableName) {
  let ExclusiveStartKey;
  let count = 0;
  do {
    const result = await client.send(
      new ScanCommand({ TableName, Select: "COUNT", ExclusiveStartKey }),
    );
    count += result.Count ?? 0;
    ExclusiveStartKey = result.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return count;
}

async function writeBatch(client, TableName, requests) {
  let pending = requests;
  for (let attempt = 0; pending.length > 0 && attempt < 8; attempt += 1) {
    const result = await client.send(
      new BatchWriteItemCommand({ RequestItems: { [TableName]: pending } }),
    );
    pending = result.UnprocessedItems?.[TableName] ?? [];
    if (pending.length > 0) await delay(Math.min(25 * 2 ** attempt, 500));
  }
  if (pending.length > 0) {
    throw new Error(`${TableName} still has ${pending.length} unprocessed writes.`);
  }
}

async function importTable(client, sourceDirectory, table) {
  const filePath = resolve(sourceDirectory, table.tableName, "items.ndjson");
  let batch = [];
  let imported = 0;
  await forEachItem(filePath, async (item) => {
    batch.push({ PutRequest: { Item: item } });
    if (batch.length === 25) {
      await writeBatch(client, table.tableName, batch);
      imported += batch.length;
      batch = [];
    }
  });
  if (batch.length > 0) {
    await writeBatch(client, table.tableName, batch);
    imported += batch.length;
  }
  return imported;
}

async function main() {
  if (!process.argv.includes("--verify") && !process.argv.includes("--import")) {
    console.log(
      "Plan only. Use --verify --source <.cube-data/export> for offline validation, " +
        "or --import after review. No connection was made.",
    );
    return;
  }

  const sourceDirectory = safeSourceDirectory();
  const manifest = JSON.parse(
    readFileSync(resolve(sourceDirectory, "manifest.json"), "utf8"),
  );
  assertManifest(manifest);
  await verifyExport(sourceDirectory, manifest);
  console.log("Export files, counts, checksums, and February exclusions verified.");

  if (!process.argv.includes("--import")) return;

  const client = localClient();
  try {
    // Complete every schema and emptiness check before the first local write.
    for (const table of manifest.tables) {
      const local = (
        await client.send(new DescribeTableCommand({ TableName: table.tableName }))
      ).Table;
      if (!local) throw new Error(`Local table ${table.tableName} was not found.`);
      assertCompatibleSchema(table.schema, local);
      await assertEmpty(client, table.tableName);
    }

    for (const table of manifest.tables) {
      const imported = await importTable(client, sourceDirectory, table);
      const localCount = await countItems(client, table.tableName);
      if (imported !== table.itemCount || localCount !== table.itemCount) {
        throw new Error(
          `${table.tableName} verification failed: imported ${imported}, ` +
            `local count ${localCount}, expected ${table.itemCount}.`,
        );
      }
      console.log(`IMPORTED ${table.tableName}: ${imported} items`);
    }
  } finally {
    client.destroy();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
