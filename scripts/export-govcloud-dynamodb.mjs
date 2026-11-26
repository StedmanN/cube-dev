import {
  DescribeTableCommand,
  DynamoDBClient,
  ScanCommand,
} from "@aws-sdk/client-dynamodb";
import { fromIni } from "@aws-sdk/credential-provider-ini";
import { createHash } from "node:crypto";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { once } from "node:events";
import { resolve, sep } from "node:path";
import {
  TABLE_DEFINITIONS,
  TABLE_NAMES,
} from "./dynamodb-local-table-definitions.mjs";

const GOVCLOUD_REGION = "us-gov-west-1";
const GOVCLOUD_ENDPOINT = "https://dynamodb.us-gov-west-1.amazonaws.com";
const LOCAL_REGION = "us-east-1";
const LOCAL_ENDPOINT = "http://127.0.0.1:8000";
const LOCAL_CREDENTIALS = {
  accessKeyId: "DUMMYLOCALACCESSKEY",
  secretAccessKey: "DUMMYLOCALSECRETKEY",
};
const EXPORT_FLAG = "--export";
const PREFLIGHT_FLAG = "--preflight";
const PREFLIGHT_PROFILE = "govcloud";
const MINIMUM_NODE_MAJOR = 20;
const REQUIRED_PACKAGES = [
  "@aws-sdk/client-dynamodb",
  "@aws-sdk/credential-provider-ini",
];
const EXCLUDED_BILLING_PERIOD_ID = 175; // February FY2026
const REQUIRED_METER_READING_PERIODS = [163, 172, 173, 174, 175];
const FORBIDDEN_ATTRIBUTE_NAME =
  /aws.?access.?key|secret.?access.?key|session.?token|private.?key|client.?secret|credential/i;
const AWS_ACCESS_KEY_VALUE = /^(?:AKIA|ASIA)[A-Z0-9]{16}$/;

const EXCLUDED_PERIOD_TABLES = new Set([
  "p72-CUBE-MONTHLY-RECONCILIATION",
  "p72-CUBE-RCBL-SHORT",
  "p72-CUBE-RCBL-SHORT-HISTORY",
]);

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function defaultOutputDirectory() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return resolve(".cube-data", `govcloud-export-${timestamp}`);
}

function safeOutputDirectory() {
  const dataRoot = resolve(".cube-data");
  const output = resolve(argument("--output") ?? defaultOutputDirectory());
  if (output !== dataRoot && !output.startsWith(`${dataRoot}${sep}`)) {
    throw new Error(`Export output must remain inside ${dataRoot}.`);
  }
  if (existsSync(output)) {
    throw new Error(`Export output already exists: ${output}`);
  }
  return output;
}

function assertCredentialInputs(profile) {
  if (!profile) {
    throw new Error("--profile is required. Use a dedicated read-only GovCloud profile.");
  }
  const credentialVariables = [
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "AWS_WEB_IDENTITY_TOKEN_FILE",
    "AWS_ROLE_ARN",
  ];
  const present = credentialVariables.filter((name) => process.env[name]);
  if (present.length > 0) {
    throw new Error(
      `Refusing environment credentials (${present.join(", ")}). ` +
        "Unset them and use the explicitly named read-only --profile.",
    );
  }
}

function verifyDependencies() {
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  const missing = [];

  for (const packageName of REQUIRED_PACKAGES) {
    try {
      import.meta.resolve(packageName);
    } catch {
      missing.push(packageName);
    }
  }

  if (!Number.isInteger(nodeMajor) || nodeMajor < MINIMUM_NODE_MAJOR) {
    throw new Error(
      `Node.js ${MINIMUM_NODE_MAJOR}+ is required; found ${process.versions.node}.`,
    );
  }
  if (missing.length > 0) {
    throw new Error(
      `Missing Node.js dependencies: ${missing.join(", ")}. Run npm ci before preflight.`,
    );
  }

  console.log(`DEPENDENCIES OK Node.js ${process.versions.node}`);
  for (const packageName of REQUIRED_PACKAGES) {
    console.log(`DEPENDENCIES OK ${packageName}`);
  }
}

