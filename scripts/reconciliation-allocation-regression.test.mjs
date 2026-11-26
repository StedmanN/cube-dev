import assert from "node:assert/strict";
import test from "node:test";

import {
  buildUsedMeterFacilityUtilityGroupKeys,
  calculateMeterPropQAllocations,
  distributeNonMeteredPool,
  facilityUtilityGroupKey,
  isMeteredConsumptionOverSource,
  isMeteredFacilityUtilityEligible,
  isNonMeteredPoolUnallocatable,
  isNonMeteredFacilityEligible,
  matchingRealPropertyRowsForUtilityGroup,
  resolveRealPropertyUtilityGroup,
} from "../lib/reconciliation-allocation.ts";
import { reserveElectricityPool } from "../lib/reconciliation-pumping.ts";

const EPSILON = 0.000001;

function assertClose(actual, expected, tolerance = 0.000001) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `Expected ${actual} to be within ${tolerance} of ${expected}`,
  );
}

test("MWCS facility 999901 with used W1500 is excluded from nonmetered PW", () => {
  const usedMeters = buildUsedMeterFacilityUtilityGroupKeys([
    { facilityNumber: "999901", utilityType: "PW", utilityGroup: "1" },
  ]);

  assert.equal(
    isNonMeteredFacilityEligible(
      {
        facilityNumber: "999901",
        utilityType: "PW",
        utilityGroup: "1",
        rpCommodityEnabled: true,
      },
      usedMeters,
    ),
    false,
  );
  const meterAllocation = calculateMeterPropQAllocations(60, [1], EPSILON);
  assert.deepEqual(meterAllocation.allocations, [60]);
});

test("zero-consumption used meters still exclude a matching facility", () => {
  const usedMeters = buildUsedMeterFacilityUtilityGroupKeys([
    { facilityNumber: "999901", utilityType: "PW", utilityGroup: "1" },
  ]);

  assert.equal(
    usedMeters.has(facilityUtilityGroupKey("999901", "PW", "1")),
    true,
  );
  assert.equal(
    isNonMeteredFacilityEligible(
      {
        facilityNumber: "999901",
        utilityType: "PW",
        utilityGroup: "1",
        rpCommodityEnabled: true,
      },
      usedMeters,
    ),
    false,
  );
});

test("unused meters do not exclude a facility", () => {
  const usedMeters = buildUsedMeterFacilityUtilityGroupKeys([]);
  assert.equal(
    isNonMeteredFacilityEligible(
      {
        facilityNumber: "999901",
        utilityType: "PW",
        utilityGroup: "1",
        rpCommodityEnabled: true,
      },
      usedMeters,
    ),
    true,
  );
});

test("a used meter does not exclude a facility when its RP commodity flag is off", () => {
  const usedMeters = buildUsedMeterFacilityUtilityGroupKeys([
    { facilityNumber: "999901", utilityType: "PW", utilityGroup: "1" },
  ]);
  assert.equal(
    isNonMeteredFacilityEligible(
      {
        facilityNumber: "999901",
        utilityType: "PW",
        utilityGroup: "1",
        rpCommodityEnabled: false,
      },
      usedMeters,
    ),
    true,
  );
});

test("multiple used meters at one facility collapse to one eligibility key", () => {
  const usedMeters = buildUsedMeterFacilityUtilityGroupKeys([
    { facilityNumber: "999901", utilityType: "PW", utilityGroup: "1" },
    { facilityNumber: "999901", utilityType: "PW", utilityGroup: "1" },
  ]);
  assert.equal(usedMeters.size, 1);
});

test("commodity, group, and facility matching stay isolated", () => {
  const usedMeters = buildUsedMeterFacilityUtilityGroupKeys([
    { facilityNumber: "999901", utilityType: "PW", utilityGroup: "1" },
  ]);

  assert.equal(
    isNonMeteredFacilityEligible(
      {
        facilityNumber: "999901",
        utilityType: "EL",
        utilityGroup: "1",
        rpCommodityEnabled: true,
      },
      usedMeters,
    ),
    true,
  );
  assert.equal(
    isNonMeteredFacilityEligible(
      {
        facilityNumber: "999901",
        utilityType: "PW",
        utilityGroup: "2",
        rpCommodityEnabled: true,
      },
      usedMeters,
    ),
    true,
  );
  assert.equal(
    isNonMeteredFacilityEligible(
      {
        facilityNumber: "OTHER",
        utilityType: "PW",
        utilityGroup: "1",
        rpCommodityEnabled: true,
      },
      usedMeters,
    ),
    true,
  );
});

test("multiple tenants share a meter without exceeding its consumption", () => {
  const result = calculateMeterPropQAllocations(60, [0.25, 0.75], EPSILON);
  assert.equal(result.exceedsMeter, false);
  assertClose(result.allocations.reduce((sum, value) => sum + value, 0), 60);
  assert.deepEqual(result.allocations, [15, 45]);
});

test("PropQ totals above 100 percent become unallocated instead of overallocating", () => {
  const result = calculateMeterPropQAllocations(60, [0.6, 0.5], EPSILON);
  assert.equal(result.exceedsMeter, true);
  assert.deepEqual(result.allocations, []);
});

test("same customer at another facility remains eligible", () => {
  const usedMeters = buildUsedMeterFacilityUtilityGroupKeys([
    { facilityNumber: "999901", utilityType: "PW", utilityGroup: "1" },
  ]);
  assert.equal(
    isNonMeteredFacilityEligible(
      {
        facilityNumber: "999902",
        utilityType: "PW",
        utilityGroup: "1",
        rpCommodityEnabled: true,
      },
      usedMeters,
    ),
    true,
  );
});

