import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import net from "node:net";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import {
  CreateTableCommand,
  DeleteTableCommand,
  DescribeTableCommand,
  DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";

const ENDPOINT = "http://127.0.0.1:8000";
const nextEnvPath = resolve("next-env.d.ts");
const originalNextEnv = readFileSync(nextEnvPath, "utf8");
const disposableNextBuild = resolve(".next-rp-integration-test");
const namespace = `CUBE-RP-IT-${Date.now()}-${process.pid}`;
const table = (suffix) => `${namespace}-${suffix}`;
const tables = Object.freeze({
  customers: table("CUSTOMERS"),
  facilities: table("FACILITIES"),
  categories: table("CATEGORY-CODES"),
  intensities: table("INTENSITY-VALUES"),
  legacy: table("RP-LEGACY"),
  monthly: table("RP-MONTHLY"),
  estimates: table("ESTIMATES"),
  propQ: table("RP-PROPQ"),
  control: table("CONTROL"),
});
const createdTables = [];

function hash(name, type = "S") {
  return { name, type, keyType: "HASH" };
}

function range(name, type = "S") {
  return { name, type, keyType: "RANGE" };
}

function definition(TableName, keys, billingPeriodIndex = false) {
  const attributes = [...keys];
  if (billingPeriodIndex) attributes.push(hash("billing_period_id", "N"));
  return {
    TableName,
    BillingMode: "PAY_PER_REQUEST",
    AttributeDefinitions: attributes.map(({ name: AttributeName, type: AttributeType }) => ({
      AttributeName,
      AttributeType,
    })),
    KeySchema: keys.map(({ name: AttributeName, keyType: KeyType }) => ({
      AttributeName,
      KeyType,
    })),
    ...(billingPeriodIndex
      ? {
          GlobalSecondaryIndexes: [
            {
              IndexName: "billing-period-index",
              KeySchema: [{ AttributeName: "billing_period_id", KeyType: "HASH" }],
              Projection: { ProjectionType: "ALL" },
            },
          ],
        }
      : {}),
  };
}

const definitions = [
  definition(tables.customers, [hash("CustomerID")]),
  definition(tables.facilities, [hash("FacilityID")]),
  definition(tables.categories, [hash("category_cd")]),
  definition(tables.intensities, [hash("intensityid")]),
  definition(tables.legacy, [hash("LegacyRPID")]),
  definition(tables.monthly, [hash("MonthlyRPID")], true),
  definition(tables.estimates, [hash("EstimateID")], true),
  definition(tables.propQ, [hash("PropQID")], true),
  definition(tables.control, [hash("PK"), range("SK")]),
];

function commandTableNames(input) {
  if (!input || typeof input !== "object") return [];
  const names = new Set();
  if (typeof input.TableName === "string") names.add(input.TableName);
  for (const name of Object.keys(input.RequestItems ?? {})) names.add(name);
  for (const transaction of input.TransactItems ?? []) {
    for (const operation of Object.values(transaction)) {
      if (typeof operation?.TableName === "string") names.add(operation.TableName);
    }
  }
  return [...names];
}

const lowLevel = new DynamoDBClient({
  endpoint: ENDPOINT,
  region: "local",
  credentials: {
    accessKeyId: "DUMMYLOCALACCESSKEY",
    secretAccessKey: "DUMMYLOCALSECRETKEY",
  },
  maxAttempts: 1,
});

lowLevel.middlewareStack.add(
  (next) => async (args) => {
    const unsafe = commandTableNames(args.input).find(
      (name) => !name.startsWith(`${namespace}-`),
    );
    assert.equal(unsafe, undefined, `Blocked fixture access to ${unsafe}`);
    const endpoint = await lowLevel.config.endpoint();
    assert.equal(endpoint.protocol, "http:");
    assert.equal(endpoint.hostname, "127.0.0.1");
    assert.equal(endpoint.port, 8000);
    return next(args);
  },
  { name: "isolatedFixtureGuard", step: "initialize" },
);

lowLevel.middlewareStack.add(
  (next) => async (args) => {
    assert.equal(args.request.protocol, "http:");
    assert.equal(args.request.hostname, "127.0.0.1");
    assert.equal(args.request.port, 8000);
    return next(args);
  },
  { name: "isolatedFixtureHttpGuard", step: "finalizeRequest", priority: "high" },
);

const ddb = DynamoDBDocumentClient.from(lowLevel, {
  marshallOptions: { removeUndefinedValues: true },
});

async function waitForTable(TableName, expected) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const result = await lowLevel.send(new DescribeTableCommand({ TableName }));
      if (expected === "ACTIVE" && result.Table?.TableStatus === "ACTIVE") return;
    } catch (error) {
      if (expected === "DELETED" && error?.name === "ResourceNotFoundException") return;
      if (error?.name !== "ResourceNotFoundException") throw error;
    }
    await delay(50);
  }
  throw new Error(`Timed out waiting for ${TableName} to become ${expected}.`);
}

