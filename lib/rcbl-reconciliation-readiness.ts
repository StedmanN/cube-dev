import { createHash } from "node:crypto";

export type ReconciliationRecord = Record<string, unknown>;

export type ReadinessFailure = {
  utilityGroup: string;
  utilityType: string;
  reason: string;
};

export type ReconciliationReadiness = {
  ready: boolean;
  failures: ReadinessFailure[];
  requiredKeys: string[];
  snapshotId: string;
};

function text(value: unknown): string {
  return value === undefined || value === null ? "" : String(value).trim();
}

function normalize(value: unknown): string {
  return text(value).toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function utilityGroup(value: unknown): string {
  const normalized = normalize(value);
  if (normalized === "1" || normalized === "WWYK" || normalized === "SHCZ") {
    return "WWYK";
  }
  if (normalized === "2" || normalized === "TAC" || normalized === "TACX") {
    return "TAC";
  }
  return normalized;
}

function utilityType(value: unknown): string {
  return normalize(value);
}

const AUTHORITATIVE_RECONCILIATION_UTILITIES = new Set([
  "EL",
  "NG",
  "PW",
  "SS",
]);

function authoritativeSourceKey(record: ReconciliationRecord): string | null {
  const group = utilityGroup(record.utility_group_id ?? record.UtilityGroup);
  const rawType = utilityType(record.utility_type_cd ?? record.UtilityType);
  const type = rawType === "IW" ? "" : rawType;
  if (!group || !AUTHORITATIVE_RECONCILIATION_UTILITIES.has(type)) return null;
  return `${group}|${type}`;
}

function numberValue(value: unknown): number {
  const parsed = Number(text(value).replace(/[$,%s,]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

export function reconciliationSummaryKey(record: ReconciliationRecord): string {
  return `${utilityGroup(record.UtilityGroup)}|${utilityType(record.UtilityType)}`;
}

export function reconciliationSummaryLabel(
  record: ReconciliationRecord | { UtilityGroup?: unknown; UtilityType?: unknown },
): { utilityGroup: string; utilityType: string } {
  return {
    utilityGroup: utilityGroup(record.UtilityGroup) || "UNKNOWN_GROUP",
    utilityType: utilityType(record.UtilityType) || "UNKNOWN_UTILITY",
  };
}

function stableRecordText(record: ReconciliationRecord): string {
  return Object.keys(record)
    .sort()
    .map((key) => `${key}=${JSON.stringify(record[key])}`)
    .join("&");
}

export function reconciliationSnapshotId(
  records: readonly ReconciliationRecord[],
  billingPeriodId: number,
  authoritativeSourceRecords: readonly ReconciliationRecord[] = [],
): string {
  const reconciliationMaterial = records
    .filter((record) => Number(record.billing_period_id) === billingPeriodId)
    .map((record) => `reconciliation:${stableRecordText(record)}`);
  const sourceMaterial = authoritativeSourceRecords
    .filter((record) => Number(record.billing_period_id) === billingPeriodId)
    .map((record) => `source:${stableRecordText(record)}`);
  const material = [...reconciliationMaterial, ...sourceMaterial]
    .sort()
    .join("\n");
  return createHash("sha256").update(material).digest("hex");
}

function blockingIssueReason(summary: ReconciliationRecord): string | null {
  const issues = summary.Issues;
  const hasIssueCount = text(summary.IssueCount) !== "";
  const normalizedIssueCount = text(summary.IssueCount).replace(/[,$%\s]/g, "");
  const issueCount = hasIssueCount ? Number(normalizedIssueCount) : 0;
  if (
    hasIssueCount &&
    (!Number.isFinite(issueCount) ||
      !Number.isInteger(issueCount) ||
      issueCount < 0)
  ) {
    return "IssueCount is invalid.";
  }
  if (Array.isArray(issues)) {
    if (hasIssueCount && issueCount !== issues.length) {
      return `IssueCount is ${issueCount}, but Issues contains ${issues.length} item(s).`;
    }
    if (issues.length > 0) {
      const blocking = issues.find(
        (issue) =>
          issue &&
          typeof issue === "object" &&
          (issue as Record<string, unknown>).blocking === true,
      ) as Record<string, unknown> | undefined;
      if (blocking) {
        return text(blocking.message) || text(blocking.code) || "Blocking reconciliation exception.";
      }
      return "Summary contains unresolved reconciliation issue(s).";
    }
  } else if (issueCount > 0) {
    return "Reconciliation issues could not be verified from the summary.";
  }
  if (Array.isArray(issues)) {
    return null;
  }
  if (hasIssueCount && issueCount === 0) {
    return null;
  }
  if (issues !== undefined && issues !== null) {
    return "Issues is not a valid list.";
  }
  return null;
}

function validateSummary(
  summary: ReconciliationRecord,
): ReadinessFailure | null {
  const label = reconciliationSummaryLabel(summary);
  const issueReason = blockingIssueReason(summary);
  if (issueReason) return { ...label, reason: issueReason };
  if (numberValue(summary.BillingReady) !== 1) {
    return { ...label, reason: "BillingReady is not 1." };
  }
  if (normalize(summary.ReconciliationStatus) !== "BILLINGREADY") {
    return {
      ...label,
      reason: `ReconciliationStatus is ${text(summary.ReconciliationStatus) || "missing"}.`,
    };
  }
  if (normalize(summary.AccountingStatus) !== "RECONCILED") {
    return {
      ...label,
      reason: `AccountingStatus is ${text(summary.AccountingStatus) || "missing"}.`,
    };
  }
  return null;
}

export function validateReconciliationReadiness(
  records: readonly ReconciliationRecord[],
  billingPeriodId: number,
  authoritativeSourceRecords: readonly ReconciliationRecord[] = [],
): ReconciliationReadiness {
  const periodRecords = records.filter(
    (record) => Number(record.billing_period_id) === billingPeriodId,
  );
  const allocations = periodRecords.filter(
    (record) => normalize(record.RecordType) === "ALLOCATION",
  );
  const summaries = periodRecords.filter(
    (record) => normalize(record.RecordType) === "SUMMARY",
  );
  const sourceKeys = new Set(
    authoritativeSourceRecords
      .filter((record) => Number(record.billing_period_id) === billingPeriodId)
      .map(authoritativeSourceKey)
      .filter((key): key is string => key !== null),
  );
  const allocationKeys = new Set(allocations.map(reconciliationSummaryKey));
  const summaryKeys = new Set(summaries.map(reconciliationSummaryKey));
  const reconciliationKeys = new Set([...allocationKeys, ...summaryKeys]);
  const requiredKeys = new Set([...sourceKeys, ...reconciliationKeys]);
  const failures: ReadinessFailure[] = [];

  const sourceAvailableKeys = new Set(sourceKeys);
  const hasApprovedWwykPlantSource = summaries.some(
    (summary) =>
      reconciliationSummaryKey(summary) === "WWYK|PW" &&
      numberValue(summary.PlantUnitProduction) > 0,
  );
  if (hasApprovedWwykPlantSource) {
    sourceAvailableKeys.add("WWYK|PW");
  }

  for (const key of requiredKeys) {
    const matchingSummaries = summaries.filter(
      (summary) => reconciliationSummaryKey(summary) === key,
    );
    if (matchingSummaries.length === 0) {
      const [group, utility] = key.split("|");
      failures.push({
        utilityGroup: group || "UNKNOWN_GROUP",
        utilityType: utility || "UNKNOWN_UTILITY",
        reason: "Required reconciliation SUMMARY is missing.",
      });
      continue;
    }
    if (matchingSummaries.length > 1) {
      const label = reconciliationSummaryLabel(matchingSummaries[0]);
      failures.push({
        ...label,
        reason: `Multiple reconciliation SUMMARY records exist for ${key}.`,
      });
      continue;
    }
    const failure = validateSummary(matchingSummaries[0]);
    if (failure) failures.push(failure);
  }

  for (const key of reconciliationKeys) {
    if (sourceAvailableKeys.has(key)) continue;
    const [group, utility] = key.split("|");
    const hasDerivedSewerSource =
      utility === "SS" &&
      allocations.some(
        (allocation) =>
          reconciliationSummaryKey(allocation) === key &&
          normalize(allocation.AllocationSource) === "DERIVEDSS" &&
          sourceAvailableKeys.has(`${group}|PW`),
      );
    if (hasDerivedSewerSource) {
      sourceAvailableKeys.add(key);
      continue;
    }
    failures.push({
      utilityGroup: group || "UNKNOWN_GROUP",
      utilityType: utility || "UNKNOWN_UTILITY",
      reason:
        "Required authoritative invoice or approved source is missing for this utility.",
    });
  }

  if (
    sourceKeys.size === 0 &&
    !hasApprovedWwykPlantSource &&
    reconciliationKeys.size === 0
  ) {
    failures.push({
      utilityGroup: "UNKNOWN_GROUP",
      utilityType: "UNKNOWN_UTILITY",
      reason:
        "No authoritative invoice or approved WWYK plant-production source exists for this billing period.",
    });
  }

  if (summaries.length === 0 && allocations.length > 0) {
    failures.push({
      utilityGroup: "UNKNOWN_GROUP",
      utilityType: "UNKNOWN_UTILITY",
      reason: "No reconciliation SUMMARY records exist for this billing period.",
    });
  }

  return {
    ready: failures.length === 0 && requiredKeys.size > 0,
    failures,
    requiredKeys: [...requiredKeys].sort(),
    snapshotId: reconciliationSnapshotId(
      periodRecords,
      billingPeriodId,
      authoritativeSourceRecords,
    ),
  };
}
