import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  billingPeriodToFiscalYear,
  effectiveRealPropertySource,
  normalizeLegacyRealPropertyRecord,
  usesPeriodSnapshot,
} from "../lib/real-property-effective-core.ts";
import {
  checkSnapshotIntegrity,
  createPropQRecords,
  selectSnapshotRecords,
} from "../lib/real-property-snapshot-core.ts";
import { replaceRecordDependents } from "../lib/real-property-crud.ts";

const periods = {
  february: { billingPeriodId: 175, billingMonth: "February" },
  august: { billingPeriodId: 181, billingMonth: "August" },
  september: { billingPeriodId: 182, billingMonth: "September" },
};

const annualRow = {
  LegacyRPID: "LRP-TEST-1",
  FY: 2026,
  FacilityID: "FAC-1",
  CustomerID: "CUST-1",
  FacilityNumber: "4058",
  LegacyCustomerName: "FAA",
  CategoryCode: "610282",
  CustomerQty: 100,
  AllocationUM: "SF",
  UtilityGroup: "WWYK",
  ELUsage: 1,
  NGUsage: 0,
  PWUsage: 1,
  SSUsage: 1,
};

test("legacy periods retain annual baseline until an override exists", () => {
  assert.equal(billingPeriodToFiscalYear(175), 2026);
  assert.equal(billingPeriodToFiscalYear(181), 2026);
  assert.equal(billingPeriodToFiscalYear(182), 2026);
  assert.equal(effectiveRealPropertySource(175, false), "legacy");
  assert.equal(effectiveRealPropertySource(175, true), "legacy_override");
  assert.equal(effectiveRealPropertySource(182, false), "monthly");
  assert.equal(usesPeriodSnapshot(175, false), false);
  assert.equal(usesPeriodSnapshot(175, true), true);
  assert.equal(usesPeriodSnapshot(182, false), true);
});

test("legacy annual rows become month-specific working copies without changing the baseline", () => {
  const baselineBefore = structuredClone(annualRow);
  const february = normalizeLegacyRealPropertyRecord(annualRow, periods.february);
  const august = normalizeLegacyRealPropertyRecord(annualRow, periods.august);
  assert.deepEqual(annualRow, baselineBefore);
  assert.equal(february.MonthlyRPID, "LRP-TEST-1");
  assert.equal(february.billing_period_id, 175);
  assert.equal(february.BillingMonth, "February");
  assert.equal(august.billing_period_id, 181);
  assert.equal(august.BillingMonth, "August");
  assert.equal(february.BaselineSource, "p72-CUBE-RP-LEGACY");
});

test("a February override does not affect August sharing the annual source", () => {
  const storedRows = [
    { MonthlyRPID: "LRP-TEST-1#V#feb-v2", billing_period_id: 175, DataVersion: "feb-v2", AllocationQty: 75 },
    { MonthlyRPID: "LRP-TEST-1#V#aug-v2", billing_period_id: 181, DataVersion: "aug-v2", AllocationQty: 125 },
  ];
  assert.equal(selectSnapshotRecords(storedRows, { ActiveDataVersion: "feb-v2" })[0].AllocationQty, 75);
  assert.equal(selectSnapshotRecords(storedRows.filter((row) => row.billing_period_id === 181), null).length, 0);
  assert.equal(selectSnapshotRecords(storedRows, { ActiveDataVersion: "aug-v2" })[0].AllocationQty, 125);
});

test("legacy Estimate and PropQ relationships remain valid after an override", () => {
  const rp = normalizeLegacyRealPropertyRecord(annualRow, periods.february);
  const estimates = [{
    EstimateID: "EST#175#LRP-TEST-1#EL",
    LegacyRPID: "LRP-TEST-1",
    billing_period_id: 175,
    FacilityID: "FAC-1",
    CustomerID: "CUST-1",
    UtilityType: "EL",
    EstimatedUsage: 100,
  }];
  const propQ = createPropQRecords(estimates, {
    billingPeriodId: 175,
    fy: 2026,
    billingMonth: "February",
  });
  assert.equal(propQ[0].LogicalMonthlyRPID, "LRP-TEST-1");
  assert.equal(propQ[0].PropQ, 1);
  assert.deepEqual(checkSnapshotIntegrity({ billingPeriodId: 175, realProperty: [rp], estimates, propQ }), []);
  assert.deepEqual(replaceRecordDependents(estimates, "LRP-TEST-1", []), []);
});

test("all effective RP readers honor month-specific override state", () => {
  const paths = [
    "../app/api/monthly-data/real-property/route.ts",
    "../app/api/monthly-data/reconciliation/route.ts",
    "../app/api/monthly-data/summary/route.ts",
    "../app/dashboard/page.tsx",
    "../app/api/monthly-data/real-property/manage/route.ts",
    "../app/api/monthly-data/real-property/upload/route.ts",
  ];
  for (const path of paths) {
    const source = readFileSync(new URL(path, import.meta.url), "utf8");
    assert.match(source, /usesPeriodSnapshot/);
  }
});