async function createFixtureTables() {
  for (const item of definitions) {
    try {
      await lowLevel.send(new DescribeTableCommand({ TableName: item.TableName }));
      throw new Error(`Refusing to reuse existing fixture table ${item.TableName}.`);
    } catch (error) {
      if (error?.name !== "ResourceNotFoundException") throw error;
    }
    await lowLevel.send(new CreateTableCommand(item));
    createdTables.push(item.TableName);
    await waitForTable(item.TableName, "ACTIVE");
  }
}

async function cleanupFixtureTables() {
  for (const TableName of [...createdTables].reverse()) {
    assert.ok(TableName.startsWith(`${namespace}-`));
    try {
      await lowLevel.send(new DeleteTableCommand({ TableName }));
      await waitForTable(TableName, "DELETED");
    } catch (error) {
      if (error?.name !== "ResourceNotFoundException") throw error;
    }
  }
}

async function seedFixture() {
  const items = [
    [tables.customers, { CustomerID: "CUST-1", CustomerName: "Test Customer" }],
    [tables.customers, { CustomerID: "CUST-2", CustomerName: "Replacement Customer" }],
    [
      tables.facilities,
      {
        FacilityID: "FAC-4058",
        FacilityNumber: "4058",
        SITE_CD: "FAA",
        RPUID: "RP-4058",
      },
    ],
    [
      tables.categories,
      { category_cd: "CAT-1", space_type_id: "10", space_type: "Office" },
    ],
    [
      tables.intensities,
      {
        intensityid: "2026#EL#10",
        fy: 2026,
        utility_type_cd: "EL",
        space_type_id: "10",
        index: 0.5,
      },
    ],
    [
      tables.intensities,
      {
        intensityid: "2026#NG#10",
        fy: 2026,
        utility_type_cd: "NG",
        space_type_id: "10",
        index: 0.1,
      },
    ],
    [
      tables.intensities,
      {
        intensityid: "2026#PW#10",
        fy: 2026,
        utility_type_cd: "PW",
        space_type_id: "10",
        index: 0.25,
      },
    ],
    ...[
      ["EL", 0.25],
      ["NG", 0.2],
      ["PW", 0.5],
    ].map(([utility, index]) => [
      tables.intensities,
      {
        intensityid: `2026#${utility}#20`,
        fy: 2026,
        utility_type_cd: utility,
        space_type_id: "20",
        index,
      },
    ]),
    [
      tables.legacy,
      {
        LegacyRPID: "LRP-BASE-1",
        FY: 2026,
        FacilityID: "FAC-4058",
        CustomerID: "CUST-1",
        LegacyCustomerName: "Test Customer",
        CustomerQty: 100,
        AllocationUM: "SF",
        UtilityGroup: 1,
        CategoryCode: "CAT-1",
        FacilityNumber: "4058",
        SiteCode: "FAA",
        ELUsage: 1,
        PWUsage: 1,
      },
    ],
    [
      tables.legacy,
      {
        LegacyRPID: "LRP-BASE-2",
        FY: 2026,
        FacilityID: "FAC-4058",
        CustomerID: "CUST-2",
        LegacyCustomerName: "Replacement Customer",
        CustomerQty: 50,
        AllocationUM: "SF",
        UtilityGroup: 1,
        CategoryCode: "CAT-1",
        FacilityNumber: "4058",
        SiteCode: "FAA",
        NGUsage: 1,
      },
    ],
  ];
  for (const [TableName, Item] of items) {
    await ddb.send(new PutCommand({ TableName, Item }));
  }
}

