import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  billingPreviewsMatch,
  billingPreviewFingerprint,
  unresolvedOfficialCustomerBillingIssues,
} from "../lib/rcbl-billing-integrity.ts";

const routeSource = readFileSync(
  new URL("../app/api/billing/rcbl-short/route.ts", import.meta.url),
  "utf8",
);

function preview() {
  return {
    billingPeriodId: 175,
    reconciliationSnapshotId: "reconciliation-and-invoice-snapshot",
    generatedAt: "2026-10-29T00:00:00.000Z",
    customers: [
      {
        customerId: "CUST-1",
        customerType: "Reimbursable",
        status: "READY",
        issueCount: 0,
        totalAmount: 125.5,
        lines: [
          {
            utilitySystem: "PW",
            allocatedConsumption: 10,
            rate: 12.55,
            amount: 125.5,
            ready: true,
            issues: [],
          },
        ],
      },
    ],
  };
}

test("generatedAt does not make an otherwise identical preview stale", () => {
  const later = { ...preview(), generatedAt: "2026-10-29T00:01:00.000Z" };
  assert.equal(billingPreviewsMatch(preview(), later), true);
});

test("modified browser-submitted amount is rejected by canonical comparison", () => {
  const modified = structuredClone(preview());
  modified.customers[0].totalAmount = 9999;
  assert.equal(billingPreviewsMatch(preview(), modified), false);
});

test("modified browser-submitted billing line is rejected", () => {
  const modified = structuredClone(preview());
  modified.customers[0].lines[0].amount = 1;
  assert.equal(billingPreviewsMatch(preview(), modified), false);
});

test("a ready reimbursable customer can be saved", () => {
  assert.deepEqual(unresolvedOfficialCustomerBillingIssues(preview()), []);
});

test("an unresolved reimbursable customer blocks official saving", () => {
  const modified = structuredClone(preview());
  modified.customers[0].status = "REVIEW";
  modified.customers[0].issueCount = 1;
  modified.customers[0].totalAmount = null;
  modified.customers[0].lines[0].ready = false;
  modified.customers[0].lines[0].amount = null;
  modified.customers[0].lines[0].issues = ["Missing rate"];
  assert.equal(unresolvedOfficialCustomerBillingIssues(modified).length, 1);
});

test("a legitimately non-reimbursable customer does not block saving by classification alone", () => {
  const modified = structuredClone(preview());
  modified.customers[0].customerType = "Non-Reimbursable";
  modified.customers[0].status = "REVIEW";
  modified.customers[0].totalAmount = null;
  assert.deepEqual(unresolvedOfficialCustomerBillingIssues(modified), []);
});

test("utility override makes a line officially reimbursable regardless of overall customer type", () => {
  const modified = structuredClone(preview());
  modified.customers[0].customerType = "Non-Reimbursable";
  modified.customers[0].lines[0].reimbursementDisposition =
    "CUSTOMER_REIMBURSABLE";
  modified.customers[0].lines[0].ready = false;
  modified.customers[0].lines[0].amount = null;
  modified.customers[0].lines[0].issues = ["Missing rate"];
  assert.equal(unresolvedOfficialCustomerBillingIssues(modified).length, 1);
});

test("CE-absorbed-only lines remain internal and do not create an official customer bill issue", () => {
  const modified = structuredClone(preview());
  modified.customers[0].lines[0].reimbursementDisposition = "CE_ABSORBED";
  modified.customers[0].lines[0].amount = 0;
  modified.customers[0].totalAmount = 0;
  assert.deepEqual(unresolvedOfficialCustomerBillingIssues(modified), []);
});

test("rate, invoice, and reconciliation identity changes make a preview stale", () => {
  for (const change of [
    (value) => { value.customers[0].lines[0].rate = 20; },
    (value) => { value.reconciliationSnapshotId = "changed-invoice-snapshot"; },
    (value) => { value.reconciliationSnapshotId = "changed-reconciliation-snapshot"; },
  ]) {
    const changed = structuredClone(preview());
    change(changed);
    assert.equal(billingPreviewsMatch(preview(), changed), false);
  }
});

test("POST uses authoritative preview data and rechecks before pointer activation", () => {
  assert.match(routeSource, /loadAuthoritativePreview/);
  assert.match(routeSource, /billingPreviewFingerprint\(authoritativePreview\) !== previewFingerprint/);
  assert.match(routeSource, /recheck authoritative inputs before pointer activation/);
  assert.match(routeSource, /billingPreviewsMatch\(authoritativePreview, latestAuthoritativePreview\)/);
  assert.match(routeSource, /unresolvedOfficialCustomerBillingIssues/);
  assert.match(routeSource, /buildVersionRecords\(\s*authoritativePreview/s);
});

console.log("RCBL billing integrity regression checks passed.");
