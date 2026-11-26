import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";

import {
  CreateTableCommand,
  DeleteTableCommand,
  DescribeTableCommand,
  DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
import {
  BatchWriteCommand,
  DynamoDBDocumentClient,
  QueryCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";

import { TABLE_DEFINITIONS } from "./dynamodb-local-table-definitions.mjs";

const endpoint = "http://127.0.0.1:8000";
const billingPeriodId = 175;
const fiscalYear = 2026;
const namespace =
  process.env.CUBE_RECONCILIATION_INTEGRATION_TEST_NAMESPACE ??
  `CUBE-RP-IT-RECON-BP175-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
assert.match(namespace, /^CUBE-RP-IT-RECON-[A-Z0-9-]{8,80}$/i);

const tables = {
  reconciliation: `${namespace}-MONTHLY-RECONCILIATION`,
  readings: `${namespace}-METER-READINGS`,
  meters: `${namespace}-METERS`,
  customers: `${namespace}-CUSTOMERS`,
  invoices: `${namespace}-INVOICES`,
  propQ: `${namespace}-RP-PROPQ`,
  plantUnit: `${namespace}-PLANT-UNIT`,
  realPropertyLegacy: `${namespace}-RP-LEGACY`,
  realPropertyMonthly: `${namespace}-RP-MONTHLY`,
  control: `${namespace}-CONTROL`,
  rates: `${namespace}-RATES`,
  rcbl: `${namespace}-RCBL-SHORT`,
  rcblHistory: `${namespace}-RCBL-HISTORY`,
};
for (const tableName of Object.values(tables)) {
  assert.ok(tableName.startsWith(`${namespace}-`));
}

const sourceNames = {
  reconciliation: "p72-CUBE-MONTHLY-RECONCILIATION",
  readings: "p72-CUBE-METER-READINGS",
  meters: "p72-CUBE-METERS",
  customers: "p72-CUBE-CUSTOMERS",
  invoices: "p72-CUBE-INVOICES",
  propQ: "p72-CUBE-RP-PROPQ",
  plantUnit: "p72-CUBE-PLANT-UNIT",
  realPropertyLegacy: "p72-CUBE-RP-LEGACY",
  rates: "p72-CUBE-3556",
  rcbl: "p72-CUBE-RCBL-SHORT",
  rcblHistory: "p72-CUBE-RCBL-SHORT-HISTORY",
};

function client() {
  return new DynamoDBClient({
    endpoint,
    region: "local",
    credentials: {
      accessKeyId: "DUMMYLOCALACCESSKEY",
      secretAccessKey: "DUMMYLOCALSECRETKEY",
    },
    maxAttempts: 1,
  });
}

const sourceLowLevel = client();
sourceLowLevel.middlewareStack.add(
  (next) => async (args) => {
    const { protocol, hostname, port, headers } = args.request;
    assert.equal(protocol, "http:");
    assert.equal(hostname, "127.0.0.1");
    assert.equal(port, 8000);
    assert.match(String(headers?.["x-amz-target"] ?? ""), /(Query|Scan)$/);
    return next(args);
  },
  { name: "bp175SourceReadOnly", step: "finalizeRequest", priority: "high" },
);
const disposableLowLevel = client();
disposableLowLevel.middlewareStack.add(
  (next) => async (args) => {
    const { protocol, hostname, port } = args.request;
    assert.equal(protocol, "http:");
    assert.equal(hostname, "127.0.0.1");
    assert.equal(port, 8000);
    const tableName = args.input?.TableName;
    if (tableName) assert.ok(tableName.startsWith(`${namespace}-`));
    for (const requestTable of Object.keys(args.input?.RequestItems ?? {})) {
      assert.ok(requestTable.startsWith(`${namespace}-`));
    }
    return next(args);
  },
  { name: "bp175DisposableOnly", step: "finalizeRequest", priority: "high" },
);
const sourceDdb = DynamoDBDocumentClient.from(sourceLowLevel);
const disposableDdb = DynamoDBDocumentClient.from(disposableLowLevel, {
  marshallOptions: { removeUndefinedValues: true },
});

const text = (value) =>
  value === undefined || value === null ? "" : String(value).trim();
const number = (value) => {
  const parsed = Number(text(value).replace(/[$,]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
};
const upper = (value) => text(value).toUpperCase();
const round = (value, decimals = 8) =>
  Math.round((value + Number.EPSILON) * 10 ** decimals) / 10 ** decimals;

async function scanAll(ddb, TableName, extra = {}) {
  const items = [];
  let ExclusiveStartKey;
  do {
    const result = await ddb.send(
      new ScanCommand({ TableName, ...extra, ExclusiveStartKey }),
    );
    items.push(...(result.Items ?? []));
    ExclusiveStartKey = result.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

async function queryPeriod(ddb, TableName, useIndex = true) {
  const items = [];
  let ExclusiveStartKey;
  do {
    const result = await ddb.send(
      new QueryCommand({
        TableName,
        ...(useIndex ? { IndexName: "billing-period-index" } : {}),
        KeyConditionExpression: "#bp = :bp",
        ExpressionAttributeNames: { "#bp": "billing_period_id" },
        ExpressionAttributeValues: { ":bp": billingPeriodId },
        ExclusiveStartKey,
      }),
    );
    items.push(...(result.Items ?? []));
    ExclusiveStartKey = result.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

async function batchPut(TableName, items) {
  for (let offset = 0; offset < items.length; offset += 25) {
    let pending = items.slice(offset, offset + 25).map((Item) => ({
      PutRequest: { Item },
    }));
    while (pending.length > 0) {
      const result = await disposableDdb.send(
        new BatchWriteCommand({ RequestItems: { [TableName]: pending } }),
      );
      pending = result.UnprocessedItems?.[TableName] ?? [];
    }
  }
}

function definitionFor(sourceName, TableName) {
  const source = TABLE_DEFINITIONS.find(
    (definition) => definition.TableName === sourceName,
  );
  assert.ok(source, `Missing definition for ${sourceName}`);
  return { ...source, TableName };
}

const definitions = [
  definitionFor(sourceNames.reconciliation, tables.reconciliation),
  definitionFor(sourceNames.readings, tables.readings),
  definitionFor(sourceNames.meters, tables.meters),
  definitionFor(sourceNames.customers, tables.customers),
  definitionFor(sourceNames.invoices, tables.invoices),
  definitionFor(sourceNames.propQ, tables.propQ),
  definitionFor(sourceNames.plantUnit, tables.plantUnit),
  definitionFor(sourceNames.realPropertyLegacy, tables.realPropertyLegacy),
  definitionFor("p72-CUBE-RP-MONTHLY", tables.realPropertyMonthly),
  definitionFor(sourceNames.rates, tables.control),
  definitionFor(sourceNames.rates, tables.rates),
  definitionFor(sourceNames.rcbl, tables.rcbl),
  definitionFor(sourceNames.rcblHistory, tables.rcblHistory),
];

async function tableExists(TableName) {
  try {
    await disposableLowLevel.send(new DescribeTableCommand({ TableName }));
    return true;
  } catch (error) {
    if (error?.name === "ResourceNotFoundException") return false;
    throw error;
  }
}

async function waitFor(TableName, expected) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if ((await tableExists(TableName)) === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${TableName}`);
}