async function scan(TableName) {
  const result = await ddb.send(new ScanCommand({ TableName, ConsistentRead: true }));
  return result.Items ?? [];
}

function canonical(items) {
  return JSON.stringify(
    [...items].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  );
}

async function state(billingPeriodId) {
  const result = await ddb.send(
    new GetCommand({
      TableName: tables.control,
      Key: { PK: `RP_PERIOD#${billingPeriodId}`, SK: "ACTIVE" },
      ConsistentRead: true,
    }),
  );
  return result.Item ?? null;
}

async function periodRows(TableName, billingPeriodId) {
  const result = await ddb.send(
    new QueryCommand({
      TableName,
      IndexName: "billing-period-index",
      KeyConditionExpression: "billing_period_id = :bp",
      ExpressionAttributeValues: { ":bp": billingPeriodId },
    }),
  );
  return result.Items ?? [];
}

async function activeRows(TableName, billingPeriodId) {
  const current = await state(billingPeriodId);
  if (!current) return [];
  return (await periodRows(TableName, billingPeriodId)).filter(
    (item) => item.DataVersion === current.ActiveDataVersion,
  );
}

async function auditRows(billingPeriodId) {
  const result = await ddb.send(
    new QueryCommand({
      TableName: tables.control,
      KeyConditionExpression: "PK = :pk",
      ExpressionAttributeValues: { ":pk": `RP_AUDIT#${billingPeriodId}` },
    }),
  );
  return result.Items ?? [];
}

async function availablePort() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  server.close();
  await once(server, "close");
  return port;
}

