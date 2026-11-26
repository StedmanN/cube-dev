import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";

import {
  CreateTableCommand,
  DeleteTableCommand,
  DescribeTableCommand,
  DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
import {
  BatchWriteCommand,
  DynamoDBDocumentClient,
  PutCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";

const endpoint = "http://127.0.0.1:8000";
const baseUrl = "http://127.0.0.1:3100";
const namespace = process.env.CUBE_RP_INTEGRATION_TEST_NAMESPACE;
assert.match(
  namespace ?? "",
  /^CUBE-RP-IT-RCBL-[A-Z0-9-]{8,80}$/i,
  "Refusing to run without a disposable CUBE-RP-IT-RCBL namespace",
);
assert.equal(
  process.env.CUBE_LOCAL_INTEGRATION_TEST_MODE,
  "1",
  "Refusing to run without explicit local integration-test mode",
);
assert.equal(
  process.env.CUBE_RECONCILIATION_INTEGRATION_TEST_NAMESPACE,
  namespace,
  "The API server and test must use the same reconciliation namespace",
);

const tables = {
  current: process.env.CUBE_RCBL_SHORT_TABLE_NAME,
  history: process.env.CUBE_RCBL_SHORT_HISTORY_TABLE_NAME,
  reconciliation: process.env.CUBE_RECONCILIATION_TABLE_NAME,
  invoices: process.env.CUBE_INVOICES_TABLE_NAME,
  rates: process.env.CUBE_3556_TABLE_NAME,
  customers: process.env.CUBE_CUSTOMERS_TABLE_NAME,
  control: `${namespace}-CONTROL`,
};
for (const [purpose, tableName] of Object.entries(tables)) {
  assert.ok(tableName?.startsWith(`${namespace}-`), `${purpose} table is not disposable`);
}

const lowLevel = new DynamoDBClient({
  endpoint,
  region: "local",
  credentials: {
    accessKeyId: "DUMMYLOCALACCESSKEY",
    secretAccessKey: "DUMMYLOCALSECRETKEY",
  },
  maxAttempts: 1,
});
lowLevel.middlewareStack.add(
  (next) => async (args) => {
    const { protocol, hostname, port } = args.request;
    assert.equal(protocol, "http:");
    assert.equal(hostname, "127.0.0.1");
    assert.equal(port, 8000);
    const command = args.input ?? {};
    const tableNames = new Set([
      ...(typeof command.TableName === "string" ? [command.TableName] : []),
      ...Object.keys(command.RequestItems ?? {}),
      ...(command.TransactItems ?? []).flatMap((transaction) =>
        Object.values(transaction).flatMap((operation) =>
          typeof operation?.TableName === "string" ? [operation.TableName] : [],
        ),
      ),
    ]);
    assert.ok(tableNames.size > 0, "DynamoDB command did not identify its target table");
    for (const tableName of tableNames) {
      assert.ok(tableName.startsWith(`${namespace}-`), `Blocked non-disposable table ${tableName}`);
    }
    return next(args);
  },
  { name: "rcblIntegrationLocalOnly", step: "finalizeRequest", priority: "high" },
);
const ddb = DynamoDBDocumentClient.from(lowLevel, {
  marshallOptions: { removeUndefinedValues: true },
});

const attribute = (AttributeName, AttributeType) => ({ AttributeName, AttributeType });
const definitions = [
  {
    TableName: tables.current,
    AttributeDefinitions: [attribute("RCBLShortID", "S")],
    KeySchema: [{ AttributeName: "RCBLShortID", KeyType: "HASH" }],
  },
  {
    TableName: tables.history,
    AttributeDefinitions: [attribute("billing_period_id", "N"), attribute("HistoryKey", "S")],
    KeySchema: [
      { AttributeName: "billing_period_id", KeyType: "HASH" },
      { AttributeName: "HistoryKey", KeyType: "RANGE" },
    ],
  },
  {
    TableName: tables.reconciliation,
    AttributeDefinitions: [attribute("billing_period_id", "N"), attribute("ReconciliationID", "S")],
    KeySchema: [
      { AttributeName: "billing_period_id", KeyType: "HASH" },
      { AttributeName: "ReconciliationID", KeyType: "RANGE" },
    ],
  },
  {
    TableName: tables.invoices,
    AttributeDefinitions: [attribute("invoiceid", "S")],
    KeySchema: [{ AttributeName: "invoiceid", KeyType: "HASH" }],
  },
  {
    TableName: tables.rates,
    AttributeDefinitions: [attribute("PK", "S"), attribute("SK", "S")],
    KeySchema: [
      { AttributeName: "PK", KeyType: "HASH" },
      { AttributeName: "SK", KeyType: "RANGE" },
    ],
  },
  {
    TableName: tables.customers,
    AttributeDefinitions: [attribute("CustomerID", "S")],
    KeySchema: [{ AttributeName: "CustomerID", KeyType: "HASH" }],
  },
  {
    TableName: tables.control,
    AttributeDefinitions: [attribute("PK", "S"), attribute("SK", "S")],
    KeySchema: [
      { AttributeName: "PK", KeyType: "HASH" },
      { AttributeName: "SK", KeyType: "RANGE" },
    ],
  },
].map((definition) => ({ ...definition, BillingMode: "PAY_PER_REQUEST" }));

const createdTables = new Set();

async function exists(TableName) {
  try {
    await lowLevel.send(new DescribeTableCommand({ TableName }));
    return true;
  } catch (error) {
    if (error?.name === "ResourceNotFoundException") return false;
    throw error;
  }
}

async function waitFor(TableName, shouldExist) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if ((await exists(TableName)) === shouldExist) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${TableName}`);
}

async function createTables() {
  for (const definition of definitions) {
    assert.equal(await exists(definition.TableName), false, `${definition.TableName} already exists`);
    await lowLevel.send(new CreateTableCommand(definition));
    createdTables.add(definition.TableName);
    await waitFor(definition.TableName, true);
  }
}

async function cleanup() {
  for (const definition of [...definitions].reverse()) {
    if (!createdTables.has(definition.TableName)) continue;
    if (!(await exists(definition.TableName))) continue;
    await lowLevel.send(new DeleteTableCommand({ TableName: definition.TableName }));
    await waitFor(definition.TableName, false);
    createdTables.delete(definition.TableName);
  }
}

async function batchPut(TableName, items) {
  for (let offset = 0; offset < items.length; offset += 25) {
    let pending = items.slice(offset, offset + 25).map((Item) => ({ PutRequest: { Item } }));
    while (pending.length) {
      const result = await ddb.send(
        new BatchWriteCommand({ RequestItems: { [TableName]: pending } }),
      );
      pending = result.UnprocessedItems?.[TableName] ?? [];
    }
  }
}

async function scanPeriod(tableName, billingPeriodId) {
  const rows = [];
  let ExclusiveStartKey;
  do {
    const result = await ddb.send(
      new ScanCommand({
        TableName: tableName,
        FilterExpression: "billing_period_id = :period",
        ExpressionAttributeValues: { ":period": billingPeriodId },
        ExclusiveStartKey,
      }),
    );
    rows.push(...(result.Items ?? []));
    ExclusiveStartKey = result.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return rows;
}

async function currentPointer(billingPeriodId) {
  return (await scanPeriod(tables.current, billingPeriodId)).find(
    (row) => row.RecordType === "BILL_VERSION_POINTER",
  ) ?? null;
}

async function api(path, init) {
  const response = await fetch(`${baseUrl}${path}`, init);
  const contentType = response.headers.get("content-type") ?? "";
  const body = contentType.includes("json") ? await response.json() : await response.text();
  return { response, body };
}

async function preview(period) {
  const result = await api(`/api/billing/rcbl-short?billing_period_id=${period}`);
  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.preview, true);
  assert.equal(result.body.reconciliationReady, true);
  assert.match(result.body.previewFingerprint ?? "", /^[a-f0-9]{64}$/);
  assert.ok(result.body.reconciliationSnapshotId, "GET preview must provide a reconciliation snapshot ID");
  return result.body;
}

async function save(period, billPreview, replace, reason, overrides = {}) {
  assert.equal(Number(billPreview.billingPeriodId), period);
  if (replace) assert.ok(reason.trim(), "Replacement requires a reason");
  const requestBody = {
    billing_period_id: period,
    replace,
    replacement_reason: reason,
    preview_fingerprint: overrides.previewFingerprint ?? billPreview.previewFingerprint,
    reconciliation_snapshot_id:
      overrides.reconciliationSnapshotId ?? billPreview.reconciliationSnapshotId,
  };
  const compactBody = JSON.stringify(requestBody);
  assert.ok(Buffer.byteLength(compactBody, "utf8") < 1024, "Save request must stay compact");
  assert.equal(Object.hasOwn(requestBody, "preview"), false);
  assert.equal(Object.hasOwn(requestBody, "customers"), false);
  assert.equal(Object.hasOwn(requestBody, "lines"), false);
  assert.doesNotMatch(compactBody, /"customers"|"lines"|"billingLines"/i);
  return api("/api/billing/rcbl-short", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: compactBody,
  });
}

function summary(period, utilityType, sourceConsumption, allocationCount) {
  return {
    billing_period_id: period,
    ReconciliationID: `SUMMARY#1#${utilityType}`,
    RecordType: "SUMMARY",
    FY: 2026,
    BillingMonth: "February",
    UtilityGroup: "1",
    UtilityType: utilityType,
    SourceConsumption: sourceConsumption,
    InvoiceConsumption: sourceConsumption,
    AllocatedTotalConsumption: sourceConsumption,
    AccountedConsumption: sourceConsumption,
    AccountingDifference: 0,
    Difference: 0,
    AccountingStatus: "RECONCILED",
    BillingReady: 1,
    ReconciliationStatus: "BILLING_READY",
    IssueCount: 0,
    Issues: [],
    AllocationRows: allocationCount,
  };
}

