export type DynamoFailureKind =
  | "authorization"
  | "configuration"
  | "throttling"
  | "temporary";

type DynamoErrorLike = {
  name?: unknown;
  message?: unknown;
  $metadata?: {
    httpStatusCode?: unknown;
    requestId?: unknown;
  };
  retryable?: unknown;
};

function errorLike(error: unknown): DynamoErrorLike {
  return error && typeof error === "object"
    ? (error as DynamoErrorLike)
    : {};
}

export function dynamoErrorName(error: unknown): string {
  return String(errorLike(error).name ?? "");
}

export function classifyDynamoError(
  error: unknown,
): DynamoFailureKind | null {
  const details = errorLike(error);
  const name = dynamoErrorName(error).toLowerCase();
  const status = Number(details.$metadata?.httpStatusCode ?? 0);

  if (
    name === "accessdeniedexception" ||
    name === "unauthorizedoperation" ||
    name === "invalidsignatureexception"
  ) {
    return "authorization";
  }

  if (
    name === "resourcenotfoundexception" ||
    name === "resourceinuseexception" ||
    name === "validationexception"
  ) {
    return "configuration";
  }

  if (
    name === "provisionedthroughputexceededexception" ||
    name === "throttlingexception" ||
    name === "requestlimitexceeded" ||
    name === "toomanyrequestsexception" ||
    name.includes("throttl")
  ) {
    return "throttling";
  }

  if (
    details.retryable === true ||
    name === "internalservererror" ||
    name === "serviceunavailable" ||
    name === "dynamodblocalunavailableerror" ||
    name === "timeout" ||
    name === "timeouterror" ||
    name === "networkingerror" ||
    name === "econnreset" ||
    name === "etimedout" ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504
  ) {
    return "temporary";
  }

  return null;
}

export function isRetryableDynamoError(error: unknown): boolean {
  const kind = classifyDynamoError(error);
  return kind === "throttling" || kind === "temporary";
}

export function logDynamoError(context: string, error: unknown): void {
  const details = errorLike(error);
  const kind = classifyDynamoError(error);
  if (!kind) return;

  console.error(`${context}: DynamoDB operation failed`, {
    name: dynamoErrorName(error),
    kind,
    message: String(details.message ?? "Unknown DynamoDB error"),
    requestId: String(details.$metadata?.requestId ?? ""),
    httpStatusCode: details.$metadata?.httpStatusCode,
  });
}

export function publicDynamoErrorResponse(
  error: unknown,
): { status: number; body: { error: string; code: string; retryable: boolean } } | null {
  const kind = classifyDynamoError(error);
  if (!kind) return null;
  const name = dynamoErrorName(error).toLowerCase();

  if (kind === "authorization") {
    return {
      status: 503,
      body: {
        error:
          "The application is not authorized to access DynamoDB billing storage. Contact an administrator.",
        code: "DYNAMODB_ACCESS_DENIED",
        retryable: false,
      },
    };
  }

  if (kind === "configuration") {
    return {
      status: 503,
      body: {
        error:
          "DynamoDB billing storage is unavailable or incorrectly configured. Verify the application table configuration.",
        code: "DYNAMODB_CONFIGURATION_ERROR",
        retryable: false,
      },
    };
  }

  return {
    status: 503,
    body: {
      error: name === "dynamodblocalunavailableerror"
        ? "DynamoDB Local is unavailable at http://127.0.0.1:8000. Start it and try again. This TEST copy will not connect to AWS."
        : "DynamoDB is temporarily unavailable. No new billing version was activated. Please try again.",
      code: name === "dynamodblocalunavailableerror"
        ? "DYNAMODB_LOCAL_UNAVAILABLE"
        : "DYNAMODB_TEMPORARY_ERROR",
      retryable: true,
    },
  };
}
