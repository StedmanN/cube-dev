import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  QueryCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";

import {
  buildOtherUtilitiesReportingBreakdown,
  selectEffectiveFinal3556,
} from "../lib/3556-reporting-breakdown.ts";

const endpoint = "http://127.0.0.1:8000";
const client = new DynamoDBClient({
  endpoint,
  region: "local",
  credentials: {
    accessKeyId: "DUMMYLOCALACCESSKEY",
    secretAccessKey: "DUMMYLOCALSECRETKEY",
  },
  maxAttempts: 1,
});
const ddb = DynamoDBDocumentClient.from(client);

client.middlewareStack.add(
  (next) => async (args) => {
    const request = args.request;
    if (
      request?.protocol !== "http:" ||
      request?.hostname !== "127.0.0.1" ||
      request?.port !== 8000
    ) {
      throw new Error("Phase 5 profiling permits only DynamoDB Local at 127.0.0.1:8000.");
    }
    return next(args);
  },
  { name: "phase5LocalOnly", step: "finalizeRequest", priority: "high" },
);

const tables = {
  reconciliation: "p72-CUBE-MONTHLY-RECONCILIATION",
  rates: "p72-CUBE-3556",
  invoices: "p72-CUBE-INVOICES",
  customers: "p72-CUBE-CUSTOMERS",
};

async function readAll(commandForPage) {
  const started = performance.now();
  const items = [];
  let requests = 0;
  let lastKey;
  do {
    const response = await ddb.send(commandForPage(lastKey));
    requests += 1;
    items.push(...(response.Items ?? []));
    lastKey = response.LastEvaluatedKey;
  } while (lastKey);
  return {
    requests,
    items,
    milliseconds: Math.round((performance.now() - started) * 100) / 100,
  };
}

function scan(tableName, projectionExpression) {
  return readAll(
    (ExclusiveStartKey) =>
      new ScanCommand({
        TableName: tableName,
        ...(projectionExpression ? { ProjectionExpression: projectionExpression } : {}),
        ExclusiveStartKey,
      }),
  );
}

function queryPeriod(tableName, billingPeriodId, indexName) {
  return readAll(
    (ExclusiveStartKey) =>
      new QueryCommand({
        TableName: tableName,
        ...(indexName ? { IndexName: indexName } : {}),
        KeyConditionExpression: "billing_period_id = :billingPeriodId",
        ExpressionAttributeValues: { ":billingPeriodId": billingPeriodId },
        ExclusiveStartKey,
      }),
  );
}