function allocation(period, id, utilityType, consumption, source, disposition) {
  const reimbursable = disposition === "CUSTOMER_REIMBURSABLE";
  return {
    billing_period_id: period,
    ReconciliationID: id,
    RecordType: "ALLOCATION",
    FY: 2026,
    BillingMonth: "February",
    UtilityGroup: "1",
    UtilityType: utilityType,
    ConsumptionUM: utilityType === "EL" ? "KWH" : "KGAL",
    CustomerID: "SYNTH-REIMB-C001",
    CustomerName: "Synthetic Reimbursement Customer",
    CustomerType: "Reimbursable",
    ReportType: "SHORT",
    RateClass: "DOD Fed",
    FacilityID: "SYNTH-FAC-1",
    FacilityNumber: "999991",
    CategoryCode: "SYNTH",
    AllocationSource: source,
    SourceID: id,
    AllocatedTotalConsumption: consumption,
    AllocatedReimbursableConsumption: reimbursable ? consumption : 0,
    AllocatedCEAbsorbedConsumption: reimbursable ? 0 : consumption,
    ReimbursementUtilityType: utilityType,
    EffectiveReimbursementType: reimbursable ? "Reimbursable" : "Non-Reimbursable",
    ReimbursementSource: source === "DERIVED_SS" ? "RP_OVERRIDE" : "CUSTOMER_REGISTRY",
    ReimbursementOverride: source === "DERIVED_SS" ? reimbursable : null,
    ReimbursementOverrideApplied: source === "DERIVED_SS" ? 1 : 0,
    ReimbursementDisposition: disposition,
  };
}

