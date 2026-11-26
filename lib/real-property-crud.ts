import type { RealPropertyItem } from "@/lib/real-property-snapshot";
import type { UtilityReimbursementOverrides } from "@/lib/utility-reimbursement";

const UTILITIES = ["EL", "NG", "PW", "SS"] as const;

function text(value: unknown): string {
  return value === undefined || value === null ? "" : String(value).trim();
}

function numberOrNull(value: unknown): number | null {
  const normalized = text(value).replace(/[$,]/g, "");
  if (!normalized) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function flag(value: unknown): number {
  return ["1", "Y", "YES", "TRUE", "X"].includes(text(value).toUpperCase())
    ? 1
    : 0;
}

function normalizeUtilityReimbursementOverrides(
  value: unknown,
): UtilityReimbursementOverrides {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const source = value as Record<string, unknown>;
  const result: UtilityReimbursementOverrides = {};
  for (const utility of UTILITIES) {
    if (typeof source[utility] === "boolean") result[utility] = source[utility];
  }
  return result;
}

function utilityReimbursementOverrideErrors(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return ["Utility reimbursement overrides must be an object."];
  }
  const source = value as Record<string, unknown>;
  return Object.keys(source).flatMap((key) => {
    if (!UTILITIES.includes(key as (typeof UTILITIES)[number])) {
      return [`Unsupported utility reimbursement override ${key}.`];
    }
    return typeof source[key] === "boolean"
      ? []
      : [`${key} reimbursement override must be true or false.`];
  });
}

export type RealPropertyEditorInput = {
  CustomerID: string;
  FacilityID: string;
  RPUID?: string;
  CategoryCode?: string;
  AllocationQty: number | string;
  AllocationUM: string;
  UtilityGroup: number | string;
  EL: number | string | boolean;
  NG: number | string | boolean;
  PW: number | string | boolean;
  SS: number | string | boolean;
  UtilityReimbursementOverrides?: UtilityReimbursementOverrides;
};

export function validateRealPropertyEditorInput(input: RealPropertyEditorInput) {
  const errors: string[] = [];
  if (!text(input.CustomerID)) errors.push("Customer is required.");
  if (!text(input.FacilityID)) errors.push("Facility is required.");
  const allocationQty = numberOrNull(input.AllocationQty);
  if (allocationQty === null || allocationQty < 0) {
    errors.push("Allocation quantity must be a non-negative number.");
  }
  if (!text(input.AllocationUM)) errors.push("Allocation unit is required.");
  const utilityGroup = numberOrNull(input.UtilityGroup);
  if (utilityGroup === null || !Number.isInteger(utilityGroup) || utilityGroup <= 0) {
    errors.push("Utility group must be a positive whole number.");
  }
  if (!UTILITIES.some((utility) => flag(input[utility]) === 1)) {
    errors.push("At least one utility must be enabled.");
  }
  errors.push(
    ...utilityReimbursementOverrideErrors(
      input.UtilityReimbursementOverrides,
    ),
  );
  return errors;
}

function findIntensity(
  intensities: RealPropertyItem[],
  targetFy: number,
  utility: string,
  spaceTypeId: string,
) {
  return intensities
    .filter(
      (item) =>
        text(item.utility_type_cd).toUpperCase() === utility &&
        text(item.space_type_id) === spaceTypeId &&
        (numberOrNull(item.fy) ?? Number.POSITIVE_INFINITY) <= targetFy,
    )
    .sort((a, b) => (numberOrNull(b.fy) ?? 0) - (numberOrNull(a.fy) ?? 0))[0];
}

export function buildRealPropertyRecord(input: {
  monthlyRpId: string;
  editor: RealPropertyEditorInput;
  customer: RealPropertyItem;
  facility: RealPropertyItem;
  fy: number;
  billingMonth: string;
  billingPeriodId: number;
  existing?: RealPropertyItem;
}): RealPropertyItem {
  const { editor, customer, facility } = input;
  return {
    ...(input.existing ?? {}),
    MonthlyRPID: input.monthlyRpId,
    LogicalMonthlyRPID: input.monthlyRpId,
    FY: input.fy,
    BillingMonth: input.billingMonth,
    BillingMonthCode: input.billingMonth.slice(0, 3).toUpperCase(),
    billing_period_id: input.billingPeriodId,
    CustomerID: text(customer.CustomerID),
    CUBECustomerName: text(customer.CustomerName ?? customer.UMMName),
    FacilityID: text(facility.FacilityID),
    FacilityNumber: text(facility.FacilityNumber),
    SiteCode: text(facility.SITE_CD ?? facility.SiteCode),
    RPUID: text(editor.RPUID ?? facility.RPUID),
    CategoryCode: text(editor.CategoryCode),
    AllocationQty: numberOrNull(editor.AllocationQty) ?? 0,
    AllocationUM: text(editor.AllocationUM).toUpperCase(),
    UtilityGroup: numberOrNull(editor.UtilityGroup) ?? 0,
    EL: flag(editor.EL),
    NG: flag(editor.NG),
    PW: flag(editor.PW),
    SS: flag(editor.SS),
    UtilityReimbursementOverrides: normalizeUtilityReimbursementOverrides(
      editor.UtilityReimbursementOverrides,
    ),
    Source: input.existing?.Source ?? "MANUAL_RP",
    SnapshotType: "MONTHLY",
    LastManualChangeAt: new Date().toISOString(),
  };
}