function normalized(value) {
  return String(value ?? "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function cutoff(allocation) {
  const month = {
    JANUARY: 1,
    FEBRUARY: 2,
    MARCH: 3,
    APRIL: 4,
    MAY: 5,
    JUNE: 6,
    JULY: 7,
    AUGUST: 8,
    SEPTEMBER: 9,
    OCTOBER: 10,
    NOVEMBER: 11,
    DECEMBER: 12,
  }[String(allocation.BillingMonth ?? "").toUpperCase()];
  const fiscalYear = Number(String(allocation.FY ?? "").replace(/[^0-9]/g, ""));
  if (!month || !fiscalYear) return "";
  const year = month >= 10 ? fiscalYear - 1 : fiscalYear;
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
}

function sourceRows(record) {
  const rows = record.worksheet?.distribution ?? [];
  const expected = new Set(["811144", "811149", "812223", "812225", "812226"]);
  return rows
    .filter((row) => expected.has(String(row.accountProjectNumber ?? "").trim()))
    .map((row) => ({
      id: row.id,
      accountProjectNumber: row.accountProjectNumber,
      cost: Number(row.cost),
    }));
}

const billingPeriodId = 175;

// Reproduce the pre-optimization route reads, then the period-scoped reads.
const legacyStarted = performance.now();
const [legacyReconciliation, rateRead, legacyInvoices] = await Promise.all([
  scan(tables.reconciliation),
  scan(tables.rates),
  scan(tables.invoices),
]);
const legacyWallMilliseconds = Math.round((performance.now() - legacyStarted) * 100) / 100;

const optimizedStarted = performance.now();
const [periodReconciliation, periodInvoices, customerRead] = await Promise.all([
  queryPeriod(tables.reconciliation, billingPeriodId),
  queryPeriod(tables.invoices, billingPeriodId, "billing-period-index"),
  scan(tables.customers, "CustomerID, CustomerName, RateClass, CustomerType, RCBLComment"),
]);
const optimizedWallMilliseconds = Math.round((performance.now() - optimizedStarted) * 100) / 100;

const allocations = periodReconciliation.items.filter(
  (row) => String(row.RecordType ?? "").toUpperCase() === "ALLOCATION",
);
const finalRates = rateRead.items.filter(
  (row) => String(row.status ?? "").toUpperCase() === "FINAL",
);
const calculationStarted = performance.now();
const selectedRates = new Map();
let readyBreakdowns = 0;
let blockedBreakdowns = 0;
for (const allocation of allocations) {
  const cacheKey = `${cutoff(allocation)}|${normalized(allocation.UtilityGroup)}|${normalized(
    allocation.UtilityType,
  )}`;
  if (!selectedRates.has(cacheKey)) {
    selectedRates.set(
      cacheKey,
      selectEffectiveFinal3556(
        finalRates,
        allocation.UtilityGroup,
        allocation.UtilityType,
        cutoff(allocation),
      ),
    );
  }
  const result = buildOtherUtilitiesReportingBreakdown({
    originalReconciledConsumption: Number(allocation.AllocatedTotalConsumption ?? 0),
    originalGrossCharge: Number(allocation.AllocatedTotalConsumption ?? 0) * 0.1,
    rateClass: allocation.RateClass,
    utilityGroup: allocation.UtilityGroup,
    utilityType: allocation.UtilityType,
    effectiveFinal3556: selectedRates.get(cacheKey),
  });
  if (result.status === "REVIEW_REQUIRED") blockedBreakdowns += 1;
  else readyBreakdowns += 1;
}
const calculationMilliseconds =
  Math.round((performance.now() - calculationStarted) * 100) / 100;

const targetPattern = /AAFES|MFH/i;
const registryTargets = customerRead.items.filter((row) =>
  targetPattern.test(`${row.CustomerID ?? ""} ${row.CustomerName ?? ""}`),
);
const allocationTargets = allocations
  .filter((row) => targetPattern.test(`${row.CustomerID ?? ""} ${row.CustomerName ?? ""}`))
  .reduce((summary, row) => {
    const key = `${row.CustomerID}|${row.CustomerName}|${row.RateClass}|${row.CustomerType}`;
    summary.set(key, (summary.get(key) ?? 0) + 1);
    return summary;
  }, new Map());

const electricitySourceInventory = finalRates
  .filter(
    (row) =>
      normalized(row.utilitySystem) === "ELECTRICITY" &&
      ["2026-01-01", "2026-08-01"].includes(String(row.effectiveDate)),
  )
  .map((row) => ({
    id: row.id,
    utilityGroup: row.utilityGroup,
    effectiveDate: row.effectiveDate,
    revision: row.revision,
    materialRows: sourceRows(row),
    materialTotal: sourceRows(row).reduce((sum, item) => sum + item.cost, 0),
  }));

console.log(
  JSON.stringify(
    {
      endpoint,
      billingPeriodId,
      preOptimizationReads: {
        wallMilliseconds: legacyWallMilliseconds,
        totalRequests:
          legacyReconciliation.requests + rateRead.requests + legacyInvoices.requests,
        reconciliation: {
          requests: legacyReconciliation.requests,
          allItems: legacyReconciliation.items.length,
          milliseconds: legacyReconciliation.milliseconds,
        },
        rates: {
          requests: rateRead.requests,
          allItems: rateRead.items.length,
          milliseconds: rateRead.milliseconds,
        },
        invoices: {
          requests: legacyInvoices.requests,
          allItems: legacyInvoices.items.length,
          milliseconds: legacyInvoices.milliseconds,
        },
      },
      optimizedReads: {
        wallMilliseconds: optimizedWallMilliseconds,
        totalRequests:
          periodReconciliation.requests + periodInvoices.requests + rateRead.requests + customerRead.requests,
        reconciliation: {
          requests: periodReconciliation.requests,
          periodItems: periodReconciliation.items.length,
          milliseconds: periodReconciliation.milliseconds,
        },
        invoices: {
          requests: periodInvoices.requests,
          periodItems: periodInvoices.items.length,
          milliseconds: periodInvoices.milliseconds,
        },
        rates: {
          requests: rateRead.requests,
          allItems: rateRead.items.length,
          reusedWithinRequest: true,
        },
        customers: {
          requests: customerRead.requests,
          allItems: customerRead.items.length,
          milliseconds: customerRead.milliseconds,
          reusedWithinRequest: true,
        },
      },
      calculation: {
        allocationCount: allocations.length,
        distinctRateSelections: selectedRates.size,
        readyBreakdowns,
        blockedBreakdowns,
        milliseconds: calculationMilliseconds,
      },
      customerClassificationAudit: {
        registryTargets,
        allocationTargets: [...allocationTargets].map(([key, count]) => ({ key, count })),
      },
      electricitySourceInventory,
    },
    null,
    2,
  ),
);
