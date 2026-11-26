import assert from "node:assert/strict";
import test from "node:test";

import {
  pumpingEnergyForPwAllocation,
  pumpingReserveForSewerEligibility,
} from "../lib/reconciliation-pumping.ts";
import {
  derivedSewerConsumption,
  distributeSewerNonMeteredPool,
  potentialDerivedSewerConsumption,
  resolveDerivedSewerEligibility,
  summarizeSewerNonMeteredPool,
} from "../lib/reconciliation-sewer.ts";
import { evaluateReconciliationBillingStatus } from "../lib/reconciliation-invoice.ts";
import {
  resolveUtilityReimbursement,
  splitReimbursementConsumption,
} from "../lib/utility-reimbursement.ts";

function rp(id, customerId, ss, overrides = {}) {
  return {
    MonthlyRPID: id,
    LogicalMonthlyRPID: id,
    CustomerID: customerId,
    FacilityID: "FAC-SHARED",
    FacilityNumber: "5703",
    UtilityGroup: 1,
    PW: 1,
    SS: ss,
    ...overrides,
  };
}

function pwAllocation(record, consumption) {
  return {
    MonthlyRPID: record.MonthlyRPID,
    LogicalMonthlyRPID: record.LogicalMonthlyRPID,
    CustomerID: record.CustomerID,
    FacilityID: record.FacilityID,
    FacilityNumber: record.FacilityNumber,
    UtilityGroup: record.UtilityGroup,
    UtilityType: "PW",
    AllocatedTotalConsumption: consumption,
  };
}

function poolRecipient(id, group, pw, overrides = {}) {
  return {
    recipientId: id,
    utilityGroup: group,
    allocationSource: "NONMETERED",
    ssCalculationEnabled: true,
    pwNonMeteredConsumption: pw,
    hasDirectSewerMeterAllocation: false,
    ...overrides,
  };
}

test("SS enabled preserves the approved PW times SS/PW factor", () => {
  const sourceRp = rp("RP-ENABLED", "CUST-A", 1);
  const eligibility = resolveDerivedSewerEligibility(
    pwAllocation(sourceRp, 100),
    [sourceRp],
  );

  assert.deepEqual(
    { status: eligibility.status, eligible: eligibility.eligible },
    { status: "MATCHED", eligible: true },
  );
  assert.equal(derivedSewerConsumption(100, 0.25, eligibility), 25);
});

test("SS disabled generates no derived sewer without changing PW", () => {
  const sourceRp = rp("RP-DISABLED", "CUST-B", 0);
  const pw = 100;
  const eligibility = resolveDerivedSewerEligibility(
    pwAllocation(sourceRp, pw),
    [sourceRp],
  );

  assert.equal(eligibility.status, "MATCHED");
  assert.equal(eligibility.eligible, false);
  assert.equal(derivedSewerConsumption(pw, 0.25, eligibility), 0);
  assert.equal(potentialDerivedSewerConsumption(pw, 0.25), 25);
  assert.equal(pwAllocation(sourceRp, pw).AllocatedTotalConsumption, 100);
});

test("SS Calculation ON preserves consumption for reimbursable and CE-absorbed billing", () => {
  const sourceRp = rp("RP-RESPONSIBILITY", "CUST-A", 1);
  const eligibility = resolveDerivedSewerEligibility(
    pwAllocation(sourceRp, 100),
    [sourceRp],
  );
  const sewer = derivedSewerConsumption(100, 0.25, eligibility);
  const reimbursable = resolveUtilityReimbursement({
    utilityType: "SS",
    customerType: "Reimbursable",
    overrides: { SS: true },
  });
  const ceAbsorbed = resolveUtilityReimbursement({
    utilityType: "SS",
    customerType: "Reimbursable",
    overrides: { SS: false },
  });

  assert.equal(sewer, 25);
  assert.deepEqual(
    splitReimbursementConsumption(sewer, reimbursable.disposition),
    {
      allocatedReimbursableConsumption: 25,
      allocatedCEAbsorbedConsumption: 0,
    },
  );
  assert.deepEqual(
    splitReimbursementConsumption(sewer, ceAbsorbed.disposition),
    {
      allocatedReimbursableConsumption: 0,
      allocatedCEAbsorbedConsumption: 25,
    },
  );
});

test("SS Calculation OFF preserves an inactive reimbursement override and contributes only to the pool", () => {
  const sourceRp = rp("RP-POOL", "CUST-B", 0);
  const eligibility = resolveDerivedSewerEligibility(
    pwAllocation(sourceRp, 60),
    [sourceRp],
  );
  const reimbursement = resolveUtilityReimbursement({
    utilityType: "SS",
    customerType: "Non-Reimbursable",
    overrides: { SS: true },
    calculationEnabled: false,
  });
  const allocated = derivedSewerConsumption(60, 0.5, eligibility);
  const pooled = potentialDerivedSewerConsumption(60, 0.5);

  assert.equal(allocated, 0);
  assert.equal(pooled, 30);
  assert.equal(reimbursement.explicitOverride, true);
  assert.equal(reimbursement.overrideApplied, false);
  assert.equal(reimbursement.effectiveReimbursable, false);
  assert.equal(allocated + pooled, 30, "excluded sewer is not double counted");
});