export function buildEstimatesForRealPropertyRecord(input: {
  record: RealPropertyItem;
  categories: RealPropertyItem[];
  intensities: RealPropertyItem[];
  fy: number;
  billingMonth: string;
  billingPeriodId: number;
}): { estimates: RealPropertyItem[]; errors: string[] } {
  const record = input.record;
  const logicalId = text(record.LogicalMonthlyRPID ?? record.MonthlyRPID).split("#V#")[0];
  if (text(record.AllocationUM).toUpperCase() !== "SF") {
    return { estimates: [], errors: [] };
  }
  const category = input.categories.find(
    (item) => text(item.category_cd) === text(record.CategoryCode),
  );
  if (!category) return { estimates: [], errors: [] };
  const spaceTypeId = text(category.space_type_id);
  if (!spaceTypeId) return { estimates: [], errors: [] };

  const estimates: RealPropertyItem[] = [];
  const errors: string[] = [];
  for (const utility of UTILITIES) {
    if (flag(record[utility]) !== 1) continue;
    const intensity = findIntensity(
      input.intensities,
      input.fy,
      utility,
      spaceTypeId,
    );
    const intensityValue = numberOrNull(intensity?.index);
    const intensityFy = numberOrNull(intensity?.fy);
    if (!intensity || intensityValue === null || intensityFy === null) {
      errors.push(
        `No ${utility} intensity exists for Space Type ${spaceTypeId} for FY ${input.fy} or a prior FY.`,
      );
      continue;
    }
    const area = numberOrNull(record.AllocationQty) ?? 0;
    estimates.push({
      EstimateID: `EST#${input.billingPeriodId}#${logicalId}#${utility}`,
      billing_period_id: input.billingPeriodId,
      FY: input.fy,
      BillingMonth: input.billingMonth,
      MonthlyRPID: logicalId,
      SourceMonthlyRPID: logicalId,
      LogicalMonthlyRPID: logicalId,
      ...(text(record.LegacyRPID)
        ? {
            LegacyRPID: text(record.LegacyRPID),
            SourceLegacyRPID: text(record.LegacyRPID),
          }
        : {}),
      FacilityID: text(record.FacilityID),
      CustomerID: text(record.CustomerID),
      CategoryCode: text(record.CategoryCode),
      SpaceTypeID: Number(spaceTypeId),
      SpaceType: text(category.space_type),
      AreaSF: area,
      UtilityType: utility,
      IntensityFY: intensityFy,
      IntensityValue: intensityValue,
      EstimatedUsage: area * intensityValue,
      CalculationMethod:
        intensityFy === input.fy ? "AREA_INTENSITY" : "AREA_INTENSITY_PRIOR_FY",
      IntensityID: `${intensityFy}#${utility}#${spaceTypeId}`,
      Source: text(record.LegacyRPID) ? "LEGACY_RP_OVERRIDE" : "RP_MONTHLY",
    });
  }
  return { estimates, errors };
}

/**
 * Rebuild estimates for the selected active Real Property snapshot using the
 * current category-to-space-type mapping and intensity values. Estimates for
 * non-area records and records without a category remain as stored, so this
 * maintenance action does not discard separately sourced estimate data.
 */
export function refreshEstimatesForRealPropertyRecords(input: {
  realProperty: RealPropertyItem[];
  existingEstimates: RealPropertyItem[];
  categories: RealPropertyItem[];
  intensities: RealPropertyItem[];
  fy: number;
  billingMonth: string;
  billingPeriodId: number;
}): { estimates: RealPropertyItem[]; errors: string[]; refreshedRecordCount: number } {
  let estimates = [...input.existingEstimates];
  const errors: string[] = [];
  let refreshedRecordCount = 0;

  for (const record of input.realProperty) {
    if (text(record.AllocationUM).toUpperCase() !== "SF") continue;

    const logicalId = text(record.LogicalMonthlyRPID ?? record.MonthlyRPID).split("#V#")[0];
    if (!text(record.CategoryCode)) {
      estimates = replaceRecordDependents(estimates, logicalId, []);
      refreshedRecordCount += 1;
      continue;
    }

    const category = input.categories.find(
      (item) => text(item.category_cd) === text(record.CategoryCode),
    );
    if (!category || !text(category.space_type_id)) {
      errors.push(
        `Category ${text(record.CategoryCode)} for Real Property ${text(record.LogicalMonthlyRPID ?? record.MonthlyRPID)} has no valid space-type mapping.`,
      );
      continue;
    }

    const result = buildEstimatesForRealPropertyRecord({
      record,
      categories: input.categories,
      intensities: input.intensities,
      fy: input.fy,
      billingMonth: input.billingMonth,
      billingPeriodId: input.billingPeriodId,
    });
    errors.push(...result.errors);
    if (result.errors.length > 0) continue;

    estimates = replaceRecordDependents(estimates, logicalId, result.estimates);
    refreshedRecordCount += 1;
  }

  return { estimates, errors, refreshedRecordCount };
}

export function replaceRecordDependents(
  estimates: RealPropertyItem[],
  targetMonthlyRpId: string,
  replacement: RealPropertyItem[],
) {
  const target = text(targetMonthlyRpId);
  return [
    ...estimates.filter((item) => {
      const source = (
        text(item.SourceMonthlyRPID) ||
        text(item.LogicalMonthlyRPID) ||
        text(item.MonthlyRPID) ||
        text(item.SourceLegacyRPID) ||
        text(item.LegacyRPID)
      ).split("#V#")[0];
      return source !== target;
    }),
    ...replacement,
  ];
}

