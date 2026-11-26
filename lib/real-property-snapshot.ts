import { randomUUID } from "node:crypto";

import { retainRealPropertySnapshots } from "./real-property-retention.ts";

import {
  BatchWriteCommand,
  GetCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";

import { ddb } from "@/lib/dynamo";
import { isRetryableDynamoError } from "@/lib/dynamo-error";
import { REAL_PROPERTY_TABLES } from "@/lib/real-property-tables";
import {
  checkSnapshotIntegrity,
  createPropQRecords,
  selectSnapshotRecords,
  snapshotRecordsFingerprint,
  snapshotLogicalMonthlyRpId,
} from "@/lib/real-property-snapshot-core";

export type RealPropertyItem = Record<string, unknown>;

export const REAL_PROPERTY_TABLE = REAL_PROPERTY_TABLES.monthly;
export const ESTIMATES_TABLE = REAL_PROPERTY_TABLES.estimates;
export const PROPQ_TABLE = REAL_PROPERTY_TABLES.propQ;
export const REAL_PROPERTY_CONTROL_TABLE = REAL_PROPERTY_TABLES.control;

export const SNAPSHOT_BATCH_SIZE = 25;
export const SNAPSHOT_BATCH_MAX_RETRIES = 5;
export const SNAPSHOT_BATCH_BASE_DELAY_MS = 200;

const MANAGED_TABLES: Set<string> = new Set([
  REAL_PROPERTY_TABLE,
  ESTIMATES_TABLE,
  PROPQ_TABLE,
]);

export type RealPropertyPeriodState = {
  PK: string;
  SK: "ACTIVE";
  ActiveDataVersion: string;
  BillingPeriodID: number;
  FY: number;
  BillingMonth: string;
  ActiveRecordCount: number;
  ActiveEstimateCount: number;
  ActivePropQCount: number;
  ReconciliationPotentiallyStale: boolean;
  BillsPotentiallyStale: boolean;
  ChangedAt: string;
  ChangedBy: string;
  ChangeOperation: string;
};

export function periodControlKey(billingPeriodId: number) {
  return {
    PK: `RP_PERIOD#${billingPeriodId}`,
    SK: "ACTIVE",
  } as const;
}

export function logicalMonthlyRpId(item: RealPropertyItem): string {
  return snapshotLogicalMonthlyRpId(item);
}

export function realPropertySourceVersion(
  items: RealPropertyItem[],
  state: RealPropertyPeriodState | null,
): string {
  return state?.ActiveDataVersion ?? `LEGACY-${snapshotRecordsFingerprint(items)}`;
}

export async function getRealPropertyPeriodState(
  billingPeriodId: number,
): Promise<RealPropertyPeriodState | null> {
  const result = await ddb.send(
    new GetCommand({
      TableName: REAL_PROPERTY_CONTROL_TABLE,
      Key: periodControlKey(billingPeriodId),
      ConsistentRead: true,
    }),
  );
  return (result.Item as RealPropertyPeriodState | undefined) ?? null;
}

export function selectActiveRealPropertyRecords(
  items: RealPropertyItem[],
  state: RealPropertyPeriodState | null,
): RealPropertyItem[] {
  return selectSnapshotRecords(items, state);
}

export async function filterActiveRealPropertyRecords(
  tableName: string,
  billingPeriodId: number,
  items: RealPropertyItem[],
): Promise<RealPropertyItem[]> {
  if (!MANAGED_TABLES.has(tableName)) return items;
  const state = await getRealPropertyPeriodState(billingPeriodId);
  return selectActiveRealPropertyRecords(items, state);
}

function numberValue(value: unknown): number {
  const parsed = Number(String(value ?? "").replace(/[$,]/g, "").trim());
  return Number.isFinite(parsed) ? parsed : 0;
}

function text(value: unknown): string {
  return value === undefined || value === null ? "" : String(value).trim();
}

export function buildPropQRecords(
  estimates: RealPropertyItem[],
  metadata: { billingPeriodId: number; fy: number; billingMonth: string },
): RealPropertyItem[] {
  return createPropQRecords(estimates, metadata);
}

export function validateRealPropertySnapshot(input: {
  billingPeriodId: number;
  realProperty: RealPropertyItem[];
  estimates: RealPropertyItem[];
  propQ: RealPropertyItem[];
}): string[] {
  return checkSnapshotIntegrity(input);
}

function materializeSnapshot(
  billingPeriodId: number,
  dataVersion: string,
  realProperty: RealPropertyItem[],
  estimates: RealPropertyItem[],
  propQ: RealPropertyItem[],
) {
  const physicalRpId = new Map<string, string>();
  const rpItems = realProperty.map((item) => {
    const logicalId = logicalMonthlyRpId(item);
    const physicalId = `${logicalId}#V#${dataVersion}`;
    physicalRpId.set(logicalId, physicalId);
    return {
      ...item,
      MonthlyRPID: physicalId,
      LogicalMonthlyRPID: logicalId,
      billing_period_id: billingPeriodId,
      DataVersion: dataVersion,
    };
  });

  const estimateIdByLogicalKey = new Map<string, string>();
  const estimateItems = estimates.map((item) => {
    const logicalRpId =
      text(item.SourceMonthlyRPID) ||
      text(item.LogicalMonthlyRPID) ||
      text(item.MonthlyRPID).split("#V#")[0] ||
      text(item.SourceLegacyRPID) ||
      text(item.LegacyRPID);
    const utility = text(item.UtilityType).toUpperCase();
    const estimateId = `EST#${billingPeriodId}#${logicalRpId}#${utility}#V#${dataVersion}`;
    estimateIdByLogicalKey.set(`${logicalRpId}|${utility}`, estimateId);
    return {
      ...item,
      EstimateID: estimateId,
      MonthlyRPID: physicalRpId.get(logicalRpId) ?? logicalRpId,
      SourceMonthlyRPID: logicalRpId,
      LogicalMonthlyRPID: logicalRpId,
      billing_period_id: billingPeriodId,
      DataVersion: dataVersion,
    };
  });

  const propQItems = propQ.map((item) => {
    const logicalRpId =
      text(item.LogicalMonthlyRPID) ||
      text(item.MonthlyRPID).split("#V#")[0] ||
      text(item.LegacyRPID);
    const utility = text(item.UtilityType).toUpperCase();
    return {
      ...item,
      PropQID: `PROPQ#${billingPeriodId}#${logicalRpId}#${utility}#V#${dataVersion}`,
      EstimateID:
        estimateIdByLogicalKey.get(`${logicalRpId}|${utility}`) ??
        text(item.EstimateID),
      MonthlyRPID: physicalRpId.get(logicalRpId) ?? logicalRpId,
      LogicalMonthlyRPID: logicalRpId,
      billing_period_id: billingPeriodId,
      DataVersion: dataVersion,
    };
  });

  return { rpItems, estimateItems, propQItems };
}

async function sleep(milliseconds: number) {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

function snapshotRetryDelay(attempt: number) {
  return Math.min(
    SNAPSHOT_BATCH_BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1),
    5_000,
  );
}

async function batchPut(tableName: string, items: RealPropertyItem[]) {
  for (let offset = 0; offset < items.length; offset += SNAPSHOT_BATCH_SIZE) {
    let requests = items.slice(offset, offset + SNAPSHOT_BATCH_SIZE).map((Item) => ({
      PutRequest: { Item },
    }));
    let attempts = 0;
    while (requests.length > 0) {
      let result;
      try {
        result = await ddb.send(
          new BatchWriteCommand({ RequestItems: { [tableName]: requests } }),
        );
      } catch (error) {
        if (
          !isRetryableDynamoError(error) ||
          attempts >= SNAPSHOT_BATCH_MAX_RETRIES
        ) {
          throw new Error(
            `Snapshot staging failed for ${tableName} after ${SNAPSHOT_BATCH_MAX_RETRIES} retries. No snapshot was activated.`,
            { cause: error },
          );
        }
        attempts += 1;
        await sleep(snapshotRetryDelay(attempts));
        continue;
      }
      const unprocessed = result.UnprocessedItems?.[tableName] ?? [];
      requests = unprocessed.flatMap(
        (request) =>
          request.PutRequest?.Item
            ? [{ PutRequest: { Item: request.PutRequest.Item } }]
            : [],
      );
      if (requests.length > 0) {
        if (attempts >= SNAPSHOT_BATCH_MAX_RETRIES) {
          throw new Error(
            `Snapshot staging left ${requests.length} unprocessed records in ${tableName} after ${SNAPSHOT_BATCH_MAX_RETRIES} retries. No snapshot was activated.`,
          );
        }
        attempts += 1;
        await sleep(snapshotRetryDelay(attempts));
      }
    }
  }
}

export async function activateRealPropertySnapshot(input: {
  billingPeriodId: number;
  fy: number;
  billingMonth: string;
  realProperty: RealPropertyItem[];
  estimates: RealPropertyItem[];
  propQ: RealPropertyItem[];
  operation: "CREATE" | "UPDATE" | "DELETE" | "DELETE_ALL" | "IMPORT" | "REPLACE" | "RECALCULATE";
  actor: string;
  targetMonthlyRpId?: string;
  details?: RealPropertyItem;
  expectedDataVersion?: string | null;
}) {
  const integrityErrors = validateRealPropertySnapshot({
    billingPeriodId: input.billingPeriodId,
    realProperty: input.realProperty,
    estimates: input.estimates,
    propQ: input.propQ,
  });
  if (integrityErrors.length > 0) {
    throw new Error(
      `Real Property snapshot validation failed. Nothing was activated. ${integrityErrors.join(" ")}`,
    );
  }
  const priorState = await getRealPropertyPeriodState(input.billingPeriodId);
  if (
    input.expectedDataVersion !== undefined &&
    (priorState?.ActiveDataVersion ?? null) !== input.expectedDataVersion
  ) {
    throw new Error(
      "Real Property changed while this operation was being prepared. Reload the month and try again.",
    );
  }
  const dataVersion = randomUUID();
  const staged = materializeSnapshot(
    input.billingPeriodId,
    dataVersion,
    input.realProperty,
    input.estimates,
    input.propQ,
  );

  // Staging rows are invisible because readers select only the active pointer.
  // The pointer transaction occurs only after every dependent row is present.
  await batchPut(REAL_PROPERTY_TABLE, staged.rpItems);
  await batchPut(ESTIMATES_TABLE, staged.estimateItems);
  await batchPut(PROPQ_TABLE, staged.propQItems);

  const changedAt = new Date().toISOString();
  const auditId = randomUUID();
  const state: RealPropertyPeriodState = {
    ...periodControlKey(input.billingPeriodId),
    ActiveDataVersion: dataVersion,
    BillingPeriodID: input.billingPeriodId,
    FY: input.fy,
    BillingMonth: input.billingMonth,
    ActiveRecordCount: staged.rpItems.length,
    ActiveEstimateCount: staged.estimateItems.length,
    ActivePropQCount: staged.propQItems.length,
    ReconciliationPotentiallyStale: true,
    BillsPotentiallyStale: true,
    ChangedAt: changedAt,
    ChangedBy: input.actor,
    ChangeOperation: input.operation,
  };

  await ddb.send(
    new TransactWriteCommand({
      TransactItems: [
        {
          Put: {
            TableName: REAL_PROPERTY_CONTROL_TABLE,
            Item: state,
            ...(input.expectedDataVersion ?? priorState?.ActiveDataVersion
              ? {
                  ConditionExpression: "ActiveDataVersion = :expectedVersion",
                  ExpressionAttributeValues: {
                    ":expectedVersion":
                      input.expectedDataVersion ?? priorState!.ActiveDataVersion,
                  },
                }
              : { ConditionExpression: "attribute_not_exists(PK)" }),
          },
        },
        {
          Put: {
            TableName: REAL_PROPERTY_CONTROL_TABLE,
            Item: {
              PK: `RP_AUDIT#${input.billingPeriodId}`,
              SK: `${changedAt}#${auditId}`,
              AuditID: auditId,
              BillingPeriodID: input.billingPeriodId,
              FY: input.fy,
              BillingMonth: input.billingMonth,
              Operation: input.operation,
              Actor: input.actor,
              ChangedAt: changedAt,
              PriorDataVersion: priorState?.ActiveDataVersion ?? "UNVERSIONED",
              NewDataVersion: dataVersion,
              TargetMonthlyRPID: input.targetMonthlyRpId ?? "",
              RecordCount: staged.rpItems.length,
              EstimateCount: staged.estimateItems.length,
              PropQCount: staged.propQItems.length,
              Details: input.details ?? {},
              ReconciliationPotentiallyStale: true,
              BillsPotentiallyStale: true,
            },
          },
        },
      ],
    }),
  );

  // Retention happens strictly after successful activation. A cleanup failure
  // must never report the already-committed snapshot as a failed activation.
  try {
    await retainRealPropertySnapshots(ddb, REAL_PROPERTY_TABLES, input.billingPeriodId, true);
  } catch (error) {
    console.error("Real Property snapshot activated; retention cleanup will need retry:", error);
  }

  return { state, dataVersion };
}

