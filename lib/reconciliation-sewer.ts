export type SewerSourceRecord = Record<string, unknown>;

export type SewerNonMeteredPoolAccounting = {
  poolContribution: number;
  distributedPoolConsumption: number;
  unresolvedPoolConsumption: number;
  otherUnallocatedConsumption: number;
  totalUnallocatedConsumption: number;
  accountedConsumption: number;
  allocationDifference: number;
};

export type SewerPoolRecipient = {
  recipientId: string;
  utilityGroup: unknown;
  allocationSource: unknown;
  ssCalculationEnabled: boolean;
  pwNonMeteredConsumption: number;
  hasDirectSewerMeterAllocation?: boolean;
};

export type SewerPoolDistribution<T extends SewerPoolRecipient> =
  | {
      status: "DISTRIBUTED";
      poolConsumption: number;
      weightingBasis: number;
      unresolvedConsumption: 0;
      allocations: Array<{
        recipient: T;
        weight: number;
        allocatedConsumption: number;
      }>;
    }
  | {
      status: "UNRESOLVED";
      poolConsumption: number;
      weightingBasis: 0;
      unresolvedConsumption: number;
      reasonCode: "NO_ELIGIBLE_PW_RECIPIENTS" | "DUPLICATE_PW_RECIPIENT";
      allocations: [];
    };

export type SewerEligibility =
  | {
      status: "MATCHED";
      eligible: boolean;
      sourceRpId: string;
      realProperty: SewerSourceRecord;
    }
  | {
      status: "REVIEW_REQUIRED";
      eligible: null;
      sourceRpId: string;
      reasonCode:
        | "MISSING_RP_ID"
        | "MISSING_ACTIVE_RP"
        | "AMBIGUOUS_ACTIVE_RP"
        | "RP_SOURCE_MISMATCH";
      message: string;
    };

function text(value: unknown): string {
  return value === undefined || value === null ? "" : String(value).trim();
}

function normalized(value: unknown): string {
  return text(value).toUpperCase();
}

function normalizedUtilityGroup(value: unknown): string {
  const group = normalized(value);
  if (group === "1" || group === "WWYK" || group === "SHCZ") return "1";
  if (group === "2" || group === "TAC" || group === "TACX") return "2";
  return group;
}

function rpIdentifiers(record: SewerSourceRecord): Set<string> {
  return new Set(
    [record.MonthlyRPID, record.LogicalMonthlyRPID, record.LegacyRPID]
      .map(text)
      .filter(Boolean),
  );
}

function utilityFlagEnabled(value: unknown): boolean {
  const flag = normalized(value);
  if (["Y", "YES", "TRUE", "X"].includes(flag)) return true;
  const parsed = Number(flag);
  return Number.isFinite(parsed) && parsed !== 0;
}

function valuesConflict(left: unknown, right: unknown): boolean {
  return Boolean(text(left) && text(right) && normalized(left) !== normalized(right));
}

function sourceLabel(source: SewerSourceRecord, sourceRpId: string): string {
  const customerId = text(source.CustomerID) || "unknown customer";
  const facility =
    text(source.FacilityNumber ?? source.facility_nbr) || "unknown facility";
  return `RP ${sourceRpId || "unknown"}, customer ${customerId}, facility ${facility}`;
}

export function resolveDerivedSewerEligibility(
  source: SewerSourceRecord,
  activeRealProperty: readonly SewerSourceRecord[],
): SewerEligibility {
  const sourceIds = rpIdentifiers(source);
  const sourceRpId = [...sourceIds][0] ?? "";
  if (sourceIds.size === 0) {
    return {
      status: "REVIEW_REQUIRED",
      eligible: null,
      sourceRpId: "",
      reasonCode: "MISSING_RP_ID",
      message:
        "The PW allocation has no MonthlyRPID, LogicalMonthlyRPID, or LegacyRPID, so sewer eligibility cannot be determined.",
    };
  }

  const matches = activeRealProperty.filter((record) => {
    const candidateIds = rpIdentifiers(record);
    return [...sourceIds].some((id) => candidateIds.has(id));
  });

  if (matches.length === 0) {
    return {
      status: "REVIEW_REQUIRED",
      eligible: null,
      sourceRpId,
      reasonCode: "MISSING_ACTIVE_RP",
      message: `${sourceLabel(source, sourceRpId)} does not match an active billing-period Real Property record.`,
    };
  }
  if (matches.length > 1) {
    return {
      status: "REVIEW_REQUIRED",
      eligible: null,
      sourceRpId,
      reasonCode: "AMBIGUOUS_ACTIVE_RP",
      message: `${sourceLabel(source, sourceRpId)} matches ${matches.length} active Real Property records.`,
    };
  }

  const realProperty = matches[0];
  const sourceFacility = source.FacilityNumber ?? source.facility_nbr;
  const rpFacility = realProperty.FacilityNumber ?? realProperty.facility_nbr;
  const sourceGroup =
    source.UtilityGroup ?? source.utility_group_id ?? source.sub_inst_cd;
  const rpGroup =
    realProperty.UtilityGroup ??
    realProperty.utility_group_id ??
    realProperty.sub_inst_cd;
  const identityMismatch =
    valuesConflict(source.CustomerID, realProperty.CustomerID) ||
    valuesConflict(source.FacilityID, realProperty.FacilityID) ||
    valuesConflict(sourceFacility, rpFacility) ||
    Boolean(
      text(sourceGroup) &&
        text(rpGroup) &&
        normalizedUtilityGroup(sourceGroup) !== normalizedUtilityGroup(rpGroup),
    );
  if (identityMismatch) {
    return {
      status: "REVIEW_REQUIRED",
      eligible: null,
      sourceRpId,
      reasonCode: "RP_SOURCE_MISMATCH",
      message: `${sourceLabel(source, sourceRpId)} conflicts with the matching active Real Property customer, facility, or utility group.`,
    };
  }

  return {
    status: "MATCHED",
    eligible: utilityFlagEnabled(realProperty.SS ?? realProperty.SSUsage),
    sourceRpId,
    realProperty,
  };
}