async function putRate(utilitySystem, rate) {
  await ddb.send(
    new PutCommand({
      TableName: tables.rates,
      Item: {
        PK: `RATE#WWYK#${utilitySystem}`,
        SK: "2026-01-01",
        id: `SYNTH-${utilitySystem}`,
        status: "FINAL",
        utilityGroup: "WWYK",
        utilitySystem,
        effectiveDate: "2026-01-01",
        calculatedSalesRates: { dod: rate },
      },
    }),
  );
}

async function seedReimbursementScenario(period, ssReimbursable) {
  const pwConsumption = 40;
  const ssPwFactor = 0.25;
  const ssConsumption = pwConsumption * ssPwFactor;
  const pwKwhPerKgal = (600 * 0.00315) / 0.624;
  const pwPumping = Math.round(pwConsumption * pwKwhPerKgal * 1e8) / 1e8;
  const ssPumping = Math.round(ssConsumption * 2.18 * 1e8) / 1e8;
  const directEl = 100;
  const elTotal = directEl + pwPumping + ssPumping;
  const rows = [
    allocation(period, "ALLOC#EL", "EL", directEl, "METER", "CUSTOMER_REIMBURSABLE"),
    allocation(period, "ALLOC#PW", "PW", pwConsumption, "METER", "CUSTOMER_REIMBURSABLE"),
    allocation(period, "ALLOC#SS", "SS", ssConsumption, "DERIVED_SS", ssReimbursable ? "CUSTOMER_REIMBURSABLE" : "CE_ABSORBED"),
    allocation(period, "ALLOC#PW_PUMPING", "EL", pwPumping, "PW_PUMPING", "CUSTOMER_REIMBURSABLE"),
    allocation(period, "ALLOC#SS_PUMPING", "EL", ssPumping, "SS_PUMPING", "CUSTOMER_REIMBURSABLE"),
    summary(period, "EL", elTotal, 3),
    summary(period, "PW", pwConsumption, 1),
    summary(period, "SS", ssConsumption, 1),
  ];
  await batchPut(tables.reconciliation, rows);
  await batchPut(tables.invoices, [
    { invoiceid: `INV-${period}-EL`, billing_period_id: period, utility_group_id: 1, utility_type_cd: "EL", consumption: elTotal, consumption_um: "KWH", charge: elTotal * 0.1 },
    { invoiceid: `INV-${period}-PW`, billing_period_id: period, utility_group_id: 1, utility_type_cd: "PW", consumption: pwConsumption, consumption_um: "KGAL", charge: pwConsumption * 2 },
    { invoiceid: `INV-${period}-SS`, billing_period_id: period, utility_group_id: 1, utility_type_cd: "SS", consumption: ssConsumption, consumption_um: "KGAL", charge: ssConsumption * 3 },
  ]);
  return { directEl, pwConsumption, ssConsumption, pwPumping, ssPumping, elTotal };
}

