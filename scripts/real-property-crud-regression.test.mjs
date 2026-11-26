import assert from "node:assert/strict";
import test from "node:test";

import {
  buildEstimatesForRealPropertyRecord,
  buildRealPropertyRecord,
  refreshEstimatesForRealPropertyRecords,
  replaceRecordDependents,
  validateRealPropertyEditorInput,
} from "../lib/real-property-crud.ts";
import {
  checkSnapshotIntegrity,
  createPropQRecords,
  selectSnapshotRecords,
  snapshotRecordsFingerprint,
} from "../lib/real-property-snapshot-core.ts";

const september = {
  billingPeriodId: 182,
  fy: 2026,
  billingMonth: "September",
};

const faa = { CustomerID: "CUST-000032", CustomerName: "FAA", UMMName: "FAA" };
const faaFacility4058 = {
  FacilityID: "FAC-001905",
  FacilityNumber: "4058",
  FacilityName: "RADAR TOWER, FAA",
  SITE_CD: "SHCZ0001",
  RPUID: "1534226",
};
const category = {
  category_cd: "610282",
  space_type_id: "12",
  space_type: "OPERATIONS",
};
const intensities = ["EL", "NG", "PW", "SS"].map((utility, index) => ({
  fy: 2026,
  utility_type_cd: utility,
  space_type_id: "12",
  index: index + 1,
}));

function editor(overrides = {}) {
  return {
    CustomerID: faa.CustomerID,
    FacilityID: faaFacility4058.FacilityID,
    RPUID: faaFacility4058.RPUID,
    CategoryCode: category.category_cd,
    AllocationQty: 100,
    AllocationUM: "SF",
    UtilityGroup: 1,
    EL: 1,
    NG: 1,
    PW: 1,
    SS: 1,
    ...overrides,
  };
}

test("individual create validates assignment, utility flags, and quantity", () => {
  assert.deepEqual(validateRealPropertyEditorInput(editor()), []);
  assert.match(
    validateRealPropertyEditorInput(editor({ EL: 0, NG: 0, PW: 0, SS: 0 })).join(" "),
    /At least one utility/,
  );
});

test("September FY2026 FAA facility 4058 record preserves the exact customer and facility assignment", () => {
  const record = buildRealPropertyRecord({
    monthlyRpId: "MRP-MANUAL-182-FAA-4058",
    editor: editor(),
    customer: faa,
    facility: faaFacility4058,
    ...september,
  });
  assert.equal(record.billing_period_id, 182);
  assert.equal(record.FY, 2026);
  assert.equal(record.BillingMonth, "September");
  assert.equal(record.CustomerID, "CUST-000032");
  assert.equal(record.FacilityID, "FAC-001905");
  assert.equal(record.FacilityNumber, "4058");
  assert.equal(record.RPUID, "1534226");
});

test("individual create and edit rebuild utility estimates without changing the area-intensity formula", () => {
  const created = buildRealPropertyRecord({
    monthlyRpId: "RP-1",
    editor: editor({ AllocationQty: 100, SS: 0 }),
    customer: faa,
    facility: faaFacility4058,
    ...september,
  });
  const first = buildEstimatesForRealPropertyRecord({
    record: created,
    categories: [category],
    intensities,
    ...september,
  });
  assert.deepEqual(first.errors, []);
  assert.equal(first.estimates.length, 3);
  assert.equal(first.estimates.find((row) => row.UtilityType === "PW").EstimatedUsage, 300);

  const edited = buildRealPropertyRecord({
    monthlyRpId: "RP-1",
    editor: editor({ AllocationQty: 50, NG: 0, SS: 1 }),
    customer: faa,
    facility: faaFacility4058,
    existing: created,
    ...september,
  });
  const second = buildEstimatesForRealPropertyRecord({
    record: edited,
    categories: [category],
    intensities,
    ...september,
  });
  assert.equal(second.estimates.length, 3);
  assert.equal(second.estimates.some((row) => row.UtilityType === "NG"), false);
  assert.equal(second.estimates.find((row) => row.UtilityType === "SS").EstimatedUsage, 200);
});

