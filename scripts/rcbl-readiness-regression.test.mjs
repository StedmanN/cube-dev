import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  reconciliationSnapshotId,
  validateReconciliationReadiness,
} from "../lib/rcbl-reconciliation-readiness.ts";

const routeSource = readFileSync(
  new URL("../app/api/billing/rcbl-short/route.ts", import.meta.url),
  "utf8",
);

function allocation(utilityGroup = "1", utilityType = "PW") {
  return {
    billing_period_id: 175,
    RecordType: "ALLOCATION",
    UtilityGroup: utilityGroup,
    UtilityType: utilityType,
    ReconciliationID: `ALLOC#${utilityGroup}#${utilityType}`,
    AllocatedTotalConsumption: 60,
  };
}

function derivedSewerAllocation(utilityGroup = "1") {
  return {
    ...allocation(utilityGroup, "SS"),
    AllocationSource: "DERIVED_SS",
    DerivedFromUtility: "PW",
  };
}

function summary(
  utilityGroup = "1",
  utilityType = "PW",
  overrides = {},
) {
  return {
    billing_period_id: 175,
    RecordType: "SUMMARY",
    UtilityGroup: utilityGroup,
    UtilityType: utilityType,
    ReconciliationID: `SUMMARY#${utilityGroup}#${utilityType}`,
    BillingReady: 1,
    ReconciliationStatus: "BILLING_READY",
    AccountingStatus: "RECONCILED",
    IssueCount: 0,
    Issues: [],
    ...overrides,
  };
}

function invoice(utilityGroup = "1", utilityType = "PW") {
  return {
    billing_period_id: 175,
    utility_group_id: utilityGroup,
    utility_type_cd: utilityType,
    consumption: 100,
  };
}

test("billing-ready summaries authorize a complete billing cycle", () => {
  const result = validateReconciliationReadiness(
    [allocation(), summary()],
    175,
    [invoice()],
  );
  assert.equal(result.ready, true);
  assert.deepEqual(result.failures, []);
});

for (const code of [
  "METERED_EXCEEDS_SOURCE",
  "PROPQ_EXCEEDS_ONE",
  "NO_NONMETERED_PROPQ",
]) {
  test(`${code} blocks billing readiness`, () => {
    const result = validateReconciliationReadiness(
      [
        allocation(),
        summary("1", "PW", {
          BillingReady: 0,
          ReconciliationStatus: "EXCEPTION",
          IssueCount: 1,
          Issues: [{ code, blocking: true, message: `${code} blocked` }],
        }),
      ],
      175,
    );
    assert.equal(result.ready, false);
    assert.match(result.failures[0].reason, new RegExp(code));
  });
}

test("missing required SUMMARY blocks the complete billing cycle", () => {
  const result = validateReconciliationReadiness([allocation()], 175);
  assert.equal(result.ready, false);
  assert.match(result.failures[0].reason, /SUMMARY is missing/);
});

test("an applicable invoice utility missing from reconciliation blocks readiness", () => {
  const result = validateReconciliationReadiness(
    [allocation(), summary()],
    175,
    [invoice("1", "PW"), invoice("2", "EL")],
  );
  assert.equal(result.ready, false);
  assert.ok(
    result.failures.some(
      (failure) =>
        failure.utilityGroup === "TAC" &&
        failure.utilityType === "EL" &&
        /SUMMARY is missing/.test(failure.reason),
    ),
  );
});

test("an existing utility summary without its individual invoice fails readiness", () => {
  const result = validateReconciliationReadiness(
    [
      allocation("1", "PW"),
      summary("1", "PW"),
      allocation("1", "EL"),
      summary("1", "EL"),
    ],
    175,
    [invoice("1", "PW")],
  );
  assert.equal(result.ready, false);
  assert.ok(
    result.failures.some(
      (failure) =>
        failure.utilityGroup === "WWYK" &&
        failure.utilityType === "EL" &&
        /source is missing/.test(failure.reason),
    ),
  );
});

test("complete per-utility sources authorize all matching summaries", () => {
  const result = validateReconciliationReadiness(
    [
      allocation("1", "PW"),
      summary("1", "PW"),
      allocation("1", "EL"),
      summary("1", "EL"),
    ],
    175,
    [invoice("1", "PW"), invoice("1", "EL")],
  );
  assert.equal(result.ready, true);
});

test("TAC source requirements remain separate from WWYK", () => {
  const result = validateReconciliationReadiness(
    [
      allocation("1", "PW"),
      summary("1", "PW"),
      allocation("2", "PW"),
      summary("2", "PW"),
    ],
    175,
    [invoice("1", "PW")],
  );
  assert.equal(result.ready, false);
  assert.ok(
    result.failures.some(
      (failure) =>
        failure.utilityGroup === "TAC" &&
        failure.utilityType === "PW",
    ),
  );
});

