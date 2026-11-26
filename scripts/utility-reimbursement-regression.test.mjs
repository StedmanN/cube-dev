import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  customerTypeIsReimbursable,
  normalizeUtilityReimbursementOverrides,
  parseUtilityReimbursementCsvValue,
  reimbursementSnapshotFields,
  resolveUtilityReimbursement,
  splitReimbursementCharge,
  splitReimbursementConsumption,
} from "../lib/utility-reimbursement.ts";
import {
  classifyMeterCalculationEligibility,
} from "../lib/reconciliation-allocation.ts";

const monthlyUiSource = readFileSync(
  new URL("../app/monthly-data/monthly-data-client.tsx", import.meta.url),
  "utf8",
);
const uploadSource = readFileSync(
  new URL(
    "../app/api/monthly-data/real-property/upload/route.ts",
    import.meta.url,
  ),
  "utf8",
);
const customerPdfSource = readFileSync(new URL("../lib/rcbl-customer-pdf.ts", import.meta.url), "utf8");
const billingUiSource = readFileSync(
  new URL("../app/billing/billing-client.tsx", import.meta.url),
  "utf8",
);

test("Customer Registry supplies reimbursable and non-reimbursable defaults", () => {
  assert.equal(customerTypeIsReimbursable("Reimbursable"), true);
  assert.equal(customerTypeIsReimbursable("Non-Reimbursable"), false);
  assert.equal(customerTypeIsReimbursable(""), false);

  const reimbursable = resolveUtilityReimbursement({
    utilityType: "EL",
    customerType: "Reimbursable",
    overrides: {},
  });
  assert.equal(reimbursable.source, "CUSTOMER_REGISTRY");
  assert.equal(reimbursable.disposition, "CUSTOMER_REIMBURSABLE");

  const nonReimbursable = resolveUtilityReimbursement({
    utilityType: "EL",
    customerType: "Non-Reimbursable",
    overrides: {},
  });
  assert.equal(nonReimbursable.disposition, "CE_ABSORBED");
});

test("all four utility overrides take precedence independently", () => {
  const overrides = { EL: false, NG: true, PW: false, SS: true };
  assert.equal(
    resolveUtilityReimbursement({
      utilityType: "EL",
      customerType: "Reimbursable",
      overrides,
    }).effectiveReimbursable,
    false,
  );
  assert.equal(
    resolveUtilityReimbursement({
      utilityType: "NG",
      customerType: "Non-Reimbursable",
      overrides,
    }).effectiveReimbursable,
    true,
  );
  assert.equal(
    resolveUtilityReimbursement({
      utilityType: "PW",
      customerType: "Reimbursable",
      overrides,
    }).effectiveReimbursable,
    false,
  );
  assert.equal(
    resolveUtilityReimbursement({
      utilityType: "SS",
      customerType: "Non-Reimbursable",
      overrides,
    }).effectiveReimbursable,
    true,
  );
});

test("reset removes an override and calculation OFF preserves but does not apply it", () => {
  assert.deepEqual(
    normalizeUtilityReimbursementOverrides({ EL: true, NG: "bad" }),
    { EL: true },
  );

  const inactive = resolveUtilityReimbursement({
    utilityType: "EL",
    customerType: "Non-Reimbursable",
    overrides: { EL: true },
    calculationEnabled: false,
  });
  assert.equal(inactive.explicitOverride, true);
  assert.equal(inactive.overrideApplied, false);
  assert.equal(inactive.effectiveReimbursable, false);
  assert.equal(inactive.source, "CUSTOMER_REGISTRY");

  const reset = resolveUtilityReimbursement({
    utilityType: "EL",
    customerType: "Reimbursable",
    overrides: {},
  });
  assert.equal(reset.explicitOverride, null);
  assert.equal(reset.source, "CUSTOMER_REGISTRY");
});

test("reconciliation snapshot fields retain explicit and effective responsibility", () => {
  const fields = reimbursementSnapshotFields(
    resolveUtilityReimbursement({
      utilityType: "SS",
      customerType: "Reimbursable",
      overrides: { SS: false },
    }),
  );
  assert.equal(fields.ReimbursementUtilityType, "SS");
  assert.equal(fields.ReimbursementOverride, false);
  assert.equal(fields.ReimbursementOverrideApplied, 1);
  assert.equal(fields.ReimbursementDisposition, "CE_ABSORBED");
});