test("SS pool accounting conserves source consumption without inventing recipients", () => {
  const accounting = summarizeSewerNonMeteredPool({
    sourceConsumption: 50,
    allocatedConsumption: 20,
    poolContribution: 25,
    epsilon: 0.000001,
  });

  assert.equal(accounting.poolContribution, 25);
  assert.equal(accounting.otherUnallocatedConsumption, 5);
  assert.equal(accounting.totalUnallocatedConsumption, 30);
  assert.equal(accounting.accountedConsumption, 50);
  assert.equal(
    20 + accounting.poolContribution + accounting.otherUnallocatedConsumption,
    50,
  );
});

test("complete SS pool distribution follows existing non-metered PW shares", () => {
  const distribution = distributeSewerNonMeteredPool(
    30,
    "1",
    [poolRecipient("RP-A", "1", 25), poolRecipient("RP-B", "1", 75)],
    0.000001,
  );

  assert.equal(distribution.status, "DISTRIBUTED");
  assert.equal(distribution.weightingBasis, 100);
  assert.deepEqual(
    distribution.allocations.map(({ weight, allocatedConsumption }) => ({
      weight,
      allocatedConsumption,
    })),
    [
      { weight: 0.25, allocatedConsumption: 7.5 },
      { weight: 0.75, allocatedConsumption: 22.5 },
    ],
  );
  assert.equal(
    distribution.allocations.reduce(
      (sum, row) => sum + row.allocatedConsumption,
      0,
    ),
    30,
  );
});

test("SS pool recipients are group-isolated, SS-enabled, non-metered PW only", () => {
  const distribution = distributeSewerNonMeteredPool(
    20,
    "WWYK",
    [
      poolRecipient("ELIGIBLE", "1", 50),
      poolRecipient("SS-OFF", "1", 500, { ssCalculationEnabled: false }),
      poolRecipient("OTHER-GROUP", "2", 500),
      poolRecipient("PW-METERED", "1", 500, { allocationSource: "METER" }),
      poolRecipient("SS-METERED", "1", 500, {
        hasDirectSewerMeterAllocation: true,
      }),
    ],
    0.000001,
  );

  assert.equal(distribution.status, "DISTRIBUTED");
  assert.equal(distribution.allocations.length, 1);
  assert.equal(distribution.allocations[0].recipient.recipientId, "ELIGIBLE");
  assert.equal(distribution.allocations[0].allocatedConsumption, 20);
});

test("no eligible PW recipient leaves the complete SS pool unresolved", () => {
  const distribution = distributeSewerNonMeteredPool(
    12.5,
    "2",
    [
      poolRecipient("SS-OFF", "2", 100, { ssCalculationEnabled: false }),
      poolRecipient("OTHER-GROUP", "1", 100),
    ],
    0.000001,
  );

  assert.equal(distribution.status, "UNRESOLVED");
  assert.equal(distribution.reasonCode, "NO_ELIGIBLE_PW_RECIPIENTS");
  assert.equal(distribution.unresolvedConsumption, 12.5);
  assert.deepEqual(distribution.allocations, []);
});

test("duplicate PW recipient identifiers fail closed without double allocation", () => {
  const distribution = distributeSewerNonMeteredPool(
    10,
    "1",
    [poolRecipient("DUP", "1", 40), poolRecipient("DUP", "1", 60)],
    0.000001,
  );

  assert.equal(distribution.status, "UNRESOLVED");
  assert.equal(distribution.reasonCode, "DUPLICATE_PW_RECIPIENT");
  assert.deepEqual(distribution.allocations, []);
});

test("distributed SS pool reconciles exactly and permits readiness", () => {
  const accounting = summarizeSewerNonMeteredPool({
    sourceConsumption: 50,
    allocatedConsumption: 50,
    poolContribution: 30,
    distributedPoolConsumption: 30,
    epsilon: 0.000001,
  });
  const readiness = evaluateReconciliationBillingStatus({
    accountingDifference: 50 - accounting.accountedConsumption,
    allocationDifference: accounting.allocationDifference,
    unallocatedMetered: 0,
    unallocatedNonMetered: accounting.totalUnallocatedConsumption,
    invalidInvoiceRows: 0,
    issueCount: 0,
  });

  assert.equal(accounting.distributedPoolConsumption, 30);
  assert.equal(accounting.unresolvedPoolConsumption, 0);
  assert.equal(accounting.otherUnallocatedConsumption, 0);
  assert.equal(accounting.totalUnallocatedConsumption, 0);
  assert.equal(accounting.accountedConsumption, 50);
  assert.equal(readiness.billingReady, true);
});