async function runReimbursementScenario() {
  const period = 920000 + (Date.now() % 9999);
  const engineering = await seedReimbursementScenario(period, false);
  await batchPut(tables.customers, [
    { CustomerID: "SYNTH-REIMB-C001", CustomerName: "Synthetic Reimbursement Customer", CustomerType: "Reimbursable", RateClass: "DOD Fed", RCBLComment: "Disposable integration fixture" },
  ]);
  await putRate("ELECTRICITY", 0.1);
  await putRate("PRODUCEDWATER", 2);
  await putRate("SEWER", 3);

  const offPreview = await preview(period);
  assert.equal(offPreview.customers.length, 1);
  const customer = offPreview.customers[0];
  assert.equal(customer.lines.length, 5);
  const ss = customer.lines.find((line) => line.reconciliationId === "ALLOC#SS");
  const pwPump = customer.lines.find((line) => line.reconciliationId === "ALLOC#PW_PUMPING");
  const ssPump = customer.lines.find((line) => line.reconciliationId === "ALLOC#SS_PUMPING");
  assert.equal(ss.allocatedConsumption, engineering.ssConsumption);
  assert.equal(ss.calculatedAmount, 30);
  assert.equal(ss.customerChargeAmount, 0);
  assert.equal(ss.ceAbsorbedAmount, 30);
  assert.equal(ss.reimbursementDisposition, "CE_ABSORBED");
  assert.equal(pwPump.reimbursementDisposition, "CUSTOMER_REIMBURSABLE");
  assert.equal(ssPump.reimbursementDisposition, "CUSTOMER_REIMBURSABLE");
  assert.equal(pwPump.utilityType, "EL");
  assert.equal(ssPump.utilityType, "EL");
  assert.equal(offPreview.summary.totalCEAbsorbed, 30);
  assert.equal(offPreview.summary.totalCustomerBilling, 104.3);
  assert.equal(offPreview.summary.totalCalculatedBilling, 134.3);

  const modifiedFingerprint = await save(period, offPreview, false, "", {
    previewFingerprint: "0".repeat(64),
  });
  assert.equal(modifiedFingerprint.response.status, 409, JSON.stringify(modifiedFingerprint.body));
  assert.equal(modifiedFingerprint.body.stalePreview, true);
  assert.equal((await scanPeriod(tables.current, period)).length, 0);

  await putRate("ELECTRICITY", 0.11);
  const staleFingerprint = await save(period, offPreview, false, "");
  assert.equal(staleFingerprint.response.status, 409, JSON.stringify(staleFingerprint.body));
  assert.equal(staleFingerprint.body.stalePreview, true);
  assert.equal((await scanPeriod(tables.current, period)).length, 0);

  await putRate("ELECTRICITY", 0.1);
  const freshOffPreview = await preview(period);
  assert.equal(freshOffPreview.summary.totalCustomerBilling, offPreview.summary.totalCustomerBilling);
  const initialSave = await save(period, freshOffPreview, false, "");
  assert.equal(initialSave.response.status, 200, JSON.stringify(initialSave.body));
  assert.equal(initialSave.body.versionNumber, 1);
  const expectedInitialRecords = 1 + freshOffPreview.customers.length +
    freshOffPreview.customers.reduce((sum, entry) => sum + entry.lines.length, 0);
  assert.equal(initialSave.body.savedRecordCount, expectedInitialRecords);
  const initialPersistedRows = await scanPeriod(tables.current, period);
  assert.equal(initialPersistedRows.length, expectedInitialRecords + 1);
  assert.equal(initialPersistedRows.filter((row) => row.VersionId === initialSave.body.versionId).length, expectedInitialRecords);
  assert.equal((await currentPointer(period))?.CurrentVersionId, initialSave.body.versionId);
  const savedOff = await api(`/api/billing/rcbl-short?billing_period_id=${period}&view=saved`);
  assert.equal(savedOff.response.status, 200);
  assert.equal(savedOff.body.customers[0].totalAmount, 104.3);
  assert.equal(savedOff.body.summary.totalCustomerBilling, freshOffPreview.summary.totalCustomerBilling);

  const detailCsv = await api(`/api/billing/rcbl-short/export?billing_period_id=${period}&format=detail-csv`);
  assert.equal(detailCsv.response.status, 200);
  assert.match(String(detailCsv.body), /CE Absorbed Amount/);
  assert.match(String(detailCsv.body), /CE_ABSORBED/);
  assert.match(String(detailCsv.body), /"30"/);

  await ddb.send(new PutCommand({
    TableName: tables.reconciliation,
    Item: allocation(period, "ALLOC#SS", "SS", engineering.ssConsumption, "DERIVED_SS", "CUSTOMER_REIMBURSABLE"),
  }));
  const onPreview = await preview(period);
  assert.equal(onPreview.summary.totalCEAbsorbed, 0);
  assert.equal(onPreview.summary.totalCustomerBilling, 134.3);
  assert.equal(onPreview.summary.totalCalculatedBilling, 134.3);
  assert.deepEqual(
    onPreview.customers[0].lines.map((line) => [line.reconciliationId, line.allocatedConsumption, line.rate]),
    offPreview.customers[0].lines.map((line) => [line.reconciliationId, line.allocatedConsumption, line.rate]),
  );
  const replacement = await save(period, onPreview, true, "SS reimbursement switched ON in disposable test");
  assert.equal(replacement.response.status, 200, JSON.stringify(replacement.body));
  assert.equal(replacement.body.versionNumber, 2);
  assert.equal((await currentPointer(period))?.CurrentVersionId, replacement.body.versionId);
  const savedOn = await api(`/api/billing/rcbl-short?billing_period_id=${period}&view=saved`);
  assert.equal(savedOn.response.status, 200);
  assert.equal(savedOn.body.savedVersionNumber, 2);
  assert.equal(savedOn.body.summary.totalCustomerBilling, onPreview.summary.totalCustomerBilling);
  assert.equal(savedOn.body.customers.reduce((sum, customer) => sum + customer.totalAmount, 0), 134.3);

  const history = await api(`/api/billing/rcbl-short?billing_period_id=${period}&view=history`);
  assert.equal(history.response.status, 200);
  assert.equal(history.body.versions.length, 1);
  assert.equal(history.body.versions[0].versionId, initialSave.body.versionId);
  assert.equal(history.body.versions[0].versionNumber, 1);
  assert.equal(history.body.versions[0].recordCount, expectedInitialRecords);
  const bothVersions = await scanPeriod(tables.current, period);
  assert.equal(bothVersions.length, expectedInitialRecords * 2 + 1);
  assert.equal(bothVersions.filter((row) => row.VersionId === initialSave.body.versionId).length, expectedInitialRecords);
  assert.equal(bothVersions.filter((row) => row.VersionId === replacement.body.versionId).length, expectedInitialRecords);
  const historical = await api(`/api/billing/rcbl-short?billing_period_id=${period}&view=history&version_id=${encodeURIComponent(history.body.versions[0].versionId)}`);
  assert.equal(historical.response.status, 200);
  assert.equal(historical.body.readOnly, true);
  assert.equal(historical.body.savedVersionNumber, 1);
  assert.equal(historical.body.customers[0].totalAmount, 104.3);
  assert.equal(historical.body.customers[0].lines.find((line) => line.reconciliationId === "ALLOC#SS").ceAbsorbedAmount, 30);

  await ddb.send(new PutCommand({
    TableName: tables.reconciliation,
    Item: allocation(period, "ALLOC#SS", "SS", engineering.ssConsumption, "DERIVED_SS", "CE_ABSORBED"),
  }));
  const offAgain = await preview(period);
  assert.equal(offAgain.summary.totalCustomerBilling, 104.3);
  assert.equal(offAgain.summary.totalCEAbsorbed, 30);
  return { period, engineering, offTotal: 104.3, onTotal: 134.3 };
}