test("customer and CE charge splits conserve the unchanged calculated amount", () => {
  assert.deepEqual(splitReimbursementCharge(125.5, "CUSTOMER_REIMBURSABLE"), {
    calculatedAmount: 125.5,
    customerChargeAmount: 125.5,
    ceAbsorbedAmount: 0,
  });
  assert.deepEqual(splitReimbursementCharge(125.5, "CE_ABSORBED"), {
    calculatedAmount: 125.5,
    customerChargeAmount: 0,
    ceAbsorbedAmount: 125.5,
  });
  assert.deepEqual(splitReimbursementCharge(null, "CE_ABSORBED"), {
    calculatedAmount: null,
    customerChargeAmount: null,
    ceAbsorbedAmount: null,
  });

  const consumption = splitReimbursementConsumption(400, "CE_ABSORBED");
  assert.equal(
    consumption.allocatedReimbursableConsumption +
      consumption.allocatedCEAbsorbedConsumption,
    400,
  );
});

test("PW pumping retains EL reimbursement; SS pumping follows SS reimbursement", () => {
  const sourceRp = {
    UtilityReimbursementOverrides: { EL: false, PW: true, SS: true },
  };
  const electricity = resolveUtilityReimbursement({
    utilityType: "EL",
    customerType: "Reimbursable",
    overrides: sourceRp.UtilityReimbursementOverrides,
  });
  assert.equal(electricity.disposition, "CE_ABSORBED");
  assert.equal(electricity.utilityType, "EL");
});

test("CSV reimbursement values support inheritance and reject ambiguous text", () => {
  assert.deepEqual(parseUtilityReimbursementCsvValue(""), {
    value: null,
    error: null,
  });
  assert.equal(parseUtilityReimbursementCsvValue("Reimbursable").value, true);
  assert.equal(
    parseUtilityReimbursementCsvValue("Non-Reimbursable").value,
    false,
  );
  assert.match(parseUtilityReimbursementCsvValue("maybe").error ?? "", /not a valid/);
});

test("shared meter eligibility fails closed for mixed Calculation settings", () => {
  const shared = [
    { FacilityNumber: "5703", UtilityGroup: 1, PW: 1 },
    { FacilityNumber: "5703", UtilityGroup: 1, PW: 0 },
  ];
  assert.equal(
    classifyMeterCalculationEligibility(shared, "PW", "1"),
    "MIXED",
  );
  assert.equal(
    classifyMeterCalculationEligibility(
      shared.map((row) => ({ ...row, PW: 0 })),
      "PW",
      "1",
    ),
    "ALL_DISABLED",
  );
  assert.equal(
    classifyMeterCalculationEligibility(
      shared.map((row) => ({ ...row, PW: 1 })),
      "PW",
      "1",
    ),
    "ALL_ENABLED",
  );
});

test("Calculation OFF disables reimbursement controls without deleting overrides", () => {
  assert.match(monthlyUiSource, /disabled=\{!calculationEnabled\}/);
  assert.match(monthlyUiSource, /saved but inactive/);
  assert.match(monthlyUiSource, /Reset to Customer Default/);
  assert.doesNotMatch(
    monthlyUiSource,
    /\[utility\]: event\.target\.checked \? 1 : 0[\s\S]{0,200}delete overrides/,
  );
});

test("replacement validation protects existing reimbursement overrides", () => {
  assert.match(uploadSource, /existingHasReimbursementOverrides/);
  assert.match(uploadSource, /mode !== "import"/);
  for (const utility of ["EL", "NG", "PW", "SS"]) {
    assert.match(uploadSource, new RegExp(`${utility} Reimbursement`));
  }
  assert.match(uploadSource, /not silently erased/);
});

test("official PDF excludes newly classified CE-absorbed lines", () => {
  assert.match(
    customerPdfSource,
    /line\.reimbursementDisposition === "CE_ABSORBED"/,
  );
  assert.match(billingUiSource, /CE Absorbed/);
  assert.match(billingUiSource, /Customer Due/);
});