test("February BP 175 fixture pools conserve both utility groups", () => {
  for (const [utilityGroup, pool] of [
    ["1", 68.71710378],
    ["2", 0.44518176],
  ]) {
    const distribution = distributeSewerNonMeteredPool(
      pool,
      utilityGroup,
      [
        poolRecipient(`${utilityGroup}-A`, utilityGroup, 2),
        poolRecipient(`${utilityGroup}-B`, utilityGroup, 3),
      ],
      0.00000001,
    );
    assert.equal(distribution.status, "DISTRIBUTED");
    const distributed = distribution.allocations.reduce(
      (sum, row) => sum + row.allocatedConsumption,
      0,
    );
    assert.ok(Math.abs(distributed - pool) < 0.00000001);
  }
});

test("an unresolved SS pool is accounted but remains not BILLING_READY", () => {
  const accounting = summarizeSewerNonMeteredPool({
    sourceConsumption: 50,
    allocatedConsumption: 20,
    poolContribution: 30,
    epsilon: 0.000001,
  });
  const readiness = evaluateReconciliationBillingStatus({
    accountingDifference: 50 - accounting.accountedConsumption,
    allocationDifference: accounting.allocationDifference,
    unallocatedMetered: 0,
    unallocatedNonMetered: accounting.totalUnallocatedConsumption,
    invalidInvoiceRows: 0,
    issueCount: 1,
  });

  assert.equal(readiness.accountingStatus, "RECONCILED");
  assert.equal(readiness.billingReady, false);
  assert.equal(readiness.reconciliationStatus, "EXCEPTION");
});

test("switching SS flags in either direction changes only sewer eligibility", () => {
  const enabled = rp("RP-SWITCH", "CUST-A", 1);
  const disabled = { ...enabled, SS: 0 };
  const allocation = pwAllocation(enabled, 80);

  const before = resolveDerivedSewerEligibility(allocation, [enabled]);
  const afterDisable = resolveDerivedSewerEligibility(allocation, [disabled]);
  const afterEnable = resolveDerivedSewerEligibility(allocation, [enabled]);

  assert.equal(derivedSewerConsumption(80, 0.5, before), 40);
  assert.equal(derivedSewerConsumption(80, 0.5, afterDisable), 0);
  assert.equal(derivedSewerConsumption(80, 0.5, afterEnable), 40);
});

test("shared facilities preserve customer-specific mixed sewer eligibility", () => {
  const enabled = rp("RP-A", "CUST-A", 1);
  const disabled = rp("RP-B", "CUST-B", 0);
  const activeRp = [enabled, disabled];
  const enabledDecision = resolveDerivedSewerEligibility(
    pwAllocation(enabled, 40),
    activeRp,
  );
  const disabledDecision = resolveDerivedSewerEligibility(
    pwAllocation(disabled, 60),
    activeRp,
  );

  assert.equal(enabledDecision.status, "MATCHED");
  assert.equal(enabledDecision.eligible, true);
  assert.equal(disabledDecision.status, "MATCHED");
  assert.equal(disabledDecision.eligible, false);

  const derived =
    derivedSewerConsumption(40, 0.5, enabledDecision) +
    derivedSewerConsumption(60, 0.5, disabledDecision);
  assert.equal(derived, 20);
  assert.equal(50 - derived, 30, "excluded sewer remains visible and is not redistributed");
});

test("missing, ambiguous, and inconsistent RP links require review", () => {
  const sourceRp = rp("RP-REVIEW", "CUST-A", 1);
  const source = pwAllocation(sourceRp, 10);

  assert.equal(
    resolveDerivedSewerEligibility(source, []).status,
    "REVIEW_REQUIRED",
  );
  assert.equal(
    resolveDerivedSewerEligibility(source, [sourceRp, { ...sourceRp }])
      .status,
    "REVIEW_REQUIRED",
  );
  const mismatch = resolveDerivedSewerEligibility(source, [
    { ...sourceRp, CustomerID: "CUST-OTHER" },
  ]);
  assert.equal(mismatch.status, "REVIEW_REQUIRED");
  assert.equal(mismatch.reasonCode, "RP_SOURCE_MISMATCH");
  assert.equal(derivedSewerConsumption(10, 0.5, mismatch), 0);
});

test("PW pumping remains for every allocation while SS pumping follows eligibility", () => {
  const factor = 0.25;
  const enabledEnergy = pumpingEnergyForPwAllocation(40, factor);
  const disabledEnergy = pumpingEnergyForPwAllocation(60, factor);
  const reserve = pumpingReserveForSewerEligibility(
    [
      { pwConsumption: 40, sewerEligible: true },
      { pwConsumption: 60, sewerEligible: false },
    ],
    factor,
  );

  assert.equal(
    reserve,
    enabledEnergy.pwPumpingKwh +
      enabledEnergy.ssPumpingKwh +
      disabledEnergy.pwPumpingKwh,
  );
  assert.ok(disabledEnergy.ssPumpingKwh > 0);
  assert.equal(
    reserve <
      enabledEnergy.pwPumpingKwh +
        enabledEnergy.ssPumpingKwh +
        disabledEnergy.pwPumpingKwh +
        disabledEnergy.ssPumpingKwh,
    true,
  );
});

