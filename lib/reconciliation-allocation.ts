export type MeterAllocationIdentity = {
  facilityNumber: string;
  utilityType: string;
  utilityGroup: string;
};

export type NonMeteredEligibilityInput = MeterAllocationIdentity & {
  rpCommodityEnabled: boolean;
};

export type RealPropertyUtilityFlagRecord = Record<string, unknown>;

export type MeterPropQAllocationResult = {
  totalPropQ: number;
  exceedsMeter: boolean;
  allocations: number[];
};

export type MeterCalculationEligibility =
  | "NO_RP"
  | "ALL_ENABLED"
  | "ALL_DISABLED"
  | "MIXED";

export type RealPropertyUtilityGroupResolution =
  | { status: "RESOLVED"; utilityGroup: string }
  | { status: "MISSING"; utilityGroups: [] }
  | { status: "AMBIGUOUS"; utilityGroups: string[] };

function normalized(value: unknown): string {
  return value === undefined || value === null ? "" : String(value).trim().toUpperCase();
}

function utilityFlagEnabled(value: unknown): boolean {
  const parsed = Number(
    value === undefined || value === null ? "" : String(value).trim(),
  );
  return Number.isFinite(parsed) && parsed !== 0;
}

function normalizedUtilityGroup(value: unknown): string {
  const group = normalized(value);
  if (group === "1" || group === "WWYK" || group === "SHCZ") return "WWYK";
  if (group === "2" || group === "TAC" || group === "TACX") return "TAC";
  return group;
}

function realPropertyGroup(row: RealPropertyUtilityFlagRecord): string {
  return normalizedUtilityGroup(
    row.UtilityGroup ??
      row.utility_group_id ??
      row.sub_inst_cd ??
      row.SUB_INST_CD,
  );
}

/**
 * Resolve a facility's group only when every active RP row for that facility
 * carries the same recognizable group. Missing or conflicting RP values must
 * not be guessed because the result controls both meter allocation and pool
 * exclusion.
 */
export function resolveRealPropertyUtilityGroup(
  realPropertyRows: readonly RealPropertyUtilityFlagRecord[],
): RealPropertyUtilityGroupResolution {
  if (realPropertyRows.length === 0) {
    return { status: "MISSING", utilityGroups: [] };
  }

  const groups = new Set(realPropertyRows.map(realPropertyGroup).filter(Boolean));
  const hasUnmappedRows = realPropertyRows.some((row) => !realPropertyGroup(row));
  const recognizedGroups = new Set(["WWYK", "TAC"]);
  if (
    groups.size === 1 &&
    !hasUnmappedRows &&
    recognizedGroups.has(Array.from(groups)[0])
  ) {
    return { status: "RESOLVED", utilityGroup: Array.from(groups)[0] };
  }

  return { status: "AMBIGUOUS", utilityGroups: Array.from(groups).sort() };
}

export function matchingRealPropertyRowsForUtilityGroup(
  realPropertyRows: readonly RealPropertyUtilityFlagRecord[],
  utilityGroup: string,
): RealPropertyUtilityFlagRecord[] {
  const groupedRows = realPropertyRows.filter((row) => realPropertyGroup(row));
  if (groupedRows.length === 0) return [...realPropertyRows];

  const normalizedGroup = normalizedUtilityGroup(utilityGroup);
  return groupedRows.filter(
    (row) => realPropertyGroup(row) === normalizedGroup,
  );
}

/**
 * A meter is billable only when its facility's period RP data enables the
 * matching utility. If no RP row exists, retain the existing behavior and let
 * the reconciliation exception identify the missing RP source.
 */
export function isMeteredFacilityUtilityEligible(
  realPropertyRows: readonly RealPropertyUtilityFlagRecord[],
  utilityType: string,
  utilityGroup = "",
): boolean {
  const matchingRows = matchingRealPropertyRowsForUtilityGroup(
    realPropertyRows,
    utilityGroup,
  );
  if (matchingRows.length === 0) return true;
  const utility = normalized(utilityType);
  return matchingRows.some((row) => utilityFlagEnabled(row[utility]));
}

export function classifyMeterCalculationEligibility(
  realPropertyRows: readonly RealPropertyUtilityFlagRecord[],
  utilityType: string,
  utilityGroup = "",
): MeterCalculationEligibility {
  const matchingRows = matchingRealPropertyRowsForUtilityGroup(
    realPropertyRows,
    utilityGroup,
  );
  if (matchingRows.length === 0) return "NO_RP";
  const utility = normalized(utilityType);
  const enabled = matchingRows.filter((row) =>
    utilityFlagEnabled(row[utility]),
  ).length;
  if (enabled === 0) return "ALL_DISABLED";
  if (enabled === matchingRows.length) return "ALL_ENABLED";
  return "MIXED";
}

export function facilityUtilityGroupKey(
  facilityNumber: string,
  utilityType: string,
  utilityGroup: string,
): string {
  return `${normalized(facilityNumber)}|${normalized(utilityType)}|${normalized(utilityGroup)}`;
}

export function buildUsedMeterFacilityUtilityGroupKeys(
  meters: readonly MeterAllocationIdentity[],
): Set<string> {
  return new Set(
    meters.map((meter) =>
      facilityUtilityGroupKey(
        meter.facilityNumber,
        meter.utilityType,
        meter.utilityGroup,
      ),
    ),
  );
}

export function isNonMeteredFacilityEligible(
  row: NonMeteredEligibilityInput,
  usedMeterKeys: ReadonlySet<string>,
): boolean {
  if (!row.rpCommodityEnabled) return true;
  return !usedMeterKeys.has(
    facilityUtilityGroupKey(
      row.facilityNumber,
      row.utilityType,
      row.utilityGroup,
    ),
  );
}

export function calculateMeterPropQAllocations(
  meterConsumption: number,
  propQValues: readonly number[],
  epsilon: number,
): MeterPropQAllocationResult {
  const totalPropQ = propQValues.reduce((sum, value) => sum + value, 0);
  const exceedsMeter = totalPropQ > 1 + epsilon;
  return {
    totalPropQ,
    exceedsMeter,
    allocations: exceedsMeter
      ? []
      : propQValues.map((value) => meterConsumption * value),
  };
}

export function isMeteredConsumptionOverSource(
  meteredConsumption: number,
  sourceConsumption: number,
  epsilon: number,
): boolean {
  return meteredConsumption > sourceConsumption + epsilon;
}

export function isNonMeteredPoolUnallocatable(
  pool: number,
  eligibleRowCount: number,
  epsilon: number,
): boolean {
  return eligibleRowCount === 0 && Math.abs(pool) > epsilon;
}

export function distributeNonMeteredPool<T>(
  pool: number,
  rows: readonly T[],
  estimatedUsage: (row: T) => number,
): { projectedUsageTotal: number; allocations: number[] } {
  const projectedUsageTotal = rows.reduce(
    (sum, row) => sum + estimatedUsage(row),
    0,
  );
  return {
    projectedUsageTotal,
    allocations:
      projectedUsageTotal > 0
        ? rows.map(
            (row) => (pool * estimatedUsage(row)) / projectedUsageTotal,
          )
        : rows.map(() => 0),
  };
}
