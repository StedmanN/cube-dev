import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

import { REAL_PROPERTY_INTEGRATION_TEST_NAMESPACE } from "@/lib/real-property-tables";

/**
 * TEST-COPY SAFETY BOUNDARY
 *
 * This checkout is intentionally locked to DynamoDB Local. These values must not
 * be read from the environment: an AWS profile, region, endpoint, or credential in
 * the invoking shell must never be able to redirect this client to AWS.
 */
export const DYNAMODB_LOCAL_ENDPOINT = "http://127.0.0.1:8000";

const localEndpoint = new URL(DYNAMODB_LOCAL_ENDPOINT);

if (
  localEndpoint.protocol !== "http:" ||
  localEndpoint.hostname !== "127.0.0.1" ||
  localEndpoint.port !== "8000"
) {
  throw new Error(
    "Unsafe DynamoDB endpoint: this TEST copy may use only http://127.0.0.1:8000.",
  );
}

const client = new DynamoDBClient({
  endpoint: DYNAMODB_LOCAL_ENDPOINT,
  region: "local",
  credentials: {
    accessKeyId: "DUMMYLOCALACCESSKEY",
    secretAccessKey: "DUMMYLOCALSECRETKEY",
  },
  // Fail quickly and visibly if DynamoDB Local is not running. The SDK must not
  // retry against, discover, or fall back to any AWS endpoint.
  maxAttempts: 1,
});

const isolatedRpTestNamespace = REAL_PROPERTY_INTEGRATION_TEST_NAMESPACE ?? "";

function commandTableNames(input: unknown): string[] {
  if (!input || typeof input !== "object") return [];
  const command = input as {
    TableName?: unknown;
    RequestItems?: Record<string, unknown>;
    TransactItems?: Array<Record<string, { TableName?: unknown }>>;
  };
  const names = new Set<string>();
  if (typeof command.TableName === "string") names.add(command.TableName);
  for (const name of Object.keys(command.RequestItems ?? {})) names.add(name);
  for (const transaction of command.TransactItems ?? []) {
    for (const operation of Object.values(transaction)) {
      if (typeof operation?.TableName === "string") names.add(operation.TableName);
    }
  }
  return [...names];
}

client.middlewareStack.add(
  (next) => async (args) => {
    if (isolatedRpTestNamespace) {
      const allowedPrefix = `${isolatedRpTestNamespace}-`;
      const unsafeTable = commandTableNames(args.input).find(
        (name) => !name.startsWith(allowedPrefix),
      );
      if (unsafeTable) {
        throw new Error(
          `Blocked integration-test access to non-disposable table ${unsafeTable}.`,
        );
      }
    }
    const endpointProvider = client.config.endpoint;
    if (!endpointProvider) {
      throw new Error(
        "Blocked DynamoDB request without the required local endpoint provider.",
      );
    }
    const endpoint = await endpointProvider();
    if (
      endpoint.protocol !== "http:" ||
      endpoint.hostname !== "127.0.0.1" ||
      endpoint.port !== 8000
    ) {
      throw new Error(
        "Blocked unsafe DynamoDB request: this TEST copy may connect only to http://127.0.0.1:8000.",
      );
    }

    try {
      return await next(args);
    } catch (cause) {
      const details = cause && typeof cause === "object"
        ? (cause as { code?: unknown; name?: unknown })
        : {};
      const code = String(details.code ?? details.name ?? "").toUpperCase();
      if (
        code === "ECONNREFUSED" ||
        code === "ECONNRESET" ||
        code === "ETIMEDOUT" ||
        code === "TIMEOUTERROR" ||
        code === "NETWORKINGERROR"
      ) {
        throw new DynamoDbLocalUnavailableError(cause);
      }
      throw cause;
    }
  },
  { name: "testCopyLocalDynamoOnly", step: "initialize" },
);

// Re-check the fully built HTTP request immediately before it leaves the SDK.
// This also blocks endpoint-discovery or middleware changes from redirecting a
// command after the client-level endpoint check above.
client.middlewareStack.add(
  (next) => async (args) => {
    const request = args.request as {
      protocol?: string;
      hostname?: string;
      port?: number;
    };
    if (
      request.protocol !== "http:" ||
      request.hostname !== "127.0.0.1" ||
      request.port !== 8000
    ) {
      throw new Error(
        "Blocked unsafe DynamoDB HTTP request: only http://127.0.0.1:8000 is allowed.",
      );
    }
    return next(args);
  },
  { name: "testCopyLocalDynamoHttpGuard", step: "finalizeRequest", priority: "high" },
);

export class DynamoDbLocalUnavailableError extends Error {
  constructor(cause: unknown) {
    super(
      "DynamoDB Local is unavailable at http://127.0.0.1:8000. Start DynamoDB Local and try again; this TEST copy will not fall back to AWS.",
      { cause },
    );
    this.name = "DynamoDBLocalUnavailableError";
  }
}

export const ddb = DynamoDBDocumentClient.from(client, {
  marshallOptions: { removeUndefinedValues: true, convertClassInstanceToMap: true },
});

export const TABLE_PREFIX = "p72_";

/** Qualifies a bare name into the prefix this environment is allowed to touch. */
export function table(name: string): string {
  return name.startsWith(TABLE_PREFIX) ? name : `${TABLE_PREFIX}${name}`;
}