function readOnlyClient(profile, { describeOnly = false } = {}) {
  const client = new DynamoDBClient({
    endpoint: GOVCLOUD_ENDPOINT,
    region: GOVCLOUD_REGION,
    credentials: fromIni({ profile }),
    maxAttempts: 2,
  });

  if (describeOnly) {
    client.middlewareStack.add(
      (next, context) => async (args) => {
        if (context.commandName !== "DescribeTableCommand") {
          throw new Error(
            `Preflight blocked non-DescribeTable operation ${context.commandName ?? "unknown"}.`,
          );
        }
        return next(args);
      },
      {
        name: "govCloudDescribeTableOnlyGuard",
        step: "initialize",
        priority: "high",
      },
    );
  }

  client.middlewareStack.add(
    (next) => async (args) => {
      const { protocol, hostname, port } = args.request;
      if (
        protocol !== "https:" ||
        hostname !== "dynamodb.us-gov-west-1.amazonaws.com" ||
        (port !== undefined && port !== 443)
      ) {
        throw new Error(
          `Blocked unexpected export destination ${protocol}//${hostname}:${port ?? ""}.`,
        );
      }
      return next(args);
    },
    { name: "govCloudReadOnlyExportGuard", step: "finalizeRequest", priority: "high" },
  );

  return client;
}

function localDescribeOnlyClient() {
  const client = new DynamoDBClient({
    endpoint: LOCAL_ENDPOINT,
    region: LOCAL_REGION,
    credentials: LOCAL_CREDENTIALS,
    maxAttempts: 1,
  });

  client.middlewareStack.add(
    (next, context) => async (args) => {
      if (context.commandName !== "DescribeTableCommand") {
        throw new Error(
          `Local preflight blocked non-DescribeTable operation ${context.commandName ?? "unknown"}.`,
        );
      }
      return next(args);
    },
    {
      name: "localDescribeTableOnlyGuard",
      step: "initialize",
      priority: "high",
    },
  );

  client.middlewareStack.add(
    (next) => async (args) => {
      const { protocol, hostname, port } = args.request;
      if (protocol !== "http:" || hostname !== "127.0.0.1" || Number(port) !== 8000) {
        throw new Error(
          `Blocked unexpected local preflight destination ${protocol}//${hostname}:${port ?? ""}.`,
        );
      }
      return next(args);
    },
    { name: "localPreflightLoopbackGuard", step: "finalizeRequest", priority: "high" },
  );

  return client;
}

function keySignature(schema = []) {
  return schema
    .map(({ AttributeName, KeyType }) => `${KeyType}:${AttributeName}`)
    .sort()
    .join("|");
}

function attributeTypes(definitions = []) {
  return new Map(
    definitions.map(({ AttributeName, AttributeType }) => [
      AttributeName,
      AttributeType,
    ]),
  );
}

function indexMap(indexes = []) {
  return new Map(indexes.map((index) => [index.IndexName, index]));
}

function projectionSignature(projection = {}) {
  return JSON.stringify({
    ProjectionType: projection.ProjectionType ?? null,
    NonKeyAttributes: [...(projection.NonKeyAttributes ?? [])].sort(),
  });
}

