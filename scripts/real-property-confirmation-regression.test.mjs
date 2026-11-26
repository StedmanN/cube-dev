import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const clientSource = readFileSync(
  new URL("../app/monthly-data/monthly-data-client.tsx", import.meta.url),
  "utf8",
);
const cssSource = readFileSync(
  new URL("../app/monthly-data/monthlydata.css", import.meta.url),
  "utf8",
);
const manageRouteSource = readFileSync(
  new URL("../app/api/monthly-data/real-property/manage/route.ts", import.meta.url),
  "utf8",
);
const uploadRouteSource = readFileSync(
  new URL("../app/api/monthly-data/real-property/upload/route.ts", import.meta.url),
  "utf8",
);
const propqRouteSource = readFileSync(
  new URL("../app/api/monthly-data/real-property/propq/route.ts", import.meta.url),
  "utf8",
);
const snapshotSource = readFileSync(
  new URL("../lib/real-property-snapshot.ts", import.meta.url),
  "utf8",
);
const effectiveSource = readFileSync(
  new URL("../lib/real-property-effective-core.ts", import.meta.url),
  "utf8",
);

const realPropertyStart = clientSource.indexOf("type RealPropertyFieldChange");
const realPropertySource = clientSource.slice(
  realPropertyStart,
  clientSource.indexOf("// MONTHLY SUMMARY", realPropertyStart),
);
const currentSource = clientSource.slice(
  clientSource.indexOf("function RealPropertyCurrent"),
  clientSource.indexOf("function RealPropertyPropQ"),
);
const uploadSource = clientSource.slice(
  clientSource.indexOf("function RealPropertyUpload"),
  clientSource.indexOf("// MONTHLY SUMMARY", realPropertyStart),
);

test("all Real Property writes use the shared secondary confirmation dialog", () => {
  for (const label of [
    "Confirm Changes",
    "Confirm Create",
    "Confirm Delete",
    "Confirm Month Delete",
    "Confirm Replacement",
    "Confirm Import",
  ]) {
    assert.match(realPropertySource, new RegExp(label));
  }
  assert.doesNotMatch(currentSource, /window\.confirm/);
  assert.doesNotMatch(uploadSource, /window\.confirm/);
});

test("record writes occur only from the final pending-operation confirmation", () => {
  assert.match(
    realPropertySource,
    /function prepareSaveConfirmation\(\)[\s\S]*setPendingConfirmation/,
  );
  assert.match(
    realPropertySource,
    /function confirmPendingOperation\(\)[\s\S]*mutate\(\{[\s\S]*\.\.\.pendingConfirmation\.payload,[\s\S]*confirmed: true/,
  );
  assert.match(realPropertySource, /mutationInFlight\.current/);
  assert.match(manageRouteSource, /body\.confirmed !== true/);
});

test("full-month deletion requires the exact DELETE phrase", () => {
  assert.match(realPropertySource, /confirmDisabled=\{deleteMonthText !== "DELETE"\}/);
  assert.match(realPropertySource, /Type <strong>DELETE<\/strong>/);
  assert.match(manageRouteSource, /confirmation_phrase\) !== "DELETE"/);
});

test("replacement validates first and writes only from final confirmation", () => {
  const validationPosition = realPropertySource.indexOf('formDataFor("validate")');
  const pendingPosition = realPropertySource.indexOf("setValidatedUpload({", validationPosition);
  const finalWritePosition = realPropertySource.indexOf("async function confirmUpload", validationPosition);
  assert.ok(validationPosition >= 0);
  assert.ok(pendingPosition > validationPosition);
  assert.ok(finalWritePosition > pendingPosition);
  assert.match(realPropertySource, /uploadInFlight\.current/);
  assert.match(uploadRouteSource, /mode !== "validate"[\s\S]*formData\.get\("confirmed"\)/);
});

test("confirmation dialog has explicit light and dark theme surfaces", () => {
  assert.match(cssSource, /\.md-rp-confirmation-dialog\s*\{/);
  assert.match(cssSource, /\.dark \.md-rp-confirmation-dialog\s*\{/);
  assert.match(cssSource, /\.md-rp-confirmation-footer/);
  assert.match(cssSource, /\.md-rp-confirmation-warning/);
});

test("all Real Property mutations support legacy periods through effective snapshots", () => {
  assert.doesNotMatch(manageRouteSource, /Legacy annual RP cannot be edited/);
  assert.doesNotMatch(uploadRouteSource, /billingPeriodId < FIRST_MONTHLY_RP_BILLING_PERIOD_ID/);
  assert.doesNotMatch(propqRouteSource, /billingPeriodId < FIRST_MONTHLY_RP_BILLING_PERIOD_ID/);
  assert.match(manageRouteSource, /loadLegacyBaseline/);
  assert.match(uploadRouteSource, /queryLegacyBaseline/);
  assert.match(effectiveSource, /legacy_override/);
});

test("replacement confirmation is bound to the validated source version", () => {
  assert.match(uploadRouteSource, /source_data_version/);
  assert.match(uploadRouteSource, /observedSourceVersion/);
  assert.match(uploadRouteSource, /mode !== "validate"[\s\S]*submittedSourceVersion !== observedSourceVersion/);
  assert.match(clientSource, /sourceDataVersion: String\(validation\.sourceDataVersion/);
  assert.match(clientSource, /formDataFor\([\s\S]*validatedUpload\.sourceDataVersion/);
});

test("snapshot batch writes are bounded and retry with exponential backoff", () => {
  assert.match(snapshotSource, /SNAPSHOT_BATCH_SIZE = 25/);
  assert.match(snapshotSource, /SNAPSHOT_BATCH_MAX_RETRIES = 5/);
  assert.match(snapshotSource, /SNAPSHOT_BATCH_BASE_DELAY_MS = 200/);
  assert.match(snapshotSource, /if \(attempts >= SNAPSHOT_BATCH_MAX_RETRIES\)/);
  assert.match(snapshotSource, /2 \*\* Math\.max\(0, attempt - 1\)/);
  assert.match(snapshotSource, /No snapshot was activated/);
});


