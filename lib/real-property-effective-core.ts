export type EffectiveRealPropertyItem = Record<string, unknown>;

export const FIRST_MONTHLY_RP_BILLING_PERIOD_ID = 182;
export const FY26_FIRST_BILLING_PERIOD_ID = 171;
export const FY26 = 2026;

function text(value: unknown): string {
  return value === undefined || value === null ? "" : String(value).trim();
}

function numberValue(value: unknown): number {
  const parsed = Number(text(value).replace(/[$,]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function utilityFlag(value: unknown): number {
  return numberValue(value) !== 0 ? 1 : 0;
}

export function billingPeriodToFiscalYear(billingPeriodId: number): number {
  return FY26 + Math.floor((billingPeriodId - FY26_FIRST_BILLING_PERIOD_ID) / 12);
}

export function normalizeLegacyUtilityGroup(value: unknown): string {
  const normalized = text(value).toUpperCase();
  if (normalized === "1" || normalized === "WWYK" || normalized === "SHCZ") {
    return "1";
  }
  if (normalized === "2" || normalized === "TACX") return "2";
  return normalized;
}

export function normalizeLegacyRealPropertyRecord(
  item: EffectiveRealPropertyItem,
  input: { billingPeriodId: number; billingMonth?: string },
): EffectiveRealPropertyItem {
  const legacyRpId = text(item.LegacyRPID);
  return {
    ...item,
    MonthlyRPID: legacyRpId,
    LogicalMonthlyRPID: legacyRpId,
    LegacyRPID: legacyRpId,
    BaselineLegacyRPID: legacyRpId,
    FY: numberValue(item.FY) || billingPeriodToFiscalYear(input.billingPeriodId),
    BillingMonth: input.billingMonth ?? "",
    billing_period_id: input.billingPeriodId,
    FacilityID: text(item.FacilityID),
    CustomerID: text(item.CustomerID),
    RPUID: text(item.RPUID),
    SiteCode: text(item.SiteCode ?? item.site_cd ?? item.SITE_CD),
    FacilityNumber: text(
      item.FacilityNumber ?? item.facility_nbr ?? item.FACILITY_NBR,
    ),
    NextGenCustomerName: text(item.NextGenCustomerName),
    CUBECustomerName: text(item.LegacyCustomerName ?? item.CustomerName),
    LegacyCustomerName: text(item.LegacyCustomerName),
    CategoryCode: text(item.CategoryCode),
    CategoryDescription: text(item.CategoryDescription),
    AllocationQty: numberValue(item.CustomerQty ?? item.AllocationQty),
    AllocationUM: text(item.AllocationUM) || "SF",
    UtilityGroup: normalizeLegacyUtilityGroup(
      item.UtilityGroup ?? item.utility_group_id ?? item.sub_inst_cd ?? item.SUB_INST_CD,
    ),
    EL: utilityFlag(item.ELUsage ?? item.EL),
    NG: utilityFlag(item.NGUsage ?? item.NG),
    PW: utilityFlag(item.PWUsage ?? item.PW),
    SS: utilityFlag(item.SSUsage ?? item.SS),
    RecordSource: "legacy",
    BaselineSource: "p72-CUBE-RP-LEGACY",
  };
}

export function effectiveRealPropertySource(
  billingPeriodId: number,
  hasPeriodSnapshot: boolean,
): "legacy" | "legacy_override" | "monthly" {
  if (billingPeriodId < FIRST_MONTHLY_RP_BILLING_PERIOD_ID) {
    return hasPeriodSnapshot ? "legacy_override" : "legacy";
  }
  return "monthly";
}

export function usesPeriodSnapshot(
  billingPeriodId: number,
  hasPeriodSnapshot: boolean,
): boolean {
  return (
    billingPeriodId >= FIRST_MONTHLY_RP_BILLING_PERIOD_ID || hasPeriodSnapshot
  );
}