function compareSchema(reference, candidate, referenceLabel, candidateLabel) {
  const mismatches = [];
  const referenceKey = keySignature(reference.KeySchema);
  const candidateKey = keySignature(candidate.KeySchema);
  if (referenceKey !== candidateKey) {
    mismatches.push(
      `primary key ${referenceLabel} ${referenceKey}, ${candidateLabel} ${candidateKey}`,
    );
  }

  const referenceTypes = attributeTypes(reference.AttributeDefinitions);
  const candidateTypes = attributeTypes(candidate.AttributeDefinitions);
  const referenceAttributes = [...referenceTypes.keys()].sort();
  const candidateAttributes = [...candidateTypes.keys()].sort();
  if (JSON.stringify(referenceAttributes) !== JSON.stringify(candidateAttributes)) {
    mismatches.push(
      `key/index attributes ${referenceLabel} [${referenceAttributes.join(", ")}], ` +
        `${candidateLabel} [${candidateAttributes.join(", ")}]`,
    );
  }
  for (const [name, referenceType] of referenceTypes) {
    const candidateType = candidateTypes.get(name);
    if (candidateType !== referenceType) {
      mismatches.push(
        `attribute ${name} ${referenceLabel} type ${referenceType}, ` +
          `${candidateLabel} ${candidateType ?? "missing"}`,
      );
    }
  }
  for (const [name, candidateType] of candidateTypes) {
    if (!referenceTypes.has(name)) {
      mismatches.push(
        `attribute ${name} ${referenceLabel} missing, ` +
          `${candidateLabel} type ${candidateType}`,
      );
    }
  }

  const referenceIndexes = indexMap(reference.GlobalSecondaryIndexes);
  const candidateIndexes = indexMap(candidate.GlobalSecondaryIndexes);
  const referenceIndexNames = [...referenceIndexes.keys()].sort();
  const candidateIndexNames = [...candidateIndexes.keys()].sort();
  if (JSON.stringify(referenceIndexNames) !== JSON.stringify(candidateIndexNames)) {
    mismatches.push(
      `GSI names ${referenceLabel} [${referenceIndexNames.join(", ")}], ` +
        `${candidateLabel} [${candidateIndexNames.join(", ")}]`,
    );
  }
  for (const [name, referenceIndex] of referenceIndexes) {
    const candidateIndex = candidateIndexes.get(name);
    if (!candidateIndex) continue;

    const referenceIndexKey = keySignature(referenceIndex.KeySchema);
    const candidateIndexKey = keySignature(candidateIndex.KeySchema);
    if (referenceIndexKey !== candidateIndexKey) {
      mismatches.push(
        `GSI ${name} key ${referenceLabel} ${referenceIndexKey}, ` +
          `${candidateLabel} ${candidateIndexKey}`,
      );
    }

    const referenceProjection = projectionSignature(referenceIndex.Projection);
    const candidateProjection = projectionSignature(candidateIndex.Projection);
    if (referenceProjection !== candidateProjection) {
      mismatches.push(
        `GSI ${name} projection ${referenceLabel} ${referenceProjection}, ` +
          `${candidateLabel} ${candidateProjection}`,
      );
    }
  }

  const referenceLocalIndexes = indexMap(reference.LocalSecondaryIndexes);
  const candidateLocalIndexes = indexMap(candidate.LocalSecondaryIndexes);
  const referenceLocalIndexNames = [...referenceLocalIndexes.keys()].sort();
  const candidateLocalIndexNames = [...candidateLocalIndexes.keys()].sort();
  if (JSON.stringify(referenceLocalIndexNames) !== JSON.stringify(candidateLocalIndexNames)) {
    mismatches.push(
      `LSI names ${referenceLabel} [${referenceLocalIndexNames.join(", ")}], ` +
        `${candidateLabel} [${candidateLocalIndexNames.join(", ")}]`,
    );
  }

  return mismatches;
}

function formatBytes(value) {
  const bytes = Number(value ?? 0);
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  const unitIndex = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  );
  return `${(bytes / 1024 ** unitIndex).toFixed(unitIndex === 0 ? 0 : 2)} ${units[unitIndex]}`;
}