async function startApplication() {
  const port = await availablePort();
  const nextBin = resolve("node_modules/next/dist/bin/next");
  const output = [];
  const childEnv = {
    ...process.env,
    CUBE_RP_INTEGRATION_TEST_NAMESPACE: namespace,
    NEXT_TELEMETRY_DISABLED: "1",
  };
  // Next's advisory nudge treats an inherited Codex marker as an interactive
  // agent and stops the noninteractive test server. The isolated server needs
  // no agent identity, so remove only those markers from this child process.
  for (const name of Object.keys(childEnv)) {
    if (name.startsWith("CODEX_")) delete childEnv[name];
  }
  const child = spawn(
    process.execPath,
    [nextBin, "dev", "-H", "127.0.0.1", "-p", String(port)],
    {
      cwd: resolve("."),
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const record = (chunk) => {
    output.push(String(chunk));
    if (output.length > 100) output.shift();
  };
  child.stdout.on("data", record);
  child.stderr.on("data", record);

  const baseUrl = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`Next.js exited early.\n${output.join("")}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/monthly-data/real-property/manage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      if (response.status === 400) return { child, baseUrl, output };
    } catch {
      // The compiler/server is still starting.
    }
    await delay(250);
  }
  throw new Error(`Next.js did not become ready.\n${output.join("")}`);
}

async function stopApplication(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([once(child, "exit"), delay(10_000)]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

async function postJson(baseUrl, body) {
  const response = await fetch(`${baseUrl}/api/monthly-data/real-property/manage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

async function postPropQJson(baseUrl, body) {
  const response = await fetch(`${baseUrl}/api/monthly-data/real-property/propq`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

async function upload(baseUrl, mode, csv, confirmed, sourceDataVersion = "") {
  const data = new FormData();
  data.append("file", new Blob([csv], { type: "text/csv" }), "replacement.csv");
  data.append("fy", "2026");
  data.append("billing_month_nm", "February");
  data.append("billing_period_id", "175");
  data.append("mode", mode);
  if (confirmed) data.append("confirmed", "true");
  if (sourceDataVersion) data.append("source_data_version", sourceDataVersion);
  const response = await fetch(`${baseUrl}/api/monthly-data/real-property/upload`, {
    method: "POST",
    body: data,
  });
  return { status: response.status, body: await response.json() };
}

function editor(overrides = {}) {
  return {
    CustomerID: "CUST-1",
    FacilityID: "FAC-4058",
    RPUID: "RP-4058",
    CategoryCode: "CAT-1",
    AllocationQty: 200,
    AllocationUM: "SF",
    UtilityGroup: 1,
    EL: 1,
    NG: 0,
    PW: 1,
    SS: 0,
    ...overrides,
  };
}

const replacementCsv = [
  "Upload?,RPUID,Site Code,Facility Number,Customer Name,CUBE Customer Name,Asset Allocation Current Use CAT Code,Asset Allocation Size Qty,Asset Allocation Size UoM,Utility Group,EL,NG,PW,SS",
  "Y,RP-4058,FAA,4058,Test Customer,Test Customer,CAT-1,300,SF,1,Y,N,Y,N",
].join("\n");

const unknownCategoryCsv = replacementCsv.replace("CAT-1", "738421");

const invalidReplacementCsv = [
  "Upload?,RPUID,Site Code,Facility Number,Customer Name,CUBE Customer Name,Asset Allocation Current Use CAT Code,Asset Allocation Size Qty,Asset Allocation Size UoM,Utility Group,EL,NG,PW,SS",
  "Y,RP-4058,FAA,4058,Missing Customer,Missing Customer,CAT-1,999,SF,1,Y,N,N,N",
].join("\n");

async function run() {
  let app = null;
  try {
    console.log(`Fixture namespace: ${namespace}`);
    console.log(`DynamoDB endpoint: ${ENDPOINT}`);
    await createFixtureTables();
    await seedFixture();
    const annualBefore = canonical(await scan(tables.legacy));
    app = await startApplication();

    const baseMutation = {
      billing_period_id: 175,
      fy: 2026,
      billing_month_nm: "February",
    };

    const rejectedInitialUpload = await upload(app.baseUrl, "validate", unknownCategoryCsv, false);
    assert.equal(rejectedInitialUpload.status, 400, JSON.stringify(rejectedInitialUpload.body));
    assert.match(rejectedInitialUpload.body.error, /Import validation failed/);
    assert.ok(rejectedInitialUpload.body.errors.some((error) =>
      /Row 2: Category Code "738421" is not in the Category Codes table/.test(error),
    ));
    assert.match(rejectedInitialUpload.body.error, /Nothing was written to DynamoDB/);
    assert.equal(await state(175), null);
    assert.equal((await periodRows(tables.monthly, 175)).length, 0);
    assert.equal(canonical(await scan(tables.legacy)), annualBefore);
    console.log("PASS initial upload validation: unknown category 738421 identifies source row and writes nothing");

    const rejectedManualCategory = await postJson(app.baseUrl, {
      ...baseMutation,
      action: "create",
      confirmed: true,
      record: editor({ CategoryCode: "738421" }),
    });
    assert.equal(rejectedManualCategory.status, 400, JSON.stringify(rejectedManualCategory.body));
    assert.match(
      [rejectedManualCategory.body.error, ...(rejectedManualCategory.body.details ?? [])].join(" "),
      /Category Code "738421" is not in the Category Codes table/,
    );
    assert.equal(await state(175), null);
    console.log("PASS manual API validation: unknown category was rejected without activating a snapshot");

    const unconfirmedCreate = await postJson(app.baseUrl, {
      ...baseMutation,
      action: "create",
      record: editor(),
    });
    assert.equal(unconfirmedCreate.status, 400);
    assert.match(unconfirmedCreate.body.error, /Final confirmation/);
    assert.equal(await state(175), null);
    console.log("PASS confirmation: unconfirmed create wrote no snapshot");

    const created = await postJson(app.baseUrl, {
      ...baseMutation,
      action: "create",
      confirmed: true,
      record: editor(),
    });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    let februaryRp = await activeRows(tables.monthly, 175);
    assert.equal(februaryRp.length, 3);
    const manual = februaryRp.find((item) => item.Source === "MANUAL_RP");
    assert.ok(manual);
    const logicalId = manual.LogicalMonthlyRPID;
    assert.equal(await state(181), null);
    assert.equal((await periodRows(tables.monthly, 181)).length, 0);
    assert.equal(canonical(await scan(tables.legacy)), annualBefore);
    console.log("PASS create: February materialized 2 baseline + 1 manual; August and annual baseline unchanged");

    const unconfirmedVersion = (await state(175)).ActiveDataVersion;
    const unconfirmedEdit = await postJson(app.baseUrl, {
      ...baseMutation,
      action: "update",
      monthly_rp_id: logicalId,
      record: editor({ AllocationQty: 225 }),
    });
    assert.equal(unconfirmedEdit.status, 400);
    assert.equal((await state(175)).ActiveDataVersion, unconfirmedVersion);

    const edited = await postJson(app.baseUrl, {
      ...baseMutation,
      action: "update",
      monthly_rp_id: logicalId,
      confirmed: true,
      record: editor({ AllocationQty: 250, NG: 1, PW: 0 }),
    });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    februaryRp = await activeRows(tables.monthly, 175);
    const editedManual = februaryRp.find((item) => item.LogicalMonthlyRPID === logicalId);
    assert.equal(editedManual.AllocationQty, 250);
    assert.equal(editedManual.EL, 1);
    assert.equal(editedManual.NG, 1);
    assert.equal(editedManual.PW, 0);
    const editedEstimates = await activeRows(tables.estimates, 175);
    const editedPropQ = await activeRows(tables.propQ, 175);
    assert.deepEqual(
      editedEstimates.map((item) => [item.UtilityType, item.EstimatedUsage]).sort(),
      [["EL", 125], ["NG", 25]],
    );
    assert.equal(editedPropQ.length, 2);
    assert.ok(editedPropQ.every((item) => item.PropQ === 1));
    assert.equal(await state(181), null);
    assert.equal(canonical(await scan(tables.legacy)), annualBefore);
    console.log("PASS edit: only February changed; Estimates and PropQ match edited utility flags and quantity");

    const priorRecalcState = await state(175);
    const priorRecalcRp = canonical(await activeRows(tables.monthly, 175));
    const priorRecalcEstimates = canonical(await activeRows(tables.estimates, 175));
    const priorRecalcPropQ = canonical(await activeRows(tables.propQ, 175));
    await ddb.send(new PutCommand({
      TableName: tables.categories,
      Item: { category_cd: "CAT-1", space_type_id: "30", space_type: "Unmapped Test Space" },
    }));
    const invalidRecalculation = await postPropQJson(app.baseUrl, {
      billing_period_id: 175,
      regenerate: true,
    });
    assert.equal(invalidRecalculation.status, 400, JSON.stringify(invalidRecalculation.body));
    assert.equal((await state(175)).ActiveDataVersion, priorRecalcState.ActiveDataVersion);
    assert.equal(canonical(await activeRows(tables.estimates, 175)), priorRecalcEstimates);
    assert.equal(canonical(await activeRows(tables.propQ, 175)), priorRecalcPropQ);
    console.log("PASS recalculation failure safety: missing space-type intensities did not replace the active snapshot");

    await ddb.send(new PutCommand({
      TableName: tables.categories,
      Item: { category_cd: "CAT-1", space_type_id: "20", space_type: "Warehouse" },
    }));
    const recalculated = await postPropQJson(app.baseUrl, {
      billing_period_id: 175,
      regenerate: true,
    });
    assert.equal(recalculated.status, 200, JSON.stringify(recalculated.body));
    assert.equal(recalculated.body.estimatesRebuilt, true);
    assert.equal(recalculated.body.realPropertyRecordsRefreshed, 3);
    const recalculatedState = await state(175);
    assert.notEqual(recalculatedState.ActiveDataVersion, priorRecalcState.ActiveDataVersion);
    assert.equal(recalculatedState.ChangeOperation, "RECALCULATE");
    assert.equal(recalculatedState.ReconciliationPotentiallyStale, true);
    assert.equal(recalculatedState.BillsPotentiallyStale, true);
    const recalculatedEstimates = await activeRows(tables.estimates, 175);
    const estimateByRpUtility = new Map(recalculatedEstimates.map((item) => [`${item.SourceMonthlyRPID}|${item.UtilityType}`, item.EstimatedUsage]));
    assert.equal(estimateByRpUtility.get("LRP-BASE-1|EL"), 25);
    assert.equal(estimateByRpUtility.get("LRP-BASE-1|PW"), 50);
    assert.equal(estimateByRpUtility.get("LRP-BASE-2|NG"), 10);
    assert.equal(estimateByRpUtility.get(`${logicalId}|EL`), 62.5);
    assert.equal(estimateByRpUtility.get(`${logicalId}|NG`), 50);
    const recalculatedPropQ = await activeRows(tables.propQ, 175);
    const propQByRpUtility = new Map(recalculatedPropQ.map((item) => [`${item.LogicalMonthlyRPID}|${item.UtilityType}`, item.PropQ]));
    assert.ok(Math.abs(propQByRpUtility.get("LRP-BASE-1|EL") - (2 / 7)) < 1e-10);
    assert.ok(Math.abs(propQByRpUtility.get(`${logicalId}|EL`) - (5 / 7)) < 1e-10);
    assert.equal(propQByRpUtility.get("LRP-BASE-1|PW"), 1);
    assert.ok(Math.abs(propQByRpUtility.get("LRP-BASE-2|NG") - (1 / 6)) < 1e-10);
    assert.ok(Math.abs(propQByRpUtility.get(`${logicalId}|NG`) - (5 / 6)) < 1e-10);
    assert.equal(canonical((await periodRows(tables.monthly, 175)).filter((item) => item.DataVersion === priorRecalcState.ActiveDataVersion)), priorRecalcRp);
    assert.equal(canonical((await periodRows(tables.estimates, 175)).filter((item) => item.DataVersion === priorRecalcState.ActiveDataVersion)), priorRecalcEstimates);
    assert.equal(canonical((await periodRows(tables.propQ, 175)).filter((item) => item.DataVersion === priorRecalcState.ActiveDataVersion)), priorRecalcPropQ);
    assert.equal(await state(181), null);
    assert.equal(canonical(await scan(tables.legacy)), annualBefore);
    console.log("PASS category refresh: current mapping recalculated active Estimates and PropQ; old version, August, and annual baseline remained unchanged");

    const stableState = await state(175);
    const stableRp = canonical(await activeRows(tables.monthly, 175));
    const failedEdit = await postJson(app.baseUrl, {
      ...baseMutation,
      action: "update",
      monthly_rp_id: logicalId,
      confirmed: true,
      record: editor({ CustomerID: "MISSING" }),
    });
    assert.equal(failedEdit.status, 400);
    assert.equal((await state(175)).ActiveDataVersion, stableState.ActiveDataVersion);
    assert.equal(canonical(await activeRows(tables.monthly, 175)), stableRp);
    console.log("PASS failure safety: rejected edit preserved the previous active snapshot");

    const deleted = await postJson(app.baseUrl, {
      ...baseMutation,
      action: "delete",
      monthly_rp_id: logicalId,
      confirmed: true,
    });
    assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
    assert.equal((await activeRows(tables.monthly, 175)).length, 2);
    assert.equal((await activeRows(tables.estimates, 175)).length, 3);
    assert.equal((await activeRows(tables.propQ, 175)).length, 3);
    assert.equal((await activeRows(tables.estimates, 175)).some((item) => item.SourceMonthlyRPID === logicalId), false);
    assert.equal((await activeRows(tables.propQ, 175)).some((item) => item.LogicalMonthlyRPID === logicalId), false);
    console.log("PASS individual delete: manual record and its dependencies removed; baseline Estimates/PropQ remained active");

    const beforeValidation = (await state(175)).ActiveDataVersion;
    const validation = await upload(app.baseUrl, "validate", replacementCsv, false);
    assert.equal(validation.status, 200, JSON.stringify(validation.body));
    assert.equal(validation.body.validated, true);
    assert.equal(typeof validation.body.sourceDataVersion, "string");
    assert.ok(validation.body.sourceDataVersion);
    assert.equal((await state(175)).ActiveDataVersion, beforeValidation);
    const unconfirmedReplace = await upload(app.baseUrl, "replace", replacementCsv, false);
    assert.equal(unconfirmedReplace.status, 400);
    assert.equal((await state(175)).ActiveDataVersion, beforeValidation);
    const staleReplace = await upload(app.baseUrl, "replace", replacementCsv, true, "stale-version");
    assert.equal(staleReplace.status, 409, JSON.stringify(staleReplace.body));
    assert.equal((await state(175)).ActiveDataVersion, beforeValidation);
    const replaced = await upload(app.baseUrl, "replace", replacementCsv, true, validation.body.sourceDataVersion);
    assert.equal(replaced.status, 200, JSON.stringify(replaced.body));
    assert.equal((await activeRows(tables.monthly, 175)).length, 1);
    assert.equal((await activeRows(tables.estimates, 175)).length, 2);
    assert.equal((await activeRows(tables.propQ, 175)).length, 2);
    console.log("PASS replacement: preview was read-only, final confirmation activated 1 RP / 2 Estimates / 2 PropQ");

    const beforeInvalidReplace = await state(175);
    const stableReplacementRp = canonical(await activeRows(tables.monthly, 175));
    const afterReplacementValidation = await upload(app.baseUrl, "validate", replacementCsv, false);
    assert.equal(afterReplacementValidation.status, 200, JSON.stringify(afterReplacementValidation.body));
    const categoryValidation = await upload(app.baseUrl, "validate", unknownCategoryCsv, false);
    assert.equal(categoryValidation.status, 400);
    assert.ok(categoryValidation.body.errors.some((error) =>
      /Row 2: Category Code "738421" is not in the Category Codes table/.test(error),
    ));
    const rejectedCategoryReplacement = await upload(
      app.baseUrl,
      "replace",
      unknownCategoryCsv,
      true,
      afterReplacementValidation.body.sourceDataVersion,
    );
    assert.equal(rejectedCategoryReplacement.status, 400, JSON.stringify(rejectedCategoryReplacement.body));
    assert.ok(rejectedCategoryReplacement.body.errors.some((error) =>
      /Row 2: Category Code "738421" is not in the Category Codes table/.test(error),
    ));
    assert.equal((await state(175)).ActiveDataVersion, beforeInvalidReplace.ActiveDataVersion);
    assert.equal(canonical(await activeRows(tables.monthly, 175)), stableReplacementRp);
    console.log("PASS replacement validation: unknown category rejected; prior active month remains unchanged");

    const invalidReplace = await upload(app.baseUrl, "replace", invalidReplacementCsv, true, afterReplacementValidation.body.sourceDataVersion);
    assert.equal(invalidReplace.status, 400);
    assert.equal(
      (await state(175)).ActiveDataVersion,
      beforeInvalidReplace.ActiveDataVersion,
    );
    assert.equal((await activeRows(tables.monthly, 175)).length, 1);
    console.log("PASS replacement failure: invalid file preserved the previous active snapshot");

    const wrongDelete = await postJson(app.baseUrl, {
      ...baseMutation,
      action: "delete_all",
      confirmed: true,
      confirmation_phrase: "delete",
      confirmation_month: "February",
      confirmation_count: 1,
    });
    assert.equal(wrongDelete.status, 400);
    assert.equal(
      (await state(175)).ActiveDataVersion,
      beforeInvalidReplace.ActiveDataVersion,
    );
    const deletedAll = await postJson(app.baseUrl, {
      ...baseMutation,
      action: "delete_all",
      confirmed: true,
      confirmation_phrase: "DELETE",
      confirmation_month: "February",
      confirmation_count: 1,
    });
    assert.equal(deletedAll.status, 200, JSON.stringify(deletedAll.body));
    assert.equal((await activeRows(tables.monthly, 175)).length, 0);
    assert.equal((await activeRows(tables.estimates, 175)).length, 0);
    assert.equal((await activeRows(tables.propQ, 175)).length, 0);
    console.log("PASS full-month delete: exact phrase/month/count required; active dependent snapshot is empty");

    const reuploadValidation = await upload(app.baseUrl, "validate", replacementCsv, false);
    assert.equal(reuploadValidation.status, 200, JSON.stringify(reuploadValidation.body));
    const rejectedUnknownReupload = await upload(
      app.baseUrl,
      "import",
      unknownCategoryCsv,
      true,
      reuploadValidation.body.sourceDataVersion,
    );
    assert.equal(rejectedUnknownReupload.status, 400, JSON.stringify(rejectedUnknownReupload.body));
    assert.ok(rejectedUnknownReupload.body.errors.some((error) =>
      /Row 2: Category Code "738421" is not in the Category Codes table/.test(error),
    ));
    assert.equal((await state(175)).ActiveDataVersion, reuploadValidation.body.sourceDataVersion);
    assert.equal((await activeRows(tables.monthly, 175)).length, 0);
    const reuploaded = await upload(app.baseUrl, "import", replacementCsv, true, reuploadValidation.body.sourceDataVersion);
    assert.equal(reuploaded.status, 200, JSON.stringify(reuploaded.body));
    assert.equal((await activeRows(tables.monthly, 175)).length, 1);
    assert.equal((await activeRows(tables.estimates, 175)).length, 2);
    assert.equal((await activeRows(tables.propQ, 175)).length, 2);
    assert.equal(await state(181), null);
    assert.equal((await periodRows(tables.monthly, 181)).length, 0);
    assert.equal(canonical(await scan(tables.legacy)), annualBefore);
    console.log("PASS reupload: import after empty snapshot restored February only");

    const audits = await auditRows(175);
    assert.deepEqual(
      audits.map((item) => item.Operation).sort(),
      ["CREATE", "DELETE", "DELETE_ALL", "IMPORT", "RECALCULATE", "REPLACE", "UPDATE"].sort(),
    );
    assert.ok(audits.every((item) => item.ReconciliationPotentiallyStale === true));
    assert.ok(audits.every((item) => item.BillsPotentiallyStale === true));
    console.log("PASS audit/stale markers: 7 successful operations recorded; failed/preview operations added none");

    console.log("INTEGRATION RESULT: category-code checks and full Real Property API workflow passed");
  } catch (error) {
    if (app) console.error(`TEST API SERVER OUTPUT:\n${app.output.join("")}`);
    throw error;
  } finally {
    try {
      if (app) await stopApplication(app.child);
      await cleanupFixtureTables();
      console.log(`CLEANUP: deleted ${createdTables.length} disposable fixture tables`);
    } finally {
      rmSync(disposableNextBuild, { recursive: true, force: true });
      writeFileSync(nextEnvPath, originalNextEnv, "utf8");
      lowLevel.destroy();
    }
  }
}

await run();