test("individual delete removes only that record's estimates and leaves no orphan PropQ", () => {
  const estimates = [
    { EstimateID: "E1", SourceMonthlyRPID: "RP-1", MonthlyRPID: "RP-1", billing_period_id: 182, FacilityID: "F1", UtilityType: "EL", EstimatedUsage: 20 },
    { EstimateID: "E2", SourceMonthlyRPID: "RP-2", MonthlyRPID: "RP-2", billing_period_id: 182, FacilityID: "F1", UtilityType: "EL", EstimatedUsage: 80 },
  ];
  const remaining = replaceRecordDependents(estimates, "RP-1", []);
  const propQ = createPropQRecords(remaining, september);
  assert.deepEqual(remaining.map((row) => row.EstimateID), ["E2"]);
  assert.equal(propQ.length, 1);
  assert.equal(propQ[0].PropQ, 1);
  assert.deepEqual(
    checkSnapshotIntegrity({
      billingPeriodId: 182,
      realProperty: [{ MonthlyRPID: "RP-2" }],
      estimates: remaining,
      propQ,
    }),
    [],
  );
});

test("shared-facility PropQ is recalculated while SS remains excluded", () => {
  const estimates = [
    { EstimateID: "E1", SourceMonthlyRPID: "RP-1", billing_period_id: 182, FacilityID: "F1", UtilityType: "PW", EstimatedUsage: 25 },
    { EstimateID: "E2", SourceMonthlyRPID: "RP-2", billing_period_id: 182, FacilityID: "F1", UtilityType: "PW", EstimatedUsage: 75 },
    { EstimateID: "E3", SourceMonthlyRPID: "RP-1", billing_period_id: 182, FacilityID: "F1", UtilityType: "SS", EstimatedUsage: 50 },
  ];
  const propQ = createPropQRecords(estimates, september);
  assert.equal(propQ.length, 2);
  assert.deepEqual(propQ.map((row) => row.PropQ), [0.25, 0.75]);
});

test("explicit period refresh rebuilds Estimates and PropQ from current category space type", () => {
  const records = [
    { MonthlyRPID: "RP-1#V#old", LogicalMonthlyRPID: "RP-1", AllocationUM: "SF", AllocationQty: 10000, CategoryCode: "A", FacilityID: "F1", CustomerID: "C1", EL: 1 },
    { MonthlyRPID: "RP-2#V#old", LogicalMonthlyRPID: "RP-2", AllocationUM: "SF", AllocationQty: 10000, CategoryCode: "B", FacilityID: "F1", CustomerID: "C2", EL: 1 },
    { MonthlyRPID: "RP-3#V#old", LogicalMonthlyRPID: "RP-3", AllocationUM: "METER", AllocationQty: 1, CategoryCode: "", FacilityID: "F2", CustomerID: "C3", EL: 1 },
    { MonthlyRPID: "RP-4#V#old", LogicalMonthlyRPID: "RP-4", AllocationUM: "SF", AllocationQty: 100, CategoryCode: "", FacilityID: "F3", CustomerID: "C4", EL: 1 },
  ];
  const existingEstimates = [
    { EstimateID: "OLD-1", SourceMonthlyRPID: "RP-1", billing_period_id: 182, FacilityID: "F1", CustomerID: "C1", UtilityType: "EL", EstimatedUsage: 20297.945 },
    { EstimateID: "OLD-2", SourceMonthlyRPID: "RP-2", billing_period_id: 182, FacilityID: "F1", CustomerID: "C2", UtilityType: "EL", EstimatedUsage: 3148.908 },
    { EstimateID: "METER-EST", SourceMonthlyRPID: "RP-3", billing_period_id: 182, FacilityID: "F2", CustomerID: "C3", UtilityType: "EL", EstimatedUsage: 900 },
    { EstimateID: "STALE-CAT-EST", SourceMonthlyRPID: "RP-4", billing_period_id: 182, FacilityID: "F3", CustomerID: "C4", UtilityType: "EL", EstimatedUsage: 999 },
  ];
  const updated = refreshEstimatesForRealPropertyRecords({
    realProperty: records,
    existingEstimates,
    categories: [
      { category_cd: "A", space_type_id: "2", space_type: "Warehouse" },
      { category_cd: "B", space_type_id: "2", space_type: "Warehouse" },
    ],
    intensities: [
      { fy: 2026, utility_type_cd: "EL", space_type_id: "2", index: 0.3148908 },
      { fy: 2026, utility_type_cd: "EL", space_type_id: "4", index: 2.0297945 },
    ],
    ...september,
  });
  assert.deepEqual(updated.errors, []);
  assert.equal(updated.refreshedRecordCount, 3);
  assert.ok(Math.abs(updated.estimates.find((row) => row.SourceMonthlyRPID === "RP-1").EstimatedUsage - 3148.908) < 1e-9);
  assert.ok(Math.abs(updated.estimates.find((row) => row.SourceMonthlyRPID === "RP-2").EstimatedUsage - 3148.908) < 1e-9);
  assert.equal(updated.estimates.find((row) => row.SourceMonthlyRPID === "RP-3").EstimatedUsage, 900);
  assert.equal(updated.estimates.some((row) => row.SourceMonthlyRPID === "RP-4"), false);
  const propQ = createPropQRecords(updated.estimates, september).filter((row) => row.FacilityID === "F1");
  assert.deepEqual(propQ.map((row) => row.PropQ), [0.5, 0.5]);
});

