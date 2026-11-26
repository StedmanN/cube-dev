import {
  CreateTableCommand,
  DescribeTableCommand,
  DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
import { createConnection } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { TABLE_DEFINITIONS } from "./dynamodb-local-table-definitions.mjs";

const LOCAL_ENDPOINT = "http://127.0.0.1:8000";
const LOCAL_HOST = "127.0.0.1";
const LOCAL_PORT = 8000;
const APPLY_FLAG = "--apply";

function schemaSummary(definition) {
  const types = new Map(
    definition.AttributeDefinitions.map(({ AttributeName, AttributeType }) => [
      AttributeName,
      AttributeType,
    ]),
  );
  const primary = definition.KeySchema.map(
    ({ AttributeName, KeyType }) => `${KeyType}:${AttributeName}(${types.get(AttributeName)})`,
  ).join(", ");
  const indexes = (definition.GlobalSecondaryIndexes ?? [])
    .map(
      (index) =>
        `${index.IndexName}[${index.KeySchema.map(
          ({ AttributeName, KeyType }) =>
            `${KeyType}:${AttributeName}(${types.get(AttributeName)})`,
        ).join(", ")}]`,
    )
    .join(", ");
  return `${definition.TableName}: ${primary}${indexes ? `; GSI ${indexes}` : ""}`;
}

function keySignature(schema = []) {
  return schema
    .map(({ AttributeName, KeyType }) => `${KeyType}:${AttributeName}`)
    .sort()
    .join("|");
}

function validateExistingTable(definition, actual) {
  const errors = [];
  const expectedTypes = new Map(
    definition.AttributeDefinitions.map(({ AttributeName, AttributeType }) => [
      AttributeName,
      AttributeType,
    ]),
  );
  const actualTypes = new Map(
    (actual.AttributeDefinitions ?? []).map(({ AttributeName, AttributeType }) => [
      AttributeName,
      AttributeType,
    ]),
  );

  if (keySignature(actual.KeySchema) !== keySignature(definition.KeySchema)) {
    errors.push(
      `primary key is ${keySignature(actual.KeySchema)}, expected ${keySignature(definition.KeySchema)}`,
    );
  }

  for (const [attributeName, expectedType] of expectedTypes) {
    if (actualTypes.get(attributeName) !== expectedType) {
      errors.push(
        `key attribute ${attributeName} is ${actualTypes.get(attributeName) ?? "missing"}, expected ${expectedType}`,
      );
    }
  }

  for (const expected of definition.GlobalSecondaryIndexes ?? []) {
    const found = (actual.GlobalSecondaryIndexes ?? []).find(
      ({ IndexName }) => IndexName === expected.IndexName,
    );
    if (!found) {
      errors.push(`missing GSI ${expected.IndexName}`);
      continue;
    }
    if (keySignature(found.KeySchema) !== keySignature(expected.KeySchema)) {
      errors.push(
        `GSI ${expected.IndexName} is ${keySignature(found.KeySchema)}, expected ${keySignature(expected.KeySchema)}`,
      );
    }
  }

  if (errors.length > 0) {
    throw new Error(
      `Existing local table ${definition.TableName} has an incompatible schema: ${errors.join("; ")}`,
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
          `DynamoDB Local is unavailable at ${LOCAL_ENDPOINT}. No tables were created.`,
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
      // DynamoDB Local accepts dummy credentials, but its access-key ID must
      // contain only ASCII letters and digits.
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
          `Blocked unsafe DynamoDB request to ${protocol}//${hostname}:${port}. ` +
            `Only ${LOCAL_ENDPOINT} is allowed.`,
        );
      }
      return next(args);
    },
    {
      name: "createTablesLocalHttpGuard",
      step: "finalizeRequest",
      priority: "high",
    },
  );

  return client;
}

async function describeIfPresent(client, TableName) {
  try {
    return (await client.send(new DescribeTableCommand({ TableName }))).Table ?? null;
  } catch (error) {
    if (error?.name === "ResourceNotFoundException") return null;
    throw error;
  }
}

async function waitForActive(client, TableName) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const tableDescription = await describeIfPresent(client, TableName);
    if (tableDescription?.TableStatus === "ACTIVE") return tableDescription;
    await delay(100);
  }
  throw new Error(`Local table ${TableName} did not become ACTIVE.`);
}

async function main() {
  console.log(`CUBE DynamoDB Local schema (${TABLE_DEFINITIONS.length} tables):`);
  for (const definition of TABLE_DEFINITIONS) {
    console.log(`- ${schemaSummary(definition)}`);
  }

  if (!process.argv.includes(APPLY_FLAG)) {
    console.log(
      `\nDry plan only. No network connection was made and no tables were created. ` +
        `After explicit approval, run this script with ${APPLY_FLAG}.`,
    );
    return;
  }

  await assertLocalPortAvailable();
  const client = localClient();
  let created = 0;
  let existing = 0;

  try {
    for (const definition of TABLE_DEFINITIONS) {
      const current = await describeIfPresent(client, definition.TableName);
      if (current) {
        validateExistingTable(definition, current);
        console.log(`EXISTS ${definition.TableName} (compatible)`);
        existing += 1;
        continue;
      }

      await client.send(new CreateTableCommand(definition));
      await waitForActive(client, definition.TableName);
      console.log(`CREATED ${definition.TableName}`);
      created += 1;
    }
  } finally {
    client.destroy();
  }

  console.log(`Done: ${created} created, ${existing} already existed and were compatible.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