async function createTables() {
  for (const definition of definitions) {
    assert.equal(await tableExists(definition.TableName), false);
    await disposableLowLevel.send(new CreateTableCommand(definition));
    await waitFor(definition.TableName, true);
  }
}

async function cleanup() {
  for (const definition of [...definitions].reverse()) {
    if (!(await tableExists(definition.TableName))) continue;
    await disposableLowLevel.send(
      new DeleteTableCommand({ TableName: definition.TableName }),
    );
    await waitFor(definition.TableName, false);
  }
}

function stableHash(items) {
  const json = items
    .map((item) => JSON.stringify(item, Object.keys(item).sort()))
    .sort()
    .join("\n");
  return createHash("sha256").update(json).digest("hex");
}

function customerName(customer) {
  return text(
    customer?.CustomerName ??
      customer?.customer_nm ??
      customer?.customer_name,
  );
}

function targetCustomerKind(name) {
  const normalized = upper(name).replace(/[^A-Z0-9]/g, "");
  if (normalized === "AAFES") return "AAFES";
  if (normalized === "BOWLINGCENTER") return "Bowling Center";
  if (normalized === "RESTAURANTS") return "Restaurants";
  if (normalized === "TACXRESTAURANTS") return "TACX Restaurants";
  if (normalized.includes("FSS") || normalized.includes("FORCESUPPORT")) {
    return "FSS";
  }
  return "";
}