async function seedImmutableScenario(period) {
  const allocations = [];
  let lineNumber = 0;
  for (let customerIndex = 0; customerIndex < 52; customerIndex += 1) {
    const lineCount = customerIndex < 51 ? 87 : 90;
    for (let index = 0; index < lineCount; index += 1) {
      lineNumber += 1;
      allocations.push({
        ...allocation(period, `SCALE#${lineNumber}`, "EL", 10, "METER", "CUSTOMER_REIMBURSABLE"),
        CustomerID: `SYNTH-C${String(customerIndex + 1).padStart(3, "0")}`,
        CustomerName: `Synthetic Customer ${customerIndex + 1}`,
      });
    }
  }
  assert.equal(allocations.length, 4527);
  await batchPut(tables.reconciliation, [...allocations, summary(period, "EL", 45270, 4527)]);
  await batchPut(tables.invoices, [
    { invoiceid: `INV-${period}-EL`, billing_period_id: period, utility_group_id: 1, utility_type_cd: "EL", consumption: 45270, consumption_um: "KWH", charge: 4527 },
  ]);
  await batchPut(tables.customers, Array.from({ length: 52 }, (_, index) => ({
    CustomerID: `SYNTH-C${String(index + 1).padStart(3, "0")}`,
    CustomerName: `Synthetic Customer ${index + 1}`,
    RCBLComment: "Immutable version fixture",
  })));
}