async function runSchemaPreflight() {
  const suppliedProfile = argument("--profile");
  if (suppliedProfile && suppliedProfile !== PREFLIGHT_PROFILE) {
    throw new Error(
      `Preflight requires the ${PREFLIGHT_PROFILE} AWS profile; received ${suppliedProfile}.`,
    );
  }
  const profile = PREFLIGHT_PROFILE;
  assertCredentialInputs(profile);
  verifyDependencies();

  console.log("CUBE GovCloud schema preflight (DescribeTable only):");
  console.log(`- Profile: ${profile}`);
  console.log(`- Region: ${GOVCLOUD_REGION}`);
  console.log(`- AWS endpoint: ${GOVCLOUD_ENDPOINT}`);
  console.log(`- Local endpoint: ${LOCAL_ENDPOINT}`);
  console.log(`- Local creation definitions: ${TABLE_DEFINITIONS.length}`);

  const awsClient = readOnlyClient(profile, { describeOnly: true });
  const localClient = localDescribeOnlyClient();
  let approximateItems = 0;
  let approximateBytes = 0;
  let mismatchedTableCount = 0;

  try {
    for (const expected of TABLE_DEFINITIONS) {
      let production;
      let local;
      try {
        production = (
          await awsClient.send(
            new DescribeTableCommand({ TableName: expected.TableName }),
          )
        ).Table;
      } catch (error) {
        if (error?.name === "ResourceNotFoundException") {
          mismatchedTableCount += 1;
          console.error(`MISMATCH ${expected.TableName}: production table is missing`);
          continue;
        }
        throw error;
      }

      try {
        local = (
          await localClient.send(
            new DescribeTableCommand({ TableName: expected.TableName }),
          )
        ).Table;
      } catch (error) {
        if (error?.name === "ResourceNotFoundException") {
          mismatchedTableCount += 1;
          console.error(`MISMATCH ${expected.TableName}: local table is missing`);
          continue;
        }
        throw error;
      }

      if (!production || !local) {
        mismatchedTableCount += 1;
        console.error(
          `MISMATCH ${expected.TableName}: DescribeTable returned no ` +
            `${!production ? "production" : "local"} schema`,
        );
        continue;
      }

      const itemCount = Number(production.ItemCount ?? 0);
      const tableBytes = Number(production.TableSizeBytes ?? 0);
      approximateItems += itemCount;
      approximateBytes += tableBytes;
      const size = `approximately ${itemCount.toLocaleString("en-US")} items, ${formatBytes(tableBytes)} (${tableBytes.toLocaleString("en-US")} bytes)`;
      const productionVsLocal = compareSchema(local, production, "local", "production");
      const localVsDefinition = compareSchema(
        expected,
        local,
        "definition",
        "local",
      );
      const mismatches = [
        ...productionVsLocal.map((message) => `production vs local: ${message}`),
        ...localVsDefinition.map((message) => `local definition drift: ${message}`),
      ];

      if (mismatches.length === 0) {
        console.log(`MATCH ${expected.TableName}: ${size}`);
      } else {
        mismatchedTableCount += 1;
        console.error(`MISMATCH ${expected.TableName}: ${size}`);
        for (const mismatch of mismatches) console.error(`  - ${mismatch}`);
      }
    }
  } finally {
    awsClient.destroy();
    localClient.destroy();
  }

  console.log(
    `TOTAL approximately ${approximateItems.toLocaleString("en-US")} items, ` +
      `${formatBytes(approximateBytes)} (${approximateBytes.toLocaleString("en-US")} bytes)`,
  );
  if (mismatchedTableCount > 0) {
    console.error(
      `PREFLIGHT FAILED: ${mismatchedTableCount} table(s) have schema mismatches.`,
    );
    process.exitCode = 2;
    return;
  }
  console.log(
    `PREFLIGHT PASSED: all ${TABLE_DEFINITIONS.length} production schemas match ` +
      "the live DynamoDB Local tables and shared creation definitions.",
  );
}