test("duplicate applicable SUMMARY records block readiness", () => {
  const result = validateReconciliationReadiness(
    [allocation(), summary(), summary()],
    175,
    [invoice("1", "PW")],
  );
  assert.equal(result.ready, false);
  assert.match(result.failures[0].reason, /Multiple reconciliation SUMMARY/);
});

test("invoice utilities that are absent from the authoritative source are not required", () => {
  const result = validateReconciliationReadiness(
    [allocation(), summary()],
    175,
    [invoice("1", "PW")],
  );
  assert.equal(result.ready, true);
});

test("valid summaries without authoritative invoice/source records fail closed", () => {
  const result = validateReconciliationReadiness(
    [allocation(), summary()],
    175,
    [],
  );
  assert.equal(result.ready, false);
  assert.match(result.failures[0].reason, /source is missing/);
});

test("WWYK plant production is an approved source when no invoice key exists", () => {
  const result = validateReconciliationReadiness(
    [
      allocation(),
      summary("1", "PW", { PlantUnitProduction: 25 }),
    ],
    175,
    [],
  );
  assert.equal(result.ready, true);
});

test("valid derived sewer consumption can use the matching PW source", () => {
  const result = validateReconciliationReadiness(
    [
      allocation("1", "PW"),
      summary("1", "PW"),
      derivedSewerAllocation("1"),
      summary("1", "SS"),
    ],
    175,
    [invoice("1", "PW")],
  );
  assert.equal(result.ready, true);
});

test("zero-consumption invoice rows still satisfy source validation", () => {
  const result = validateReconciliationReadiness(
    [allocation("1", "PW"), summary("1", "PW")],
    175,
    [{ ...invoice("1", "PW"), consumption: 0 }],
  );
  assert.equal(result.ready, true);
});

test("nonnumeric IssueCount fails closed", () => {
  const result = validateReconciliationReadiness(
    [summary("1", "PW", { IssueCount: "not-a-number", Issues: [] })],
    175,
    [invoice("1", "PW")],
  );
  assert.equal(result.ready, false);
  assert.match(result.failures[0].reason, /IssueCount is invalid/);
});

test("IssueCount and Issues mismatch blocks readiness", () => {
  const result = validateReconciliationReadiness(
    [
      allocation(),
      summary("1", "PW", { IssueCount: 1, Issues: [] }),
    ],
    175,
  );
  assert.equal(result.ready, false);
  assert.match(result.failures[0].reason, /IssueCount is 1/);
});

test("BillingReady cannot contradict a nonempty unresolved Issues list", () => {
  const result = validateReconciliationReadiness(
    [
      allocation(),
      summary("1", "PW", {
        IssueCount: 1,
        Issues: [{ code: "INFO", blocking: false }],
      }),
    ],
    175,
  );
  assert.equal(result.ready, false);
  assert.match(result.failures[0].reason, /unresolved/);
});

test("an unrelated incomplete summary also blocks the complete cycle", () => {
  const result = validateReconciliationReadiness(
    [
      allocation("1", "PW"),
      summary("1", "PW"),
      summary("2", "EL", {
        BillingReady: 0,
        ReconciliationStatus: "EXCEPTION",
        IssueCount: 1,
        Issues: [{ code: "MISSING_SOURCE", blocking: true }],
      }),
    ],
    175,
  );
  assert.equal(result.ready, false);
  assert.equal(result.failures[0].utilityGroup, "TAC");
});

test("snapshot identity changes when reconciliation records change", () => {
  const original = [allocation(), summary()];
  const changed = [allocation(), summary("1", "PW", { BillingReady: 0 })];
  assert.notEqual(
    reconciliationSnapshotId(original, 175),
    reconciliationSnapshotId(changed, 175),
  );
});

test("snapshot identity changes when authoritative invoice data changes", () => {
  assert.notEqual(
    reconciliationSnapshotId([allocation(), summary()], 175, [invoice()]),
    reconciliationSnapshotId(
      [allocation(), summary()],
      175,
      [invoice("1", "PW"), { ...invoice(), charge: 1 }],
    ),
  );
});

test("RCBL preview stays available while save revalidates readiness server-side", () => {
  assert.match(routeSource, /reconciliationReady/);
  assert.match(routeSource, /validateReconciliationReadiness/);
  assert.match(routeSource, /scanAll\(INVOICES_TABLE\)/);
  assert.match(routeSource, /stale because the reconciliation changed/);
  assert.match(routeSource, /candidate record writes/);
});

test("readiness validation occurs before candidate billing writes", () => {
  const readinessIndex = routeSource.indexOf('operationPhase = "validate reconciliation readiness"');
  const writeIndex = routeSource.indexOf('operationPhase = "candidate record writes"');
  assert.ok(readinessIndex >= 0);
  assert.ok(writeIndex > readinessIndex);
});

console.log("RCBL readiness regression checks passed.");