async function runImmutableScenario() {
  const period = 900000 + (Date.now() % 99999);
  await seedImmutableScenario(period);
  const timings = {};
  let lastPreview;
  let initialVersionId = "";
  for (const [index, rate] of [0.1, 0.2, 0.3].entries()) {
    await putRate("ELECTRICITY", rate);
    const billPreview = await preview(period);
    lastPreview = billPreview;
    const started = performance.now();
    const result = await save(period, billPreview, index > 0, index > 0 ? `Synthetic immutable replacement ${index}` : "");
    timings[`save${index + 1}Ms`] = Math.round(performance.now() - started);
    assert.equal(result.response.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.versionNumber, index + 1);
    assert.equal(result.body.savedRecordCount, 4580);
    if (index === 0) initialVersionId = result.body.versionId;
  }

  const saved = await api(`/api/billing/rcbl-short?billing_period_id=${period}&view=saved`);
  assert.equal(saved.response.status, 200);
  assert.equal(saved.body.customers.length, 52);
  assert.equal(saved.body.customers[0].totalAmount, 261);
  assert.equal(saved.body.savedVersionNumber, 3);
  assert.equal(saved.body.summary.totalCustomerBilling, lastPreview.summary.totalCustomerBilling);
  assert.equal(saved.body.customers.reduce((sum, customer) => sum + customer.totalAmount, 0), 13581);
  assert.equal((await currentPointer(period))?.CurrentVersionId, saved.body.savedVersionId);
  const historyList = await api(`/api/billing/rcbl-short?billing_period_id=${period}&view=history`);
  assert.equal(historyList.response.status, 200);
  assert.equal(historyList.body.versions.length, 2);
  assert.deepEqual(historyList.body.versions.map((entry) => entry.versionNumber).sort(), [1, 2]);
  assert.equal(historyList.body.versions.some((entry) => entry.versionId === initialVersionId), true);
  for (const version of historyList.body.versions) {
    const historical = await api(`/api/billing/rcbl-short?billing_period_id=${period}&view=history&version_id=${encodeURIComponent(version.versionId)}`);
    assert.equal(historical.response.status, 200);
    assert.equal(historical.body.readOnly, true);
    assert.equal(historical.body.customers.reduce((sum, customer) => sum + customer.lines.length, 0), 4527);
  }

  await putRate("ELECTRICITY", 0.4);
  const concurrentPreview = await preview(period);
  const [a, b] = await Promise.all([
    save(period, concurrentPreview, true, "Concurrent replacement A"),
    save(period, concurrentPreview, true, "Concurrent replacement B"),
  ]);
  const concurrentStatuses = [a.response.status, b.response.status].sort();
  assert.deepEqual(concurrentStatuses, [200, 409]);
  const concurrentWinner = a.response.status === 200 ? a.body : b.body;
  assert.equal(concurrentWinner.versionNumber, 4);
  const concurrentSaved = await api(`/api/billing/rcbl-short?billing_period_id=${period}&view=saved`);
  assert.equal(concurrentSaved.response.status, 200);
  assert.equal(concurrentSaved.body.savedVersionNumber, 4);
  assert.equal(concurrentSaved.body.summary.totalCustomerBilling, concurrentPreview.summary.totalCustomerBilling);
  assert.equal(
    concurrentSaved.body.customers.reduce((sum, customer) => sum + customer.totalAmount, 0),
    concurrentPreview.summary.totalCustomerBilling,
  );

  const current = await scanPeriod(tables.current, period);
  const history = await scanPeriod(tables.history, period);
  const pointer = current.find((row) => row.RecordType === "BILL_VERSION_POINTER");
  assert.ok(pointer?.CurrentVersionId);
  assert.equal(pointer.CurrentVersionId, concurrentWinner.versionId);
  assert.equal(history.length, 3);
  assert.deepEqual(
    (await api(`/api/billing/rcbl-short?billing_period_id=${period}&view=history`)).body.versions
      .map((entry) => entry.versionNumber).sort(),
    [1, 2, 3],
  );
  assert.equal(current.filter((row) => row.VersionId === pointer.CurrentVersionId).length, 4580);
  return {
    period,
    timings,
    concurrentStatuses,
    currentRecords: current.length,
    versionNumbers: [1, 2, 3, 4],
    activeVersionId: pointer.CurrentVersionId,
    historyRows: history.length,
    authoritativeTotal: lastPreview.summary.totalCustomerBilling,
  };
}