test("remaining nonmetered pool is redistributed using eligible EstimatedUsage", () => {
  const rows = [
    { facility: "A", estimatedUsage: 100 },
    { facility: "B", estimatedUsage: 300 },
  ];
  const result = distributeNonMeteredPool(
    1000,
    rows,
    (row) => row.estimatedUsage,
  );
  assert.equal(result.projectedUsageTotal, 400);
  assert.deepEqual(result.allocations, [250, 750]);
  assertClose(result.allocations.reduce((sum, value) => sum + value, 0), 1000);
});

test("no eligible facilities produce no artificial allocations", () => {
  const result = distributeNonMeteredPool(1000, [], () => 0);
  assert.equal(result.projectedUsageTotal, 0);
  assert.deepEqual(result.allocations, []);
});

test("zero remaining nonmetered pool does not create a PropQ exception", () => {
  assert.equal(isNonMeteredPoolUnallocatable(0, 0, EPSILON), false);
  assert.equal(isNonMeteredPoolUnallocatable(0.0000005, 0, EPSILON), false);
});

test("nonzero remaining pool with no eligible facilities remains blocking", () => {
  assert.equal(isNonMeteredPoolUnallocatable(1, 0, EPSILON), true);
});

test("metered consumption above the source total is detected", () => {
  assert.equal(isMeteredConsumptionOverSource(101, 100, EPSILON), true);
  assert.equal(isMeteredConsumptionOverSource(100, 100, EPSILON), false);
});

test("WWYK pumping and TAC remain isolated by utility group", () => {
  const wwyk = facilityUtilityGroupKey("999901", "PW", "1");
  const tac = facilityUtilityGroupKey("9001", "PW", "2");
  assert.notEqual(wwyk, tac);
});

test("E0461 is excluded from metered consumption when RP electricity is disabled", () => {
  const e0461Rp = [{ FacilityNumber: "1096", EL: 0, PW: 0, SS: 0, NG: 0 }];

  assert.equal(isMeteredFacilityUtilityEligible(e0461Rp, "EL", "1"), false);

  const invoiceConsumption = 10_000;
  const e0461Consumption = 2_280;
  const eligibleMeteredConsumption = isMeteredFacilityUtilityEligible(
    e0461Rp,
    "EL",
  )
    ? e0461Consumption
    : 0;

  assert.equal(eligibleMeteredConsumption, 0);
  const pool = reserveElectricityPool(
    invoiceConsumption,
    eligibleMeteredConsumption,
    0,
  );
  assert.equal(pool.originalNonMeteredPool, invoiceConsumption);
  assert.equal(pool.distributableNonMeteredPool, invoiceConsumption);
  assert.equal(
    eligibleMeteredConsumption + pool.distributableNonMeteredPool,
    invoiceConsumption,
  );
});

test("RP-disabled meter eligibility stays isolated by utility and group", () => {
  const rp = [{ EL: 0, PW: 1 }];

  assert.equal(isMeteredFacilityUtilityEligible(rp, "EL", "1"), false);
  assert.equal(isMeteredFacilityUtilityEligible(rp, "PW", "1"), true);
  assert.equal(
    isMeteredFacilityUtilityEligible([{ EL: 1 }], "EL", "1"),
    true,
  );
  assert.equal(isMeteredFacilityUtilityEligible([], "EL", "1"), true);
});

test("RP utility eligibility stays isolated by facility utility group", () => {
  const rp = [
    { FacilityNumber: "1096", UtilityGroup: 2, EL: 1 },
    { FacilityNumber: "1096", UtilityGroup: 1, EL: 0 },
  ];

  assert.equal(
    matchingRealPropertyRowsForUtilityGroup(rp, "1").length,
    1,
  );
  assert.equal(isMeteredFacilityUtilityEligible(rp, "EL", "1"), false);
  assert.equal(isMeteredFacilityUtilityEligible(rp, "EL", "2"), true);
});

test("a unique active RP group resolves a blank meter group generically", () => {
  const resolution = resolveRealPropertyUtilityGroup([
    { FacilityNumber: "31", UtilityGroup: 1, EL: 1 },
    { FacilityNumber: "31", UtilityGroup: "WWYK", EL: 1 },
  ]);

  assert.deepEqual(resolution, { status: "RESOLVED", utilityGroup: "WWYK" });
  const usedMeterKeys = buildUsedMeterFacilityUtilityGroupKeys([
    {
      facilityNumber: "31",
      utilityType: "EL",
      utilityGroup: "1",
    },
  ]);
  assert.equal(
    isNonMeteredFacilityEligible(
      {
        facilityNumber: "31",
        utilityType: "EL",
        utilityGroup: "1",
        rpCommodityEnabled: true,
      },
      usedMeterKeys,
    ),
    false,
  );
});

test("conflicting or incomplete active RP groups are not guessed", () => {
  assert.deepEqual(
    resolveRealPropertyUtilityGroup([
      { UtilityGroup: 1 },
      { UtilityGroup: 2 },
    ]),
    { status: "AMBIGUOUS", utilityGroups: ["TAC", "WWYK"] },
  );
  assert.deepEqual(
    resolveRealPropertyUtilityGroup([
      { UtilityGroup: 1 },
      { UtilityGroup: "" },
    ]),
    { status: "AMBIGUOUS", utilityGroups: ["WWYK"] },
  );
  assert.deepEqual(resolveRealPropertyUtilityGroup([]), {
    status: "MISSING",
    utilityGroups: [],
  });
});

test("unsupported RP group values cannot resolve a meter group", () => {
  assert.deepEqual(resolveRealPropertyUtilityGroup([{ UtilityGroup: "UNKNOWN" }]), {
    status: "AMBIGUOUS",
    utilityGroups: ["UNKNOWN"],
  });
});

console.log("Reconciliation allocation regression checks passed.");
