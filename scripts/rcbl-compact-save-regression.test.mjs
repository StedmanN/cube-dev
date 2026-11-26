import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  billingPreviewFingerprint,
  billingPreviewsMatch,
} from "../lib/rcbl-billing-integrity.ts";

const client = readFileSync(new URL("../app/billing/billing-client.tsx", import.meta.url), "utf8");
const route = readFileSync(new URL("../app/api/billing/rcbl-short/route.ts", import.meta.url), "utf8");

function preview() {
  return {
    ok: true,
    preview: true,
    persisted: false,
    billingPeriodId: 182,
    reconciliationReady: true,
    reconciliationSnapshotId: "snapshot-182",
    generatedAt: "2026-11-08T10:00:00.000Z",
    summary: { totalCustomerBilling: 100, totalCEAbsorbed: 20 },
    customers: [{ customerId: "CUST-1", totalAmount: 100, lines: [
      { reconciliationId: "R1", amount: 100, rate: 2, allocatedConsumption: 50 },
    ] }],
  };
}

test("preview identity is stable across generation timestamps and serialization", () => {
  const first = preview();
  const later = { ...first, generatedAt: "2026-11-08T10:01:00.000Z" };
  assert.equal(billingPreviewFingerprint(first), billingPreviewFingerprint(later));
  assert.equal(billingPreviewFingerprint(first), billingPreviewFingerprint(JSON.parse(JSON.stringify(first))));
  assert.equal(billingPreviewFingerprint(first).length, 64);
  assert.equal(billingPreviewsMatch(first, later), true);
});

test("fingerprint does not change when the server includes its own fingerprint", () => {
  const first = preview();
  const fingerprint = billingPreviewFingerprint(first);
  assert.equal(billingPreviewFingerprint({ ...first, previewFingerprint: fingerprint }), fingerprint);
});

test("changed line amounts, rates, customer IDs, or snapshot IDs invalidate the identity", () => {
  const original = preview();
  for (const modify of [
    p => { p.customers[0].lines[0].amount += 0.01; },
    p => { p.customers[0].lines[0].rate = 99; },
    p => { p.customers[0].customerId = "OTHER"; },
    p => { p.reconciliationSnapshotId = "new-snapshot"; },
    p => { p.summary.totalCEAbsorbed += 1; },
  ]) {
    const changed = structuredClone(original);
    modify(changed);
    assert.notEqual(billingPreviewFingerprint(original), billingPreviewFingerprint(changed));
  }
});

test("large September-like preview has a compact save request", () => {
  const huge = preview();
  huge.customers = Array.from({length: 45}, (_, i) => ({
    customerId: `SYNTH-${i}`,
    lines: Array.from({length: 112}, (_, j) => ({
      reconciliationId: `SYNTH-R-${i}-${j}`,
      amount: 10.02,
      note: "Synthetic test content, not real billing data. ".repeat(50),
    })),
  }));
  const hugeSize = Buffer.byteLength(JSON.stringify(huge), "utf8");
  assert.ok(hugeSize > 10_473_782, `synthetic input was ${hugeSize} bytes`);
  const postBody = JSON.stringify({
    billing_period_id: huge.billingPeriodId,
    replace: true,
    replacement_reason: "Synthetic test",
    preview_fingerprint: billingPreviewFingerprint(huge),
    reconciliation_snapshot_id: huge.reconciliationSnapshotId,
  });
  assert.ok(Buffer.byteLength(postBody) < 1024);
  assert.ok(!postBody.includes("customers"));
  assert.equal(billingPreviewFingerprint(huge), billingPreviewFingerprint(JSON.parse(JSON.stringify(huge))));
});

test("frontend submits fingerprint only; server validates identifiers and authoritative preview", () => {
  assert.match(client, /preview_fingerprint: preview\.previewFingerprint/);
  assert.match(client, /reconciliation_snapshot_id: preview\.reconciliationSnapshotId/);
  assert.doesNotMatch(client, /replacement_reason: replacementReason,\s*preview[,}]/);
  assert.match(route, /\/\^\[a-f0-9\]\{64\}\$\/\.test\(previewFingerprint\)/);
  assert.match(route, /previewSnapshotId !== reconciliationReadiness\.snapshotId/);
  assert.match(route, /billingPreviewFingerprint\(authoritativePreview\) !== previewFingerprint/);
  assert.match(route, /buildVersionRecords\(\s*authoritativePreview,/);
  assert.match(route, /billingPreviewsMatch\(authoritativePreview, latestAuthoritativePreview\)/);
  assert.match(route, /reportingSplitsMatch\(authoritativePreview, latestAuthoritativePreview\)/);
  assert.match(route, /candidate record writes/);
  assert.match(route, /pointer activation/);
});