function sanitizedSchema(description) {
  return {
    TableName: description.TableName,
    AttributeDefinitions: description.AttributeDefinitions ?? [],
    KeySchema: description.KeySchema ?? [],
    GlobalSecondaryIndexes: (description.GlobalSecondaryIndexes ?? []).map((index) => ({
      IndexName: index.IndexName,
      KeySchema: index.KeySchema ?? [],
      Projection: index.Projection,
    })),
  };
}

async function writeLine(stream, line) {
  if (!stream.write(line)) await once(stream, "drain");
}

function assertNoCredentialMaterial(attributeMap, path = "item") {
  for (const [name, value] of Object.entries(attributeMap ?? {})) {
    const attributePath = `${path}.${name}`;
    if (FORBIDDEN_ATTRIBUTE_NAME.test(name)) {
      throw new Error(`Refusing credential/secret-like attribute ${attributePath}.`);
    }
    if (value?.S && AWS_ACCESS_KEY_VALUE.test(value.S)) {
      throw new Error(`Refusing AWS access-key-like value at ${attributePath}.`);
    }
    if (value?.S && /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/.test(value.S)) {
      throw new Error(`Refusing private-key material at ${attributePath}.`);
    }
    if (value?.M) assertNoCredentialMaterial(value.M, attributePath);
    if (Array.isArray(value?.L)) {
      value.L.forEach((entry, index) => {
        if (entry?.M) assertNoCredentialMaterial(entry.M, `${attributePath}[${index}]`);
        if (entry?.S && AWS_ACCESS_KEY_VALUE.test(entry.S)) {
          throw new Error(`Refusing AWS access-key-like value at ${attributePath}[${index}].`);
        }
      });
    }
  }
}

async function exportTable(client, TableName, outputDirectory, dependencyCounts) {
  const description = (
    await client.send(new DescribeTableCommand({ TableName }))
  ).Table;
  if (!description) throw new Error(`DescribeTable returned no schema for ${TableName}.`);

  const tableDirectory = resolve(outputDirectory, TableName);
  mkdirSync(tableDirectory, { recursive: true });
  const schema = sanitizedSchema(description);
  writeFileSync(
    resolve(tableDirectory, "schema.json"),
    `${JSON.stringify(schema, null, 2)}\n`,
    { encoding: "utf8", flag: "wx" },
  );

  const itemsPath = resolve(tableDirectory, "items.ndjson");
  const stream = createWriteStream(itemsPath, { encoding: "utf8", flags: "wx" });
  const checksum = createHash("sha256");
  let ExclusiveStartKey;
  let itemCount = 0;
  let scannedCount = 0;
  let pageCount = 0;
  let bytes = 0;

  do {
    const excludePeriod = EXCLUDED_PERIOD_TABLES.has(TableName);
    const result = await client.send(
      new ScanCommand({
        TableName,
        ExclusiveStartKey,
        ...(excludePeriod
          ? {
              FilterExpression: "attribute_not_exists(#bp) OR #bp <> :excludedBp",
              ExpressionAttributeNames: { "#bp": "billing_period_id" },
              ExpressionAttributeValues: {
                ":excludedBp": { N: String(EXCLUDED_BILLING_PERIOD_ID) },
              },
            }
          : {}),
      }),
    );
    pageCount += 1;
    scannedCount += result.ScannedCount ?? 0;

    for (const item of result.Items ?? []) {
      assertNoCredentialMaterial(item, TableName);
      const line = `${JSON.stringify(item)}\n`;
      checksum.update(line);
      bytes += Buffer.byteLength(line);
      itemCount += 1;
      await writeLine(stream, line);

      if (TableName === "p72-CUBE-METER-READINGS") {
        const billingPeriodId = Number(item.billing_period_id?.N);
        if (Number.isInteger(billingPeriodId)) {
          dependencyCounts.set(
            billingPeriodId,
            (dependencyCounts.get(billingPeriodId) ?? 0) + 1,
          );
        }
      }
    }

    ExclusiveStartKey = result.LastEvaluatedKey;
  } while (ExclusiveStartKey);

  stream.end();
  await once(stream, "finish");

  return {
    tableName: TableName,
    sourceEstimatedItemCount: description.ItemCount ?? null,
    sourceEstimatedTableBytes: description.TableSizeBytes ?? null,
    itemCount,
    scannedCount,
    pageCount,
    ndjsonBytes: bytes,
    ndjsonSha256: checksum.digest("hex"),
    schema,
  };
}

