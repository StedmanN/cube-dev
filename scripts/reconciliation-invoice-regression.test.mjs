import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyReconciliationInvoiceRow,
  evaluateReconciliationBillingStatus,
} from "../lib/reconciliation-invoice.ts";

const affectedFebruaryLines = [
  { label: "WWYK PW", unit: "ALL", charge: 238.02 },
  { label: "WWYK SS", unit: "KGAL", charge: 6.71 },
  { label: "TACX PW", unit: "KGAL", charge: 7_564.46 },
  { label: "TACX SS", unit: "ALL", charge: 12_130.97 },
];

function balancedStatus(invalidInvoiceRows = 0) {
  return evaluateReconciliationBillingStatus({
    accountingDifference: 0.0000001,
    allocationDifference: -0.0000001,
    unallocatedMetered: 0,
    unallocatedNonMetered: 0,
    invalidInvoiceRows,
    issueCount: 0,
  });
}

test("legitimate February flat-charge rows retain charges without blocking readiness", () => {
  for (const row of affectedFebruaryLines) {
    const classification = classifyReconciliationInvoiceRow({
      utilityType: row.label.endsWith("PW") ? "PW" : "SS",
      consumption: undefined,
      consumptionUnit: row.unit,
      charge: row.charge,
    });

    assert.equal(classification.kind, "CHARGE_ONLY", row.label);
    assert.equal(classification.charge, row.charge, row.label);
    assert.deepEqual(balancedStatus(), {
      accountingStatus: "RECONCILED",
      billingReady: true,
      reconciliationStatus: "BILLING_READY",
    });
  }
});

test("unsupported consumption rows remain invalid and block billing", () => {
  const classification = classifyReconciliationInvoiceRow({
    utilityType: "PW",
    consumption: 25,
    consumptionUnit: "ALL",
    charge: 400,
  });

  assert.deepEqual(classification, {
    kind: "INVALID",
    reason: "UNSUPPORTED_UNIT",
  });
  assert.deepEqual(balancedStatus(1), {
    accountingStatus: "EXCEPTION",
    billingReady: false,
    reconciliationStatus: "EXCEPTION",
  });
});

test("malformed supplied consumption remains invalid even when a charge exists", () => {
  assert.deepEqual(
    classifyReconciliationInvoiceRow({
      utilityType: "SS",
      consumption: "not-a-number",
      consumptionUnit: "KGAL",
      charge: 100,
    }),
    { kind: "INVALID", reason: "INVALID_CONSUMPTION" },
  );
});

test("genuine reconciliation differences still block billing", () => {
  const status = evaluateReconciliationBillingStatus({
    accountingDifference: 1,
    allocationDifference: 1,
    unallocatedMetered: 0,
    unallocatedNonMetered: 0,
    invalidInvoiceRows: 0,
    issueCount: 0,
  });

  assert.equal(status.accountingStatus, "EXCEPTION");
  assert.equal(status.billingReady, false);
  assert.equal(status.reconciliationStatus, "EXCEPTION");
});

test("blocking allocation issues remain blocking", () => {
  const status = evaluateReconciliationBillingStatus({
    accountingDifference: 0,
    allocationDifference: 0,
    unallocatedMetered: 0,
    unallocatedNonMetered: 0,
    invalidInvoiceRows: 0,
    issueCount: 1,
  });

  assert.equal(status.accountingStatus, "RECONCILED");
  assert.equal(status.billingReady, false);
  assert.equal(status.reconciliationStatus, "EXCEPTION");
});

console.log("Reconciliation invoice regression checks passed.");