async function runFailedCandidateWriteScenario() {
  const period = 940000 + (Date.now() % 9999);
  const normalAllocations = Array.from({ length: 25 }, (_, index) => ({
    ...allocation(period, `FAIL#NORMAL#${index + 1}`, "EL", 10, "METER", "CUSTOMER_REIMBURSABLE"),
    CustomerID: "SYNTH-FAIL-C001",
    CustomerName: "Synthetic Failure Customer 1",
  }));
  const oversizedAllocation = {
    ...allocation(period, "FAIL#OVERSIZED", "EL", 10, "METER", "CUSTOMER_REIMBURSABLE"),
    CustomerID: "SYNTH-FAIL-C002",
  };
  // Keep the source reconciliation item within DynamoDB's 400 KiB limit,
  // while leaving so little headroom that the bill's copied version metadata
  // pushes its generated CUSTOMER_BILL candidate over the limit. This tests
  // failure during the API's candidate-write phase, rather than failing while
  // seeding an invalid oversized source fixture.
  let acceptedNameLength = 0;
  for (let nameLength = 408_000; nameLength >= 400_000; nameLength -= 256) {
    try {
      await ddb.send(new PutCommand({
        TableName: tables.reconciliation,
        Item: {
          ...oversizedAllocation,
          CustomerName: "X".repeat(nameLength),
        },
      }));
      acceptedNameLength = nameLength;
      break;
    } catch (error) {
      if (!/item size|maximum allowed size|400\s?kb/i.test(String(error?.message ?? error))) {
        throw error;
      }
    }
  }
  assert.ok(acceptedNameLength > 0, "Could not seed a valid near-limit reconciliation item");
  await batchPut(tables.reconciliation, [
    ...normalAllocations,
    summary(period, "EL", 260, 26),
  ]);
  await batchPut(tables.invoices, [{
    invoiceid: `INV-${period}-EL`,
    billing_period_id: period,
    utility_group_id: 1,
    utility_type_cd: "EL",
    consumption: 260,
    consumption_um: "KWH",
    charge: 26,
  }]);
  await batchPut(tables.customers, [
    { CustomerID: "SYNTH-FAIL-C001", CustomerName: "Synthetic Failure Customer 1", CustomerType: "Reimbursable", RateClass: "DOD Fed" },
    { CustomerID: "SYNTH-FAIL-C002", CustomerName: "Synthetic Failure Customer 2", CustomerType: "Reimbursable", RateClass: "DOD Fed" },
  ]);
  await putRate("ELECTRICITY", 0.1);

  const billPreview = await preview(period);
  assert.equal(billPreview.summary.totalCustomerBilling, 26);
  const failed = await save(period, billPreview, false, "");
  assert.equal(failed.response.status, 503, JSON.stringify({ status: failed.response.status, body: failed.body }));
  assert.equal(failed.body.code, "DYNAMODB_CONFIGURATION_ERROR");

  const rowsAfterFailure = await scanPeriod(tables.current, period);
  assert.ok(rowsAfterFailure.length > 0, "Earlier candidate batches should persist before the oversized item fails");
  assert.equal(rowsAfterFailure.some((row) => row.RecordType === "BILL_VERSION_POINTER"), false);
  assert.equal(new Set(rowsAfterFailure.map((row) => row.VersionId)).size, 1);
  const savedAfterFailure = await api(`/api/billing/rcbl-short?billing_period_id=${period}&view=saved`);
  assert.equal(savedAfterFailure.response.status, 404);

  return {
    period,
    acceptedSourceCustomerNameBytes: acceptedNameLength,
    candidateRowsWrittenBeforeFailure: rowsAfterFailure.length,
    pointerActivated: false,
    savedViewStatus: savedAfterFailure.response.status,
    apiStatus: failed.response.status,
    apiCode: failed.body.code,
  };
}

try {
  await createTables();
  const reimbursement = await runReimbursementScenario();
  const immutable = await runImmutableScenario();
  const failedCandidateWrite = await runFailedCandidateWriteScenario();
  console.log(JSON.stringify({ ok: true, namespace, tables, reimbursement, immutable, failedCandidateWrite }, null, 2));
} finally {
  await cleanup();
}