test("period estimate refresh fails closed when a populated category has no current space type", () => {
  const result = refreshEstimatesForRealPropertyRecords({
    realProperty: [{ MonthlyRPID: "RP-1", AllocationUM: "SF", AllocationQty: 100, CategoryCode: "MISSING", EL: 1 }],
    existingEstimates: [{ EstimateID: "OLD", SourceMonthlyRPID: "RP-1", UtilityType: "EL", EstimatedUsage: 999 }],
    categories: [],
    intensities,
    ...september,
  });
  assert.match(result.errors.join(" "), /no valid space-type mapping/);
  assert.equal(result.estimates[0].EstimatedUsage, 999);
});

test("full-month deletion activates an empty version without exposing archived rows", () => {
  const archived = [
    { MonthlyRPID: "RP-1#V#old", DataVersion: "old" },
    { MonthlyRPID: "RP-2#V#old", DataVersion: "old" },
  ];
  assert.deepEqual(selectSnapshotRecords(archived, { ActiveDataVersion: "empty" }), []);
  assert.deepEqual(
    checkSnapshotIntegrity({ billingPeriodId: 182, realProperty: [], estimates: [], propQ: [] }),
    [],
  );
});

test("validated reupload/replacement hides incomplete staging and switches the complete month together", () => {
  const rows = [
    { MonthlyRPID: "OLD", billing_period_id: 182 },
    { MonthlyRPID: "NEW-1#V#new", billing_period_id: 182, DataVersion: "new" },
    { MonthlyRPID: "NEW-2#V#new", billing_period_id: 182, DataVersion: "new" },
    { MonthlyRPID: "PARTIAL#V#future", billing_period_id: 182, DataVersion: "future" },
  ];
  assert.deepEqual(selectSnapshotRecords(rows, null).map((row) => row.MonthlyRPID), ["OLD"]);
  assert.deepEqual(
    selectSnapshotRecords(rows, { ActiveDataVersion: "new" }).map((row) => row.MonthlyRPID),
    ["NEW-1#V#new", "NEW-2#V#new"],
  );
});

test("legacy monthly records remain visible and have a stable source fingerprint", () => {
  const legacyRows = [
    { MonthlyRPID: "RP-2", billing_period_id: 182, AllocationQty: 100 },
    { MonthlyRPID: "RP-1", billing_period_id: 182, AllocationQty: 50 },
  ];
  const reorderedRows = [legacyRows[1], legacyRows[0]];
  assert.deepEqual(
    selectSnapshotRecords(legacyRows, null),
    legacyRows,
  );
  assert.equal(
    snapshotRecordsFingerprint(legacyRows),
    snapshotRecordsFingerprint(reorderedRows),
  );
  assert.notEqual(
    snapshotRecordsFingerprint(legacyRows),
    snapshotRecordsFingerprint([
      ...legacyRows,
      { MonthlyRPID: "RP-3", billing_period_id: 182, AllocationQty: 25 },
    ]),
  );
});

test("replacement validation rejects cross-month or orphaned dependent rows", () => {
  const errors = checkSnapshotIntegrity({
    billingPeriodId: 182,
    realProperty: [{ MonthlyRPID: "RP-1" }],
    estimates: [
      { EstimateID: "E1", SourceMonthlyRPID: "MISSING", billing_period_id: 181 },
    ],
    propQ: [
      { PropQID: "P1", EstimateID: "NO-ESTIMATE", MonthlyRPID: "RP-1", billing_period_id: 182 },
    ],
  });
  assert.equal(errors.some((error) => error.includes("no parent RP")), true);
  assert.equal(errors.some((error) => error.includes("another billing period")), true);
  assert.equal(errors.some((error) => error.includes("no parent estimate")), true);
});