function assertMeterDependencies(dependencyCounts) {
  const missing = REQUIRED_METER_READING_PERIODS.filter(
    (billingPeriodId) => (dependencyCounts.get(billingPeriodId) ?? 0) === 0,
  );
  if (missing.length > 0) {
    throw new Error(
      `Meter-reading export is missing required billing period(s): ${missing.join(", ")}.`,
    );
  }
}

async function main() {
  const preflightRequested = process.argv.includes(PREFLIGHT_FLAG);
  const exportRequested = process.argv.includes(EXPORT_FLAG);
  if (preflightRequested && exportRequested) {
    throw new Error(`${PREFLIGHT_FLAG} and ${EXPORT_FLAG} cannot be used together.`);
  }
  if (preflightRequested) {
    await runSchemaPreflight();
    return;
  }

  console.log("CUBE GovCloud export plan (read-only):");
  console.log(`- Region: ${GOVCLOUD_REGION}`);
  console.log(`- Endpoint: ${GOVCLOUD_ENDPOINT}`);
  console.log(`- Tables: ${TABLE_NAMES.length}`);
  console.log(
    `- Exclusion: billing_period_id ${EXCLUDED_BILLING_PERIOD_ID} from ${[
      ...EXCLUDED_PERIOD_TABLES,
    ].join(", ")}`,
  );
  console.log(`- Required meter-reading periods: ${REQUIRED_METER_READING_PERIODS.join(", ")}`);

  if (!exportRequested) {
    console.log("Plan only. No AWS connection was made. Add --export after review.");
    return;
  }

  const profile = argument("--profile");
  assertCredentialInputs(profile);
  const outputDirectory = safeOutputDirectory();
  mkdirSync(outputDirectory, { recursive: true });
  const client = readOnlyClient(profile);
  const dependencyCounts = new Map();
  const tables = [];

  try {
    for (const TableName of TABLE_NAMES) {
      const result = await exportTable(
        client,
        TableName,
        outputDirectory,
        dependencyCounts,
      );
      tables.push(result);
      console.log(
        `EXPORTED ${TableName}: ${result.itemCount} items, ${result.ndjsonBytes} bytes`,
      );
    }
  } finally {
    client.destroy();
  }

  assertMeterDependencies(dependencyCounts);
  const manifest = {
    formatVersion: 1,
    exportedAt: new Date().toISOString(),
    source: {
      service: "DynamoDB",
      partition: "aws-us-gov",
      region: GOVCLOUD_REGION,
      endpoint: GOVCLOUD_ENDPOINT,
    },
    dataFormat: "DynamoDB AttributeValue JSON, one item per line",
    exclusions: [
      {
        billingPeriodId: EXCLUDED_BILLING_PERIOD_ID,
        tables: [...EXCLUDED_PERIOD_TABLES],
        reason: "Exclude incorrect February FY2026 saved reconciliation and billing records",
      },
    ],
    meterReadingDependencies: Object.fromEntries(
      [...dependencyCounts.entries()]
        .filter(([billingPeriodId]) => REQUIRED_METER_READING_PERIODS.includes(billingPeriodId))
        .sort(([left], [right]) => left - right),
    ),
    tables,
  };
  writeFileSync(
    resolve(outputDirectory, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { encoding: "utf8", flag: "wx" },
  );
  console.log(`Manifest written to ${resolve(outputDirectory, "manifest.json")}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
