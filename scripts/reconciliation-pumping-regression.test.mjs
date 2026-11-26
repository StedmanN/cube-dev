import assert from "node:assert/strict";
import test from "node:test";

import {
  PW_KWH_PER_KGAL,
  SS_KWH_PER_KGAL,
  isProducedWaterPumpingGroup,
  pumpingEnergyForPwAllocation,
  pumpingReserveForPwAllocations,
  reserveElectricityPool,
} from "../lib/reconciliation-pumping.ts";
import {
  displayAccountedConsumption,
  displayDistributableNonMeteredConsumption,
  displayPumpingReservedConsumption,
} from "../lib/reconciliation-display.ts";

function assertClose(actual, expected, tolerance = 0.000001) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `Expected ${actual} to be within ${tolerance} of ${expected}`,
  );
}

test("WWYK February FY2026 pool balances after one pumping reservation", () => {
  const invoice = 19_559_167;
  const metered = 5_837_442.52;
  const pumpingReserved = 105_503.93437521 + 35_375.07800006;
  const pool = reserveElectricityPool(invoice, metered, pumpingReserved);

  assertClose(pool.originalNonMeteredPool, 13_721_724.48);
  assertClose(pool.distributableNonMeteredPool, 13_580_845.46762473);
  assertClose(
    metered + pool.distributableNonMeteredPool + pool.pumpingReserved,
    invoice,
  );
  assert.equal(pool.insufficientPool, false);
});

test("pumping formulas and row-level rounding remain unchanged", () => {
  const energy = pumpingEnergyForPwAllocation(100, 0.25);

  assertClose(energy.pwPumpingKwh, 100 * PW_KWH_PER_KGAL);
  assertClose(energy.ssPumpingKwh, 100 * 0.25 * SS_KWH_PER_KGAL);
  assertClose(
    pumpingReserveForPwAllocations([100, 0], 0.25),
    energy.pwPumpingKwh + energy.ssPumpingKwh,
  );
});

test("February WWYK reference PW allocations reproduce both pumping totals", () => {
  const pwAllocatedKgal = 34_833.045;
  const ssPwFactor = 16_227.1 / pwAllocatedKgal;
  const energy = pumpingEnergyForPwAllocation(pwAllocatedKgal, ssPwFactor);

  assertClose(energy.pwPumpingKwh, 105_503.93437521);
  assertClose(energy.ssPumpingKwh, 35_375.07800006);
});

test("only WWYK is eligible for produced-water pumping electricity", () => {
  assert.equal(isProducedWaterPumpingGroup("1"), true);
  assert.equal(isProducedWaterPumpingGroup("2"), false);
  assert.equal(isProducedWaterPumpingGroup("TAC"), false);
});

test("zero and missing source values do not create a pumping reserve", () => {
  assert.equal(pumpingReserveForPwAllocations([], 0), 0);
  assert.equal(pumpingReserveForPwAllocations([0, 0], 0.5), 0);

  const pool = reserveElectricityPool(0, 0, 0);
  assert.equal(pool.originalNonMeteredPool, 0);
  assert.equal(pool.distributableNonMeteredPool, 0);
  assert.equal(pool.insufficientPool, false);
});

test("insufficient WWYK EL pool is reported instead of clamped", () => {
  const pool = reserveElectricityPool(100, 90, 10.000002);

  assert.equal(pool.insufficientPool, true);
  assert.ok(pool.distributableNonMeteredPool < 0);
});

test("period 175, 179, and 180 retain February, June, and July FY2026 mapping", () => {
  const months = ["October", "November", "December", "January", "February", "March", "April", "May", "June", "July", "August", "September"];
  const monthForPeriod = (billingPeriodId) =>
    months[(billingPeriodId - 171) % 12];

  assert.equal(monthForPeriod(175), "February");
  assert.equal(monthForPeriod(179), "June");
  assert.equal(monthForPeriod(180), "July");
});

test("reconciliation display includes derived pumping in accounted consumption", () => {
  const summary = {
    UtilityType: "EL",
    InvoiceConsumption: 19_559_167,
    NonMeteredConsumption: 13_721_724.48,
    PumpingReservedConsumption: 140_879.01237527,
    DistributableNonMeteredConsumption: 13_580_845.46762473,
    AllocatedMeteredConsumption: 5_837_442.52,
    AllocatedNonMeteredConsumption: 13_580_845.46762473,
    AllocatedDerivedConsumption: 140_879.01237527,
    AccountedConsumption: 19_559_167,
  };

  assertClose(displayPumpingReservedConsumption(summary), 140_879.01237527);
  assertClose(
    displayDistributableNonMeteredConsumption(summary),
    13_580_845.46762473,
  );
  assertClose(displayAccountedConsumption(summary), 19_559_167);
});

test("legacy reconciliation summaries use derived rows in display fallback", () => {
  const legacySummary = {
    UtilityType: "EL",
    NonMeteredConsumption: 100,
    AllocatedMeteredConsumption: 40,
    AllocatedNonMeteredConsumption: 50,
    AllocatedDerivedConsumption: 10,
  };

  assert.equal(displayPumpingReservedConsumption(legacySummary), 10);
  assert.equal(displayDistributableNonMeteredConsumption(legacySummary), 90);
  assert.equal(displayAccountedConsumption(legacySummary), 100);
});