function enabled(value) {
  const normalized = upper(value);
  if (["Y", "YES", "TRUE", "X"].includes(normalized)) return true;
  return number(value) !== 0;
}

async function waitForServer(baseUrl, server) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (server.exitCode !== null) {
      throw new Error(`Next dev exited with code ${server.exitCode}`);
    }
    try {
      const response = await fetch(baseUrl);
      if (response.status < 500) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Timed out waiting for isolated Next dev server.");
}

function allocationSignature(records) {
  return records
    .filter((row) => upper(row.RecordType) === "ALLOCATION")
    .map((row) => [
      text(row.ReconciliationID),
      upper(row.UtilityType),
      upper(row.AllocationSource),
      round(number(row.AllocatedTotalConsumption)),
    ])
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

async function setTargetReimbursement(legacyRows, targetIds, reimbursable) {
  const updated = legacyRows.map((row) => {
    if (!targetIds.has(text(row.LegacyRPID))) return row;
    return {
      ...row,
      UtilityReimbursementOverrides: {
        ...(row.UtilityReimbursementOverrides &&
        typeof row.UtilityReimbursementOverrides === "object"
          ? row.UtilityReimbursementOverrides
          : {}),
        SS: reimbursable,
      },
    };
  });
  await batchPut(tables.realPropertyLegacy, updated);
}

const importedRcblBefore = await scanAll(sourceDdb, sourceNames.rcbl);
const importedHistoryBefore = await scanAll(sourceDdb, sourceNames.rcblHistory);
const importedBillFingerprint = stableHash(importedRcblBefore);
const importedHistoryFingerprint = stableHash(importedHistoryBefore);

let server;
let report;
await createTables();
try {
  const [readings, invoices, propQ, plantUnit, meters, customers, legacy, rates, importedReconciliation] =
    await Promise.all([
      queryPeriod(sourceDdb, sourceNames.readings),
      queryPeriod(sourceDdb, sourceNames.invoices),
      queryPeriod(sourceDdb, sourceNames.propQ),
      queryPeriod(sourceDdb, sourceNames.plantUnit),
      scanAll(sourceDdb, sourceNames.meters),
      scanAll(sourceDdb, sourceNames.customers),
      scanAll(sourceDdb, sourceNames.realPropertyLegacy),
      scanAll(sourceDdb, sourceNames.rates),
      queryPeriod(sourceDdb, sourceNames.reconciliation, false),
    ]);

  const customersById = new Map(
    customers.map((customer) => [text(customer.CustomerID), customer]),
  );
  const propQByLegacy = new Map();
  for (const row of propQ) {
    const propQIdMatch = text(row.PropQID).match(/^PROPQ#175#(.+)#[A-Z]+$/i);
    const legacyRpId =
      text(row.LegacyRPID ?? row.MonthlyRPID) || propQIdMatch?.[1] || "";
    if (!legacyRpId) continue;
    const rows = propQByLegacy.get(legacyRpId) ?? [];
    rows.push(row);
    propQByLegacy.set(legacyRpId, rows);
  }

  const targetRecords = [];
  const clarificationRecords = [];
  const targetIds = new Set();
  const configuredLegacy = legacy
    .filter((row) => number(row.FY) === fiscalYear)
    .map((row) => {
      const customer = customersById.get(text(row.CustomerID));
      const kind = targetCustomerKind(customerName(customer));
      if (!kind) return row;
      const pwEnabled = enabled(row.PWUsage ?? row.PW);
      const groups = [
        ...new Set(
          [
            ...(propQByLegacy.get(text(row.LegacyRPID)) ?? [])
              .filter(
                (item) =>
                  upper(
                    item.UtilityType ??
                      item.utility_type_cd ??
                      item.UTILITY_TYPE_CD ??
                      text(item.PropQID).split("#").at(-1),
                  ) === "PW",
              )
              .map((item) =>
                text(item.UtilityGroup ?? item.utility_group_id),
              ),
            text(
              row.UtilityGroup ??
                row.utility_group_id ??
                row.sub_inst_cd ??
                row.SUB_INST_CD,
            ),
          ],
        ),
      ].filter(Boolean);
      const currentOverrides =
        row.UtilityReimbursementOverrides &&
        typeof row.UtilityReimbursementOverrides === "object"
          ? row.UtilityReimbursementOverrides
          : {};
      const record = {
        kind,
        rpId: text(row.LegacyRPID),
        customerId: text(row.CustomerID),
        customerName: customerName(customer),
        facility: text(row.FacilityNumber ?? row.facility_nbr),
        billingPeriodId,
        utilityGroups: groups,
        currentSsCalculation: enabled(row.SSUsage ?? row.SS) ? "ON" : "OFF",
        requiredSsCalculation: "ON",
        currentEffectiveSsReimbursement:
          typeof currentOverrides.SS === "boolean"
            ? currentOverrides.SS
              ? "ON"
              : "OFF"
            : upper(customer?.CustomerType ?? customer?.customer_type) ===
                "REIMBURSABLE"
              ? "ON"
              : "OFF",
        requiredSsReimbursement: "OFF",
        pwEligible: pwEnabled,
      };
      if (!pwEnabled || groups.length === 0) {
        clarificationRecords.push({
          ...record,
          reason: !pwEnabled
            ? "PW Calculation is not enabled."
            : "No BP 175 PW PropQ utility group was found.",
        });
        return row;
      }
      targetRecords.push(record);
      targetIds.add(record.rpId);
      return {
        ...row,
        SSUsage: 1,
        SS: 1,
        UtilityReimbursementOverrides: {
          ...currentOverrides,
          SS: false,
        },
      };
    });

  assert.equal(clarificationRecords.length, 0, JSON.stringify(clarificationRecords));
  assert.equal(targetRecords.length, 19);
  assert.deepEqual(
    [...new Set(targetRecords.map((record) => record.kind))].sort(),
    ["AAFES", "Bowling Center", "FSS", "Restaurants", "TACX Restaurants"].sort(),
  );

  await Promise.all([
    batchPut(tables.readings, readings),
    batchPut(tables.invoices, invoices),
    batchPut(tables.propQ, propQ),
    batchPut(tables.plantUnit, plantUnit),
    batchPut(tables.meters, meters),
    batchPut(tables.customers, customers),
    batchPut(tables.realPropertyLegacy, configuredLegacy),
    batchPut(tables.rates, rates),
  ]);

  const port = 3200 + Math.floor(Math.random() * 200);
  const baseUrl = `http://127.0.0.1:${port}`;
  const nextBin = new URL("../node_modules/next/dist/bin/next", import.meta.url).pathname.replace(/^\/(.:)/, "$1");
  server = spawn(
    process.execPath,
    [nextBin, "dev", "-H", "127.0.0.1", "-p", String(port)],
    {
      cwd: new URL("..", import.meta.url).pathname.replace(/^\/(.:)/, "$1"),
      env: {
        ...process.env,
        CUBE_LOCAL_INTEGRATION_TEST_MODE: "1",
        CUBE_RP_INTEGRATION_TEST_NAMESPACE: namespace,
        CUBE_RECONCILIATION_INTEGRATION_TEST_NAMESPACE: namespace,
        CUBE_RECONCILIATION_TABLE_NAME: tables.reconciliation,
        CUBE_INVOICES_TABLE_NAME: tables.invoices,
        CUBE_CUSTOMERS_TABLE_NAME: tables.customers,
        CUBE_3556_TABLE_NAME: tables.rates,
        CUBE_RCBL_SHORT_TABLE_NAME: tables.rcbl,
        CUBE_RCBL_SHORT_HISTORY_TABLE_NAME: tables.rcblHistory,
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  let serverLogs = "";
  server.stdout.on("data", (chunk) => {
    serverLogs += String(chunk);
  });
  server.stderr.on("data", (chunk) => {
    serverLogs += String(chunk);
  });
  await waitForServer(baseUrl, server);

  async function regenerate() {
    const response = await fetch(`${baseUrl}/api/monthly-data/reconciliation`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ billing_period_id: billingPeriodId }),
    });
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify({ body, serverLogs }));
    assert.equal(body.persisted, true);
    return body;
  }

  async function readReconciliation() {
    const response = await fetch(
      `${baseUrl}/api/monthly-data/reconciliation?billing_period_id=${billingPeriodId}`,
    );
    assert.equal(response.status, 200);
    return response.json();
  }

  await regenerate();
  const reimbursementOff = await readReconciliation();
  const offSignature = allocationSignature(reimbursementOff.records);

  await setTargetReimbursement(configuredLegacy, targetIds, true);
  await regenerate();
  const reimbursementOn = await readReconciliation();
  assert.deepEqual(allocationSignature(reimbursementOn.records), offSignature);

  await setTargetReimbursement(configuredLegacy, targetIds, false);
  await regenerate();
  const finalReconciliation = await readReconciliation();
  assert.deepEqual(allocationSignature(finalReconciliation.records), offSignature);

  const summaries = finalReconciliation.summaries;
  const allocations = finalReconciliation.allocations;
  const contributions = finalReconciliation.poolContributions;
  const ssSummaries = summaries
    .filter((row) => upper(row.UtilityType) === "SS")
    .sort((left, right) => text(left.UtilityGroup).localeCompare(text(right.UtilityGroup)));
  assert.equal(ssSummaries.length, 2);
  for (const summary of ssSummaries) {
    assert.equal(summary.ReconciliationStatus, "BILLING_READY");
    assert.equal(number(summary.BillingReady), 1);
    assert.ok(Math.abs(number(summary.Difference)) <= 0.01);
    assert.ok(Math.abs(number(summary.UnresolvedPoolConsumption)) <= 0.01);
  }

  const ssAllocations = allocations.filter((row) => upper(row.UtilityType) === "SS");
  const poolAllocations = ssAllocations.filter(
    (row) => upper(row.AllocationSource) === "SS_NONMETERED",
  );
  for (const contribution of contributions.filter(
    (row) => upper(row.UtilityType) === "SS",
  )) {
    assert.equal(contribution.PoolDisposition, "DISTRIBUTED_NONMETERED_POOL");
    assert.equal(number(contribution.Blocking), 0);
  }
  for (const allocation of poolAllocations) {
    assert.equal(number(allocation.SourceRPSSCommodityEnabled), 1);
    assert.equal(text(allocation.PoolDisposition), "DISTRIBUTED_NONMETERED_POOL");
  }

  const ssAccounting = ssSummaries.map((summary) => {
    const utilityGroup = text(summary.UtilityGroup);
    const groupAllocations = ssAllocations.filter(
      (row) => text(row.UtilityGroup) === utilityGroup,
    );
    const regular = groupAllocations
      .filter((row) => upper(row.AllocationSource) === "DERIVED_SS")
      .reduce((sum, row) => sum + number(row.AllocatedTotalConsumption), 0);
    const distributed = groupAllocations
      .filter((row) => upper(row.AllocationSource) === "SS_NONMETERED")
      .reduce((sum, row) => sum + number(row.AllocatedTotalConsumption), 0);
    const source = number(summary.SourceConsumption);
    const unresolved = number(summary.UnresolvedPoolConsumption);
    assert.ok(Math.abs(source - regular - distributed - unresolved) <= 0.01);
    return {
      utilityGroup,
      source: round(source),
      regular: round(regular),
      poolContributions: round(number(summary.CalculationExcludedConsumption)),
      distributed: round(distributed),
      unresolved: round(unresolved),
      difference: round(number(summary.Difference)),
      billingReady: number(summary.BillingReady) === 1,
    };
  });

  const targetCustomerIds = new Set(targetRecords.map((record) => record.customerId));
  const targetSsAllocations = ssAllocations.filter((row) =>
    targetCustomerIds.has(text(row.CustomerID)),
  );
  assert.ok(targetSsAllocations.length > 0);
  for (const allocation of targetSsAllocations) {
    assert.equal(allocation.ReimbursementDisposition, "CE_ABSORBED");
    assert.equal(number(allocation.AllocatedReimbursableConsumption), 0);
    assert.equal(
      round(number(allocation.AllocatedCEAbsorbedConsumption)),
      round(number(allocation.AllocatedTotalConsumption)),
    );
  }

  const importedPwTotals = importedReconciliation
    .filter(
      (row) =>
        upper(row.RecordType) === "ALLOCATION" && upper(row.UtilityType) === "PW",
    )
    .reduce((map, row) => {
      const key = text(row.UtilityGroup);
      map[key] = (map[key] ?? 0) + number(row.AllocatedTotalConsumption);
      return map;
    }, {});
  const newPwTotals = allocations
    .filter((row) => upper(row.UtilityType) === "PW")
    .reduce((map, row) => {
      const key = text(row.UtilityGroup);
      map[key] = (map[key] ?? 0) + number(row.AllocatedTotalConsumption);
      return map;
    }, {});
  for (const [utilityGroup, total] of Object.entries(importedPwTotals)) {
    assert.ok(Math.abs(total - (newPwTotals[utilityGroup] ?? 0)) <= 0.01);
  }

  for (const row of allocations.filter(
    (item) => upper(item.AllocationSource) === "SS_PUMPING",
  )) {
    assert.ok(
      Math.abs(number(row.PumpingKWH) - number(row.DerivedSSKGAL) * 2.18) <=
        0.000001,
    );
  }

  const previewResponse = await fetch(
    `${baseUrl}/api/billing/rcbl-short?billing_period_id=${billingPeriodId}`,
  );
  const preview = await previewResponse.json();
  assert.equal(previewResponse.status, 200, JSON.stringify(preview));
  const targetPreviewLines = preview.customers.flatMap((customer) =>
    targetCustomerIds.has(text(customer.customerId))
      ? customer.lines.filter((line) => upper(line.utilityType) === "SS")
      : [],
  );
  assert.ok(targetPreviewLines.length > 0);
  for (const line of targetPreviewLines) {
    assert.equal(line.reimbursementDisposition, "CE_ABSORBED");
    assert.equal(number(line.customerChargeAmount), 0);
    assert.equal(round(number(line.ceAbsorbedAmount), 2), round(number(line.calculatedAmount), 2));
  }

  const targetConsumption = targetSsAllocations.reduce(
    (sum, row) => sum + number(row.AllocatedTotalConsumption),
    0,
  );
  const targetCeAmount = targetPreviewLines.reduce(
    (sum, line) => sum + number(line.ceAbsorbedAmount),
    0,
  );
  const targetCustomerAmount = targetPreviewLines.reduce(
    (sum, line) => sum + number(line.customerChargeAmount),
    0,
  );

  const unrelatedExceptions = summaries
    .filter((summary) => number(summary.BillingReady) !== 1)
    .map((summary) => ({
      utilityGroup: text(summary.UtilityGroup),
      utilityType: text(summary.UtilityType),
      status: text(summary.ReconciliationStatus),
      issues: summary.Issues ?? [],
    }));

  report = {
    ok: true,
    namespace,
    targetRecords,
    clarificationRecords,
    ssAccounting,
    targetConsumption: round(targetConsumption),
    targetCustomerCharge: round(targetCustomerAmount, 2),
    targetCeAbsorbedCharge: round(targetCeAmount, 2),
    preview: {
      reconciliationReady: preview.reconciliationReady,
      reconciliationIssues: preview.reconciliationIssues,
      customerCount: preview.summary.customerCount,
      totalCustomerBilling: preview.summary.totalCustomerBilling,
      totalCEAbsorbed: preview.summary.totalCEAbsorbed,
      totalCalculatedBilling: preview.summary.totalCalculatedBilling,
      targetSsLineCount: targetPreviewLines.length,
    },
    poolContributionRows: contributions.filter(
      (row) => upper(row.UtilityType) === "SS",
    ).length,
    poolDistributionRows: poolAllocations.length,
    reimbursementInvariant: true,
    pwTotalsInvariant: true,
    unrelatedExceptions,
  };
} finally {
  if (server && server.exitCode === null) {
    server.kill("SIGTERM");
    await new Promise((resolve) => {
      server.once("exit", resolve);
      setTimeout(resolve, 5000);
    });
  }
  await cleanup();
}

const importedRcblAfter = await scanAll(sourceDdb, sourceNames.rcbl);
const importedHistoryAfter = await scanAll(sourceDdb, sourceNames.rcblHistory);
assert.equal(stableHash(importedRcblAfter), importedBillFingerprint);
assert.equal(stableHash(importedHistoryAfter), importedHistoryFingerprint);
report.importedSavedBillsUnchanged = true;

console.log(JSON.stringify(report, null, 2));
