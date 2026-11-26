import {
  CreateTableCommand,
  DeleteTableCommand,
  DescribeTableCommand,
  DynamoDBClient,
  ScanCommand,
} from "@aws-sdk/client-dynamodb";
import { createConnection } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { TABLE_DEFINITIONS } from "./dynamodb-local-table-definitions.mjs";

const LOCAL_ENDPOINT = "http://127.0.0.1:8000";
const LOCAL_HOST = "127.0.0.1";
const LOCAL_PORT = 8000;
const TARGET_TABLE = "p72-CUBE-METER-MAPPINGS";
const APPLY_FLAG = "--apply";
const NO_WRITERS_FLAG = "--confirm-no-writers";
const ALLOWED_COMMANDS = new Set([
  "CreateTableCommand",
  "DeleteTableCommand",
  "DescribeTableCommand",
  "ScanCommand",
]);

const targetDefinition = TABLE_DEFINITIONS.find(
  ({ TableName }) => TableName === TARGET_TABLE,
);

if (!targetDefinition) {
  throw new Error(`Missing local table definition for ${TARGET_TABLE}.`);
}

function keySignature(schema = []) {
  return schema
    .map(({ AttributeName, KeyType }) => `${KeyType}:${AttributeName}`)
    .sort()
    .join("|");
}

function attributeSignature(definitions = []) {
  return definitions
    .map(({ AttributeName, AttributeType }) => `${AttributeName}:${AttributeType}`)
    .sort()
    .join("|");
}

function schemaMatches(actual, expected) {
  return (
    keySignature(actual.KeySchema) === keySignature(expected.KeySchema) &&
    attributeSignature(actual.AttributeDefinitions) ===
      attributeSignature(expected.AttributeDefinitions) &&
    (actual.GlobalSecondaryIndexes ?? []).length ===
      (expected.GlobalSecondaryIndexes ?? []).length &&
    (actual.LocalSecondaryIndexes ?? []).length === 0
  );
}

function assertTargetDefinition() {
  const expectedKey = "HASH:source_meterid|RANGE:source_facility_nbr";
  const expectedAttributes = "source_facility_nbr:S|source_meterid:S";
  if (
    keySignature(targetDefinition.KeySchema) !== expectedKey ||
    attributeSignature(targetDefinition.AttributeDefinitions) !== expectedAttributes
  ) {
    throw new Error(
      `${TARGET_TABLE} definition is not the reviewed composite string-key schema.`,
    );
  }
}

async function assertLocalPortAvailable() {
  await new Promise((resolve, reject) => {
    const socket = createConnection({ host: LOCAL_HOST, port: LOCAL_PORT });
    const fail = (cause) => {
      socket.destroy();
      reject(
        new Error(
          `DynamoDB Local is unavailable at ${LOCAL_ENDPOINT}. No table was changed.`,
          { cause },
        ),
      );
    };

    socket.setTimeout(750, () => fail(new Error("connection timed out")));
    socket.once("error", fail);
    socket.once("connect", () => {
      socket.removeListener("error", fail);
      socket.end();
      resolve();
    });
  });
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
    (next, context) => async (args) => {
      if (!ALLOWED_COMMANDS.has(context.commandName)) {
        throw new Error(`Blocked unexpected command ${context.commandName ?? "unknown"}.`);
      }
      if (args.input?.TableName !== TARGET_TABLE) {
        throw new Error(
          `Blocked operation on ${args.input?.TableName ?? "an unspecified table"}; ` +
            `only ${TARGET_TABLE} is allowed.`,
        );
      }
      return next(args);
    },
    {
      name: "meterMappingsSingleTableGuard",
      step: "initialize",
      priority: "high",
    },
  );

  client.middlewareStack.add(
    (next) => async (args) => {
      const { protocol, hostname, port } = args.request;
      if (
        protocol !== "http:" ||
        hostname !== LOCAL_HOST ||
        Number(port) !== LOCAL_PORT
      ) {
        throw new Error(
          `Blocked unsafe DynamoDB destination ${protocol}//${hostname}:${port ?? ""}. ` +
            `Only ${LOCAL_ENDPOINT} is allowed.`,
        );
      }
      return next(args);
    },
    {
      name: "meterMappingsLoopbackGuard",
      step: "finalizeRequest",
      priority: "high",
    },
  );

  return client;
}

async function describeIfPresent(client) {
  try {
    return (
      await client.send(new DescribeTableCommand({ TableName: TARGET_TABLE }))
    ).Table;
  } catch (error) {
    if (error?.name === "ResourceNotFoundException") return null;
    throw error;
  }
}

async function assertTableEmpty(client) {
  let ExclusiveStartKey;
  let count = 0;

  do {
    const result = await client.send(
      new ScanCommand({
        TableName: TARGET_TABLE,
        ConsistentRead: true,
        Select: "COUNT",
        ExclusiveStartKey,
      }),
    );
    count += result.Count ?? 0;
    if (count > 0) {
      throw new Error(
        `Refusing to delete ${TARGET_TABLE}: a consistent local scan found ${count} item(s).`,
      );
    }
    ExclusiveStartKey = result.LastEvaluatedKey;
  } while (ExclusiveStartKey);

  console.log(`EMPTY ${TARGET_TABLE}: consistent scan found 0 items`);
}

async function waitUntilDeleted(client) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (!(await describeIfPresent(client))) return;
    await delay(100);
  }
  throw new Error(`Timed out waiting for local table ${TARGET_TABLE} to be deleted.`);
}

async function waitUntilActive(client) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const description = await describeIfPresent(client);
    if (description?.TableStatus === "ACTIVE") return description;
    await delay(100);
  }
  throw new Error(`Timed out waiting for local table ${TARGET_TABLE} to become active.`);
}

async function main() {
  assertTargetDefinition();
  console.log(`DynamoDB Local endpoint: ${LOCAL_ENDPOINT}`);
  console.log(`Only permitted table: ${TARGET_TABLE}`);
  console.log("Required schema: HASH source_meterid (S), RANGE source_facility_nbr (S)");

  if (!process.argv.includes(APPLY_FLAG)) {
    console.log(
      `Dry plan only. No network connection was made. Stop all local writers, then add ` +
        `${APPLY_FLAG} ${NO_WRITERS_FLAG} after review.`,
    );
    return;
  }
  if (!process.argv.includes(NO_WRITERS_FLAG)) {
    throw new Error(
      `Refusing repair without ${NO_WRITERS_FLAG}. Stop the test application and ` +
        "every process that can write to DynamoDB Local before retrying.",
    );
  }

  await assertLocalPortAvailable();
  const client = localClient();

  try {
    const current = await describeIfPresent(client);
    if (!current) {
      throw new Error(
        `Refusing repair because ${TARGET_TABLE} does not exist. No table was changed.`,
      );
    }
    if (schemaMatches(current, targetDefinition)) {
      console.log(`${TARGET_TABLE} already has the reviewed schema; no change was made.`);
      return;
    }

    await assertTableEmpty(client);
    await client.send(new DeleteTableCommand({ TableName: TARGET_TABLE }));
    await waitUntilDeleted(client);
    console.log(`DELETED ${TARGET_TABLE}`);

    await client.send(new CreateTableCommand(targetDefinition));
    const recreated = await waitUntilActive(client);
    if (!schemaMatches(recreated, targetDefinition)) {
      throw new Error(`${TARGET_TABLE} was recreated with an unexpected schema.`);
    }
    console.log(`RECREATED ${TARGET_TABLE} with the reviewed composite string key`);
  } finally {
    client.destroy();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