export function derivedSewerConsumption(
  pwConsumption: number,
  ssPwFactor: number,
  eligibility: SewerEligibility,
): number {
  return eligibility.status === "MATCHED" && eligibility.eligible
    ? pwConsumption * ssPwFactor
    : 0;
}

export function potentialDerivedSewerConsumption(
  pwConsumption: number,
  ssPwFactor: number,
): number {
  return pwConsumption * ssPwFactor;
}

export function distributeSewerNonMeteredPool<T extends SewerPoolRecipient>(
  poolConsumption: number,
  utilityGroup: unknown,
  recipients: readonly T[],
  epsilon = 0,
): SewerPoolDistribution<T> {
  const eligible = recipients.filter(
    (recipient) =>
      normalizedUtilityGroup(recipient.utilityGroup) ===
        normalizedUtilityGroup(utilityGroup) &&
      normalized(recipient.allocationSource) === "NONMETERED" &&
      recipient.ssCalculationEnabled &&
      !recipient.hasDirectSewerMeterAllocation &&
      Number.isFinite(recipient.pwNonMeteredConsumption) &&
      recipient.pwNonMeteredConsumption > epsilon,
  );
  const recipientIds = new Set<string>();
  for (const recipient of eligible) {
    const recipientId = text(recipient.recipientId);
    if (!recipientId || recipientIds.has(recipientId)) {
      return {
        status: "UNRESOLVED",
        poolConsumption,
        weightingBasis: 0,
        unresolvedConsumption: poolConsumption,
        reasonCode: "DUPLICATE_PW_RECIPIENT",
        allocations: [],
      };
    }
    recipientIds.add(recipientId);
  }

  const weightingBasis = eligible.reduce(
    (sum, recipient) => sum + recipient.pwNonMeteredConsumption,
    0,
  );
  if (eligible.length === 0 || weightingBasis <= epsilon) {
    return {
      status: "UNRESOLVED",
      poolConsumption,
      weightingBasis: 0,
      unresolvedConsumption: poolConsumption,
      reasonCode: "NO_ELIGIBLE_PW_RECIPIENTS",
      allocations: [],
    };
  }

  return {
    status: "DISTRIBUTED",
    poolConsumption,
    weightingBasis,
    unresolvedConsumption: 0,
    allocations: eligible.map((recipient) => {
      const weight = recipient.pwNonMeteredConsumption / weightingBasis;
      return {
        recipient,
        weight,
        allocatedConsumption: poolConsumption * weight,
      };
    }),
  };
}

export function summarizeSewerNonMeteredPool(input: {
  sourceConsumption: number;
  allocatedConsumption: number;
  poolContribution: number;
  distributedPoolConsumption?: number;
  epsilon?: number;
}): SewerNonMeteredPoolAccounting {
  const epsilon = input.epsilon ?? 0;
  const distributedPoolRaw = input.distributedPoolConsumption ?? 0;
  const distributedPoolConsumption =
    Math.abs(distributedPoolRaw) <= epsilon ? 0 : distributedPoolRaw;
  const unresolvedPoolRaw =
    input.poolContribution - distributedPoolConsumption;
  const unresolvedPoolConsumption =
    Math.abs(unresolvedPoolRaw) <= epsilon ? 0 : unresolvedPoolRaw;
  const allocationDifference =
    input.sourceConsumption - input.allocatedConsumption;
  const otherUnallocatedRaw =
    allocationDifference - unresolvedPoolConsumption;
  const otherUnallocatedConsumption =
    Math.abs(otherUnallocatedRaw) <= epsilon ? 0 : otherUnallocatedRaw;
  const totalUnallocatedRaw =
    unresolvedPoolConsumption + otherUnallocatedConsumption;
  const totalUnallocatedConsumption =
    Math.abs(totalUnallocatedRaw) <= epsilon ? 0 : totalUnallocatedRaw;

  return {
    poolContribution: input.poolContribution,
    distributedPoolConsumption,
    unresolvedPoolConsumption,
    otherUnallocatedConsumption,
    totalUnallocatedConsumption,
    accountedConsumption:
      input.allocatedConsumption + totalUnallocatedConsumption,
    allocationDifference,
  };
}
