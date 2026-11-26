import { createHash } from "node:crypto";

export type SnapshotItem = Record<string, unknown>;

export type SnapshotState = { ActiveDataVersion: string } | null;

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, stableValue(entry)]),
    );
  }
  return value;
}

export function snapshotRecordsFingerprint(items: SnapshotItem[]): string {
  const normalized = items
    .map((item) => JSON.stringify(stableValue(item)))
    .sort()
    .join("\n");
  return createHash("sha256").update(normalized).digest("hex");
}

function text(value: unknown): string {
  return value === undefined || value === null ? "" : String(value).trim();
}

function numberValue(value: unknown): number {
  const parsed = Number(text(value).replace(/[$,]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

export function snapshotLogicalMonthlyRpId(item: SnapshotItem): string {
  const explicit = text(item.LogicalMonthlyRPID);
  return explicit || text(item.MonthlyRPID).split("#V#")[0];
}

export function selectSnapshotRecords(
  items: SnapshotItem[],
  state: SnapshotState,
) {
  if (!state) return items.filter((item) => !text(item.DataVersion));
  return items.filter(
    (item) => text(item.DataVersion) === state.ActiveDataVersion,
  );
}

export function createPropQRecords(
  estimates: SnapshotItem[],
  metadata: { billingPeriodId: number; fy: number; billingMonth: string },
) {
  const eligible = estimates.filter(
    (estimate) => text(estimate.UtilityType).toUpperCase() !== "SS",
  );
  const totals = new Map<string, number>();
  for (const estimate of eligible) {
    const key = `${text(estimate.FacilityID)}|${text(estimate.UtilityType).toUpperCase()}`;
    totals.set(key, (totals.get(key) ?? 0) + numberValue(estimate.EstimatedUsage));
  }
  return eligible.map((estimate) => {
    const utility = text(estimate.UtilityType).toUpperCase();
    const facilityId = text(estimate.FacilityID);
    const sourceRpId =
      text(estimate.SourceMonthlyRPID) ||
      text(estimate.LogicalMonthlyRPID) ||
      text(estimate.MonthlyRPID).split("#V#")[0] ||
      text(estimate.SourceLegacyRPID) ||
      text(estimate.LegacyRPID);
    const facilityTotal = totals.get(`${facilityId}|${utility}`) ?? 0;
    const estimatedUsage = numberValue(estimate.EstimatedUsage);
    return {
      PropQID: `PROPQ#${metadata.billingPeriodId}#${sourceRpId}#${utility}`,
      EstimateID: text(estimate.EstimateID),
      billing_period_id: metadata.billingPeriodId,
      FY: metadata.fy,
      BillingMonth: metadata.billingMonth,
      BillingMonthCode: metadata.billingMonth.slice(0, 3).toUpperCase(),
      FacilityID: facilityId,
      MonthlyRPID: sourceRpId,
      LogicalMonthlyRPID: sourceRpId,
      ...(text(estimate.LegacyRPID)
        ? { LegacyRPID: text(estimate.LegacyRPID) }
        : {}),
      CustomerID: text(estimate.CustomerID),
      CategoryCode: text(estimate.CategoryCode),
      AreaSF: numberValue(estimate.AreaSF),
      SpaceType: text(estimate.SpaceType),
      UtilityType: utility,
      EstimatedUsage: estimatedUsage,
      FacilityEstimatedUsage: facilityTotal,
      PropQ: facilityTotal > 0 ? estimatedUsage / facilityTotal : 0,
      CalculationMethod: "ESTIMATED_USAGE_PROPQ",
      Source: "RP_ESTIMATE",
      CreatedDate: new Date().toISOString(),
      PropQStatus: facilityTotal > 0 ? "CALCULATED" : "ZERO_PROJECTED_USAGE",
    };
  });
}

export function checkSnapshotIntegrity(input: {
  billingPeriodId: number;
  realProperty: SnapshotItem[];
  estimates: SnapshotItem[];
  propQ: SnapshotItem[];
}) {
  const errors: string[] = [];
  const rpIds = input.realProperty.map(snapshotLogicalMonthlyRpId);
  const rpIdSet = new Set(rpIds);
  if (rpIdSet.size !== rpIds.length || rpIds.some((id) => !id)) {
    errors.push("Real Property logical IDs must be present and unique.");
  }
  const estimateIds = new Set<string>();
  for (const estimate of input.estimates) {
    const source =
      text(estimate.SourceMonthlyRPID) ||
      text(estimate.LogicalMonthlyRPID) ||
      text(estimate.MonthlyRPID).split("#V#")[0] ||
      text(estimate.SourceLegacyRPID) ||
      text(estimate.LegacyRPID);
    if (!rpIdSet.has(source)) {
      errors.push(`Estimate ${text(estimate.EstimateID)} has no parent RP record ${source}.`);
    }
    if (numberValue(estimate.billing_period_id) !== input.billingPeriodId) {
      errors.push(`Estimate ${text(estimate.EstimateID)} belongs to another billing period.`);
    }
    estimateIds.add(text(estimate.EstimateID));
  }
  for (const propQ of input.propQ) {
    const source =
      text(propQ.LogicalMonthlyRPID) ||
      text(propQ.MonthlyRPID).split("#V#")[0] ||
      text(propQ.LegacyRPID);
    if (!rpIdSet.has(source)) {
      errors.push(`PropQ ${text(propQ.PropQID)} has no parent RP record.`);
    }
    if (!estimateIds.has(text(propQ.EstimateID))) {
      errors.push(`PropQ ${text(propQ.PropQID)} has no parent estimate.`);
    }
    if (numberValue(propQ.billing_period_id) !== input.billingPeriodId) {
      errors.push(`PropQ ${text(propQ.PropQID)} belongs to another billing period.`);
    }
  }
  return errors;
}

