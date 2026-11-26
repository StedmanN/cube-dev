"use client";

import { Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";

import { useRouter } from "next/navigation";
import { useAppSection } from "@/components/app-section-navigation";
import {
  searchRealPropertyCategoryCodes,
  validateRealPropertyCategoryCode,
  type RealPropertyCategoryCodeOption,
} from "@/lib/real-property-category-code";

import {
  displayAccountedConsumption,
  displayDistributableNonMeteredConsumption,
  displayPumpingReservedConsumption,
} from "@/lib/reconciliation-display";

import {
  Check,
  ChevronLeft,
  ChevronRight,
  Download,
  FileSpreadsheet,
  Search,
  Trash2,
  Upload,
} from "lucide-react";

// ============================================================
// TYPES
// ============================================================

type InvoiceRateMonitoringStatus =
  | "WITHIN_RANGE"
  | "REVIEW_REQUIRED"
  | "NO_BASELINE"
  | "NO_CONSUMPTION";

export type InvoiceRecord = {
  invoiceid: string;
  billing_period_id: string;
  fy: string;
  billing_month_nm: string;
  utility_group_id: string;
  utility_type_cd: string;
  utility_provider_cd: string;
  primary_account_nbr: string;
  account_nbr: string;
  distribution_system: string;
  billing_from_date: string;
  billing_to_date: string;
  consumption: string;
  consumption_um: string;
  charge: string;
  account_detail: string;
  entry_instruction: string;
  invoice_comments: string;
  period: string;
  rate_monitoring_status?: InvoiceRateMonitoringStatus;
  rate_monitoring_current_rate?: number | string | null;
  rate_monitoring_baseline_rate?: number | string | null;
  rate_monitoring_variance_percent?: number | string | null;
  rate_monitoring_threshold_percent?: number | string | null;
  rate_monitoring_checked_at?: string;
  rate_monitoring_baseline_effective_date?: string;
  rate_monitoring_baseline_approved_at?: string;
  rate_monitoring_baseline_pk?: string;
  rate_monitoring_baseline_sk?: string;
};

export type MeterReadingRecord = {
  meterid: string;
  period: string;
  billing_period_id: string;
  fy: string;
  billing_month_nm: string;
  utility_type_cd: string;
  inst_cd: string;
  sub_inst_cd: string;
  site_cd: string;
  facility_nbr: string;
  multiplier: string;
  previous_reading: string;
  previous_adjusted_reading: string;
  reading: string;
  consumption: string;
  meter_correction_rule_cd: string;
  adjusted_consumption: string;
  used_in_calculation: string;
  validation_required?: string;
  validation_status?: string;
  validation_action?: string;
  isMasterOnly?: boolean;
};

type MeterReadingApiResult = Record<string, unknown> & {
  item?: Record<string, unknown> | null;
  error?: string;
};

export type CorrectionRuleRecord = {
  correction_rule_cd: string;
  correction_rule_name: string;
  correction_rule_description: string;
};

export type MeterMasterRecord = {
  meterid: string;
  facility_nbr: string;
  sub_inst_cd: string;
  utility_type_cd: string;
};

type Props = {
  invoices: InvoiceRecord[];
  meterReadings: MeterReadingRecord[];
  correctionRules: CorrectionRuleRecord[];
  meterMaster: MeterMasterRecord[];
  initialFY: string;
  initialMonth: string;
  billingPeriodId: string;
  fiscalYears: string[];
};

type MeterCoverageCustomerRecord = {
  customerId: string;
  customerName: string;
  facilityId: string;
  facilityNumber: string;
  utilityType: string;
  allocatedArea: number;
  allocationUM: string;
  usageFlag: number;
  propQ: number | null;
  propQStatus: string;
};

type MeterCoverageRecord = {
  facilityId: string;
  facilityNumber: string;
  facilityName: string;
  facilityArea: number;
  facilityAreaUM: string;
  utilityType: string;
  eligibleRpArea: number;
  areaCoveragePercent: number | null;
  areaDifference: number;
  areaDifferencePercent: number | null;
  rpSource: "LEGACY" | "MONTHLY";
  allowedAreaTolerancePercent: number;
  areaToleranceStatus: "PASS" | "FAIL";
  areaMatchesFacility: boolean;
  expectedMeters: string[];
  activeExpectedMeters: string[];
  possiblyRemovedMeters: string[];
  goodMeters: string[];
  badMeters: string[];
  meterValidation: {
    meterId: string;
    currentGood: boolean;
    previousGood: boolean;
    twoMonthsPriorGood: boolean;
    state: "ACTIVE" | "POSSIBLY_REMOVED";
    lastGoodBillingPeriodId: number | null;
    lastGoodReading: string;
  }[];
  meterConsumption: number;
  coverageStatus: "FULL" | "PARTIAL" | "NONMETERED" | "REVIEW";
  nonMeteredEligible: "NO" | "YES" | "REVIEW";
  customers: MeterCoverageCustomerRecord[];
};

type LazySummaryPayload = {
  invoices: InvoiceRecord[];
  readings: MeterReadingRecord[];
  meterMaster: MeterMasterRecord[];
  meterCoverage?: MeterCoverageRecord[];
};

type LazyFacilityPayload = {
  readings: MeterReadingRecord[];
  meterMaster: MeterMasterRecord[];
};

export type RealPropertyRecord = {
  MonthlyRPID: string;
  StorageMonthlyRPID?: string;
  LegacyRPID?: string;
  FY: number | string;
  BillingMonth: string;
  billing_period_id: number | string;
  FacilityID: string;
  CustomerID: string;
  RPUID?: string;
  SiteCode: string;
  FacilityNumber: string;
  NextGenCustomerName?: string;
  CUBECustomerName: string;
  LegacyCustomerName?: string;
  CategoryCode?: string;
  CategoryDescription?: string;
  AllocationQty: number | string;
  AllocationUM: string;
  UtilityGroup: number | string;
  EL: number | string;
  NG: number | string;
  PW: number | string;
  SS: number | string;
  ELUsage?: number | string;
  NGUsage?: number | string;
  PWUsage?: number | string;
  SSUsage?: number | string;
  CustomerType?: string;
  CustomerReimbursementDefault?: boolean;
  UtilityReimbursementOverrides?: Partial<
    Record<"EL" | "NG" | "PW" | "SS", boolean>
  >;
  CustomerQty?: number | string;
  RecordSource?: "legacy" | "legacy_override" | "monthly";
  AreaSF?: number | string | null;
  SpaceType?: string | null;
};

export type EstimateRecord = {
  EstimateID: string;
  billing_period_id: number | string;
  FY: number | string;
  BillingMonth: string;
  MonthlyRPID?: string;
  SourceMonthlyRPID?: string;
  LegacyRPID?: string;
  SourceLegacyRPID?: string;
  FacilityID: string;
  CustomerID: string;
  CategoryCode: string;
  SpaceTypeID: number | string;
  SpaceType: string;
  AreaSF: number | string;
  UtilityType: string;
  IntensityValue: number | string;
  EstimatedUsage: number | string;
};

type RealPropertySummaryRow = {
  utility_type_cd: string;
  utility_name: string;
  invoice_consumption: number;
  estimated_consumption: number;
  difference: number;
  variance_percent: number | null;
  invoice_count: number;
  estimate_count: number;
  invoice_um: string;
};

type RealPropertyPayload = {
  realProperty: RealPropertyRecord[];
  estimates: EstimateRecord[];
  summary: RealPropertySummaryRow[];
  fiscalYear?: number;
  realPropertySource?: "legacy" | "legacy_override" | "monthly";
  realPropertyTable?: string;
  sourceChangeStatus?: {
    changedAt: string;
    changedBy: string;
    operation: string;
    reconciliationPotentiallyStale: boolean;
    billsPotentiallyStale: boolean;
  } | null;
  customerDefaults?: Record<
    string,
    { customerType: string; reimbursable: boolean }
  >;
};

type PropQRecord = {
  PropQID: string;
  EstimateID?: string;
  billing_period_id: number | string;
  FY?: number | string | null;
  BillingMonth?: string;
  BillingMonthCode?: string;
  FacilityID: string;
  MonthlyRPID?: string;
  LegacyRPID?: string;
  CustomerID?: string;
  CategoryCode?: string;
  AreaSF?: number | string;
  SpaceType?: string;
  UtilityType: string;
  EstimatedUsage: number | string;
  FacilityEstimatedUsage: number | string;
  PropQ: number | string;
  CalculationMethod?: string;
  Source?: string;
  CreatedDate?: string;
  PropQStatus?: string;
};

type PropQPayload = {
  ok: boolean;
  billingPeriodId: number;
  generated: boolean;
  recordCount: number;
  zeroProjectedUsage: number;
  records: PropQRecord[];
};

// ============================================================
// CONSTANTS
// ============================================================

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

const DEFAULT_PAGE_SIZE = 100;

function periodFromFiscalMonth(fy: string, month: string) {
  const monthIndex = MONTHS.indexOf(month);

  if (monthIndex < 0 || !/^\d{4}$/.test(String(fy))) {
    return "";
  }

  const calendarYear = monthIndex >= 9 ? Number(fy) - 1 : Number(fy);

  return `${calendarYear}-${String(monthIndex + 1).padStart(2, "0")}`;
}

// ============================================================
// UTILITY PROVIDERS
// ============================================================

const UTILITY_PROVIDER_NAMES: Record<string, string> = {
  "1": "OG&E",
  "2": "Shell Energy North America (US), L.P.",
  "3": "Oklahoma Natural Gas",
  "4": "City of Oklahoma",
  "5": "Midwest City Water",
};

function utilityProviderName(code: string) {
  const normalized = String(code ?? "").trim();

  if (!normalized) {
    return "—";
  }

  return UTILITY_PROVIDER_NAMES[normalized] ?? `Provider ${normalized}`;
}

// ============================================================
// UTILITY GROUP DISPLAY
//
// Presentation only. DynamoDB continues storing utility_group_id
// exactly as it does now.
// ============================================================

const UTILITY_GROUP_NAMES: Record<string, string> = {
  "1": "WWYK",
  "2": "TACX",
};

function utilityGroupName(code: string) {
  const normalized = String(code ?? "").trim();

  if (!normalized) {
    return "—";
  }

  return UTILITY_GROUP_NAMES[normalized] ?? `Group ${normalized}`;
}

// ============================================================
// NUMBER HELPERS
// ============================================================

function numberValue(value: string) {
  const cleaned = String(value ?? "")
    .replace(/[$,]/g, "")
    .trim();

  const parsed = Number(cleaned);

  return Number.isFinite(parsed)
    ? parsed
    : 0;
}

function formatConsumption(value: number) {
  return value.toLocaleString(
    undefined,
    {
      maximumFractionDigits: 2,
    },
  );
}

function formatMoney(value: number) {
  return value.toLocaleString(
    undefined,
    {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    },
  );
}

// ============================================================
// MONTHLY SUMMARY DISPLAY CONVERSIONS
//
// Display/reconciliation only. Nothing written to DynamoDB is
// changed. Natural-gas meter readings are stored in CF, while
// the monthly summary presents NG in MMBtu.
//
// Temporary standard heat-content factor:
//   1 CF = 1,031 BTU
//   MMBtu = CF * 0.001031
// ============================================================

const NATURAL_GAS_MMBTU_PER_CF = 0.001031;

function summaryMeterConsumption(
  utilityType: string,
  consumption: number,
) {
  const normalizedUtility =
    String(utilityType ?? "").trim().toUpperCase();

  if (normalizedUtility === "NG") {
    return consumption * NATURAL_GAS_MMBTU_PER_CF;
  }

  return consumption;
}

// ============================================================
// CORRECTION RULE HELPERS
// ============================================================

const MANUAL_CORRECTION_RULES = new Set(["f", "g", "h", "i", "k", "m"]);

function normalizeRule(rule: string) {
  return String(rule ?? "").trim().toLowerCase();
}

function isManualCorrectionRule(rule: string) {
  return MANUAL_CORRECTION_RULES.has(normalizeRule(rule));
}

function usableConsumption(reading: MeterReadingRecord | undefined): number | null {
  if (!reading) return null;
  const adjustedText = String(reading.adjusted_consumption ?? "").trim();
  if (adjustedText) {
    const adjusted = numberValue(adjustedText);
    if (Number.isFinite(adjusted)) return adjusted;
  }
  const consumptionText = String(reading.consumption ?? "").trim();
  if (!consumptionText) return null;
  const consumption = numberValue(consumptionText);
  return Number.isFinite(consumption) ? consumption : null;
}

function roundAdjusted(value: number) {
  if (!Number.isFinite(value)) return "";
  return String(Math.round(value * 10000) / 10000);
}

type MeterReadingDraft = {
  reading: string;
  meter_correction_rule_cd: string;
  used_in_calculation: string;
  adjusted_consumption: string;
};

// ============================================================
// READING HAS VALUE
// ============================================================

function hasReadingValue(reading: string) {
  const normalized =
    reading.trim();

  if (!normalized) {
    return false;
  }

  const numeric =
    Number(normalized);

  if (Number.isFinite(numeric)) {
    return numeric !== 0;
  }

  return true;
}

// ============================================================
// METER SORT
// ============================================================

function compareMeterReadings(
  a: MeterReadingRecord,
  b: MeterReadingRecord,
) {
  const facility =
    a.facility_nbr.localeCompare(
      b.facility_nbr,
      undefined,
      {
        numeric: true,
        sensitivity: "base",
      },
    );

  if (facility !== 0) {
    return facility;
  }

  const meter =
    a.meterid.localeCompare(
      b.meterid,
      undefined,
      {
        numeric: true,
        sensitivity: "base",
      },
    );

  if (meter !== 0) {
    return meter;
  }

  const aValue =
    hasReadingValue(
      a.reading,
    );

  const bValue =
    hasReadingValue(
      b.reading,
    );

  if (aValue !== bValue) {
    return aValue
      ? -1
      : 1;
  }

  return a.period.localeCompare(
    b.period,
    undefined,
    {
      numeric: true,
      sensitivity: "base",
    },
  );
}

// ============================================================
// BILLING PERIOD ID
// FY2026 October = 171, then increments one per month.
// Federal fiscal-year month order is October through September.
// ============================================================

const BILLING_PERIOD_MONTHS = [
  "October",
  "November",
  "December",
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
];

function resolveBillingPeriodId(
  fy: string,
  month: string,
  fallback: string,
): string {
  const rawFY = String(fy ?? "").trim();
  const fiscalYear =
    rawFY.length === 2
      ? 2000 + Number(rawFY)
      : Number(rawFY);

  const normalizedMonth =
    String(month ?? "").trim().toLowerCase();

  const monthIndex = BILLING_PERIOD_MONTHS.findIndex(
    (value) => {
      const full = value.toLowerCase();
      return (
        full === normalizedMonth ||
        full.slice(0, 3) === normalizedMonth.slice(0, 3)
      );
    },
  );

  if (
    Number.isInteger(fiscalYear) &&
    fiscalYear >= 2026 &&
    monthIndex >= 0
  ) {
    return String(
      171 +
        (fiscalYear - 2026) * 12 +
        monthIndex,
    );
  }

  const rawFallback = String(fallback ?? "").trim();

  if (/^\d+$/.test(rawFallback)) {
    return rawFallback;
  }

  const prefixedMatch = rawFallback.match(
    /^BP\s*(\d+)$/i,
  );

  return prefixedMatch?.[1] ?? "";
}

// ============================================================
// MAIN CLIENT
// ============================================================

export function MonthlyDataClient({
  invoices,
  meterReadings,
  correctionRules,
  meterMaster,
  initialFY,
  initialMonth,
  billingPeriodId,
  fiscalYears,
}: Props) {
  const router =
    useRouter();

  const [
    isPending,
    startTransition,
  ] =
    useTransition();

  const [
    localInvoices,
    setLocalInvoices,
  ] =
    useState(
      invoices,
    );

  useEffect(
    () => {
      setLocalInvoices(
        invoices,
      );
    },
    [
      invoices,
    ],
  );

  const [
    localReadings,
    setLocalReadings,
  ] =
    useState(
      meterReadings,
    );

  useEffect(
    () => {
      setLocalReadings(
        meterReadings,
      );
    },
    [
      meterReadings,
    ],
  );

  const { activeSection: activeTab, setActiveSection: setActiveTab } = useAppSection();

  const [
    invoiceSubTab,
    setInvoiceSubTab,
  ] =
    useState<
      "Data" |
      "Upload"
    >(
      "Data",
    );

  const [
    meterSubTab,
    setMeterSubTab,
  ] =
    useState<
      | "Review"
      | "AMR"
      | "Manual"
    >(
      "Review",
    );

  const [
    realPropertySubTab,
    setRealPropertySubTab,
  ] = useState<"Current" | "PropQ" | "Upload">("Current");

  const [realPropertyCache, setRealPropertyCache] =
    useState<Record<string, RealPropertyPayload>>({});
  const [realPropertyLoading, setRealPropertyLoading] = useState(false);
  const [realPropertyError, setRealPropertyError] = useState("");

  const [propQCache, setPropQCache] =
    useState<Record<string, PropQPayload>>({});
  const [propQLoading, setPropQLoading] = useState(false);
  const [propQError, setPropQError] = useState("");

  const [
    selectedFY,
    setSelectedFY,
  ] =
    useState(
      initialFY,
    );

  const [
    selectedMonth,
    setSelectedMonth,
  ] =
    useState(
      initialMonth,
    );

  useEffect(
    () => {
      setSelectedFY(
        initialFY,
      );

      setSelectedMonth(
        initialMonth,
      );
    },
    [
      initialFY,
      initialMonth,
    ],
  );

  const selectedBillingPeriodId =
    resolveBillingPeriodId(
      selectedFY,
      selectedMonth,
      billingPeriodId,
    );

  // ============================================================
  // PHASE 1 - LAZY SUMMARY DATA
  //
  // Summary tabs no longer block the initial Monthly Data load.
  // Results are cached in this mounted client by billing period.
  // ============================================================

  const [monthlySummaryCache, setMonthlySummaryCache] =
    useState<Record<string, LazySummaryPayload>>({});

  const [facilitySummaryCache, setFacilitySummaryCache] =
    useState<Record<string, LazyFacilityPayload>>({});

  const [monthlySummaryLoading, setMonthlySummaryLoading] =
    useState(false);

  const [facilitySummaryLoading, setFacilitySummaryLoading] =
    useState(false);

  const [monthlySummaryError, setMonthlySummaryError] =
    useState("");

  const [facilitySummaryError, setFacilitySummaryError] =
    useState("");

  async function loadMonthlySummary() {
    const key = String(selectedBillingPeriodId ?? "").trim();

    if (!key || monthlySummaryCache[key] || monthlySummaryLoading) {
      return;
    }

    setMonthlySummaryLoading(true);
    setMonthlySummaryError("");

    try {
      const response = await fetch(
        `/api/monthly-data/summary?billing_period_id=${encodeURIComponent(
          key,
        )}&fy=${encodeURIComponent(
          selectedFY,
        )}&month=${encodeURIComponent(
          selectedMonth,
        )}`,
        { cache: "no-store" },
      );

      const result = await response.json();

      if (!response.ok) {
        throw new Error(result?.error || "Unable to load Monthly Summary.");
      }

      setMonthlySummaryCache((current) => ({
        ...current,
        [key]: result as LazySummaryPayload,
      }));
    } catch (error) {
      setMonthlySummaryError(
        error instanceof Error ? error.message : "Unable to load Monthly Summary.",
      );
    } finally {
      setMonthlySummaryLoading(false);
    }
  }

  async function loadFacilitySummary() {
    const key = String(selectedBillingPeriodId ?? "").trim();

    if (!key || facilitySummaryCache[key] || facilitySummaryLoading) {
      return;
    }

    setFacilitySummaryLoading(true);
    setFacilitySummaryError("");

    try {
      const response = await fetch(
        `/api/monthly-data/facility-summary?billing_period_id=${encodeURIComponent(key)}`,
        { cache: "no-store" },
      );

      const result = await response.json();

      if (!response.ok) {
        throw new Error(result?.error || "Unable to load Facility Summary.");
      }

      setFacilitySummaryCache((current) => ({
        ...current,
        [key]: result as LazyFacilityPayload,
      }));
    } catch (error) {
      setFacilitySummaryError(
        error instanceof Error ? error.message : "Unable to load Facility Summary.",
      );
    } finally {
      setFacilitySummaryLoading(false);
    }
  }

  async function loadRealProperty(force = false) {
    const key = String(selectedBillingPeriodId ?? "").trim();

    if (!key || (!force && realPropertyCache[key]) || realPropertyLoading) {
      return;
    }

    setRealPropertyLoading(true);
    setRealPropertyError("");

    try {
      const response = await fetch(
        `/api/monthly-data/real-property?billing_period_id=${encodeURIComponent(key)}`,
        { cache: "no-store" },
      );

      const result = await response.json();

      if (!response.ok) {
        throw new Error(result?.error || "Unable to load Real Property data.");
      }

      setRealPropertyCache((current) => ({
        ...current,
        [key]: result as RealPropertyPayload,
      }));
    } catch (error) {
      setRealPropertyError(
        error instanceof Error ? error.message : "Unable to load Real Property data.",
      );
    } finally {
      setRealPropertyLoading(false);
    }
  }

  async function loadPropQ(force = false) {
    const key = String(selectedBillingPeriodId ?? "").trim();

    if (!key || (!force && propQCache[key]) || propQLoading) {
      return;
    }

    setPropQLoading(true);
    setPropQError("");

    try {
      const response = await fetch(
        `/api/monthly-data/real-property/propq?billing_period_id=${encodeURIComponent(key)}`,
        { cache: "no-store" },
      );

      const result = await response.json();

      if (!response.ok) {
        throw new Error(result?.error || "Unable to load PropQ status.");
      }

      setPropQCache((current) => ({
        ...current,
        [key]: result as PropQPayload,
      }));
    } catch (error) {
      setPropQError(
        error instanceof Error ? error.message : "Unable to load PropQ status.",
      );
    } finally {
      setPropQLoading(false);
    }
  }

  useEffect(() => {
    if (activeTab === "Monthly Summary") {
      void loadMonthlySummary();
    }

    if (activeTab === "Monthly Reconciliation") {
      void loadFacilitySummary();
    }

    if (activeTab === "Real Property") {
      void loadRealProperty();
      void loadPropQ();
    }
    // The active tab and billing period are the triggers.
    // Cache/loading state is intentionally not part of this dependency list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, selectedBillingPeriodId]);

  const monthlySummaryData =
    monthlySummaryCache[String(selectedBillingPeriodId ?? "").trim()];

  const facilitySummaryData =
    facilitySummaryCache[String(selectedBillingPeriodId ?? "").trim()];

  const realPropertyData =
    realPropertyCache[String(selectedBillingPeriodId ?? "").trim()];

  const propQData =
    propQCache[String(selectedBillingPeriodId ?? "").trim()];

  function changePeriod(
    fy: string,
    month: string,
  ) {
    setSelectedFY(
      fy,
    );

    setSelectedMonth(
      month,
    );

    const params =
      new URLSearchParams();

    params.set(
      "fy",
      fy,
    );

    params.set(
      "month",
      month,
    );

    startTransition(
      () => {
        router.push(
          `/monthly-data?${params.toString()}`,
        );
      },
    );
  }

  return (
    <>
      <section className="md-period-bar">
        <div>
          <p className="md-period-label">
            Current Billing Period
          </p>

          <div className="md-period-title">
            {selectedMonth} FY{" "}
            {selectedFY}
          </div>
        </div>

        <div className="md-period-controls">
          <label>
            <span>
              Fiscal Year
            </span>

            <select
              value={
                selectedFY
              }
              disabled={
                isPending
              }
              onChange={(
                event,
              ) =>
                changePeriod(
                  event.target.value,
                  selectedMonth,
                )
              }
            >
              {fiscalYears.map(
                (
                  fy,
                ) => (
                  <option
                    key={fy}
                    value={fy}
                  >
                    FY {fy}
                  </option>
                ),
              )}
            </select>
          </label>

          <label>
            <span>
              Billing Month
            </span>

            <select
              value={
                selectedMonth
              }
              disabled={
                isPending
              }
              onChange={(
                event,
              ) =>
                changePeriod(
                  selectedFY,
                  event.target.value,
                )
              }
            >
              {MONTHS.map(
                (
                  month,
                ) => (
                  <option
                    key={month}
                    value={month}
                  >
                    {month}
                  </option>
                ),
              )}
            </select>
          </label>

          <div className="md-period-id">
            <span>
              Billing Period ID
            </span>

            <strong>
              {isPending
                ? "Loading..."
                : selectedBillingPeriodId ||
                  "Not defined"}
            </strong>
          </div>
        </div>
      </section>

      <section className="bd-workspace md-workspace">
        {activeTab ===
          "Invoices" && (
          <>
            <SubTabs
              options={[
                {
                  value: "Data",
                  label:
                    "Invoice Data",
                },
                {
                  value: "Upload",
                  label:
                    "Upload Invoice",
                },
              ]}
              active={
                invoiceSubTab
              }
              onChange={(
                value,
              ) =>
                setInvoiceSubTab(
                  value as
                    | "Data"
                    | "Upload",
                )
              }
            />

            {invoiceSubTab ===
              "Data" && (
              <InvoiceTable
                invoices={
                  localInvoices
                }
                setInvoices={
                  setLocalInvoices
                }
              />
            )}

            {invoiceSubTab ===
              "Upload" && (
              <InvoiceUpload
                fiscalYear={
                  selectedFY
                }
                billingMonth={
                  selectedMonth
                }
                billingPeriodId={
                  selectedBillingPeriodId
                }
                onComplete={() =>
                  router.refresh()
                }
              />
            )}
          </>
        )}

        {activeTab ===
          "Meter Readings" && (
          <>
            <SubTabs
              options={[
                {
                  value:
                    "Review",

                  label:
                    "Review Readings",
                },

                {
                  value:
                    "AMR",

                  label:
                    "Upload AMR",
                },

                {
                  value:
                    "Manual",

                  label:
                    "Upload Manual Readings",
                },
              ]}
              active={
                meterSubTab
              }
              onChange={(
                value,
              ) =>
                setMeterSubTab(
                  value as
                    | "Review"
                    | "AMR"
                    | "Manual",
                )
              }
            />

            {meterSubTab ===
              "Review" && (
              <MeterReadingTable
                readings={
                  localReadings
                }
                meterMaster={
                  meterMaster
                }
                setReadings={
                  setLocalReadings
                }
                correctionRules={
                  correctionRules
                }
                fy={
                  selectedFY
                }
                month={
                  selectedMonth
                }
                billingPeriodId={
                  selectedBillingPeriodId
                }
                onSaved={
                  () => router.refresh()
                }
              />
            )}

            {meterSubTab ===
              "AMR" && (
              <AMRUpload
                fy={
                  selectedFY
                }
                month={
                  selectedMonth
                }
                billingPeriodId={
                  selectedBillingPeriodId
                }
                onComplete={() =>
                  router.refresh()
                }
              />
            )}

            {meterSubTab ===
              "Manual" && (
              <ManualUpload
                fy={selectedFY}
                month={selectedMonth}
                billingPeriodId={selectedBillingPeriodId}
                onComplete={() => router.refresh()}
              />
            )}
          </>
        )}


        {activeTab === "Plant Unit" && (
          <PlantUnitEntry
            fy={selectedFY}
            month={selectedMonth}
            billingPeriodId={selectedBillingPeriodId}
          />
        )}

        {activeTab === "Monthly Summary" && (
          <>
            {monthlySummaryLoading && !monthlySummaryData && (
              <div className="bd-empty">
                Loading Monthly Summary...
              </div>
            )}

            {monthlySummaryError && !monthlySummaryData && (
              <div className="bd-empty">
                {monthlySummaryError}
                <div style={{ marginTop: 12 }}>
                  <button
                    type="button"
                    className="bd-button"
                    onClick={() => void loadMonthlySummary()}
                  >
                    Retry
                  </button>
                </div>
              </div>
            )}

            {monthlySummaryData && (
              <MonthlySummary
                invoices={monthlySummaryData.invoices}
                readings={monthlySummaryData.readings}
                meterMaster={monthlySummaryData.meterMaster}
                meterCoverage={monthlySummaryData.meterCoverage ?? []}
                fy={selectedFY}
                month={selectedMonth}
                billingPeriodId={selectedBillingPeriodId}
              />
            )}
          </>
        )}

        {activeTab === "Monthly Reconciliation" && (
          <>
            {/* {facilitySummaryLoading && !facilitySummaryData && (
              <div className="bd-empty">
                Loading 24 months of Facility Summary data...
              </div>
            )} */}

            {facilitySummaryError && !facilitySummaryData && (
              <div className="bd-empty">
                {facilitySummaryError}
                <div style={{ marginTop: 12 }}>
                  <button
                    type="button"
                    className="bd-button"
                    onClick={() => void loadFacilitySummary()}
                  >
                    Retry
                  </button>
                </div>
              </div>
            )}

            {facilitySummaryData && (
              <FacilitySummary
                readings={facilitySummaryData.readings}
                meterMaster={facilitySummaryData.meterMaster}
                fy={selectedFY}
                month={selectedMonth}
                billingPeriodId={selectedBillingPeriodId}
              />
            )}
          </>
        )}

        {activeTab === "Real Property" && (
          <>
            <SubTabs
              options={[
                { value: "Current", label: "Current Data" },
                { value: "PropQ", label: "PropQ" },
                { value: "Upload", label: "Upload Real Property" },
              ]}
              active={realPropertySubTab}
              onChange={(value) => {
                const next =
                  value as "Current" | "PropQ" | "Upload";

                setRealPropertySubTab(next);

                if (next === "PropQ") {
                  void loadPropQ();
                }
              }}
            />

            {realPropertySubTab === "Current" && (
              <>
                {realPropertyLoading && !realPropertyData && (
                  <div className="bd-empty">Loading Real Property data and estimates...</div>
                )}

                {realPropertyError && !realPropertyData && (
                  <div className="bd-empty">
                    {realPropertyError}
                    <div style={{ marginTop: 12 }}>
                      <button
                        type="button"
                        className="bd-button"
                        onClick={() => void loadRealProperty(true)}
                      >
                        Retry
                      </button>
                    </div>
                  </div>
                )}

                {realPropertyData && (
                  <RealPropertyCurrent
                    data={realPropertyData}
                    fy={selectedFY}
                    month={selectedMonth}
                    billingPeriodId={selectedBillingPeriodId}
                    loading={realPropertyLoading}
                    onRefresh={() => void loadRealProperty(true)}
                    onChanged={async () => {
                      await Promise.all([
                        loadRealProperty(true),
                        loadPropQ(true),
                      ]);
                    }}
                  />
                )}
              </>
            )}

            {realPropertySubTab === "PropQ" && (
              <RealPropertyPropQ
                data={propQData}
                realProperty={realPropertyData?.realProperty ?? []}
                estimates={realPropertyData?.estimates ?? []}
                estimatesAvailable={(realPropertyData?.estimates.length ?? 0) > 0}
                fy={selectedFY}
                month={selectedMonth}
                billingPeriodId={selectedBillingPeriodId}
                loading={propQLoading}
                error={propQError}
                onRefresh={() => void loadPropQ(true)}
                onGenerated={async () => {
                  await loadPropQ(true);
                }}
              />
            )}

            {realPropertySubTab === "Upload" && (
              <RealPropertyUpload
                fy={selectedFY}
                month={selectedMonth}
                billingPeriodId={selectedBillingPeriodId}
                existingRecordCount={realPropertyData?.realProperty.length ?? 0}
                onComplete={async () => {
                  await Promise.all([
                    loadRealProperty(true),
                    loadPropQ(true),
                  ]);
                  setRealPropertySubTab("Current");
                }}
              />
            )}
          </>
        )}

      </section>
    </>
  );
}


// ============================================================
// REAL PROPERTY
// ============================================================

function rpNumber(value: unknown) {
  const parsed = Number(String(value ?? "").replace(/[$,]/g, "").trim());
  return Number.isFinite(parsed) ? parsed : 0;
}

function rpFormat(value: unknown, decimals = 2) {
  return rpNumber(value).toLocaleString(undefined, {
    maximumFractionDigits: decimals,
  });
}

type RealPropertyFieldChange = {
  label: string;
  before: string;
  after: string;
};

type RealPropertyPendingConfirmation = {
  kind: "create" | "edit" | "delete" | "delete_all";
  payload: Record<string, unknown>;
  recordId?: string;
  customer?: string;
  facility?: string;
  changes?: RealPropertyFieldChange[];
  recordCount?: number;
};

function RealPropertyConfirmationDialog({
  eyebrow,
  title,
  description,
  confirmLabel,
  cancelLabel = "Cancel",
  danger = false,
  busy,
  confirmDisabled = false,
  error,
  children,
  onConfirm,
  onCancel,
}: {
  eyebrow: string;
  title: string;
  description: string;
  confirmLabel: string;
  cancelLabel?: string;
  danger?: boolean;
  busy: boolean;
  confirmDisabled?: boolean;
  error?: string;
  children?: ReactNode;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      className="md-rp-confirmation-backdrop"
      onMouseDown={(event) => {
        if (!busy && event.target === event.currentTarget) onCancel();
      }}
    >
      <section
        className={`md-rp-confirmation-dialog${danger ? " md-rp-confirmation-danger" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="md-rp-confirmation-title"
      >
        <header className="md-rp-confirmation-header">
          <p>{eyebrow}</p>
          <h2 id="md-rp-confirmation-title">{title}</h2>
          <span>{description}</span>
        </header>
        <div className="md-rp-confirmation-body">
          {children}
          {error ? <div className="md-rp-confirmation-error" role="alert">{error}</div> : null}
        </div>
        <footer className="md-rp-confirmation-footer">
          <button
            type="button"
            className="md-secondary-button"
            disabled={busy}
            onClick={onCancel}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            className={danger ? "md-danger-button" : "bd-add-button"}
            disabled={busy || confirmDisabled}
            onClick={onConfirm}
          >
            {busy ? "Working..." : confirmLabel}
          </button>
        </footer>
      </section>
    </div>
  );
}

function RealPropertyCurrent({
  data,
  fy,
  month,
  billingPeriodId,
  loading,
  onRefresh,
  onChanged,
}: {
  data: RealPropertyPayload;
  fy: string;
  month: string;
  billingPeriodId: string;
  loading: boolean;
  onRefresh: () => void;
  onChanged: () => Promise<void>;
}) {
  const [search, setSearch] = useState("");
  const [draft, setDraft] = useState<Partial<RealPropertyRecord> | null>(null);
  const [editingOriginal, setEditingOriginal] = useState<RealPropertyRecord | null>(null);
  const [editingId, setEditingId] = useState("");
  const [pendingConfirmation, setPendingConfirmation] =
    useState<RealPropertyPendingConfirmation | null>(null);
  const [deleteMonthText, setDeleteMonthText] = useState("");
  const [mutating, setMutating] = useState(false);
  const [mutationError, setMutationError] = useState("");
  const [mutationMessage, setMutationMessage] = useState("");
  const mutationInFlight = useRef(false);
  const [categoryCodes, setCategoryCodes] = useState<RealPropertyCategoryCodeOption[]>([]);
  const [categoryCodesLoaded, setCategoryCodesLoaded] = useState(false);
  const [categoryCodesError, setCategoryCodesError] = useState("");
  const [categoryCodeSuggestionsOpen, setCategoryCodeSuggestionsOpen] = useState(false);
  const [highlightedCategoryCodeIndex, setHighlightedCategoryCodeIndex] = useState(0);

  const realPropertyEditable = Boolean(billingPeriodId);
  const reimbursementUtilities = [
    ["EL", "Electricity"],
    ["NG", "Natural Gas"],
    ["PW", "Produced Water"],
    ["SS", "Sewer"],
  ] as const;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch("/api/yearly-data/category-codes");
        const result = await response.json();
        if (!response.ok || !result?.ok || !Array.isArray(result.items)) {
          throw new Error(result?.error || "Unable to load Category Codes.");
        }
        if (!cancelled) {
          setCategoryCodes(result.items);
          setCategoryCodesError("");
        }
      } catch (error) {
        if (!cancelled) {
          setCategoryCodesError(
            error instanceof Error ? error.message : "Unable to load Category Codes.",
          );
        }
      } finally {
        if (!cancelled) setCategoryCodesLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const categorySearchText = String(draft?.CategoryCode ?? "");
  const categorySuggestions = useMemo(
    () => searchRealPropertyCategoryCodes(categoryCodes, categorySearchText),
    [categoryCodes, categorySearchText],
  );

  function chooseCategoryCode(category: RealPropertyCategoryCodeOption) {
    setDraft((current) => current
      ? { ...current, CategoryCode: category.category_cd }
      : current);
    setCategoryCodeSuggestionsOpen(false);
    setHighlightedCategoryCodeIndex(0);
  }

  function customerReimbursementDefault(customerId: unknown) {
    return data.customerDefaults?.[String(customerId ?? "").trim()] ?? {
      customerType: "Non-Reimbursable",
      reimbursable: false,
    };
  }

  function beginCreate() {
    setEditingId("");
    setEditingOriginal(null);
    setDraft({
      CustomerID: "",
      FacilityID: "",
      RPUID: "",
      CategoryCode: "",
      AllocationQty: 0,
      AllocationUM: "SF",
      UtilityGroup: 1,
      EL: 0,
      NG: 0,
      PW: 0,
      SS: 0,
      UtilityReimbursementOverrides: {},
    });
    setMutationError("");
  }

  function beginEdit(row: RealPropertyRecord) {
    setEditingId(String(row.MonthlyRPID ?? "").trim());
    setEditingOriginal({ ...row });
    setDraft({ ...row });
    setMutationError("");
  }

  async function mutate(payload: Record<string, unknown>) {
    if (mutationInFlight.current) return;
    mutationInFlight.current = true;
    setMutating(true);
    setMutationError("");
    setMutationMessage("");
    try {
      const response = await fetch("/api/monthly-data/real-property/manage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...payload,
          billing_period_id: billingPeriodId,
          fy,
          billing_month_nm: month,
        }),
      });
      const result = await response.json();
      if (!response.ok) {
        const details = Array.isArray(result?.details)
          ? ` ${result.details.join(" ")}`
          : "";
        throw new Error(`${result?.error || "Real Property change failed."}${details}`);
      }
      setMutationMessage(String(result.message ?? "Real Property updated."));
      setDraft(null);
      setEditingOriginal(null);
      setEditingId("");
      setPendingConfirmation(null);
      setDeleteMonthText("");
      await onChanged();
    } catch (error) {
      setMutationError(
        error instanceof Error ? error.message : "Real Property change failed.",
      );
    } finally {
      mutationInFlight.current = false;
      setMutating(false);
    }
  }

  function recordPayload() {
    if (!draft) return null;
    return {
      CustomerID: draft.CustomerID ?? "",
      FacilityID: draft.FacilityID ?? "",
      RPUID: draft.RPUID ?? "",
      CategoryCode: draft.CategoryCode ?? "",
      AllocationQty: draft.AllocationQty ?? 0,
      AllocationUM: draft.AllocationUM ?? "SF",
      UtilityGroup: draft.UtilityGroup ?? 1,
      EL: draft.EL ?? 0,
      NG: draft.NG ?? 0,
      PW: draft.PW ?? 0,
      SS: draft.SS ?? 0,
      UtilityReimbursementOverrides: {
        ...(draft.UtilityReimbursementOverrides ?? {}),
      },
    };
  }

  function reimbursementSettingLabel(
    record: Partial<RealPropertyRecord> | null,
    utility: "EL" | "NG" | "PW" | "SS",
  ) {
    const explicit = record?.UtilityReimbursementOverrides?.[utility];
    const customerDefault = customerReimbursementDefault(record?.CustomerID);
    if (typeof explicit === "boolean") {
      return explicit
        ? "Override: Customer reimburses CE"
        : "Override: CE absorbs charge";
    }
    return customerDefault.reimbursable
      ? "Customer default: Reimbursable"
      : "Customer default: Non-Reimbursable";
  }

  function setReimbursementOverride(
    utility: "EL" | "NG" | "PW" | "SS",
    value: boolean | undefined,
  ) {
    setDraft((current) => {
      if (!current) return current;
      const overrides = { ...(current.UtilityReimbursementOverrides ?? {}) };
      if (value === undefined) delete overrides[utility];
      else overrides[utility] = value;
      return { ...current, UtilityReimbursementOverrides: overrides };
    });
  }

  function displayRealPropertyField(field: keyof RealPropertyRecord, value: unknown) {
    if (["EL", "NG", "PW", "SS"].includes(field)) {
      return rpNumber(value) === 1 ? "Yes" : "No";
    }
    const displayed = String(value ?? "").trim();
    return displayed || "Blank";
  }

  function prepareSaveConfirmation() {
    if (!draft) return;
    const categoryCode = String(draft.CategoryCode ?? "").trim();
    if (categoryCode && categoryCodesError) {
      setMutationError(`Category Codes could not be verified. ${categoryCodesError}`);
      return;
    }
    const categoryCodeError = validateRealPropertyCategoryCode(categoryCode, categoryCodes);
    if (categoryCodeError) {
      setMutationError(categoryCodeError);
      return;
    }
    const record = recordPayload();
    if (!record) return;
    const fields: Array<[keyof RealPropertyRecord, string]> = [
      ["CustomerID", "Customer ID"],
      ["FacilityID", "Facility ID"],
      ["RPUID", "RPUID"],
      ["CategoryCode", "Category Code"],
      ["AllocationQty", "Allocation Quantity"],
      ["AllocationUM", "Allocation U/M"],
      ["UtilityGroup", "Utility Group"],
      ["EL", "Electric"],
      ["NG", "Natural Gas"],
      ["PW", "Produced Water"],
      ["SS", "Sewer"],
    ];
    const changes = fields.flatMap(([field, label]) => {
      const before = displayRealPropertyField(field, editingOriginal?.[field]);
      const after = displayRealPropertyField(field, draft[field]);
      return before === after ? [] : [{ label, before, after }];
    });
    for (const [utility, utilityLabel] of reimbursementUtilities) {
      const before = reimbursementSettingLabel(editingOriginal, utility);
      const after = reimbursementSettingLabel(draft, utility);
      if (before !== after) {
        changes.push({
          label: `${utilityLabel} reimbursement`,
          before,
          after,
        });
      }
    }
    setMutationError("");
    setPendingConfirmation({
      kind: editingId ? "edit" : "create",
      recordId: editingId || undefined,
      customer: String(draft.CUBECustomerName ?? draft.CustomerID ?? "").trim(),
      facility: String(draft.FacilityNumber ?? draft.FacilityID ?? "").trim(),
      changes,
      payload: {
        action: editingId ? "update" : "create",
        monthly_rp_id: editingId,
        record,
      },
    });
  }

  function prepareDeleteRecord(row: RealPropertyRecord) {
    const id = String(row.MonthlyRPID ?? "").trim();
    setMutationError("");
    setPendingConfirmation({
      kind: "delete",
      recordId: id,
      customer: String(
        row.CUBECustomerName || row.LegacyCustomerName || row.CustomerID || "Unknown customer",
      ),
      facility: String(row.FacilityNumber || row.FacilityID || "Unknown facility"),
      payload: { action: "delete", monthly_rp_id: id },
    });
  }

  function prepareDeleteAll() {
    const count = data.realProperty.length;
    setMutationError("");
    setDeleteMonthText("");
    setPendingConfirmation({
      kind: "delete_all",
      recordCount: count,
      payload: {
        action: "delete_all",
        confirmation_month: month,
        confirmation_count: count,
      },
    });
  }

  function cancelConfirmation() {
    if (mutating) return;
    setPendingConfirmation(null);
    setDeleteMonthText("");
    setMutationError("");
  }

  function confirmPendingOperation() {
    if (!pendingConfirmation || mutating) return;
    void mutate({
      ...pendingConfirmation.payload,
      confirmed: true,
      ...(pendingConfirmation.kind === "delete_all"
        ? { confirmation_phrase: deleteMonthText }
        : {}),
    });
  }

  function editConfirmationContent() {
    if (!pendingConfirmation || !["create", "edit"].includes(pendingConfirmation.kind)) {
      return null;
    }
    const changes = pendingConfirmation.changes ?? [];
    return (
      <>
        <dl className="md-rp-confirmation-identifiers">
          {pendingConfirmation.recordId ? (
            <><dt>Record</dt><dd>{pendingConfirmation.recordId}</dd></>
          ) : null}
          <dt>Customer</dt><dd>{pendingConfirmation.customer || "New assignment"}</dd>
          <dt>Facility</dt><dd>{pendingConfirmation.facility || "New assignment"}</dd>
          <dt>Billing month</dt><dd>{month} FY {fy}</dd>
        </dl>
        <div className="md-rp-confirmation-changes">
          <strong>{pendingConfirmation.kind === "create" ? "Values to create" : "Fields changed"}</strong>
          {changes.length > 0 ? (
            <ul>
              {changes.map((change) => (
                <li key={change.label}>
                  <span>{change.label}</span>
                  {pendingConfirmation.kind === "edit" ? <del>{change.before}</del> : null}
                  <b>{change.after}</b>
                </li>
              ))}
            </ul>
          ) : (
            <p>No field values changed. Confirming will still save the current values.</p>
          )}
        </div>
      </>
    );
  }

  const estimatesByRpId = useMemo(() => {
    const map = new Map<string, Map<string, EstimateRecord>>();

    function addEstimate(id: unknown, utility: string, estimate: EstimateRecord) {
      const normalizedId = String(id ?? "").trim();
      if (!normalizedId || !utility) return;

      if (!map.has(normalizedId)) {
        map.set(normalizedId, new Map());
      }

      map.get(normalizedId)!.set(utility, estimate);
    }

    for (const estimate of data.estimates) {
      const utility = String(estimate.UtilityType ?? "").trim().toUpperCase();
      if (!utility) continue;

      // Index every RP identifier that may be returned by the API.
      // Monthly snapshots use MonthlyRPID/SourceMonthlyRPID, while
      // legacy annual RP rows can use LegacyRPID/SourceLegacyRPID.
      addEstimate(estimate.SourceMonthlyRPID, utility, estimate);
      addEstimate(estimate.MonthlyRPID, utility, estimate);
      addEstimate(estimate.SourceLegacyRPID, utility, estimate);
      addEstimate(estimate.LegacyRPID, utility, estimate);
    }

    return map;
  }, [data.estimates]);

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return data.realProperty;

    return data.realProperty.filter((row) =>
      Object.values(row).some((value) =>
        String(value ?? "").toLowerCase().includes(query),
      ),
    );
  }, [data.realProperty, search]);

  function estimateValue(row: RealPropertyRecord, utility: string) {
    const normalizedUtility = String(utility ?? "").trim().toUpperCase();

    // Try every identifier available on the RP row. This keeps the UI
    // working for both legacy annual RP and monthly RP snapshots.
    const candidateIds = [
      row.MonthlyRPID,
      row.LegacyRPID,
      row.RPUID,
    ]
      .map((value) => String(value ?? "").trim())
      .filter(Boolean);

    for (const id of candidateIds) {
      const estimate = estimatesByRpId.get(id)?.get(normalizedUtility);
      if (estimate) {
        return rpFormat(estimate.EstimatedUsage);
      }
    }

    return "—";
  }

  return (
    <>
      {pendingConfirmation && ["create", "edit"].includes(pendingConfirmation.kind) ? (
        <RealPropertyConfirmationDialog
          eyebrow={pendingConfirmation.kind === "edit" ? "Confirm record changes" : "Confirm new record"}
          title={pendingConfirmation.kind === "edit" ? "Save Real Property Changes?" : "Create Real Property Record?"}
          description={
            pendingConfirmation.kind === "edit"
              ? "Review the changed fields below. DynamoDB Local will not be updated until you confirm."
              : "Review the new record before it is added to the selected billing month."
          }
          confirmLabel={pendingConfirmation.kind === "edit" ? "Confirm Changes" : "Confirm Create"}
          busy={mutating}
          error={mutationError}
          onCancel={cancelConfirmation}
          onConfirm={confirmPendingOperation}
        >
          {editConfirmationContent()}
        </RealPropertyConfirmationDialog>
      ) : null}

      {pendingConfirmation?.kind === "delete" ? (
        <RealPropertyConfirmationDialog
          eyebrow="Confirm record deletion"
          title="Delete Real Property Record?"
          description="This removes the record from the active monthly snapshot and updates its dependent estimates and PropQ."
          confirmLabel="Confirm Delete"
          danger
          busy={mutating}
          error={mutationError}
          onCancel={cancelConfirmation}
          onConfirm={confirmPendingOperation}
        >
          <dl className="md-rp-confirmation-identifiers">
            <dt>Customer</dt><dd>{pendingConfirmation.customer}</dd>
            <dt>Facility</dt><dd>{pendingConfirmation.facility}</dd>
            <dt>Billing month</dt><dd>{month} FY {fy}</dd>
            <dt>Record</dt><dd>{pendingConfirmation.recordId}</dd>
          </dl>
        </RealPropertyConfirmationDialog>
      ) : null}

      {pendingConfirmation?.kind === "delete_all" ? (
        <RealPropertyConfirmationDialog
          eyebrow="Destructive monthly operation"
          title={`Delete All Real Property for ${month} FY ${fy}?`}
          description={`${Number(pendingConfirmation.recordCount ?? 0).toLocaleString()} active Real Property records will be removed from this billing month.`}
          confirmLabel="Confirm Month Delete"
          danger
          busy={mutating}
          confirmDisabled={deleteMonthText !== "DELETE"}
          error={mutationError}
          onCancel={cancelConfirmation}
          onConfirm={confirmPendingOperation}
        >
          <div className="md-rp-confirmation-warning">
            Dependent estimates and PropQ will also be removed from the active snapshot. Existing reconciliation and saved bills will be flagged potentially stale and will not be regenerated automatically.
          </div>
          <label className="md-rp-confirmation-phrase">
            <span>Type <strong>DELETE</strong> to enable final confirmation.</span>
            <input
              type="text"
              value={deleteMonthText}
              disabled={mutating}
              autoComplete="off"
              onChange={(event) => setDeleteMonthText(event.target.value)}
            />
          </label>
        </RealPropertyConfirmationDialog>
      ) : null}

      <section className="md-rp-summary-section">
        <div className="md-invoice-summary-heading">
          <div>
            <span className="md-invoice-summary-eyebrow">
              Real Property Reconciliation
            </span>
            <h3>Invoice Consumption vs. Real Property Estimates</h3>
            <p>
              {month} FY {fy} • Billing Period {billingPeriodId}
              {data.realPropertySource
                ? ` • ${
                    data.realPropertySource === "legacy"
                      ? "Legacy Annual RP Baseline"
                      : data.realPropertySource === "legacy_override"
                        ? "Month-Specific Legacy Override"
                        : "Monthly RP"
                  }`
                : ""}
            </p>
          </div>

          <button
            type="button"
            className="md-secondary-button"
            disabled={loading}
            onClick={onRefresh}
          >
            {loading ? "Refreshing..." : "Refresh"}
          </button>
        </div>

        <div className="md-rp-summary-grid">
          {data.summary.map((row) => {
            const variance = row.variance_percent;

            return (
              <article key={row.utility_type_cd} className="md-rp-summary-card">
                <div className="md-rp-summary-card-heading">
                  <span className="md-rp-utility-code">{row.utility_type_cd}</span>
                  <strong>{row.utility_name}</strong>
                </div>

                <div className="md-rp-metric">
                  <span>Invoice</span>
                  <strong>{rpFormat(row.invoice_consumption)}</strong>
                </div>

                <div className="md-rp-metric">
                  <span>Estimate</span>
                  <strong>{rpFormat(row.estimated_consumption)}</strong>
                </div>

                <div className="md-rp-metric">
                  <span>Difference</span>
                  <strong>
                    {row.difference > 0 ? "+" : ""}
                    {rpFormat(row.difference)}
                  </strong>
                </div>

                <div className="md-rp-metric">
                  <span>Variance</span>
                  <strong>
                    {variance === null
                      ? "—"
                      : `${variance > 0 ? "+" : ""}${variance.toFixed(1)}%`}
                  </strong>
                </div>

                <div className="md-rp-summary-footer">
                  {row.estimate_count.toLocaleString()} estimates • {row.invoice_count.toLocaleString()} invoices
                  {row.invoice_um ? ` • ${row.invoice_um}` : ""}
                </div>
              </article>
            );
          })}
        </div>
      </section>

      {data.sourceChangeStatus?.reconciliationPotentiallyStale ||
      data.sourceChangeStatus?.billsPotentiallyStale ? (
        <div className="md-rp-alert md-rp-alert-error">
          Real Property source data changed on {new Date(data.sourceChangeStatus.changedAt).toLocaleString()}.
          Existing reconciliation and saved bills may be stale; they were not regenerated or overwritten.
        </div>
      ) : null}

      {mutationError ? <div className="md-rp-alert md-rp-alert-error">{mutationError}</div> : null}
      {mutationMessage ? <div className="md-rp-alert md-rp-alert-success">{mutationMessage}</div> : null}

      {draft ? (
        <section className="md-rp-editor">
          <h3>{editingId ? "Edit Real Property Record" : "Create Real Property Record"}</h3>
          <p>Customer and facility assignments use their CUBE IDs. Facility details are resolved from the Facility master.</p>
          <div className="md-rp-editor-grid">
            {[
              ["CustomerID", "Customer ID"],
              ["FacilityID", "Facility ID"],
              ["RPUID", "RPUID"],
              ["AllocationQty", "Allocation Quantity"],
              ["AllocationUM", "Allocation U/M"],
              ["UtilityGroup", "Utility Group"],
            ].map(([field, label]) => (
              <label key={field}>
                <span>{label}</span>
                <input
                  type={field === "AllocationQty" || field === "UtilityGroup" ? "number" : "text"}
                  value={String(draft[field as keyof RealPropertyRecord] ?? "")}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      [field]: event.target.value,
                    }))
                  }
                />
              </label>
            ))}
            <label className="md-rp-category-picker">
              <span>Category Code</span>
              <input
                type="text"
                role="combobox"
                aria-autocomplete="list"
                aria-expanded={categoryCodeSuggestionsOpen && categorySuggestions.length > 0}
                aria-controls="rp-category-code-suggestions"
                aria-activedescendant={categoryCodeSuggestionsOpen && categorySuggestions[highlightedCategoryCodeIndex]
                  ? `rp-category-code-option-${highlightedCategoryCodeIndex}`
                  : undefined}
                value={categorySearchText}
                onFocus={() => setCategoryCodeSuggestionsOpen(true)}
                onBlur={() => setCategoryCodeSuggestionsOpen(false)}
                onChange={(event) => {
                  setDraft((current) => current
                    ? { ...current, CategoryCode: event.target.value }
                    : current);
                  setHighlightedCategoryCodeIndex(0);
                  setCategoryCodeSuggestionsOpen(true);
                  setMutationError("");
                }}
                onKeyDown={(event) => {
                  if (!categoryCodeSuggestionsOpen || categorySuggestions.length === 0) return;
                  if (event.key === "ArrowDown") {
                    event.preventDefault();
                    setHighlightedCategoryCodeIndex((index) => (index + 1) % categorySuggestions.length);
                  } else if (event.key === "ArrowUp") {
                    event.preventDefault();
                    setHighlightedCategoryCodeIndex((index) => (index - 1 + categorySuggestions.length) % categorySuggestions.length);
                  } else if (event.key === "Enter") {
                    event.preventDefault();
                    chooseCategoryCode(categorySuggestions[highlightedCategoryCodeIndex]);
                  } else if (event.key === "Escape") {
                    setCategoryCodeSuggestionsOpen(false);
                  }
                }}
              />
              {categoryCodeSuggestionsOpen && categorySearchText.trim() && (
                <div id="rp-category-code-suggestions" className="md-rp-category-suggestions" role="listbox">
                  {categorySuggestions.length > 0 ? categorySuggestions.map((category, index) => (
                    <button
                      id={`rp-category-code-option-${index}`}
                      key={category.category_cd}
                      type="button"
                      role="option"
                      aria-selected={index === highlightedCategoryCodeIndex}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => chooseCategoryCode(category)}
                    >
                      <strong>{category.category_cd}</strong>
                      <span>{category.category_nm || "Unnamed category"}</span>
                      <small>{category.space_type || `Space Type ${category.space_type_id ?? "—"}`}</small>
                    </button>
                  )) : (
                    <p role="status">No matching Category Codes. Add the approved code under Yearly Data first.</p>
                  )}
                </div>
              )}
              {!categoryCodesLoaded ? <small>Loading valid Category Codes…</small> : null}
              {categoryCodesError ? <small className="md-rp-category-error" role="alert">Category Codes could not be loaded. Saving is blocked until they can be verified.</small> : null}
              {categorySearchText.trim() && !categoryCodesError && categoryCodesLoaded && !categoryCodes.some((category) => category.category_cd === categorySearchText.trim()) ? (
                <small className="md-rp-category-error" role="alert">Choose a Category Code from the suggestions. This code is not in the Category Codes table.</small>
              ) : null}
            </label>
          </div>
          <div className="md-rp-utility-settings">
            <fieldset className="md-rp-utility-group">
              <legend>Utility Calculation</legend>
              <p>ON includes the utility in this record&apos;s individual calculation.</p>
              <div className="md-rp-utility-editor">
                {reimbursementUtilities.map(([utility, label]) => (
                  <label key={utility}>
                    <input
                      type="checkbox"
                      checked={rpNumber(draft[utility]) === 1}
                      onChange={(event) =>
                        setDraft((current) => ({
                          ...current,
                          [utility]: event.target.checked ? 1 : 0,
                        }))
                      }
                    />
                    <span><strong>{utility}</strong> {label}</span>
                  </label>
                ))}
              </div>
            </fieldset>

            <fieldset className="md-rp-utility-group">
              <legend>Utility Reimbursement</legend>
              <p>ON charges the customer; OFF records the charge as CE absorbed.</p>
              <div className="md-rp-reimbursement-grid">
                {reimbursementUtilities.map(([utility, label]) => {
                  const calculationEnabled = rpNumber(draft[utility]) === 1;
                  const explicit = draft.UtilityReimbursementOverrides?.[utility];
                  const customerDefault = customerReimbursementDefault(draft.CustomerID);
                  const effective =
                    typeof explicit === "boolean"
                      ? explicit
                      : customerDefault.reimbursable;
                  return (
                    <div
                      key={utility}
                      className={`md-rp-reimbursement-row${calculationEnabled ? "" : " md-rp-reimbursement-inactive"}`}
                    >
                      <label>
                        <input
                          type="checkbox"
                          checked={effective}
                          disabled={!calculationEnabled}
                          onChange={(event) =>
                            setReimbursementOverride(utility, event.target.checked)
                          }
                        />
                        <span><strong>{utility}</strong> {label}</span>
                      </label>
                      <small>
                        {typeof explicit === "boolean"
                          ? explicit
                            ? "Override: Reimbursable"
                            : "Override: CE absorbed"
                          : `Customer default: ${customerDefault.customerType}`}
                        {!calculationEnabled && typeof explicit === "boolean"
                          ? " (saved but inactive)"
                          : ""}
                      </small>
                      <button
                        type="button"
                        className="md-rp-reset-button"
                        disabled={typeof explicit !== "boolean"}
                        onClick={() => setReimbursementOverride(utility, undefined)}
                      >
                        Reset to Customer Default
                      </button>
                    </div>
                  );
                })}
              </div>
            </fieldset>
          </div>
          <div className="md-action-row">
            <button type="button" className="bd-add-button" disabled={mutating} onClick={prepareSaveConfirmation}>
              {editingId ? "Save Changes" : "Create Record"}
            </button>
            <button type="button" className="md-secondary-button" disabled={mutating} onClick={() => {
              setDraft(null);
              setEditingOriginal(null);
              setEditingId("");
            }}>
              Cancel
            </button>
          </div>
        </section>
      ) : null}

      <div className="md-action-row">
        <label className="bd-search">
          <Search size={18} />
          <input
            type="search"
            placeholder="Search customer, facility, RPUID, category..."
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>

        <span className="md-row-count">
          {filtered.length.toLocaleString()} of {data.realProperty.length.toLocaleString()} RP records • {data.estimates.length.toLocaleString()} estimates
        </span>

        {realPropertyEditable ? (
          <>
            <button type="button" className="bd-add-button" disabled={mutating} onClick={beginCreate}>
              Add Real Property
            </button>
            <button type="button" className="md-secondary-button" disabled={mutating || data.realProperty.length === 0} onClick={prepareDeleteAll}>
              <Trash2 size={16} /> Delete Month ({data.realProperty.length.toLocaleString()})
            </button>
          </>
        ) : null}
      </div>

      <div className="bd-table-panel">
        <div className="bd-table-scroll">
          <table className="bd-table md-rp-table">
            <thead>
              <tr>
                <th>Customer</th>
                <th>Facility</th>
                <th>RP ID</th>
                <th>Category</th>
                <th>Area</th>
                <th>U/M</th>
                <th>EL</th>
                <th>NG</th>
                <th>PW</th>
                <th>SS</th>
                <th>EL Estimate</th>
                <th>NG Estimate</th>
                <th>PW Estimate</th>
                <th>SS Estimate</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={15} className="bd-empty-row">
                    No Real Property records found for {month} FY {fy}.
                  </td>
                </tr>
              ) : (
                filtered.map((row) => {
                  const monthlyRpId = String(row.MonthlyRPID ?? "").trim();
                  const legacyRpId = String(row.LegacyRPID ?? "").trim();
                  const rowKey =
                    monthlyRpId ||
                    legacyRpId ||
                    String(row.RPUID ?? "").trim() ||
                    `${row.FacilityID}-${row.CustomerID}-${row.CategoryCode}`;

                  return (
                    <tr key={rowKey}>
                      <td>
                        {row.CUBECustomerName || row.LegacyCustomerName || row.CustomerID || "—"}
                        {row.CustomerID ? (
                          <div className="md-rp-cell-note">Customer ID: {row.CustomerID}</div>
                        ) : null}
                      </td>
                      <td>
                        {row.FacilityNumber || row.FacilityID || "—"}
                        {row.FacilityID && row.FacilityID !== row.FacilityNumber ? (
                          <div className="md-rp-cell-note">Facility ID: {row.FacilityID}</div>
                        ) : null}
                      </td>
                      <td>
                        {row.RPUID || row.LegacyRPID || row.MonthlyRPID || "—"}
                        {row.RecordSource === "legacy" || row.RecordSource === "legacy_override" ? (
                          <div className="md-rp-cell-note">
                            {row.RecordSource === "legacy_override" ? "Legacy baseline override" : "Legacy RPID"}
                          </div>
                        ) : null}
                      </td>
                      <td>
                        {row.CategoryCode || "—"}
                        {row.CategoryDescription ? (
                          <div className="md-rp-cell-note">{row.CategoryDescription}</div>
                        ) : null}
                      </td>
                      <td>{rpFormat(row.AllocationQty)}</td>
                      <td>{row.AllocationUM || "—"}</td>
                      <td>{rpNumber(row.EL) === 1 ? "Yes" : "—"}</td>
                      <td>{rpNumber(row.NG) === 1 ? "Yes" : "—"}</td>
                      <td>{rpNumber(row.PW) === 1 ? "Yes" : "—"}</td>
                      <td>{rpNumber(row.SS) === 1 ? "Yes" : "—"}</td>
                      <td>{estimateValue(row, "EL")}</td>
                      <td>{estimateValue(row, "NG")}</td>
                      <td>{estimateValue(row, "PW")}</td>
                      <td>{estimateValue(row, "SS")}</td>
                      <td>
                        {realPropertyEditable ? (
                          <div className="md-rp-row-actions">
                            <button type="button" className="md-secondary-button" disabled={mutating} onClick={() => beginEdit(row)}>Edit</button>
                            <button type="button" className="md-secondary-button" disabled={mutating} onClick={() => prepareDeleteRecord(row)}>Delete</button>
                          </div>
                        ) : "—"}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}


function RealPropertyPropQ({
  data,
  realProperty,
  estimates,
  estimatesAvailable,
  fy,
  month,
  billingPeriodId,
  loading,
  error,
  onRefresh,
  onGenerated,
}: {
  data?: PropQPayload;
  realProperty: RealPropertyRecord[];
  estimates: EstimateRecord[];
  estimatesAvailable: boolean;
  fy: string;
  month: string;
  billingPeriodId: string;
  loading: boolean;
  error: string;
  onRefresh: () => void;
  onGenerated: () => void | Promise<void>;
}) {
  type TreeUtility = {
    utility: string;
    estimatedUsage: number;
    facilityEstimatedUsage: number;
    propQ: number;
    status: string;
    record: PropQRecord;
  };

  type TreeArea = {
    key: string;
    rpId: string;
    areaSF: number;
    spaceType: string;
    utilities: TreeUtility[];
  };

  type TreeCategory = {
    key: string;
    categoryCode: string;
    areas: TreeArea[];
  };

  type TreeCustomer = {
    key: string;
    customerId: string;
    customerName: string;
    categories: TreeCategory[];
  };

  type TreeFacility = {
    key: string;
    facilityId: string;
    facilityNumber: string;
    customers: TreeCustomer[];
  };

  const UTILITIES = ["EL", "NG", "PW", "SS"];

  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState("");
  const [search, setSearch] = useState("");
  const [issuesOnly, setIssuesOnly] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [sortBy, setSortBy] = useState<
    "facility" | "customer" | "category" | "area"
  >("facility");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("asc");

  function numeric(value: unknown): number {
    const parsed = Number(
      String(value ?? "")
        .replace(/[$,]/g, "")
        .trim(),
    );

    return Number.isFinite(parsed) ? parsed : 0;
  }

  function pct(value: number): string {
    return `${(value * 100).toFixed(4)}%`;
  }

  function utilityTotals(
    records: TreeUtility[],
  ): Record<string, number> {
    const totals: Record<string, number> = {};

    for (const row of records) {
      totals[row.utility] =
        (totals[row.utility] ?? 0) + row.propQ;
    }

    return totals;
  }

  function allUtilitiesFromFacility(
    facility: TreeFacility,
  ): TreeUtility[] {
    return facility.customers.flatMap((customer) =>
      customer.categories.flatMap((category) =>
        category.areas.flatMap((area) => area.utilities),
      ),
    );
  }

  function allUtilitiesFromCustomer(
    customer: TreeCustomer,
  ): TreeUtility[] {
    return customer.categories.flatMap((category) =>
      category.areas.flatMap((area) => area.utilities),
    );
  }

  function allUtilitiesFromCategory(
    category: TreeCategory,
  ): TreeUtility[] {
    return category.areas.flatMap((area) => area.utilities);
  }

  function isFacilityBalanced(
    facility: TreeFacility,
  ): boolean {
    const rows = allUtilitiesFromFacility(facility);
    const totals = utilityTotals(rows);
    const present = new Set(rows.map((row) => row.utility));

    return Array.from(present).every(
      (utility) =>
        Math.abs((totals[utility] ?? 0) - 1) <= 0.000001,
    );
  }

  function toggle(key: string) {
    setExpanded((current) => {
      const next = new Set(current);

      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }

      return next;
    });
  }

  async function generate(regenerate = false) {
    if (!billingPeriodId || generating) {
      return;
    }

    if (!regenerate && data?.generated) {
      return;
    }

    const confirmed = window.confirm(
      regenerate
        ? `Regenerate PropQ for ${month} FY ${fy} (Billing Period ${billingPeriodId})?\n\n` +
            "For a versioned Real Property month, CUBE will rebuild Estimates from the active records using the current category-to-space-type mappings and intensity values, then replace PropQ. Existing reconciliation and saved bills will be marked potentially stale, not overwritten. SS PropQ records will not be created."
        : `Generate PropQ for ${month} FY ${fy} (Billing Period ${billingPeriodId})?\n\n` +
            "CUBE will calculate each RP record's proportion of projected facility utility consumption from the stored estimates.",
    );

    if (!confirmed) return;

    setGenerating(true);
    setGenerateError("");

    try {
      const response = await fetch(
        "/api/monthly-data/real-property/propq",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            billing_period_id: Number(billingPeriodId),
            ...(regenerate ? { regenerate: true } : {}),
          }),
        },
      );

      const result = await response.json();

      if (!response.ok) {
        throw new Error(
          result?.error ||
            (regenerate
              ? "Unable to regenerate PropQ."
              : "Unable to generate PropQ."),
        );
      }

      await onGenerated();
    } catch (requestError) {
      setGenerateError(
        requestError instanceof Error
          ? requestError.message
          : regenerate
            ? "Unable to regenerate PropQ."
            : "Unable to generate PropQ.",
      );
    } finally {
      setGenerating(false);
    }
  }

  const rpDisplayLookup = useMemo(() => {
    const byMonthlyRpId = new Map<string, RealPropertyRecord>();
    const byLegacyRpId = new Map<string, RealPropertyRecord>();

    for (const row of realProperty) {
      const monthlyRpId =
        String(row.MonthlyRPID ?? "").trim();

      const legacyRpId =
        String(row.LegacyRPID ?? "").trim();

      if (monthlyRpId) {
        byMonthlyRpId.set(monthlyRpId, row);
      }

      if (legacyRpId) {
        byLegacyRpId.set(legacyRpId, row);
      }
    }

    return {
      byMonthlyRpId,
      byLegacyRpId,
    };
  }, [realProperty]);

  const estimateDisplayLookup = useMemo(() => {
    const byEstimateId = new Map<string, EstimateRecord>();

    for (const estimate of estimates) {
      const estimateId = String(estimate.EstimateID ?? "").trim();

      if (estimateId) {
        byEstimateId.set(estimateId, estimate);
      }
    }

    return byEstimateId;
  }, [estimates]);

  const tree = useMemo<TreeFacility[]>(() => {
    const facilityMap = new Map<
      string,
      {
        facilityNumber: string;
        customers: Map<
          string,
          {
            customerName: string;
            categories: Map<
              string,
              Map<string, TreeArea>
            >;
          }
        >;
      }
    >();

    for (const row of data?.records ?? []) {
      const estimateId =
        String(row.EstimateID ?? "").trim();

      const estimate = estimateId
        ? estimateDisplayLookup.get(estimateId)
        : undefined;

      const monthlyRpId =
        String(
          row.MonthlyRPID ??
            estimate?.MonthlyRPID ??
            estimate?.SourceMonthlyRPID ??
            "",
        ).trim();

      const legacyRpId =
        String(
          row.LegacyRPID ??
            estimate?.LegacyRPID ??
            estimate?.SourceLegacyRPID ??
            "",
        ).trim();

      const rp =
        (monthlyRpId
          ? rpDisplayLookup.byMonthlyRpId.get(monthlyRpId)
          : undefined) ??
        (legacyRpId
          ? rpDisplayLookup.byLegacyRpId.get(legacyRpId)
          : undefined);

      const facilityId =
        String(
          rp?.FacilityID ??
            row.FacilityID ??
            "",
        ).trim() || "Unknown Facility";

      const facilityNumber =
        String(
          rp?.FacilityNumber ??
            "",
        ).trim() || facilityId;

      const customerId =
        String(
          rp?.CustomerID ??
            row.CustomerID ??
            "",
        ).trim() || "Unknown Customer";

      const customerName =
        String(
          rp?.CUBECustomerName ??
            rp?.NextGenCustomerName ??
            rp?.LegacyCustomerName ??
            "",
        ).trim() || customerId;

      const categoryCode =
        String(
          rp?.CategoryCode ??
            row.CategoryCode ??
            estimate?.CategoryCode ??
            "",
        ).trim() || "No Category";

      const rpId =
        monthlyRpId ||
        legacyRpId ||
        String(
          row.EstimateID ??
            row.PropQID,
        ).trim();

      const areaSF =
        numeric(
          estimate?.AreaSF ??
            row.AreaSF,
        );

      const spaceType =
        String(
          estimate?.SpaceType ??
            row.SpaceType ??
            "",
        ).trim();

      const areaKey = rpId;

      if (!facilityMap.has(facilityId)) {
        facilityMap.set(facilityId, {
          facilityNumber,
          customers: new Map(),
        });
      }

      const facility =
        facilityMap.get(facilityId)!;

      if (
        facility.facilityNumber === facilityId &&
        facilityNumber !== facilityId
      ) {
        facility.facilityNumber = facilityNumber;
      }

      if (!facility.customers.has(customerId)) {
        facility.customers.set(customerId, {
          customerName,
          categories: new Map(),
        });
      }

      const customer =
        facility.customers.get(customerId)!;

      if (
        customer.customerName === customerId &&
        customerName !== customerId
      ) {
        customer.customerName = customerName;
      }

      if (!customer.categories.has(categoryCode)) {
        customer.categories.set(
          categoryCode,
          new Map(),
        );
      }

      const areaMap =
        customer.categories.get(categoryCode)!;

      if (!areaMap.has(areaKey)) {
        areaMap.set(areaKey, {
          key:
            `area:${facilityId}:${customerId}:${categoryCode}:${areaKey}`,
          rpId,
          areaSF,
          spaceType,
          utilities: [],
        });
      }

      const area =
        areaMap.get(areaKey)!;

      // Area/space type comes from the stored estimate. Do not overwrite it
      // from the RP snapshot because AreaSF is not an RP source field.
      if (estimate || row.AreaSF != null || row.SpaceType) {
        area.areaSF = areaSF;
        area.spaceType = spaceType;
      }

      area.utilities.push({
        utility:
          String(
            row.UtilityType ?? "",
          )
            .trim()
            .toUpperCase(),

        estimatedUsage:
          numeric(
            row.EstimatedUsage,
          ),

        facilityEstimatedUsage:
          numeric(
            row.FacilityEstimatedUsage,
          ),

        propQ:
          numeric(
            row.PropQ,
          ),

        status:
          String(
            row.PropQStatus ?? "",
          ).trim(),

        record:
          row,
      });
    }

    return Array.from(
      facilityMap.entries(),
    )
      .map(
        ([
          facilityId,
          facility,
        ]) => ({
          key:
            `facility:${facilityId}`,

          facilityId,

          facilityNumber:
            facility.facilityNumber,

          customers: Array.from(
            facility.customers.entries(),
          )
            .map(
              ([
                customerId,
                customer,
              ]) => ({
                key:
                  `customer:${facilityId}:${customerId}`,

                customerId,

                customerName:
                  customer.customerName,

                categories:
                  Array.from(
                    customer.categories.entries(),
                  )
                    .map(
                      ([
                        categoryCode,
                        areaMap,
                      ]) => ({
                        key:
                          `category:${facilityId}:${customerId}:${categoryCode}`,

                        categoryCode,

                        areas:
                          Array.from(
                            areaMap.values(),
                          ).sort(
                            (a, b) =>
                              a.areaSF -
                                b.areaSF ||
                              a.rpId.localeCompare(
                                b.rpId,
                                undefined,
                                {
                                  numeric: true,
                                  sensitivity:
                                    "base",
                                },
                              ),
                          ),
                      }),
                    )
                    .sort((a, b) =>
                      a.categoryCode.localeCompare(
                        b.categoryCode,
                        undefined,
                        {
                          numeric: true,
                          sensitivity:
                            "base",
                        },
                      ),
                    ),
              }),
            )
            .sort((a, b) =>
              a.customerName.localeCompare(
                b.customerName,
                undefined,
                {
                  numeric: true,
                  sensitivity:
                    "base",
                },
              ),
            ),
        }),
      )
      .sort((a, b) =>
        a.facilityNumber.localeCompare(
          b.facilityNumber,
          undefined,
          {
            numeric: true,
            sensitivity: "base",
          },
        ),
      );
  }, [
    data?.records,
    rpDisplayLookup,
    estimateDisplayLookup,
  ]);

  const visibleTree = useMemo(() => {
    const query = search.trim().toLowerCase();

    return tree.filter((facility) => {
      if (issuesOnly && isFacilityBalanced(facility)) {
        return false;
      }

      if (!query) {
        return true;
      }

      if (
        facility.facilityId.toLowerCase().includes(query) ||
        facility.facilityNumber.toLowerCase().includes(query)
      ) {
        return true;
      }

      return facility.customers.some((customer) => {
        if (
          customer.customerId.toLowerCase().includes(query) ||
          customer.customerName.toLowerCase().includes(query)
        ) {
          return true;
        }

        return customer.categories.some((category) => {
          if (category.categoryCode.toLowerCase().includes(query)) {
            return true;
          }

          return category.areas.some(
            (area) =>
              area.rpId.toLowerCase().includes(query) ||
              area.spaceType.toLowerCase().includes(query) ||
              String(area.areaSF).includes(query),
          );
        });
      });
    });
  }, [tree, search, issuesOnly]);

  const sortedVisibleTree = useMemo(() => {
    const direction = sortDirection === "asc" ? 1 : -1;
    const compareText = (a: string, b: string) =>
      a.localeCompare(b, undefined, {
        numeric: true,
        sensitivity: "base",
      }) * direction;

    return [...visibleTree]
      .map((facility) => ({
        ...facility,
        customers: [...facility.customers]
          .map((customer) => ({
            ...customer,
            categories: [...customer.categories]
              .map((category) => ({
                ...category,
                areas: [...category.areas].sort((a, b) => {
                  if (sortBy === "area") {
                    return (a.areaSF - b.areaSF) * direction;
                  }
                  return compareText(a.rpId, b.rpId);
                }),
              }))
              .sort((a, b) =>
                sortBy === "category"
                  ? compareText(a.categoryCode, b.categoryCode)
                  : a.categoryCode.localeCompare(b.categoryCode, undefined, {
                      numeric: true,
                      sensitivity: "base",
                    }),
              ),
          }))
          .sort((a, b) =>
            sortBy === "customer"
              ? compareText(a.customerName, b.customerName)
              : a.customerName.localeCompare(b.customerName, undefined, {
                  numeric: true,
                  sensitivity: "base",
                }),
          ),
      }))
      .sort((a, b) =>
        sortBy === "facility"
          ? compareText(a.facilityNumber, b.facilityNumber)
          : a.facilityNumber.localeCompare(b.facilityNumber, undefined, {
              numeric: true,
              sensitivity: "base",
            }),
      );
  }, [visibleTree, sortBy, sortDirection]);

  const allExpandableKeys = useMemo(() => {
    const keys: string[] = [];

    for (const facility of sortedVisibleTree) {
      keys.push(facility.key);

      for (const customer of facility.customers) {
        keys.push(customer.key);

        for (const category of customer.categories) {
          keys.push(category.key);

          for (const area of category.areas) {
            keys.push(area.key);
          }
        }
      }
    }

    return keys;
  }, [sortedVisibleTree]);

  const issueCount = useMemo(
    () => tree.filter((facility) => !isFacilityBalanced(facility)).length,
    [tree],
  );

  if (loading && !data) {
    return <div className="bd-empty">Loading PropQ status...</div>;
  }

  if (error && !data) {
    return (
      <div className="bd-empty">
        {error}
        <div style={{ marginTop: 12 }}>
          <button type="button" className="bd-button" onClick={onRefresh}>
            Retry
          </button>
        </div>
      </div>
    );
  }

  const generated = data?.generated === true;

  function utilityCells(rows: TreeUtility[]) {
    const totals = utilityTotals(rows);
    const present = new Set(rows.map((row) => row.utility));

    return UTILITIES.map((utility) => {
      if (!present.has(utility)) {
        return <td key={utility}>—</td>;
      }

      const total = totals[utility] ?? 0;
      const balanced = Math.abs(total - 1) <= 0.000001;

      return (
        <td key={utility}>
          <span
            title={
              balanced
                ? `${utility} allocation reconciles to 100%.`
                : `${utility} allocation totals ${pct(total)}.`
            }
          >
            {pct(total)}
            {balanced ? " ✓" : ""}
          </span>
        </td>
      );
    });
  }

  return (
    <>
      <section className="md-rp-summary-section">
        <div className="md-invoice-summary-heading">
          <div>
            <span className="md-invoice-summary-eyebrow">
              Real Property Allocation
            </span>
            <h3>Projected Quantity Proportion</h3>
            <p>
              {month} FY {fy} • Billing Period {billingPeriodId || "Not defined"}
            </p>
          </div>

          <button
            type="button"
            className="md-secondary-button"
            disabled={loading}
            onClick={onRefresh}
          >
            {loading ? "Refreshing..." : "Refresh"}
          </button>
        </div>

        <div className="md-rp-summary-grid">
          <article className="md-rp-summary-card">
            <div className="md-rp-summary-card-heading"><strong>Status</strong></div>
            <div className="md-rp-metric">
              <span>PropQ</span>
              <strong>{generated ? "Generated" : "Not Generated"}</strong>
            </div>
          </article>

          <article className="md-rp-summary-card">
            <div className="md-rp-summary-card-heading"><strong>Facilities</strong></div>
            <div className="md-rp-metric">
              <span>Facility Records</span>
              <strong>{tree.length.toLocaleString()}</strong>
            </div>
          </article>

          <article className="md-rp-summary-card">
            <div className="md-rp-summary-card-heading"><strong>PropQ Records</strong></div>
            <div className="md-rp-metric">
              <span>Utility Allocations</span>
              <strong>{(data?.recordCount ?? 0).toLocaleString()}</strong>
            </div>
          </article>

          <article className="md-rp-summary-card">
            <div className="md-rp-summary-card-heading"><strong>Allocation Issues</strong></div>
            <div className="md-rp-metric">
              <span>Facilities</span>
              <strong>{issueCount.toLocaleString()}</strong>
            </div>
          </article>
        </div>
      </section>

      {!generated && (
        <div className="md-action-row">
          <span className="md-row-count">
            {estimatesAvailable
              ? "Estimates are available. PropQ has not been generated for this billing period."
              : "No stored estimates are available for this billing period. Import Real Property first."}
          </span>

          {estimatesAvailable && (
            <button
              type="button"
              className="bd-add-button"
              disabled={generating || !billingPeriodId}
              onClick={() => void generate()}
            >
              {generating ? "Generating PropQ..." : "Generate PropQ"}
            </button>
          )}
        </div>
      )}

      {generateError && <div className="bd-empty">{generateError}</div>}

      {generated && (
        <>
          <div className="md-action-row">
            <span className="md-row-count">
              PropQ is stored for this billing period. Regenerate only when the
              underlying Real Property estimates have changed.
            </span>

            <button
              type="button"
              className="bd-add-button"
              disabled={generating || !billingPeriodId}
              onClick={() => void generate(true)}
            >
              {generating ? "Regenerating PropQ..." : "Regenerate PropQ"}
            </button>
          </div>

          <div className="md-action-row">
            <label className="bd-search">
              <Search size={18} />
              <input
                type="search"
                placeholder="Search facility, customer, category, area, RP ID..."
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </label>

            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <select
                className="bd-select"
                value={sortBy}
                onChange={(event) =>
                  setSortBy(
                    event.target.value as
                      | "facility"
                      | "customer"
                      | "category"
                      | "area",
                  )
                }
                aria-label="Sort PropQ table"
              >
                <option value="facility">Sort: Facility Number</option>
                <option value="customer">Sort: Customer Name</option>
                <option value="category">Sort: Category Code</option>
                <option value="area">Sort: Area</option>
              </select>

              <button
                type="button"
                className="md-secondary-button"
                onClick={() =>
                  setSortDirection((current) =>
                    current === "asc" ? "desc" : "asc",
                  )
                }
              >
                {sortDirection === "asc" ? "Ascending ↑" : "Descending ↓"}
              </button>

              <button
                type="button"
                className="md-secondary-button"
                onClick={() => setExpanded(new Set(allExpandableKeys))}
              >
                Expand All
              </button>

              <button
                type="button"
                className="md-secondary-button"
                onClick={() => setExpanded(new Set())}
              >
                Collapse All
              </button>

              <button
                type="button"
                className="md-secondary-button"
                onClick={() => setIssuesOnly((current) => !current)}
              >
                {issuesOnly ? "Show All" : `Show Issues Only (${issueCount})`}
              </button>
            </div>
          </div>

          <div className="bd-table-panel md-propq-table-panel">
            <div className="bd-table-scroll md-propq-table-scroll">
              <table className="bd-table md-propq-table">
                <thead>
                  <tr>
                    <th>Allocation</th>
                    <th>RP Area SF</th>
                    <th>EL</th>
                    <th>NG</th>
                    <th>PW</th>
                    <th>SS</th>
                  </tr>
                </thead>

                <tbody>
                  {visibleTree.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="bd-empty-row">
                        No PropQ allocation records match the current filters.
                      </td>
                    </tr>
                  ) : (
                    sortedVisibleTree.flatMap((facility) => {
                      const rows: React.ReactNode[] = [];
                      const facilityRows = allUtilitiesFromFacility(facility);
                      const facilityOpen = expanded.has(facility.key);
                      const facilityArea = facility.customers.reduce(
                        (sum, customer) =>
                          sum +
                          customer.categories.reduce(
                            (categorySum, category) =>
                              categorySum +
                              category.areas.reduce(
                                (areaSum, area) => areaSum + area.areaSF,
                                0,
                              ),
                            0,
                          ),
                        0,
                      );

                      rows.push(
                        <tr key={facility.key}>
                          <td className="md-propq-allocation md-propq-level-facility">
                            <button
                              type="button"
                              className="md-secondary-button"
                              onClick={() => toggle(facility.key)}
                            >
                              {facilityOpen ? "▼" : "▶"} Facility {facility.facilityNumber}
                            </button>
                            <span style={{ marginLeft: 8 }}>
                              {facility.customers.length} customer
                              {facility.customers.length === 1 ? "" : "s"}
                            </span>
                          </td>
                          <td className="md-propq-area-cell">{facilityArea.toLocaleString()}</td>
                          {utilityCells(facilityRows)}
                        </tr>,
                      );

                      if (!facilityOpen) return rows;

                      for (const customer of facility.customers) {
                        const customerRows = allUtilitiesFromCustomer(customer);
                        const customerOpen = expanded.has(customer.key);
                        const customerArea = customer.categories.reduce(
                          (sum, category) =>
                            sum +
                            category.areas.reduce(
                              (areaSum, area) => areaSum + area.areaSF,
                              0,
                            ),
                          0,
                        );

                        rows.push(
                          <tr key={customer.key}>
                            <td className="md-propq-allocation md-propq-level-customer">
                              <button
                                type="button"
                                className="md-secondary-button"
                                onClick={() => toggle(customer.key)}
                              >
                                {customerOpen ? "▼" : "▶"} {customer.customerName}
                              </button>
                            </td>
                            <td className="md-propq-area-cell">{customerArea.toLocaleString()}</td>
                            {utilityCells(customerRows)}
                          </tr>,
                        );

                        if (!customerOpen) continue;

                        for (const category of customer.categories) {
                          const categoryRows = allUtilitiesFromCategory(category);
                          const categoryOpen = expanded.has(category.key);
                          const categoryArea = category.areas.reduce(
                            (sum, area) => sum + area.areaSF,
                            0,
                          );

                          rows.push(
                            <tr key={category.key}>
                              <td className="md-propq-allocation md-propq-level-category">
                                <button
                                  type="button"
                                  className="md-secondary-button"
                                  onClick={() => toggle(category.key)}
                                >
                                  {categoryOpen ? "▼" : "▶"} Category {category.categoryCode}
                                </button>
                              </td>
                              <td className="md-propq-area-cell">{categoryArea.toLocaleString()}</td>
                              {utilityCells(categoryRows)}
                            </tr>,
                          );

                          if (!categoryOpen) continue;

                          for (const area of category.areas) {
                            const areaOpen = expanded.has(area.key);

                            rows.push(
                              <tr key={area.key}>
                                <td className="md-propq-allocation md-propq-level-area">
                                  <button
                                    type="button"
                                    className="md-secondary-button"
                                    onClick={() => toggle(area.key)}
                                  >
                                    {areaOpen ? "▼" : "▶"} {area.rpId}
                                  </button>
                                  {area.spaceType ? (
                                    <span style={{ marginLeft: 8 }}>
                                      {area.spaceType}
                                    </span>
                                  ) : null}
                                </td>
                                <td className="md-propq-area-cell">{area.areaSF.toLocaleString()}</td>
                                {utilityCells(area.utilities)}
                              </tr>,
                            );

                            if (!areaOpen) continue;

                            for (const utilityRow of area.utilities) {
                              rows.push(
                                <tr
                                  key={`${area.key}:${utilityRow.utility}:${utilityRow.record.PropQID}`}
                                >
                                  <td className="md-propq-allocation md-propq-level-utility">
                                    {utilityRow.utility}
                                    <span style={{ marginLeft: 8 }}>
                                      Estimate {rpFormat(utilityRow.estimatedUsage)}
                                    </span>
                                  </td>
                                  <td className="md-propq-area-cell">—</td>
                                  {UTILITIES.map((utility) => (
                                    <td key={utility}>
                                      {utility === utilityRow.utility
                                        ? pct(utilityRow.propQ)
                                        : "—"}
                                    </td>
                                  ))}
                                </tr>,
                              );
                            }
                          }
                        }
                      }

                      return rows;
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </>
  );
}


function RealPropertyUpload({
  fy,
  month,
  billingPeriodId,
  existingRecordCount,
  onComplete,
}: {
  fy: string;
  month: string;
  billingPeriodId: string;
  existingRecordCount: number;
  onComplete: () => void | Promise<void>;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [validatedUpload, setValidatedUpload] = useState<{
    replacing: boolean;
    fileName: string;
    existingRecordCount: number;
    replacementRecordCount: number;
    estimateCount: number;
    propQCount: number;
    sourceDataVersion: string;
  } | null>(null);
  const uploadInFlight = useRef(false);

  function formDataFor(
    mode: "validate" | "import" | "replace",
    sourceDataVersion?: string,
  ) {
    if (!file) throw new Error("Choose a Real Property CSV file.");
    const formData = new FormData();
    formData.append("file", file);
    formData.append("fy", fy);
    formData.append("billing_month_nm", month);
    formData.append("billing_period_id", billingPeriodId);
    formData.append("mode", mode);
    if (sourceDataVersion) {
      formData.append("source_data_version", sourceDataVersion);
    }
    if (mode !== "validate") formData.append("confirmed", "true");
    return formData;
  }

  async function upload() {
    if (!file || !billingPeriodId || uploading || uploadInFlight.current) return;

    uploadInFlight.current = true;
    setUploading(true);
    setMessage("");
    setError("");

    try {
      const validationResponse = await fetch("/api/monthly-data/real-property/upload", {
        method: "POST",
        body: formDataFor("validate"),
      });
      const validation = await validationResponse.json();
      if (!validationResponse.ok) {
        const details = Array.isArray(validation?.errors)
          ? ` ${validation.errors.join(" ")}`
          : "";
        throw new Error(`${validation?.error || "Replacement validation failed."}${details}`);
      }

      const replacing = Number(validation.existingRecordCount ?? existingRecordCount) > 0;
      setValidatedUpload({
        replacing,
        fileName: file.name,
        existingRecordCount: Number(validation.existingRecordCount ?? 0),
        replacementRecordCount: Number(validation.realPropertyImported ?? 0),
        estimateCount: Number(validation.estimatesCreated ?? 0),
        propQCount: Number(validation.propQCreated ?? 0),
        sourceDataVersion: String(validation.sourceDataVersion ?? ""),
      });
    } catch (uploadError) {
      setError(
        uploadError instanceof Error
          ? uploadError.message
          : "Unable to import Real Property data.",
      );
    } finally {
      uploadInFlight.current = false;
      setUploading(false);
    }
  }

  async function confirmUpload() {
    if (!validatedUpload || !file || uploading || uploadInFlight.current) return;
    uploadInFlight.current = true;
    setUploading(true);
    setError("");
    setMessage("");
    try {
      const response = await fetch("/api/monthly-data/real-property/upload", {
        method: "POST",
        body: formDataFor(
          validatedUpload.replacing ? "replace" : "import",
          validatedUpload.sourceDataVersion,
        ),
      });
      const result = await response.json();
      if (!response.ok) {
        throw new Error(result?.error || "Unable to import Real Property data.");
      }
      setMessage(
        `${result.replacement ? "Replaced the month with" : "Imported"} ${Number(result.realPropertyImported ?? 0).toLocaleString()} RP records, ${Number(result.estimatesCreated ?? 0).toLocaleString()} estimates, and ${Number(result.propQCreated ?? 0).toLocaleString()} PropQ rows.`,
      );
      setValidatedUpload(null);
      setFile(null);
      await onComplete();
    } catch (uploadError) {
      setError(
        uploadError instanceof Error
          ? uploadError.message
          : "Unable to import Real Property data.",
      );
    } finally {
      uploadInFlight.current = false;
      setUploading(false);
    }
  }

  function cancelValidatedUpload() {
    if (uploading) return;
    setValidatedUpload(null);
    setError("");
    setMessage("Validation passed. No data was changed.");
  }

  return (
    <>
      {validatedUpload ? (
        <RealPropertyConfirmationDialog
          eyebrow={validatedUpload.replacing ? "Validated monthly replacement" : "Validated monthly import"}
          title={validatedUpload.replacing ? `Replace ${month} FY ${fy} Real Property?` : `Import ${month} FY ${fy} Real Property?`}
          description={
            validatedUpload.replacing
              ? `${validatedUpload.replacementRecordCount.toLocaleString()} validated replacement records will become the active snapshot for this billing month.`
              : `${validatedUpload.replacementRecordCount.toLocaleString()} validated records will be imported for this billing month.`
          }
          confirmLabel={validatedUpload.replacing ? "Confirm Replacement" : "Confirm Import"}
          danger={validatedUpload.replacing}
          busy={uploading}
          error={error}
          onCancel={cancelValidatedUpload}
          onConfirm={() => void confirmUpload()}
        >
          <dl className="md-rp-confirmation-identifiers">
            <dt>File</dt><dd>{validatedUpload.fileName}</dd>
            <dt>Billing month</dt><dd>{month} FY {fy}</dd>
            <dt>Billing period</dt><dd>{billingPeriodId}</dd>
            {validatedUpload.replacing ? (
              <><dt>Current records</dt><dd>{validatedUpload.existingRecordCount.toLocaleString()}</dd></>
            ) : null}
            <dt>{validatedUpload.replacing ? "Replacement records" : "Import records"}</dt>
            <dd>{validatedUpload.replacementRecordCount.toLocaleString()}</dd>
            <dt>Estimates</dt><dd>{validatedUpload.estimateCount.toLocaleString()}</dd>
            <dt>PropQ records</dt><dd>{validatedUpload.propQCount.toLocaleString()}</dd>
          </dl>
          {validatedUpload.replacing ? (
            <div className="md-rp-confirmation-warning">
              The file was validated successfully. Confirming will stage the complete replacement and atomically switch the active monthly snapshot. Existing reconciliation and bills will be flagged potentially stale.
            </div>
          ) : null}
        </RealPropertyConfirmationDialog>
      ) : null}

      <div className="md-upload-panel md-rp-upload-panel">
      <div className="md-upload-icon">
        <FileSpreadsheet size={28} />
      </div>

      <h2>Upload NextGen Real Property</h2>
      <p>
        Upload the NextGen monthly Real Property CSV. CUBE resolves the
        customer and facility, maps Category Code to Space Type, applies the FY
        utility intensity, and calculates estimates and PropQ. If the month
        already has data, CUBE validates the complete file before atomically
        switching to the replacement snapshot.
      </p>

      <div className="md-rp-upload-period">
        <span>Target Period</span>
        <strong>
          {month} FY {fy} • Billing Period {billingPeriodId || "Not defined"}
        </strong>
      </div>

      {error ? <div className="md-rp-alert md-rp-alert-error">{error}</div> : null}
      {message ? <div className="md-rp-alert md-rp-alert-success">{message}</div> : null}

      <label className="md-file-picker">
        <Upload size={20} />
        <span>{file ? file.name : "Choose NextGen Real Property CSV"}</span>
        <input
          type="file"
          accept=".csv,text/csv"
          disabled={uploading || validatedUpload !== null}
          onChange={(event) => setFile(event.target.files?.[0] ?? null)}
        />
      </label>

      <button
        type="button"
        className="bd-add-button"
        disabled={!file || !billingPeriodId || uploading || validatedUpload !== null}
        onClick={() => void upload()}
      >
        <Upload size={17} />
        {uploading ? "Validating..." : "Validate Import File"}
      </button>
      </div>
    </>
  );
}

// ============================================================
// MONTHLY SUMMARY
//
// Invoice grouping:
//   utility_group_id 1 = WWYK
//   utility_group_id 2 = TACX
//
// Meter grouping is intentionally based on the authoritative
// p72-CUBE-METERS Sub Installation value:
//   sub_inst_cd WWYK -> group 1 (WWYK)
//   sub_inst_cd SHCZ -> group 1 (WWYK)
//   sub_inst_cd TACX -> group 2 (TACX)
//
// Metered consumption uses adjusted_consumption when present,
// otherwise consumption. AMR and manual readings are both stored
// in the same readings table. Any PENDING/quarantined reading is
// always excluded from Monthly Summary calculations.
// ============================================================

function isMonthlySummaryQuarantined(
  reading: MeterReadingRecord,
): boolean {
  const validationRequired =
    String(reading.validation_required ?? "").trim() === "1";

  const validationStatus =
    String(reading.validation_status ?? "")
      .trim()
      .toUpperCase();

  const validationAction =
    String(reading.validation_action ?? "")
      .trim()
      .toUpperCase();

  return (
    validationRequired ||
    validationStatus === "PENDING" ||
    validationAction.includes("QUARANTINED") ||
    validationAction.includes("INSUFFICIENT_HISTORY") ||
    validationAction.includes("POSSIBLE_METER_RESET")
  );
}

function MonthlySummary({
  invoices,
  readings,
  meterMaster,
  meterCoverage,
  fy,
  month,
  billingPeriodId,
}: {
  invoices: InvoiceRecord[];
  readings: MeterReadingRecord[];
  meterMaster: MeterMasterRecord[];
  meterCoverage: MeterCoverageRecord[];
  fy: string;
  month: string;
  billingPeriodId: string;
}) {
  const [expandedDeltaKey, setExpandedDeltaKey] = useState<string | null>(null);
  const [expandedCoverageKey, setExpandedCoverageKey] = useState<string | null>(null);
  const [summaryView, setSummaryView] = useState<"Consumption" | "Meter Coverage">("Consumption");
  const [showAllMeters, setShowAllMeters] = useState(false);

  const previousPeriod = useMemo(() => {
    const monthIndex = MONTHS.indexOf(month);
    const numericFY = Number(fy);
    const calendarYear = monthIndex >= 9 ? numericFY - 1 : numericFY;
    const date = new Date(Date.UTC(calendarYear, monthIndex - 1, 1));
    const shiftedMonthIndex = date.getUTCMonth();
    const shiftedCalendarYear = date.getUTCFullYear();
    const shiftedFY =
      shiftedMonthIndex >= 9
        ? shiftedCalendarYear + 1
        : shiftedCalendarYear;

    return {
      fy: String(shiftedFY),
      month: MONTHS[shiftedMonthIndex],
    };
  }, [fy, month]);

  const analysis = useMemo(() => {
    const meterLookup = new Map(
      meterMaster.map((meter) => [
        String(meter.meterid ?? "").trim().toUpperCase(),
        meter,
      ]),
    );

    type SummaryBucket = {
      groupId: string;
      installation: string;
      utilityType: string;
      invoiceConsumption: number;
      currentMeteredConsumption: number;
      previousMeteredConsumption: number;
      invoiceRows: number;
      currentMeterCount: number;
      previousMeterCount: number;
      units: Set<string>;
    };

    const buckets = new Map<string, SummaryBucket>();

    function getBucket(groupId: string, utilityType: string) {
      const installation = utilityGroupName(groupId);
      const utility = String(utilityType ?? "").trim() || "Unknown";
      const key = `${groupId}|${utility}`;

      let bucket = buckets.get(key);

      if (!bucket) {
        bucket = {
          groupId,
          installation,
          utilityType: utility,
          invoiceConsumption: 0,
          currentMeteredConsumption: 0,
          previousMeteredConsumption: 0,
          invoiceRows: 0,
          currentMeterCount: 0,
          previousMeterCount: 0,
          units: new Set<string>(),
        };
        buckets.set(key, bucket);
      }

      return bucket;
    }

    invoices.forEach((invoice) => {
      const groupId = String(invoice.utility_group_id ?? "").trim();

      if (groupId !== "1" && groupId !== "2") return;

      const bucket = getBucket(groupId, invoice.utility_type_cd);
      bucket.invoiceConsumption += numberValue(invoice.consumption);
      bucket.invoiceRows += 1;

      const unit = String(invoice.consumption_um ?? "").trim();
      if (unit) bucket.units.add(unit);
    });

    readings.forEach((reading) => {
      // Quarantined readings NEVER participate in Monthly Summary,
      // even when "Show All" is enabled.
      if (isMonthlySummaryQuarantined(reading)) {
        return;
      }

      // For non-quarantined readings, preserve the existing Used toggle.
      if (
        !showAllMeters &&
        String(reading.used_in_calculation ?? "").trim() !== "1"
      ) {
        return;
      }

      const isCurrent =
        String(reading.fy ?? "").trim() === fy &&
        String(reading.billing_month_nm ?? "").trim() === month;

      const isPrevious =
        String(reading.fy ?? "").trim() === previousPeriod.fy &&
        String(reading.billing_month_nm ?? "").trim() === previousPeriod.month;

      if (!isCurrent && !isPrevious) return;

      const master = meterLookup.get(
        String(reading.meterid ?? "").trim().toUpperCase(),
      );
      const subInstallation = String(
        master?.sub_inst_cd || reading.sub_inst_cd || "",
      )
        .trim()
        .toUpperCase();

      const groupId =
        subInstallation === "WWYK" || subInstallation === "SHCZ"
          ? "1"
          : subInstallation === "TACX"
            ? "2"
            : "";

      if (!groupId) return;

      const utilityType =
        String(master?.utility_type_cd ?? "").trim() ||
        String(reading.utility_type_cd ?? "").trim() ||
        "Unknown";

      const adjusted = String(reading.adjusted_consumption ?? "").trim();
      const rawValue = adjusted
        ? numberValue(adjusted)
        : numberValue(reading.consumption);

      const value = summaryMeterConsumption(utilityType, rawValue);
      const bucket = getBucket(groupId, utilityType);

      if (isCurrent) {
        bucket.currentMeteredConsumption += value;
        bucket.currentMeterCount += 1;
      } else {
        bucket.previousMeteredConsumption += value;
        bucket.previousMeterCount += 1;
      }
    });

    const rows = Array.from(buckets.values())
      .map((bucket) => {
        const meterDelta =
          bucket.currentMeteredConsumption -
          bucket.previousMeteredConsumption;

        const meterDeltaPercent =
          bucket.previousMeteredConsumption !== 0
            ? (meterDelta / bucket.previousMeteredConsumption) * 100
            : null;

        return {
          ...bucket,
          unit:
            bucket.utilityType.toUpperCase() === "NG"
              ? "MMBtu"
              : bucket.units.size === 1
                ? Array.from(bucket.units)[0]
                : bucket.units.size > 1
                  ? "Mixed"
                  : "",
          meterDelta,
          meterDeltaPercent,
          nonMeteredPool:
            bucket.invoiceConsumption -
            bucket.currentMeteredConsumption,
        };
      })
      .sort((a, b) => {
        const groupCompare = a.groupId.localeCompare(
          b.groupId,
          undefined,
          { numeric: true },
        );
        if (groupCompare !== 0) return groupCompare;

        return a.utilityType.localeCompare(
          b.utilityType,
          undefined,
          {
            numeric: true,
            sensitivity: "base",
          },
        );
      });

    type MeterDeltaRow = {
      meterid: string;
      facility: string;
      groupId: string;
      installation: string;
      utilityType: string;
      previous: number;
      current: number;
      delta: number;
      deltaPercent: number | null;
      correctionRule: string;
    };

    const currentByMeter = new Map<string, MeterReadingRecord>();
    const previousByMeter = new Map<string, MeterReadingRecord>();

    readings.forEach((reading) => {
      // Keep meter delta drill-down consistent with summary totals.
      // Quarantined readings are never eligible.
      if (isMonthlySummaryQuarantined(reading)) {
        return;
      }

      if (
        !showAllMeters &&
        String(reading.used_in_calculation ?? "").trim() !== "1"
      ) {
        return;
      }

      const meterid = String(reading.meterid ?? "")
        .trim()
        .toUpperCase();
      if (!meterid) return;

      if (
        String(reading.fy ?? "").trim() === fy &&
        String(reading.billing_month_nm ?? "").trim() === month
      ) {
        currentByMeter.set(meterid, reading);
      }

      if (
        String(reading.fy ?? "").trim() === previousPeriod.fy &&
        String(reading.billing_month_nm ?? "").trim() === previousPeriod.month
      ) {
        previousByMeter.set(meterid, reading);
      }
    });

    const meterIds = new Set([
      ...Array.from(currentByMeter.keys()),
      ...Array.from(previousByMeter.keys()),
    ]);

    const meterDeltas: MeterDeltaRow[] = [];

    meterIds.forEach((meterid) => {
      const currentReading = currentByMeter.get(meterid);
      const previousReading = previousByMeter.get(meterid);
      const master = meterLookup.get(meterid);

      const subInstallation = String(
        master?.sub_inst_cd ||
          currentReading?.sub_inst_cd ||
          previousReading?.sub_inst_cd ||
          "",
      )
        .trim()
        .toUpperCase();

      const groupId =
        subInstallation === "WWYK" || subInstallation === "SHCZ"
          ? "1"
          : subInstallation === "TACX"
            ? "2"
            : "";

      if (!groupId) return;

      const utilityType =
        String(master?.utility_type_cd ?? "").trim() ||
        String(currentReading?.utility_type_cd ?? "").trim() ||
        String(previousReading?.utility_type_cd ?? "").trim() ||
        "Unknown";

      function effectiveValue(reading: MeterReadingRecord | undefined) {
        if (!reading) return 0;

        const adjusted = String(reading.adjusted_consumption ?? "").trim();
        const rawValue = adjusted
          ? numberValue(adjusted)
          : numberValue(reading.consumption);

        return summaryMeterConsumption(utilityType, rawValue);
      }

      const previous = effectiveValue(previousReading);
      const current = effectiveValue(currentReading);
      const delta = current - previous;
      const deltaPercent =
        previous !== 0
          ? (delta / previous) * 100
          : null;

      meterDeltas.push({
        meterid,
        facility:
          String(master?.facility_nbr ?? "").trim() ||
          String(currentReading?.facility_nbr ?? "").trim() ||
          String(previousReading?.facility_nbr ?? "").trim(),
        groupId,
        installation: utilityGroupName(groupId),
        utilityType,
        previous,
        current,
        delta,
        deltaPercent,
        correctionRule:
          String(currentReading?.meter_correction_rule_cd ?? "").trim(),
      });
    });

    meterDeltas.sort(
      (a, b) =>
        Math.abs(b.delta) - Math.abs(a.delta),
    );

    return {
      rows,
      meterDeltas,
    };
  }, [
    invoices,
    readings,
    meterMaster,
    fy,
    month,
    previousPeriod,
    showAllMeters,
  ]);

  const installations = ["1", "2"].map((groupId) => {
    const groupRows = analysis.rows.filter(
      (row) => row.groupId === groupId,
    );

    return {
      groupId,
      installation: utilityGroupName(groupId),
      utilityCount: groupRows.length,
      invoiceRows: groupRows.reduce(
        (sum, row) => sum + row.invoiceRows,
        0,
      ),
      meterCount: groupRows.reduce(
        (sum, row) => sum + row.currentMeterCount,
        0,
      ),
    };
  });

  function formatDeltaPercent(value: number | null) {
    if (value === null) return "—";
    return `${value > 0 ? "+" : ""}${value.toFixed(1)}%`;
  }

  return (
    <div className="md-monthly-summary">
      <section className="md-summary-hero">
        <div>
          <span className="md-invoice-summary-eyebrow">
            Monthly Reconciliation
          </span>
          <h2>
            {month} FY {fy}
          </h2>
          <p>
            Invoice consumption minus metered consumption equals the
            non-metered pool. Meter assignment uses the meter master
            Sub Installation value: WWYK and SHCZ are grouped under WWYK;
            TACX is grouped under TACX. By default, only meter readings with
            Used = 1 are included; use the toggle below to show all meter
            readings. Meter deltas compare the selected month with{" "}
            {previousPeriod.month} FY{" "}
            {previousPeriod.fy}.
          </p>
        </div>

        <div className="md-summary-period-card">
          <span>Billing Period ID</span>
          <strong>{billingPeriodId || "Not defined"}</strong>
        </div>
      </section>

      <div className="md-action-row" style={{ gap: 8, flexWrap: "wrap" }}>
        <button
          type="button"
          className={summaryView === "Consumption" ? "bd-add-button" : "md-secondary-button"}
          onClick={() => setSummaryView("Consumption")}
        >
          Consumption Summary
        </button>
        <button
          type="button"
          className={summaryView === "Meter Coverage" ? "bd-add-button" : "md-secondary-button"}
          onClick={() => setSummaryView("Meter Coverage")}
        >
          Meter Coverage
        </button>
      </div>

      {summaryView === "Consumption" && (
        <>
      <div className="md-action-row">
        <label
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 8,
            cursor: "pointer",
          }}
        >
          <input
            type="checkbox"
            checked={showAllMeters}
            onChange={(event) => {
              setShowAllMeters(event.target.checked);
              setExpandedDeltaKey(null);
            }}
          />
          <span>
            {showAllMeters
              ? "Showing all meter readings"
              : "Showing only Used = 1 meter readings"}
          </span>
        </label>
      </div>

      <div className="md-summary-installation-grid">
        {installations.map((installation) => (
          <article
            key={installation.groupId}
            className="md-summary-installation-card"
          >
            <span>Utility Group {installation.groupId}</span>
            <strong>{installation.installation}</strong>
            <div>
              {installation.utilityCount} utility type
              {installation.utilityCount === 1 ? "" : "s"} •{" "}
              {installation.invoiceRows} invoice row
              {installation.invoiceRows === 1 ? "" : "s"} •{" "}
              {installation.meterCount} meter reading
              {installation.meterCount === 1 ? "" : "s"}
            </div>
          </article>
        ))}
      </div>

      <div className="bd-table-panel md-summary-table-panel">
        <div className="bd-table-scroll">
          <table className="bd-table md-summary-table">
            <thead>
              <tr>
                <th>Installation</th>
                <th>Utility</th>
                <th>Invoice</th>
                <th>Previous Metered</th>
                <th>Current Metered</th>
                <th>Meter Delta</th>
                <th>Delta %</th>
                <th>Non-Metered Pool</th>
                <th>UOM</th>
                <th>Meter Count</th>
                <th>Delta Detail</th>
              </tr>
            </thead>

            <tbody>
              {analysis.rows.map((row) => {
                const deltaKey = `${row.groupId}|${row.utilityType}`;
                const expanded = expandedDeltaKey === deltaKey;

                return (
                  <tr key={deltaKey}>
                    <td>
                      <strong>{row.installation}</strong>
                    </td>
                    <td className="bd-id-cell">{row.utilityType}</td>
                    <td>{formatConsumption(row.invoiceConsumption)}</td>
                    <td>
                      {formatConsumption(row.previousMeteredConsumption)}
                    </td>
                    <td>
                      {formatConsumption(row.currentMeteredConsumption)}
                    </td>
                    <td>
                      <strong
                        className={
                          row.meterDelta > 0
                            ? "md-percent-up"
                            : row.meterDelta < 0
                              ? "md-percent-down"
                              : "md-percent-flat"
                        }
                      >
                        {row.meterDelta > 0 ? "+" : ""}
                        {formatConsumption(row.meterDelta)}
                      </strong>
                    </td>
                    <td>{formatDeltaPercent(row.meterDeltaPercent)}</td>
                    <td>
                      <strong
                        className={
                          row.nonMeteredPool < 0
                            ? "md-summary-negative"
                            : "md-summary-pool"
                        }
                      >
                        {formatConsumption(row.nonMeteredPool)}
                      </strong>
                    </td>
                    <td>{row.unit || "—"}</td>
                    <td>
                      {row.currentMeterCount.toLocaleString()}
                      {row.currentMeterCount !== row.previousMeterCount
                        ? ` (${row.previousMeterCount.toLocaleString()} prev)`
                        : ""}
                    </td>
                    <td>
                      <button
                        type="button"
                        className="md-secondary-button"
                        onClick={() =>
                          setExpandedDeltaKey(
                            expanded ? null : deltaKey,
                          )
                        }
                      >
                        {expanded ? "Hide Meters" : "View Meters"}
                      </button>
                    </td>
                  </tr>
                );
              })}

              {analysis.rows.length === 0 && (
                <tr>
                  <td colSpan={13} className="bd-empty-row">
                    No invoice or meter-reading consumption is available for
                    this billing period.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {expandedDeltaKey && (() => {
        const [groupId, utilityType] = expandedDeltaKey.split("|");
        const deltaRows = analysis.meterDeltas.filter(
          (row) =>
            row.groupId === groupId &&
            row.utilityType === utilityType,
        );

        return (
          <section className="md-difference-section">
            <div className="md-difference-heading">
              <div>
                <h3>
                  {utilityGroupName(groupId)} {utilityType} Meter Deltas
                </h3>
                <p>
                  Ranked by absolute month-over-month consumption change.
                  This identifies the meters contributing most to the total
                  metered delta.
                </p>
              </div>

              <span className="md-row-count">
                {deltaRows.length} meters
              </span>
            </div>

            <div className="bd-table-scroll">
              <table className="bd-table">
                <thead>
                  <tr>
                    <th>Meter</th>
                    <th>Facility</th>
                    <th>{previousPeriod.month}</th>
                    <th>{month}</th>
                    <th>Delta</th>
                    <th>Delta %</th>
                    <th>Correction Rule</th>
                  </tr>
                </thead>

                <tbody>
                  {deltaRows.map((row) => (
                    <tr key={`${row.groupId}-${row.utilityType}-${row.meterid}`}>
                      <td className="bd-id-cell">{row.meterid}</td>
                      <td>{row.facility || "—"}</td>
                      <td>{formatConsumption(row.previous)}</td>
                      <td>{formatConsumption(row.current)}</td>
                      <td>
                        <strong
                          className={
                            row.delta > 0
                              ? "md-percent-up"
                              : row.delta < 0
                                ? "md-percent-down"
                                : "md-percent-flat"
                          }
                        >
                          {row.delta > 0 ? "+" : ""}
                          {formatConsumption(row.delta)}
                        </strong>
                      </td>
                      <td>{formatDeltaPercent(row.deltaPercent)}</td>
                      <td>{row.correctionRule || "None"}</td>
                    </tr>
                  ))}

                  {deltaRows.length === 0 && (
                    <tr>
                      <td colSpan={7} className="bd-empty-row">
                        No meter delta records are available.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
        );
      })()}

        </>
      )}

      {summaryView === "Meter Coverage" && (
        <section className="md-difference-section">
          <div className="md-difference-heading">
            <div>
              <h3>Meter Coverage Analysis</h3>
              <p>
                View-only Facility + Utility analysis. FULL requires eligible
                RP area to match facility area. Registry meters with no usable
                reading in the current or prior two months are treated as
                POSSIBLY REMOVED for this analysis only.
              </p>
            </div>
            <span className="md-row-count">
              {meterCoverage.length} facility / utility rows
            </span>
          </div>

          <div className="bd-table-scroll">
            <table className="bd-table">
              <thead>
                <tr>
                  <th>Facility</th>
                  <th>Utility</th>
                  <th>Facility SF</th>
                  <th>Eligible RP SF</th>
                  <th>SF Difference</th>
                  <th>Difference %</th>
                  <th>RP Coverage</th>
                  <th>RP Source</th>
                  <th>Allowed Tolerance</th>
                  <th>SF Check</th>
                  <th>Registry Meters</th>
                  <th>Active Expected</th>
                  <th>Possibly Removed</th>
                  <th>Good Current</th>
                  <th>Meter Consumption</th>
                  <th>Status</th>
                  <th>Nonmetered Eligible</th>
                  <th>Detail</th>
                </tr>
              </thead>
              <tbody>
                {meterCoverage.map((row) => {
                  const key = `${row.facilityId}|${row.utilityType}`;
                  const expanded = expandedCoverageKey === key;

                  return (
                    <Fragment key={key}>
                      <tr>
                        <td>
                          <strong>{row.facilityNumber || row.facilityId}</strong>
                          {row.facilityName ? <div>{row.facilityName}</div> : null}
                        </td>
                        <td className="bd-id-cell">{row.utilityType}</td>
                        <td>{formatConsumption(row.facilityArea)}</td>
                        <td>{formatConsumption(row.eligibleRpArea)}</td>
                        <td>{formatConsumption(row.areaDifference)}</td>
                        <td>
                          {row.areaDifferencePercent === null
                            ? "—"
                            : `${row.areaDifferencePercent >= 0 ? "+" : ""}${row.areaDifferencePercent.toFixed(1)}%`}
                        </td>
                        <td>
                          {row.areaCoveragePercent === null
                            ? "—"
                            : `${row.areaCoveragePercent.toFixed(1)}%`}
                        </td>
                        <td><strong>{row.rpSource}</strong></td>
                        <td>±{row.allowedAreaTolerancePercent.toFixed(0)}%</td>
                        <td><strong>{row.areaToleranceStatus}</strong></td>
                        <td>{row.expectedMeters.length}</td>
                        <td>{row.activeExpectedMeters.length}</td>
                        <td>{row.possiblyRemovedMeters.length}</td>
                        <td>
                          {row.goodMeters.length}
                          {row.badMeters.length > 0
                            ? ` / ${row.badMeters.length} missing current`
                            : ""}
                        </td>
                        <td>{formatConsumption(row.meterConsumption)}</td>
                        <td><strong>{row.coverageStatus}</strong></td>
                        <td><strong>{row.nonMeteredEligible}</strong></td>
                        <td>
                          <button
                            type="button"
                            className="md-secondary-button"
                            onClick={() =>
                              setExpandedCoverageKey(expanded ? null : key)
                            }
                          >
                            {expanded ? "Hide Detail" : "View Detail"}
                          </button>
                        </td>
                      </tr>

                      {expanded && (
                        <tr>
                          <td colSpan={13}>
                            <div style={{ padding: "8px 0" }}>
                              <div style={{ marginBottom: 10 }}>
                                <strong>Registry meters:</strong>{" "}
                                {row.expectedMeters.length
                                  ? row.expectedMeters.join(", ")
                                  : "None"}
                                {" • "}
                                <strong>Active expected:</strong>{" "}
                                {row.activeExpectedMeters.length
                                  ? row.activeExpectedMeters.join(", ")
                                  : "None"}
                                {row.possiblyRemovedMeters.length > 0 && (
                                  <>
                                    {" • "}
                                    <strong>Possibly removed:</strong>{" "}
                                    {row.possiblyRemovedMeters.join(", ")}
                                  </>
                                )}
                              </div>

                              <div className="bd-table-scroll" style={{ marginBottom: 12 }}>
                                <table className="bd-table">
                                  <thead>
                                    <tr>
                                      <th>Meter</th>
                                      <th>Current</th>
                                      <th>Previous</th>
                                      <th>Two Months Prior</th>
                                      <th>Last Good Reading</th>
                                      <th>Coverage State</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {row.meterValidation.map((meter) => (
                                      <tr key={`${key}|meter|${meter.meterId}`}>
                                        <td><strong>{meter.meterId}</strong></td>
                                        <td>{meter.currentGood ? "Good" : "No Good Reading"}</td>
                                        <td>{meter.previousGood ? "Good" : "No Good Reading"}</td>
                                        <td>{meter.twoMonthsPriorGood ? "Good" : "No Good Reading"}</td>
                                        <td>{meter.lastGoodReading}</td>
                                        <td><strong>{meter.state}</strong></td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>

                              <div className="bd-table-scroll">
                                <table className="bd-table">
                                  <thead>
                                    <tr>
                                      <th>Customer</th>
                                      <th>Allocated SF</th>
                                      <th>Usage Flag</th>
                                      <th>PropQ</th>
                                      <th>PropQ Status</th>
                                      <th>Coverage Result</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {row.customers.map((customer, index) => (
                                      <tr key={`${key}|${customer.customerId}|${index}`}>
                                        <td>
                                          <strong>{customer.customerId || "—"}</strong>
                                          {customer.customerName ? (
                                            <div>{customer.customerName}</div>
                                          ) : null}
                                        </td>
                                        <td>{formatConsumption(customer.allocatedArea)}</td>
                                        <td>{customer.usageFlag ? "ON" : "OFF"}</td>
                                        <td>
                                          {customer.propQ === null
                                            ? row.utilityType === "SS"
                                              ? "Derived"
                                              : "—"
                                            : `${(customer.propQ * 100).toFixed(2)}%`}
                                        </td>
                                        <td>
                                          {customer.propQStatus ||
                                            (row.utilityType === "SS"
                                              ? "PW_DERIVED"
                                              : "—")}
                                        </td>
                                        <td>
                                          {row.coverageStatus === "FULL"
                                            ? "Fully metered - should not receive nonmetered allocation"
                                            : row.coverageStatus === "NONMETERED"
                                              ? "Nonmetered"
                                              : "Review before excluding from nonmetered allocation"}
                                        </td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}

                {meterCoverage.length === 0 && (
                  <tr>
                    <td colSpan={11} className="bd-empty-row">
                      No meter coverage records are available for this billing period.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="md-summary-note">
            <strong>View-only:</strong> A registry meter remains ACTIVE if it
            has a usable reading in the current month, previous month, or two
            months prior. If it has no usable reading in all three periods, it
            becomes POSSIBLY REMOVED and is excluded from the effective expected
            meter count. A valid zero-consumption reading still counts as meter
            activity. FULL requires RP area within 1% of facility area and all
            ACTIVE expected meters to have a usable current-period reading.
            Nothing here changes the Meter Registry, PropQ, readings,
            reconciliation, or customer consumption.
          </div>
        </section>
      )}

      {summaryView === "Consumption" && (
      <div className="md-summary-note">
        <strong>Calculation:</strong> Non-Metered Pool = Invoice Consumption −
        Current Metered Consumption. Meter Delta = Current Metered − Previous
        Month Metered. Adjusted meter consumption is used when present;
        otherwise raw meter consumption is used. NG is converted from CF to
        MMBtu for this summary only using 1 CF = 1,031 BTU. The default
        view includes only readings with used_in_calculation = 1. Enable
        "Showing all meter readings" to include Used = 0 readings in the
        summary totals and meter delta analysis.
      </div>
      )}
    </div>
  );
}


// ============================================================
// FACILITY SUMMARY
// Rolling 12-month facility view with 1/3/6/12 month deviations.
// Only used_in_calculation = 1 is included. Adjusted consumption
// is preferred, and NG is converted from CF to MMBtu for display.
// ============================================================
function FacilitySummary({ fy, month, billingPeriodId }: {
  readings: MeterReadingRecord[];
  meterMaster: MeterMasterRecord[];
  fy: string;
  month: string;
  billingPeriodId: string;
}) {
  type PreviewSummary = {
    ReconciliationID: string;
    UtilityGroup: string;
    UtilityType: string;
    ConsumptionUM?: string;
    InvoiceConsumption: number;
    MeteredConsumption: number;
    NonMeteredConsumption: number;
    PumpingReservedConsumption?: number;
    DistributableNonMeteredConsumption?: number;
    AllocatedMeteredConsumption: number;
    UnallocatedMeteredConsumption?: number;
    AllocatedNonMeteredConsumption: number;
    AllocatedDerivedConsumption?: number;
    UnallocatedNonMeteredConsumption?: number;
    AllocatedTotalConsumption: number;
    AccountedConsumption?: number;
    Difference: number;
    ProjectedUsageTotal: number;
    MeterCount: number;
    AllocationRows: number;
    ReconciliationStatus: string;
  };

  type PreviewAllocation = {
    ReconciliationID: string;
    AllocationSource: "METER" | "NONMETERED";
    SourceID: string;
    MeterID?: string;
    UtilityGroup: string;
    UtilityType: string;
    ConsumptionUM?: string;
    FacilityID?: string;
    FacilityNumber?: string;
    CustomerID?: string;
    CustomerName?: string;
    CategoryCode?: string;
    MonthlyRPID?: string;
    ProjectedUsage?: number;
    FacilityPropQ?: number;
    AllocationWeight?: number;
    AllocatedMeteredConsumption?: number;
    AllocatedNonMeteredConsumption?: number;
    AllocatedTotalConsumption?: number;
  };

  type PreviewUnallocatedMeter = {
    ReconciliationID: string;
    RecordType?: string;
    UtilityGroup: string;
    UtilityType: string;
    FacilityNumber?: string;
    MeterID?: string;
    MeterType?: string;
    SourceID?: string;
    SourceConsumption?: number;
    SourceRawConsumption?: number;
    SourceRawUM?: string;
    ConsumptionUM?: string;
    UnallocatedMeteredConsumption?: number;
    UnallocatedReasonCode?: string;
    UnallocatedReason?: string;
    ReconciliationStatus?: string;
  };

  type PreviewPayload = {
    ok: boolean;
    preview?: boolean;
    persisted?: boolean;
    exists?: boolean;
    replacedExistingRecordCount?: number;
    billingPeriodId: number | string;
    generatedAt: string;
    sourceCounts?: {
      invoices: number;
      meterReadings: number;
      includedMeters: number;
      propQ: number;
      realProperty: number;
    };
    issues?: { meter?: string[]; allocation?: string[] };
    summaries: PreviewSummary[];
    allocations: PreviewAllocation[];
    unallocatedMeters?: PreviewUnallocatedMeter[];
  };

  const [preview, setPreview] = useState<PreviewPayload | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [previewError, setPreviewError] = useState("");
  const [saveMessage, setSaveMessage] = useState("");
  const [groupFilter, setGroupFilter] = useState("All");
  const [utilityFilter, setUtilityFilter] = useState("All");
  const [view, setView] = useState<"SUMMARY" | "CUSTOMER" | "CATEGORY" | "DETAIL">("SUMMARY");
  const [expandedSummaryRows, setExpandedSummaryRows] = useState<Set<string>>(new Set());

  async function loadSavedReconciliation() {
    if (!billingPeriodId) {
      setPreview(null);
      return;
    }

    setLoadingPreview(true);
    setPreviewError("");
    setSaveMessage("");

    try {
      const response = await fetch(
        `/api/monthly-data/reconciliation?billing_period_id=${encodeURIComponent(billingPeriodId)}`,
        { cache: "no-store" },
      );
      const result = await response.json();

      if (!response.ok) {
        throw new Error(result?.error || "Unable to load saved reconciliation.");
      }

      setPreview(result?.exists ? (result as PreviewPayload) : null);
    } catch (error) {
      setPreviewError(
        error instanceof Error
          ? error.message
          : "Unable to load saved reconciliation.",
      );
      setPreview(null);
    } finally {
      setLoadingPreview(false);
    }
  }

  useEffect(() => {
    setPreview(null);
    setPreviewError("");
    setSaveMessage("");
    setGroupFilter("All");
    setUtilityFilter("All");
    setView("SUMMARY");
    setExpandedSummaryRows(new Set());

    if (billingPeriodId) {
      void loadSavedReconciliation();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [billingPeriodId]);

  async function saveReconciliation() {
    if (!billingPeriodId || loadingPreview) return;

    setLoadingPreview(true);
    setPreviewError("");
    setSaveMessage("");

    try {
      const response = await fetch("/api/monthly-data/reconciliation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          billing_period_id: Number(billingPeriodId),
        }),
      });

      const result = await response.json();

      if (!response.ok) {
        throw new Error(result?.error || "Unable to save reconciliation.");
      }

      setPreview(result as PreviewPayload);

      const replaced = Number(result?.replacedExistingRecordCount ?? 0);
      setSaveMessage(
        replaced > 0
          ? `Reconciliation regenerated and saved. ${replaced.toLocaleString()} previous records were replaced.`
          : "Reconciliation generated and saved.",
      );
    } catch (error) {
      setPreviewError(
        error instanceof Error
          ? error.message
          : "Unable to save reconciliation.",
      );
    } finally {
      setLoadingPreview(false);
    }
  }

  const allocations = preview?.allocations ?? [];
  const summaries = preview?.summaries ?? [];
  const unallocatedMeters = preview?.unallocatedMeters ?? [];
  const groups = Array.from(new Set(summaries.map(r => String(r.UtilityGroup)))).sort();
  const utilities = Array.from(new Set(summaries.map(r => String(r.UtilityType)))).sort();
  const matches = (r: { UtilityGroup: string; UtilityType: string }) =>
    (groupFilter === "All" || String(r.UtilityGroup) === groupFilter) &&
    (utilityFilter === "All" || String(r.UtilityType) === utilityFilter);
  const shownSummaries = summaries.filter(matches);
  const shownAllocations = allocations.filter(matches);

  type Rollup = {
    key: string; label: string; utilityGroup: string; utilityType: string;
    metered: number; nonmetered: number; total: number; projected: number; rows: number;
  };

  function rollup(mode: "CUSTOMER" | "CATEGORY") {
    const map = new Map<string, Rollup>();
    for (const row of shownAllocations) {
      const identity = mode === "CUSTOMER"
        ? `${String(row.CustomerID ?? "").trim()}|${String(row.CustomerName ?? "").trim()}`
        : String(row.CategoryCode ?? "").trim() || "Unassigned";
      const label = mode === "CUSTOMER"
        ? `${String(row.CustomerID ?? "—").trim() || "—"} • ${String(row.CustomerName ?? "Unknown").trim() || "Unknown"}`
        : identity;
      const key = `${row.UtilityGroup}|${row.UtilityType}|${identity}`;
      let item = map.get(key);
      if (!item) {
        item = { key, label, utilityGroup: row.UtilityGroup, utilityType: row.UtilityType, metered: 0, nonmetered: 0, total: 0, projected: 0, rows: 0 };
        map.set(key, item);
      }
      item.metered += Number(row.AllocatedMeteredConsumption ?? 0);
      item.nonmetered += Number(row.AllocatedNonMeteredConsumption ?? 0);
      item.total += Number(row.AllocatedTotalConsumption ?? 0);
      // ProjectedUsage appears once for METER and once for NONMETERED, so only
      // count it on NONMETERED rows for a clean RP projected-usage rollup.
      if (row.AllocationSource === "NONMETERED") item.projected += Number(row.ProjectedUsage ?? 0);
      item.rows += 1;
    }
    return Array.from(map.values()).sort((a,b) => a.utilityGroup.localeCompare(b.utilityGroup) || a.utilityType.localeCompare(b.utilityType) || a.label.localeCompare(b.label, undefined, { numeric: true }));
  }

  const customerRows = useMemo(() => rollup("CUSTOMER"), [shownAllocations]);
  const categoryRows = useMemo(() => rollup("CATEGORY"), [shownAllocations]);
  type DisplayIssue = {
    type: string;
    code?: string;
    message: string;
    meterId?: string;
    facilityNumber?: string;
    utilityGroup?: string;
    utilityType?: string;
  };

  const structuredUnallocatedIssues: DisplayIssue[] = unallocatedMeters.map((item) => ({
    type: item.UnallocatedReasonCode || "Unallocated Meter",
    code: item.UnallocatedReasonCode || undefined,
    message:
      item.UnallocatedReason ||
      `Meter ${item.MeterID || item.SourceID || "—"} could not be allocated.`,
    meterId: item.MeterID || item.SourceID || undefined,
    facilityNumber: item.FacilityNumber || undefined,
    utilityGroup: String(item.UtilityGroup ?? "").trim() || undefined,
    utilityType: String(item.UtilityType ?? "").trim().toUpperCase() || undefined,
  }));

  const legacyPreviewIssues: DisplayIssue[] = [
    ...(preview?.issues?.meter ?? []).map((message) => ({ type: "Meter", message })),
    ...(preview?.issues?.allocation ?? []).map((message) => ({ type: "Allocation", message })),
  ];

  // The reconciliation route returns unallocatedMeters as structured records.
  // Those records are authoritative for meter allocation exceptions because they
  // already contain the exact Utility Group, Utility Type, Meter, Facility,
  // reason code, and reason text. The legacy issue arrays remain visible in the
  // page-wide issue list for non-meter/general reconciliation warnings.
  const allPreviewIssues: DisplayIssue[] = [
    ...structuredUnallocatedIssues,
    ...legacyPreviewIssues,
  ];
  const issueCount = allPreviewIssues.length;

  function summaryRowIssues(row: PreviewSummary): DisplayIssue[] {
    const group = String(row.UtilityGroup ?? "").trim();
    const utility = String(row.UtilityType ?? "").trim().toUpperCase();

    // First use structured unallocated-meter records. No text matching is needed.
    const structured = structuredUnallocatedIssues.filter(
      (issue) =>
        String(issue.utilityGroup ?? "").trim() === group &&
        String(issue.utilityType ?? "").trim().toUpperCase() === utility,
    );

    // General route issues do not always have structured ownership. Only attach
    // one to a summary line when the text explicitly identifies BOTH the utility
    // group and utility type. This prevents an EL issue from leaking to another
    // utility group.
    const groupName = utilityGroupName(group).trim();
    const escapedGroup = group.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const escapedUtility = utility.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    const legacy = legacyPreviewIssues.filter(({ message }) => {
      const upper = String(message ?? "").toUpperCase();
      const groupMatch =
        (group && new RegExp(`(^|[^A-Z0-9])${escapedGroup}([^A-Z0-9]|$)`, "i").test(upper)) ||
        (groupName && upper.includes(groupName.toUpperCase()));
      const utilityMatch =
        utility &&
        new RegExp(`(^|[^A-Z0-9])${escapedUtility}([^A-Z0-9]|$)`, "i").test(upper);
      return Boolean(groupMatch && utilityMatch);
    });

    return [...structured, ...legacy];
  }

  function toggleSummaryRow(key: string) {
    setExpandedSummaryRows((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  return (
    <div className="md-monthly-summary">
      <section className="md-summary-hero">
        <div>
          <span className="md-invoice-summary-eyebrow">Monthly Reconciliation</span>
          <h2>{month} FY {fy} Facility Allocation</h2>
          <p>
            Generate Reconciliation calculates the billing-period allocation and saves the resulting snapshot to p72-CUBE-MONTHLY-RECONCILIATION. Regenerating replaces the existing snapshot for the selected billing period.
          </p>
        </div>
        <div className="md-summary-period-card">
          <span>Selected Billing Period</span>
          <strong>{billingPeriodId || "Not defined"}</strong>
          <small style={{ display: "block", marginTop: 6 }}>
            {preview ? "SAVED SNAPSHOT" : "NO SAVED SNAPSHOT"}
          </small>
        </div>
      </section>

      <div className="md-action-row">
        <div className="md-period-controls">
          <label><span>Utility Group</span><select value={groupFilter} onChange={e=>setGroupFilter(e.target.value)}><option value="All">All Groups</option>{groups.map(g=><option key={g} value={g}>{utilityGroupName(g)}</option>)}</select></label>
          <label><span>Utility Type</span><select value={utilityFilter} onChange={e=>setUtilityFilter(e.target.value)}><option value="All">All Utilities</option>{utilities.map(u=><option key={u} value={u}>{u}</option>)}</select></label>
        </div>
        <button
          type="button"
          className="bd-add-button"
          disabled={!billingPeriodId || loadingPreview}
          onClick={() => void saveReconciliation()}
        >
          {loadingPreview
            ? "Working..."
            : preview
              ? "Regenerate Reconciliation"
              : "Generate Reconciliation"}
        </button>
      </div>

      {previewError ? <div className="md-rp-alert md-rp-alert-error">{previewError}</div> : null}

      {saveMessage ? (
        <div className="md-rp-alert md-rp-alert-success">{saveMessage}</div>
      ) : null}

      {!preview && !loadingPreview ? (
        <div className="bd-empty">
          No saved reconciliation exists for this billing period. Select Generate Reconciliation to calculate and save it.
        </div>
      ) : null}

      {preview ? <>
        <div className="md-rp-summary-grid">
          <article className="md-rp-summary-card"><div className="md-rp-summary-card-heading"><strong>Mode</strong></div><div className="md-rp-metric"><span>Persistence</span><strong>Saved Snapshot</strong></div></article>
          <article className="md-rp-summary-card"><div className="md-rp-summary-card-heading"><strong>Included Meters</strong></div><div className="md-rp-metric"><span>Used = 1</span><strong>{Number(preview.sourceCounts?.includedMeters ?? 0).toLocaleString()}</strong></div></article>
          <article className="md-rp-summary-card"><div className="md-rp-summary-card-heading"><strong>Allocation Rows</strong></div><div className="md-rp-metric"><span>Calculated</span><strong>{allocations.length.toLocaleString()}</strong></div></article>
          <article className="md-rp-summary-card"><div className="md-rp-summary-card-heading"><strong>Issues</strong></div><div className="md-rp-metric"><span>Exceptions</span><strong>{issueCount.toLocaleString()}</strong></div></article>
        </div>

        <SubTabs options={[{value:"SUMMARY",label:"Group Summary"},{value:"CUSTOMER",label:"By Customer"},{value:"CATEGORY",label:"By Category Code"},{value:"DETAIL",label:"Allocation Detail"}]} active={view} onChange={v=>setView(v as typeof view)} />

        {view === "SUMMARY" && (
          <div className="bd-table-panel md-summary-table-panel">
            <div className="bd-table-scroll">
              <table className="bd-table md-summary-table">
                <thead>
                  <tr>
                    <th style={{ width: 44 }}></th>
                    <th>Group</th>
                    <th>Utility</th>
                    <th>Invoice</th>
                    <th>Metered</th>
                    <th>Original Nonmetered Pool</th>
                    <th>Pumping Reserved</th>
                    <th>Distributable Nonmetered</th>
                    <th>Allocated Metered</th>
                    <th>Allocated Nonmetered</th>
                    <th>Allocated Total</th>
                    <th>Difference</th>
                    <th>UOM</th>
                    <th>Issues</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {shownSummaries.map((r) => {
                    const rowKey = String(r.ReconciliationID);
                    const isExpanded = expandedSummaryRows.has(rowKey);
                    const rowIssues = summaryRowIssues(r);
                    const unallocatedMetered =
                      Number(r.MeteredConsumption ?? 0) -
                      Number(r.AllocatedMeteredConsumption ?? 0);
                    const accountedConsumption = displayAccountedConsumption(r);
                    const pumpingReserved =
                      displayPumpingReservedConsumption(r);
                    const distributableNonMetered =
                      displayDistributableNonMeteredConsumption(r);

                    return (
                      <Fragment key={rowKey}>
                        <tr
                          onClick={() => toggleSummaryRow(rowKey)}
                          style={{ cursor: "pointer" }}
                          aria-expanded={isExpanded}
                        >
                          <td>
                            <button
                              type="button"
                              className="md-secondary-button"
                              onClick={(event) => {
                                event.stopPropagation();
                                toggleSummaryRow(rowKey);
                              }}
                              aria-label={`${isExpanded ? "Collapse" : "Expand"} ${utilityGroupName(r.UtilityGroup)} ${r.UtilityType}`}
                              style={{ minWidth: 32, padding: "4px 8px" }}
                            >
                              {isExpanded ? "▼" : "▶"}
                            </button>
                          </td>
                          <td><strong>{utilityGroupName(r.UtilityGroup)}</strong></td>
                          <td>{r.UtilityType}</td>
                          <td>{formatConsumption(Number(r.InvoiceConsumption ?? 0))}</td>
                          <td>{formatConsumption(Number(r.MeteredConsumption ?? 0))}</td>
                          <td>{formatConsumption(Number(r.NonMeteredConsumption ?? 0))}</td>
                          <td>{formatConsumption(pumpingReserved)}</td>
                          <td>{formatConsumption(distributableNonMetered)}</td>
                          <td>{formatConsumption(Number(r.AllocatedMeteredConsumption ?? 0))}</td>
                          <td>{formatConsumption(Number(r.AllocatedNonMeteredConsumption ?? 0))}</td>
                          <td><strong>{formatConsumption(Number(r.AllocatedTotalConsumption ?? 0))}</strong></td>
                          <td>{formatConsumption(Number(r.Difference ?? 0))}</td>
                          <td>{r.ConsumptionUM || "—"}</td>
                          <td>
                            <strong>
                              {rowIssues.length > 0 ? `⚠ ${rowIssues.length}` : "✓ 0"}
                            </strong>
                          </td>
                          <td><strong>{r.ReconciliationStatus}</strong></td>
                        </tr>

                        {isExpanded && (
                          <tr className="md-reconciliation-expanded-row">
                            <td colSpan={15} style={{ padding: 0 }}>
                              <div
                                style={{
                                  padding: "18px 22px",
                                  background: "#f8fafc",
                                  borderTop: "1px solid #e5e7eb",
                                  borderBottom: "1px solid #e5e7eb",
                                }}
                              >
                                <div
                                  style={{
                                    display: "flex",
                                    justifyContent: "space-between",
                                    gap: 16,
                                    alignItems: "flex-start",
                                    flexWrap: "wrap",
                                    marginBottom: 16,
                                  }}
                                >
                                  <div>
                                    <strong style={{ fontSize: 16 }}>
                                      {utilityGroupName(r.UtilityGroup)} — {r.UtilityType}
                                    </strong>
                                    <div style={{ marginTop: 4, color: "#6b7280" }}>
                                      Reconciliation detail for this utility line
                                    </div>
                                  </div>
                                  <strong>{r.ReconciliationStatus}</strong>
                                </div>

                                <div
                                  style={{
                                    display: "grid",
                                    gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))",
                                    gap: 10,
                                    marginBottom: 18,
                                  }}
                                >
                                  <div><span>Invoice Consumption</span><br /><strong>{formatConsumption(Number(r.InvoiceConsumption ?? 0))} {r.ConsumptionUM || ""}</strong></div>
                                  <div><span>Metered Consumption</span><br /><strong>{formatConsumption(Number(r.MeteredConsumption ?? 0))} {r.ConsumptionUM || ""}</strong></div>
                                  <div><span>Allocated Metered</span><br /><strong>{formatConsumption(Number(r.AllocatedMeteredConsumption ?? 0))} {r.ConsumptionUM || ""}</strong></div>
                                  <div><span>Unallocated Metered</span><br /><strong>{formatConsumption(unallocatedMetered)} {r.ConsumptionUM || ""}</strong></div>
                                  <div><span>Original Nonmetered Pool</span><br /><strong>{formatConsumption(Number(r.NonMeteredConsumption ?? 0))} {r.ConsumptionUM || ""}</strong></div>
                                  <div><span>Pumping Reserved</span><br /><strong>{formatConsumption(pumpingReserved)} {r.ConsumptionUM || ""}</strong></div>
                                  <div><span>Distributable Nonmetered Pool</span><br /><strong>{formatConsumption(distributableNonMetered)} {r.ConsumptionUM || ""}</strong></div>
                                  <div><span>Allocated Nonmetered</span><br /><strong>{formatConsumption(Number(r.AllocatedNonMeteredConsumption ?? 0))} {r.ConsumptionUM || ""}</strong></div>
                                  <div><span>Accounted Consumption</span><br /><strong>{formatConsumption(accountedConsumption)} {r.ConsumptionUM || ""}</strong></div>
                                  <div><span>Difference</span><br /><strong>{formatConsumption(Number(r.Difference ?? 0))} {r.ConsumptionUM || ""}</strong></div>
                                </div>

                                <div>
                                  <strong>
                                    {rowIssues.length > 0
                                      ? `Exceptions (${rowIssues.length})`
                                      : "Exceptions"}
                                  </strong>

                                  {rowIssues.length > 0 ? (
                                    <div style={{ marginTop: 8, display: "grid", gap: 8 }}>
                                      {rowIssues.map((issue, index) => (
                                        <div
                                          key={`${rowKey}-${issue.type}-${index}`}
                                          className="md-summary-note"
                                          style={{ margin: 0 }}
                                        >
                                          <div>
                                            <strong>⚠ {issue.code || issue.type}</strong>
                                            {(issue.meterId || issue.facilityNumber) && (
                                              <div style={{ marginTop: 4, color: "#4b5563" }}>
                                                {issue.meterId ? `Meter: ${issue.meterId}` : ""}
                                                {issue.meterId && issue.facilityNumber ? " • " : ""}
                                                {issue.facilityNumber ? `Facility: ${issue.facilityNumber}` : ""}
                                              </div>
                                            )}
                                            <div style={{ marginTop: 4 }}>{issue.message}</div>
                                          </div>
                                        </div>
                                      ))}
                                    </div>
                                  ) : (
                                    <div style={{ marginTop: 8, color: "#6b7280" }}>
                                      No structured exceptions are associated with this utility line.
                                    </div>
                                  )}
                                </div>
                              </div>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}

                  {!shownSummaries.length && (
                    <tr>
                      <td colSpan={13} className="bd-empty-row">
                        No reconciliation summary rows match the selected filters.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {(view === "CUSTOMER" || view === "CATEGORY") && (()=>{const data=view==="CUSTOMER"?customerRows:categoryRows;return <div className="bd-table-panel md-summary-table-panel"><div className="bd-table-scroll"><table className="bd-table"><thead><tr><th>{view==="CUSTOMER"?"Customer":"Category Code"}</th><th>Group</th><th>Utility</th><th>Projected Usage</th><th>Allocated Metered</th><th>Allocated Nonmetered</th><th>Total Allocated</th></tr></thead><tbody>{data.map(r=><tr key={r.key}><td><strong>{r.label}</strong></td><td>{utilityGroupName(r.utilityGroup)}</td><td>{r.utilityType}</td><td>{formatConsumption(r.projected)}</td><td>{formatConsumption(r.metered)}</td><td>{formatConsumption(r.nonmetered)}</td><td><strong>{formatConsumption(r.total)}</strong></td></tr>)}{!data.length&&<tr><td colSpan={7} className="bd-empty-row">No allocation rows match the selected filters.</td></tr>}</tbody></table></div></div>})()}

        {view === "DETAIL" && <div className="bd-table-panel md-summary-table-panel"><div className="bd-table-scroll"><table className="bd-table"><thead><tr><th>Source</th><th>Source ID</th><th>Group</th><th>Utility</th><th>Facility</th><th>Customer</th><th>Category</th><th>Weight</th><th>Projected</th><th>Allocated</th><th>UOM</th></tr></thead><tbody>{shownAllocations.map(r=><tr key={r.ReconciliationID}><td><strong>{r.AllocationSource}</strong></td><td className="bd-id-cell">{r.MeterID||r.SourceID||"—"}</td><td>{utilityGroupName(r.UtilityGroup)}</td><td>{r.UtilityType}</td><td>{r.FacilityNumber||r.FacilityID||"—"}</td><td>{r.CustomerID||"—"}</td><td>{r.CategoryCode||"—"}</td><td>{((Number(r.AllocationWeight??0))*100).toFixed(4)}%</td><td>{formatConsumption(Number(r.ProjectedUsage??0))}</td><td><strong>{formatConsumption(Number(r.AllocatedTotalConsumption??0))}</strong></td><td>{r.ConsumptionUM||"—"}</td></tr>)}{!shownAllocations.length&&<tr><td colSpan={11} className="bd-empty-row">No allocation rows match the selected filters.</td></tr>}</tbody></table></div></div>}

        {issueCount > 0 && (
          <section className="md-difference-section">
            <div className="md-difference-heading">
              <div>
                <h3>All Preview Issues</h3>
                <p>
                  Exceptions are also shown inside expandable Group Summary rows
                  when they can be matched to that utility line.
                </p>
              </div>
              <span className="md-row-count">{issueCount} issues</span>
            </div>
            <div className="md-summary-note">
              {allPreviewIssues.map((issue, i) => (
                <div key={`${i}-${issue.type}-${issue.message}`}>
                  <strong>{issue.type}:</strong> {issue.message}
                </div>
              ))}
            </div>
          </section>
        )}

        <div className="md-summary-note"><strong>Saved reconciliation:</strong> Generate Reconciliation writes the selected billing period to p72-CUBE-MONTHLY-RECONCILIATION. Regenerate Reconciliation replaces the existing billing-period snapshot with newly calculated SUMMARY, ALLOCATION, and UNALLOCATED_METER records.</div>
      </> : null}
    </div>
  );
}

// ============================================================
// SUB TABS
// ============================================================

type PlantUnitRecord = {
  PlantUnitID: string;
  billing_period_id: string;
  fy: string;
  billing_month_nm: string;
  plant_id: string;
  plant_unit: string;
  produced_utility_type_cd: string;
  total_production: number | string;
  unit_capacity_um: string;
  utility_group_id: string;
  distribution_system: string;
};

function PlantUnitEntry({
  fy,
  month,
  billingPeriodId,
}: {
  fy: string;
  month: string;
  billingPeriodId: string;
}) {
  const [records, setRecords] = useState<PlantUnitRecord[]>([]);
  const [utilityGroupId, setUtilityGroupId] = useState("1");
  const [totalProduction, setTotalProduction] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const periodId = String(billingPeriodId ?? "").trim();

  async function loadPlantUnits() {
    if (!periodId) {
      setRecords([]);
      return;
    }

    setLoading(true);
    setError("");

    try {
      const response = await fetch(
        `/api/monthly-data/plant-unit?billing_period_id=${encodeURIComponent(periodId)}`,
        { cache: "no-store" },
      );
      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.error || "Unable to load Plant Unit data.");
      }

      setRecords(Array.isArray(result.records) ? result.records : []);
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : "Unable to load Plant Unit data.",
      );
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadPlantUnits();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [periodId]);

  async function savePlantUnit() {
    const production = Number(totalProduction.replace(/,/g, "").trim());

    if (!periodId) {
      setError("Billing Period ID is required.");
      return;
    }

    if (!Number.isFinite(production) || production < 0) {
      setError("Enter a valid PW production value in KGAL.");
      return;
    }

    setSaving(true);
    setError("");
    setMessage("");

    try {
      const response = await fetch("/api/monthly-data/plant-unit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          billing_period_id: periodId,
          fy,
          billing_month_nm: month,
          plant_id: "16",
          plant_unit: "WATER WELLS COMBINED",
          produced_utility_type_cd: "PW",
          total_production: production,
          unit_capacity_um: "KGAL",
          utility_group_id: utilityGroupId,
          distribution_system: "WATER WELLS COMBINED",
        }),
      });
      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.error || "Unable to save Plant Unit production.");
      }

      setTotalProduction("");
      setMessage("PW production saved successfully.");
      await loadPlantUnits();
    } catch (saveError) {
      setError(
        saveError instanceof Error
          ? saveError.message
          : "Unable to save Plant Unit production.",
      );
    } finally {
      setSaving(false);
    }
  }

  async function deletePlantUnit(record: PlantUnitRecord) {
    if (!window.confirm("Delete this Plant Unit production entry?")) return;

    setDeletingId(record.PlantUnitID);
    setError("");
    setMessage("");

    try {
      const response = await fetch(
        `/api/monthly-data/plant-unit?plant_unit_id=${encodeURIComponent(record.PlantUnitID)}`,
        { method: "DELETE" },
      );
      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.error || "Unable to delete Plant Unit production.");
      }

      setMessage("Plant Unit production deleted.");
      await loadPlantUnits();
    } catch (deleteError) {
      setError(
        deleteError instanceof Error
          ? deleteError.message
          : "Unable to delete Plant Unit production.",
      );
    } finally {
      setDeletingId("");
    }
  }

  const totalSavedProduction = records.reduce(
    (sum, record) =>
      sum + numberValue(String(record.total_production ?? "0")),
    0,
  );

  return (
    <div className="md-plant-unit">
      <section className="md-plant-unit-hero">
        <div>
          <span className="md-plant-unit-eyebrow">Plant Production</span>
          <h2>Produced Water Entry</h2>
          <p>
            Record monthly PW production in KGAL for the selected billing
            period.
          </p>
        </div>

        <div className="md-plant-unit-period">
          <span>Billing Period</span>
          <strong>{periodId || "Not defined"}</strong>
          <small>
            {month} · FY {fy}
          </small>
        </div>
      </section>

      <section className="md-plant-unit-summary">
        <article>
          <span>Utility</span>
          <strong>PW</strong>
          <small>Produced Water</small>
        </article>

        <article>
          <span>Plant</span>
          <strong>16</strong>
          <small>Water Wells Combined</small>
        </article>

        <article>
          <span>Saved Production</span>
          <strong>{formatConsumption(totalSavedProduction)}</strong>
          <small>KGAL this billing period</small>
        </article>
      </section>

      <section className="md-plant-unit-card">
        <div className="md-plant-unit-card-heading">
          <div>
            <span className="md-plant-unit-eyebrow">New Entry</span>
            <h3>PW Production</h3>
            <p>
              Select the utility group and enter the total plant production for
              this billing period.
            </p>
          </div>

          <span className="md-plant-unit-uom-badge">KGAL</span>
        </div>

        <div className="md-plant-unit-form">
          <label>
            <span>Utility Group</span>
            <select
              value={utilityGroupId}
              onChange={(event) => setUtilityGroupId(event.target.value)}
            >
              <option value="1">WWYK</option>
              <option value="2">TACX</option>
            </select>
          </label>

          <label className="md-plant-unit-production-input">
            <span>Total Production</span>
            <div className="md-plant-unit-input-wrap">
              <input
                type="number"
                min="0"
                step="0.001"
                value={totalProduction}
                placeholder="0.000"
                onChange={(event) => setTotalProduction(event.target.value)}
              />
              <span>KGAL</span>
            </div>
          </label>

          <div className="md-plant-unit-readonly">
            <span>Plant Unit</span>
            <strong>WATER WELLS COMBINED</strong>
          </div>

          <div className="md-plant-unit-readonly">
            <span>Distribution System</span>
            <strong>WATER WELLS COMBINED</strong>
          </div>
        </div>

        <div className="md-plant-unit-save-row">
          <div>
            {message && (
              <span className="md-plant-unit-success">{message}</span>
            )}
            {error && <span className="md-plant-unit-error">{error}</span>}
          </div>

          <button
            type="button"
            className="md-plant-unit-save-button"
            disabled={saving || !periodId}
            onClick={() => void savePlantUnit()}
          >
            {saving ? "Saving..." : "Save PW Production"}
          </button>
        </div>
      </section>

      <section className="md-plant-unit-card md-plant-unit-records-card">
        <div className="md-plant-unit-card-heading">
          <div>
            <span className="md-plant-unit-eyebrow">Billing Period Records</span>
            <h3>Saved Plant Production</h3>
            <p>
              Production entries currently stored for {month} FY {fy}.
            </p>
          </div>

          <span className="md-plant-unit-count">
            {records.length.toLocaleString()}{" "}
            {records.length === 1 ? "record" : "records"}
          </span>
        </div>

        {loading ? (
          <div className="md-plant-unit-empty">Loading production data...</div>
        ) : records.length === 0 ? (
          <div className="md-plant-unit-empty">
            <strong>No production entered yet</strong>
            <span>
              Add PW production above to create the first record for this
              billing period.
            </span>
          </div>
        ) : (
          <div className="bd-table-wrap">
            <table className="bd-table md-plant-unit-table">
              <thead>
                <tr>
                  <th>Utility Group</th>
                  <th>Utility</th>
                  <th>Plant ID</th>
                  <th>Plant Unit</th>
                  <th>Total Production</th>
                  <th>UOM</th>
                  <th>Distribution System</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {records.map((record) => (
                  <tr key={record.PlantUnitID}>
                    <td>
                      <span className="md-plant-unit-group-badge">
                        {utilityGroupName(record.utility_group_id)}
                      </span>
                    </td>
                    <td>
                      <strong>{record.produced_utility_type_cd}</strong>
                    </td>
                    <td>{record.plant_id}</td>
                    <td>{record.plant_unit}</td>
                    <td className="md-plant-unit-number">
                      {formatConsumption(
                        numberValue(String(record.total_production ?? "0")),
                      )}
                    </td>
                    <td>{record.unit_capacity_um}</td>
                    <td>{record.distribution_system}</td>
                    <td>
                      <button
                        type="button"
                        className="bd-icon-button"
                        disabled={deletingId === record.PlantUnitID}
                        title="Delete Plant Unit production"
                        onClick={() => void deletePlantUnit(record)}
                      >
                        <Trash2 size={16} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function SubTabs({
  options,
  active,
  onChange,
}: {
  options: {
    value:
      string;

    label:
      string;
  }[];

  active:
    string;

  onChange:
    (
      value:
        string,
    ) => void;
}) {
  return (
    <div className="md-subtabs">
      {options.map(
        (
          option,
        ) => (
          <button
            key={
              option.value
            }
            type="button"
            className={
              active ===
              option.value
                ? "md-subtab md-subtab-active"
                : "md-subtab"
            }
            onClick={() =>
              onChange(
                option.value,
              )
            }
          >
            {
              option.label
            }
          </button>
        ),
      )}
    </div>
  );
}

// ============================================================
// PAGINATION
// ============================================================

function Pagination({
  page,
  pageSize,
  total,
  setPage,
  setPageSize,
}: {
  page:
    number;

  pageSize:
    number;

  total:
    number;

  setPage:
    (
      page:
        number,
    ) => void;

  setPageSize:
    (
      size:
        number,
    ) => void;
}) {
  const totalPages =
    Math.max(
      1,
      Math.ceil(
        total /
          pageSize,
      ),
    );

  return (
    <div className="md-pagination">
      <div>
        Showing{" "}
        {total ===
        0
          ? 0
          : page *
              pageSize +
            1}
        –
        {Math.min(
          (
            page +
            1
          ) *
            pageSize,
          total,
        )}{" "}
        of {total}
      </div>

      <div className="md-pagination-controls">
        <select
          value={
            pageSize
          }
          onChange={(
            event,
          ) => {
            setPageSize(
              Number(
                event.target
                  .value,
              ),
            );

            setPage(
              0,
            );
          }}
        >
          <option value="50">
            50 rows
          </option>

          <option value="100">
            100 rows
          </option>

          <option value="250">
            250 rows
          </option>
        </select>

        <button
          type="button"
          disabled={
            page === 0
          }
          onClick={() =>
            setPage(
              Math.max(
                0,
                page - 1,
              ),
            )
          }
        >
          <ChevronLeft
            size={17}
          />
        </button>

        <span>
          Page{" "}
          {page + 1} of{" "}
          {totalPages}
        </span>

        <button
          type="button"
          disabled={
            page + 1 >=
            totalPages
          }
          onClick={() =>
            setPage(
              Math.min(
                totalPages - 1,
                page + 1,
              ),
            )
          }
        >
          <ChevronRight
            size={17}
          />
        </button>
      </div>
    </div>
  );
}

// ============================================================
// INVOICE TABLE
// ============================================================

function InvoiceTable({
  invoices,
  setInvoices,
}: {
  invoices:
    InvoiceRecord[];
  setInvoices:
    Dispatch<
      SetStateAction<
        InvoiceRecord[]
      >
    >;
}) {
  const [
    search,
    setSearch,
  ] =
    useState("");

  const [
    page,
    setPage,
  ] =
    useState(
      0,
    );

  const [
    pageSize,
    setPageSize,
  ] =
    useState(
      DEFAULT_PAGE_SIZE,
    );

  const [
    selectedInvoiceIds,
    setSelectedInvoiceIds,
  ] =
    useState<
      Set<string>
    >(
      () => new Set(),
    );

  const [
    deletingInvoices,
    setDeletingInvoices,
  ] =
    useState(
      false,
    );

  useEffect(
    () => {
      setPage(
        0,
      );
    },
    [
      search,
      invoices,
    ],
  );

  // ==========================================================
  // UTILITY SUMMARY
  // ==========================================================

  const utilitySummary =
    useMemo(
      () => {
        const summary =
          new Map<
            string,
            {
              utility:
                string;

              consumption:
                number;

              charge:
                number;

              units:
                Set<string>;

              count:
                number;
            }
          >();

        invoices.forEach(
          (
            invoice,
          ) => {
            const utility =
              String(
                invoice.utility_type_cd ??
                  "",
              )
                .trim() ||
              "Unknown";

            const consumption =
              numberValue(
                invoice.consumption,
              );

            const charge =
              numberValue(
                invoice.charge,
              );

            const unit =
              String(
                invoice.consumption_um ??
                  "",
              ).trim();

            let item =
              summary.get(
                utility,
              );

            if (!item) {
              item = {
                utility,
                consumption: 0,
                charge: 0,
                units:
                  new Set<
                    string
                  >(),
                count: 0,
              };

              summary.set(
                utility,
                item,
              );
            }

            item.consumption +=
              consumption;

            item.charge +=
              charge;

            item.count +=
              1;

            if (unit) {
              item.units.add(
                unit,
              );
            }
          },
        );

        return Array.from(
          summary.values(),
        )
          .map(
            (
              item,
            ) => ({
              utility:
                item.utility,

              consumption:
                item.consumption,

              charge:
                item.charge,

              count:
                item.count,

              unit:
                item.units.size ===
                1
                  ? Array.from(
                      item.units,
                    )[0]
                  : item.units.size >
                      1
                    ? "Mixed"
                    : "",
            }),
          )
          .sort(
            (
              a,
              b,
            ) =>
              a.utility.localeCompare(
                b.utility,
                undefined,
                {
                  numeric:
                    true,

                  sensitivity:
                    "base",
                },
              ),
          );
      },
      [
        invoices,
      ],
    );

  const persistedRateMonitoring =
    useMemo<InvoiceRateMonitoringResult[]>(
      () => {
        const rows =
          new Map<string, InvoiceRateMonitoringResult>();

        invoices.forEach((invoice) => {
          const status =
            invoice.rate_monitoring_status;

          if (!status) return;

          const utilityGroupId =
            Number(invoice.utility_group_id);
          const utilityType =
            String(invoice.utility_type_cd ?? "")
              .trim()
              .toUpperCase();

          const key =
            `${utilityGroupId}#${utilityType}`;

          if (rows.has(key)) return;

          rows.set(key, {
            utilityGroupId,
            utilityGroup:
              utilityGroupId === 1
                ? "WWYK"
                : utilityGroupId === 2
                  ? "TAC"
                  : String(invoice.utility_group_id ?? ""),
            utilityType,
            utilitySystem:
              utilityType === "EL"
                ? "Electricity"
                : utilityType === "NG"
                  ? "Natural Gas"
                  : utilityType === "PW"
                    ? "Produced Water"
                    : utilityType === "SS"
                      ? "Sewer"
                      : utilityType,
            totalCost: 0,
            totalConsumption: 0,
            currentRate:
              invoice.rate_monitoring_current_rate == null
                ? null
                : Number(invoice.rate_monitoring_current_rate),
            baselineRate:
              invoice.rate_monitoring_baseline_rate == null
                ? null
                : Number(invoice.rate_monitoring_baseline_rate),
            variancePercent:
              invoice.rate_monitoring_variance_percent == null
                ? null
                : Number(invoice.rate_monitoring_variance_percent),
            thresholdPercent:
              Number(
                invoice.rate_monitoring_threshold_percent ?? 5,
              ),
            status,
            baselineEffectiveDate:
              invoice.rate_monitoring_baseline_effective_date,
            baselineApprovedAt:
              invoice.rate_monitoring_baseline_approved_at,
          });
        });

        for (const row of rows.values()) {
          const matching =
            invoices.filter(
              (invoice) =>
                Number(invoice.utility_group_id) ===
                  row.utilityGroupId &&
                String(invoice.utility_type_cd ?? "")
                  .trim()
                  .toUpperCase() ===
                  row.utilityType,
            );

          row.totalCost =
            matching.reduce(
              (sum, invoice) =>
                sum + numberValue(invoice.charge),
              0,
            );

          row.totalConsumption =
            matching.reduce(
              (sum, invoice) =>
                sum + numberValue(invoice.consumption),
              0,
            );
        }

        return Array.from(rows.values()).sort(
          (a, b) =>
            a.utilityGroup.localeCompare(b.utilityGroup) ||
            a.utilitySystem.localeCompare(b.utilitySystem),
        );
      },
      [invoices],
    );

  const totalCharge =
    useMemo(
      () =>
        utilitySummary.reduce(
          (
            total,
            item,
          ) =>
            total +
            item.charge,
          0,
        ),
      [
        utilitySummary,
      ],
    );

  // ==========================================================
  // SEARCH
  // ==========================================================

  const filtered =
    useMemo(
      () => {
        const query =
          search
            .trim()
            .toLowerCase();

        if (!query) {
          return invoices;
        }

        return invoices.filter(
          (
            invoice,
          ) => {
            const providerName =
              utilityProviderName(
                invoice.utility_provider_cd,
              )
                .toLowerCase();

            const utilityGroup =
              utilityGroupName(
                invoice.utility_group_id,
              )
                .toLowerCase();

            return (
              providerName.includes(
                query,
              ) ||
              utilityGroup.includes(
                query,
              ) ||
              Object.values(
                invoice,
              ).some(
                (
                  itemValue,
                ) =>
                  String(
                    itemValue ??
                      "",
                  )
                    .toLowerCase()
                    .includes(
                      query,
                    ),
              )
            );
          },
        );
      },
      [
        invoices,
        search,
      ],
    );

  const visible =
    useMemo(
      () =>
        filtered.slice(
          page *
            pageSize,

          page *
              pageSize +
            pageSize,
        ),
      [
        filtered,
        page,
        pageSize,
      ],
    );

  const visibleInvoiceIds =
    visible
      .map(
        (invoice) =>
          String(
            invoice.invoiceid ??
              "",
          ).trim(),
      )
      .filter(
        Boolean,
      );

  const allVisibleInvoicesSelected =
    visibleInvoiceIds.length > 0 &&
    visibleInvoiceIds.every(
      (invoiceid) =>
        selectedInvoiceIds.has(
          invoiceid,
        ),
    );

  function toggleVisibleInvoices() {
    setSelectedInvoiceIds(
      (current) => {
        const next =
          new Set(
            current,
          );

        if (
          allVisibleInvoicesSelected
        ) {
          visibleInvoiceIds.forEach(
            (invoiceid) =>
              next.delete(
                invoiceid,
              ),
          );
        } else {
          visibleInvoiceIds.forEach(
            (invoiceid) =>
              next.add(
                invoiceid,
              ),
          );
        }

        return next;
      },
    );
  }

  async function deleteSelectedInvoices() {
    const invoiceids =
      Array.from(
        selectedInvoiceIds,
      );

    if (!invoiceids.length) {
      return;
    }

    const confirmed =
      window.confirm(
        `Delete ${invoiceids.length} selected invoice record${invoiceids.length === 1 ? "" : "s"}?\n\nThis permanently deletes the selected DynamoDB record${invoiceids.length === 1 ? "" : "s"}.`,
      );

    if (!confirmed) {
      return;
    }

    setDeletingInvoices(
      true,
    );

    try {
      const response =
        await fetch(
          "/api/monthly-data/invoices/upload",
          {
            method:
              "DELETE",
            headers: {
              "Content-Type":
                "application/json",
            },
            body:
              JSON.stringify({
                invoiceids,
              }),
          },
        );

      const result =
        await response.json();

      if (!response.ok) {
        throw new Error(
          result.error ||
            "Unable to delete invoice record(s).",
        );
      }

      const deletedIds =
        new Set(
          invoiceids,
        );

      setInvoices(
        (current) =>
          current.filter(
            (invoice) =>
              !deletedIds.has(
                String(
                  invoice.invoiceid ??
                    "",
                ).trim(),
              ),
          ),
      );

      setSelectedInvoiceIds(
        new Set(),
      );

      if (
        Number(
          result.notFound,
        ) > 0
      ) {
        window.alert(
          `Deleted ${result.deleted} invoice record(s). ${result.notFound} selected record(s) no longer existed.`,
        );
      }
    } catch (error) {
      window.alert(
        error instanceof Error
          ? error.message
          : "Unable to delete invoice record(s).",
      );
    } finally {
      setDeletingInvoices(
        false,
      );
    }
  }

  return (
    <>
      <InvoiceRateMonitoringPanel rows={persistedRateMonitoring} />

      {/* ====================================================
          SEARCH
      ==================================================== */}

      <div className="md-action-row">
        <label className="bd-search">
          <Search
            size={18}
          />

          <input
            type="search"
            value={
              search
            }
            placeholder="Search invoices"
            onChange={(
              event,
            ) =>
              setSearch(
                event.target
                  .value,
              )
            }
          />
        </label>

        <div className="md-record-actions">
          <button
            type="button"
            className="md-delete-selected-button"
            disabled={
              deletingInvoices ||
              selectedInvoiceIds.size === 0
            }
            title={
              selectedInvoiceIds.size === 0
                ? "Select one or more invoice rows to delete"
                : `Delete ${selectedInvoiceIds.size} selected invoice record${selectedInvoiceIds.size === 1 ? "" : "s"}`
            }
            onClick={() =>
              void deleteSelectedInvoices()
            }
          >
            <Trash2 size={15} />
            {deletingInvoices
              ? "Deleting..."
              : `Delete Selected (${selectedInvoiceIds.size})`}
          </button>

          <span className="md-row-count">
            {
              filtered.length
            }{" "}
            invoice rows
          </span>
        </div>
      </div>

      {/* ====================================================
          UTILITY SUMMARY
      ==================================================== */}

      <section className="md-invoice-summary-section">
        <div className="md-invoice-summary-heading">
          <div>
            <span className="md-invoice-summary-eyebrow">
              Billing Period Summary
            </span>

            <h3>
              Utility Consumption
              & Charges
            </h3>
          </div>

          <div className="md-invoice-summary-total-charge">
            <span>
              Total Charges
            </span>

            <strong>
              {formatMoney(
                totalCharge,
              )}
            </strong>
          </div>
        </div>

        {utilitySummary.length >
        0 ? (
          <div className="md-invoice-summary-grid">
            {utilitySummary.map(
              (
                item,
              ) => (
                <article
                  key={
                    item.utility
                  }
                  className="md-invoice-summary-card"
                >
                  <div className="md-invoice-summary-card-top">
                    <strong>
                      {
                        item.utility
                      }
                    </strong>

                    <span>
                      {
                        item.count
                      }{" "}
                      rows
                    </span>
                  </div>

                  <div className="md-invoice-summary-metric">
                    <span>
                      Consumption
                    </span>

                    <strong>
                      {formatConsumption(
                        item.consumption,
                      )}

                      {item.unit
                        ? ` ${item.unit}`
                        : ""}
                    </strong>
                  </div>

                  <div className="md-invoice-summary-metric">
                    <span>
                      Charge
                    </span>

                    <strong>
                      {formatMoney(
                        item.charge,
                      )}
                    </strong>
                  </div>
                </article>
              ),
            )}
          </div>
        ) : (
          <div className="md-invoice-summary-empty">
            No invoice
            summary data is
            available for this
            billing period.
          </div>
        )}
      </section>

      {/* ====================================================
          INVOICE TABLE
      ==================================================== */}

      <div className="bd-table-panel">
        <div className="bd-table-scroll">
          <table className="bd-table md-invoice-table">
            <thead>
              <tr>
                <th className="md-select-column">
                  <div className="md-select-header">
                    <span>Select</span>
                    <input
                      type="checkbox"
                      aria-label="Select visible invoice records"
                    checked={
                      allVisibleInvoicesSelected
                    }
                    disabled={
                      visibleInvoiceIds.length === 0 ||
                      deletingInvoices
                    }
                      onChange={
                        toggleVisibleInvoices
                      }
                    />
                  </div>
                </th>

                <th>
                  Period
                </th>

                <th>
                  Installation
                </th>

                <th>
                  Utility
                </th>

                <th>
                  Primary Account
                </th>

                <th>
                  Account
                </th>

                <th>
                  Distribution
                </th>

                <th>
                  Utility Provider
                </th>

                <th>
                  From
                </th>

                <th>
                  To
                </th>

                <th>
                  Consumption
                </th>

                <th>
                  UM
                </th>

                <th>
                  Charge
                </th>

                <th>
                  Account Detail
                </th>

                <th>
                  Entry Instruction
                </th>

              </tr>
            </thead>

            <tbody>
              {visible.map(
                (
                  invoice,
                  index,
                ) => (
                  <tr
                    key={
                      invoice.invoiceid ||
                      `${invoice.account_nbr}-${index}`
                    }
                  >
                    <td className="md-select-column">
                      <input
                        type="checkbox"
                        aria-label={`Select invoice ${invoice.invoiceid}`}
                        checked={
                          selectedInvoiceIds.has(
                            String(
                              invoice.invoiceid ??
                                "",
                            ).trim(),
                          )
                        }
                        disabled={
                          deletingInvoices ||
                          !String(
                            invoice.invoiceid ??
                              "",
                          ).trim()
                        }
                        onChange={(event) => {
                          const invoiceid =
                            String(
                              invoice.invoiceid ??
                                "",
                            ).trim();

                          if (!invoiceid) {
                            return;
                          }

                          setSelectedInvoiceIds(
                            (current) => {
                              const next =
                                new Set(
                                  current,
                                );

                              if (
                                event.target.checked
                              ) {
                                next.add(
                                  invoiceid,
                                );
                              } else {
                                next.delete(
                                  invoiceid,
                                );
                              }

                              return next;
                            },
                          );
                        }}
                      />
                    </td>

                    <td>
                      {
                        invoice.billing_period_id
                      }
                    </td>

                    <td>
                      {
                        utilityGroupName(
                          invoice.utility_group_id,
                        )
                      }
                    </td>

                    <td>
                      {
                        invoice.utility_type_cd
                      }
                    </td>

                    <td className="bd-id-cell">
                      {
                        invoice.primary_account_nbr
                      }
                    </td>

                    <td>
                      {
                        invoice.account_nbr
                      }
                    </td>

                    <td>
                      {
                        invoice.distribution_system
                      }
                    </td>

                    <td className="md-provider-cell">
                      {
                        utilityProviderName(
                          invoice.utility_provider_cd,
                        )
                      }
                    </td>

                    <td>
                      {
                        invoice.billing_from_date
                      }
                    </td>

                    <td>
                      {
                        invoice.billing_to_date
                      }
                    </td>

                    <td>
                      {
                        invoice.consumption
                      }
                    </td>

                    <td>
                      {
                        invoice.consumption_um
                      }
                    </td>

                    <td>
                      {invoice.charge
                        ? formatMoney(
                            numberValue(
                              invoice.charge,
                            ),
                          )
                        : "—"}
                    </td>

                    <td className="bd-long-cell">
                      {
                        invoice.account_detail
                      }
                    </td>

                    <td className="bd-long-cell">
                      {
                        invoice.entry_instruction
                      }
                    </td>

                  </tr>
                ),
              )}

              {visible.length ===
                0 && (
                <tr>
                  <td
                    colSpan={
                      15
                    }
                    className="bd-empty-row"
                  >
                    No invoice
                    records found
                    for this billing
                    period.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <Pagination
        page={
          page
        }
        pageSize={
          pageSize
        }
        total={
          filtered.length
        }
        setPage={
          setPage
        }
        setPageSize={
          setPageSize
        }
      />
    </>
  );
}

// ============================================================
// METER READING TABLE
// ============================================================

function MeterReadingTable({
  readings,
  meterMaster,
  setReadings,
  correctionRules,
  fy,
  month,
  billingPeriodId,
  onSaved,
}: {
  readings: MeterReadingRecord[];
  meterMaster: MeterMasterRecord[];
  setReadings: Dispatch<SetStateAction<MeterReadingRecord[]>>;
  correctionRules: CorrectionRuleRecord[];
  fy: string;
  month: string;
  billingPeriodId: string;
  onSaved: () => void;
}) {
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<
    | "meter"
    | "facility"
    | "previous_reading"
    | "reading"
    | "reading_delta"
    | "multiplier"
    | "consumption"
    | "previous_fy"
    | "adjusted"
    | "correction_rule"
    | "used"
    | null
  >(null);
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("asc");
  const [drafts, setDrafts] = useState<Record<string, MeterReadingDraft>>({});
  const [selectedReadingKeys, setSelectedReadingKeys] =
    useState<Set<string>>(() => new Set());
  const [deletingReadings, setDeletingReadings] =
    useState(false);

  useEffect(() => {
    setPage(0);
    setDrafts({});
    setSelectedReadingKeys(new Set());
  }, [fy, month]);

  useEffect(() => {
    setPage(0);
  }, [search]);

  async function readApiResult(response: Response): Promise<MeterReadingApiResult> {
    const body = await response.text();

    if (!body.trim()) {
      return {};
    }

    try {
      const parsed: unknown = JSON.parse(body);

      return parsed && typeof parsed === "object"
        ? (parsed as MeterReadingApiResult)
        : {};
    } catch {
      return {
        error: body.trim().slice(0, 500),
      };
    }
  }

  function fiscalPeriodOffset(sourceFY: string, sourceMonth: string, offset: number) {
    const monthIndex = MONTHS.indexOf(sourceMonth);
    const numericFY = Number(sourceFY);
    const calendarYear = monthIndex >= 9 ? numericFY - 1 : numericFY;
    const date = new Date(Date.UTC(calendarYear, monthIndex + offset, 1));
    const shiftedMonthIndex = date.getUTCMonth();
    const shiftedCalendarYear = date.getUTCFullYear();
    const shiftedFY = shiftedMonthIndex >= 9 ? shiftedCalendarYear + 1 : shiftedCalendarYear;

    return {
      fy: String(shiftedFY),
      month: MONTHS[shiftedMonthIndex],
    };
  }

  const readingLookup = useMemo(() => {
    const lookup = new Map<string, MeterReadingRecord>();

    readings.forEach((reading) => {
      lookup.set(
        [reading.meterid, reading.fy, reading.billing_month_nm].join("|"),
        reading,
      );
    });

    return lookup;
  }, [readings]);

  function findMeterReading(meterid: string, targetFY: string, targetMonth: string) {
    return readingLookup.get([meterid, targetFY, targetMonth].join("|"));
  }

  function getContext(reading: MeterReadingRecord) {
    const previous1 = fiscalPeriodOffset(reading.fy, reading.billing_month_nm, -1);
    const previous2 = fiscalPeriodOffset(reading.fy, reading.billing_month_nm, -2);
    const previous3 = fiscalPeriodOffset(reading.fy, reading.billing_month_nm, -3);
    const next1 = fiscalPeriodOffset(reading.fy, reading.billing_month_nm, 1);
    const priorFY = String(Number(reading.fy) - 1);

    return {
      previous1: findMeterReading(reading.meterid, previous1.fy, previous1.month),
      previous2: findMeterReading(reading.meterid, previous2.fy, previous2.month),
      previous3: findMeterReading(reading.meterid, previous3.fy, previous3.month),
      next1: findMeterReading(reading.meterid, next1.fy, next1.month),
      priorYear: findMeterReading(reading.meterid, priorFY, reading.billing_month_nm),
    };
  }

  function calculateAdjustedConsumption(reading: MeterReadingRecord, rule: string) {
    const normalized = normalizeRule(rule);

    // No correction = adjusted consumption equals raw consumption.
    if (!normalized) {
      return roundAdjusted(
        numberValue(
          reading.consumption,
        ),
      );
    }

    if (isManualCorrectionRule(normalized)) return reading.adjusted_consumption;

    const { previous1, previous2, previous3, next1, priorYear } = getContext(reading);
    const p1 = usableConsumption(previous1);
    const p2 = usableConsumption(previous2);
    const p3 = usableConsumption(previous3);
    const n1 = usableConsumption(next1);
    const py = usableConsumption(priorYear);

    switch (normalized) {
      case "a":
        return p1 !== null && n1 !== null ? roundAdjusted((p1 + n1) / 2) : "";
      case "b":
        return p1 !== null && p2 !== null && p3 !== null
          ? roundAdjusted((p1 + p2 + p3) / 3)
          : "";
      case "c":
        return p1 !== null ? roundAdjusted(p1) : "";
      case "d":
        return n1 !== null ? roundAdjusted(n1) : "";
      case "e":
        return py !== null ? roundAdjusted(py) : "";
      case "j":
      case "l":
        return "0";
      default:
        return "";
    }
  }

  function rowKey(reading: MeterReadingRecord) {
    const billingPeriod = String(reading.billing_period_id ?? "").trim();
    return `${reading.meterid}|${billingPeriod || reading.period}`;
  }

  function sameReadingKey(
    left: MeterReadingRecord,
    right: MeterReadingRecord,
  ) {
    return (
      String(left.meterid).trim().toUpperCase() ===
        String(right.meterid).trim().toUpperCase() &&
      String(left.billing_period_id).trim() ===
        String(right.billing_period_id).trim()
    );
  }

  function mergePersistedReading(
    previous: MeterReadingRecord,
    item: Record<string, unknown>,
  ): MeterReadingRecord {
    const has = (name: string) =>
      Object.prototype.hasOwnProperty.call(item, name);
    const text = (name: string, fallback: string) =>
      has(name) && item[name] !== null && item[name] !== undefined
        ? String(item[name]).trim()
        : fallback;

    const merged: MeterReadingRecord = {
      ...previous,
      meterid: text("meterid", previous.meterid),
      period: text("period", previous.period),
      billing_period_id: text(
        "billing_period_id",
        previous.billing_period_id,
      ),
      fy: text("fy", previous.fy),
      billing_month_nm: text(
        "billing_month_nm",
        previous.billing_month_nm,
      ),
      utility_type_cd: text(
        "utility_type_cd",
        previous.utility_type_cd,
      ),
      inst_cd: text("inst_cd", previous.inst_cd),
      sub_inst_cd: text("sub_inst_cd", previous.sub_inst_cd),
      site_cd: text("site_cd", previous.site_cd),
      facility_nbr: text("facility_nbr", previous.facility_nbr),
      multiplier: text("multiplier", previous.multiplier),
      previous_reading: text(
        "previous_reading",
        previous.previous_reading,
      ),
      previous_adjusted_reading: text(
        "previous_adjusted_reading",
        previous.previous_adjusted_reading,
      ),
      reading: text("reading", previous.reading),
      consumption: text("consumption", previous.consumption),
      meter_correction_rule_cd: text(
        "meter_correction_rule_cd",
        has("meter_correction_rule_cd")
          ? ""
          : previous.meter_correction_rule_cd,
      ),
      adjusted_consumption: text(
        "adjusted_consumption",
        has("adjusted_consumption") ? "" : previous.adjusted_consumption,
      ),
      used_in_calculation: text(
        "used_in_calculation",
        previous.used_in_calculation,
      ) === "1"
        ? "1"
        : "0",
    };

    return {
      ...merged,
      isMasterOnly: !merged.reading.trim(),
    };
  }

  function applyPersistedReading(item: Record<string, unknown>) {
    const meterid = String(item.meterid ?? "").trim();
    const billingPeriod = String(item.billing_period_id ?? "").trim();

    if (!meterid || !billingPeriod) {
      throw new Error(
        "The server saved the meter reading but did not return its meter ID and billing period.",
      );
    }

    setReadings((current) => {
      const existingIndex = current.findIndex((reading) =>
        sameReadingKey(reading, {
          meterid,
          period: String(item.period ?? ""),
          billing_period_id: billingPeriod,
        } as MeterReadingRecord),
      );

      if (existingIndex >= 0) {
        return current.map((reading, index) =>
          index === existingIndex
            ? mergePersistedReading(reading, item)
            : reading,
        );
      }

      const placeholder: MeterReadingRecord = {
        meterid,
        period: String(item.period ?? ""),
        billing_period_id: billingPeriod,
        fy: String(item.fy ?? fy),
        billing_month_nm: String(item.billing_month_nm ?? month),
        utility_type_cd: String(item.utility_type_cd ?? ""),
        inst_cd: String(item.inst_cd ?? ""),
        sub_inst_cd: String(item.sub_inst_cd ?? ""),
        site_cd: String(item.site_cd ?? ""),
        facility_nbr: String(item.facility_nbr ?? ""),
        multiplier: String(item.multiplier ?? ""),
        previous_reading: String(item.previous_reading ?? ""),
        previous_adjusted_reading: String(
          item.previous_adjusted_reading ?? "",
        ),
        reading: "",
        consumption: "",
        meter_correction_rule_cd: "",
        adjusted_consumption: "",
        used_in_calculation: "0",
        isMasterOnly: true,
      };

      return [...current, mergePersistedReading(placeholder, item)];
    });
  }

  function baseDraft(reading: MeterReadingRecord): MeterReadingDraft {
    const hasConsumption = String(reading.consumption ?? "").trim() !== "";
    const normalizedRule = normalizeRule(reading.meter_correction_rule_cd);
    const masterOnlyRuleEValue =
      reading.isMasterOnly && normalizedRule === "e"
        ? calculateAdjustedConsumption(reading, normalizedRule)
        : "";
    const effectiveAdjusted =
      reading.adjusted_consumption ||
      masterOnlyRuleEValue ||
      (!normalizeRule(reading.meter_correction_rule_cd) && hasConsumption
        ? roundAdjusted(numberValue(reading.consumption))
        : "");

    return {
      reading: reading.reading,
      meter_correction_rule_cd: reading.meter_correction_rule_cd,
      used_in_calculation: reading.used_in_calculation === "1" ? "1" : "0",
      adjusted_consumption: effectiveAdjusted,
    };
  }

  function getDraft(reading: MeterReadingRecord) {
    return drafts[rowKey(reading)] ?? baseDraft(reading);
  }

  function changeDraft(reading: MeterReadingRecord, changes: Partial<MeterReadingDraft>) {
    const key = rowKey(reading);

    setDrafts((current) => ({
      ...current,
      [key]: {
        ...(current[key] ?? baseDraft(reading)),
        ...changes,
      },
    }));
  }

  function rowHasChanges(reading: MeterReadingRecord, draft: MeterReadingDraft) {
    if (reading.isMasterOnly) {
      const savedUsed = reading.used_in_calculation === "1" ? "1" : "0";
      const savedAdjusted = String(reading.adjusted_consumption ?? "");

      return (
        draft.adjusted_consumption !== savedAdjusted ||
        draft.meter_correction_rule_cd !== reading.meter_correction_rule_cd ||
        draft.used_in_calculation !== savedUsed ||
        (normalizeRule(draft.meter_correction_rule_cd) === "e" &&
          !draft.adjusted_consumption.trim())
      );
    }

    const savedUsed = reading.used_in_calculation === "1" ? "1" : "0";

    const savedAdjusted =
      reading.adjusted_consumption ||
      (!normalizeRule(reading.meter_correction_rule_cd)
        ? roundAdjusted(numberValue(reading.consumption))
        : "");

    return (
      draft.meter_correction_rule_cd !== reading.meter_correction_rule_cd ||
      draft.used_in_calculation !== savedUsed ||
      draft.adjusted_consumption !== savedAdjusted
    );
  }

  type MeterSortKey = NonNullable<typeof sortKey>;

  function changeMeterSort(key: MeterSortKey) {
    setPage(0);

    if (sortKey === key) {
      setSortDirection((current) => (current === "asc" ? "desc" : "asc"));
      return;
    }

    setSortKey(key);
    setSortDirection("asc");
  }

  function sortIndicator(key: MeterSortKey) {
    if (sortKey !== key) return "";
    return sortDirection === "asc" ? " ▲" : " ▼";
  }

  const currentPeriodReadings = useMemo(
    () =>
      readings.filter(
        (reading) =>
          reading.fy === fy &&
          reading.billing_month_nm === month,
      ),
    [readings, fy, month],
  );

  const displayReadings = useMemo(() => {
    const currentByMeter = new Map<string, MeterReadingRecord>();

    currentPeriodReadings.forEach((reading) => {
      const meterid = String(reading.meterid ?? "").trim().toUpperCase();
      if (meterid) currentByMeter.set(meterid, reading);
    });

    const masterMeterIds = new Set<string>();
    const merged: MeterReadingRecord[] = [];

    meterMaster.forEach((master) => {
      const meterid = String(master.meterid ?? "").trim();
      const normalizedMeterid = meterid.toUpperCase();

      if (!meterid || masterMeterIds.has(normalizedMeterid)) return;

      masterMeterIds.add(normalizedMeterid);

      const current = currentByMeter.get(normalizedMeterid);

      if (current) {
        merged.push(current);
        return;
      }

      merged.push({
        meterid,
        period: periodFromFiscalMonth(fy, month),
        billing_period_id: billingPeriodId,
        fy,
        billing_month_nm: month,
        utility_type_cd: master.utility_type_cd,
        inst_cd: "",
        sub_inst_cd: master.sub_inst_cd,
        site_cd: "",
        facility_nbr: master.facility_nbr,
        multiplier: "",
        previous_reading: "",
        previous_adjusted_reading: "",
        reading: "",
        consumption: "",
        meter_correction_rule_cd: "",
        adjusted_consumption: "",
        used_in_calculation: "0",
        isMasterOnly: true,
      });
    });

    // Preserve any current-period reading whose meter is not yet present in
    // the master list. This keeps existing data visible while making the
    // master list the normal source of rows.
    currentPeriodReadings.forEach((reading) => {
      const meterid = String(reading.meterid ?? "").trim().toUpperCase();

      if (meterid && !masterMeterIds.has(meterid)) {
        merged.push(reading);
      }
    });

    return merged;
  }, [
    currentPeriodReadings,
    meterMaster,
    fy,
    month,
    billingPeriodId,
  ]);

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();

    const result = displayReadings.filter((reading) => {
      if (!query) return true;

      return Object.values(reading).some((value) =>
        String(value ?? "").toLowerCase().includes(query),
      );
    });

    if (!sortKey) {
      return result.sort(compareMeterReadings);
    }

    const textCompare = (left: string, right: string) =>
      String(left ?? "").localeCompare(String(right ?? ""), undefined, {
        numeric: true,
        sensitivity: "base",
      });

    const numericCompare = (left: string | number | null, right: string | number | null) => {
      const leftText = String(left ?? "").trim();
      const rightText = String(right ?? "").trim();
      const leftMissing = leftText === "" || left === null;
      const rightMissing = rightText === "" || right === null;

      // Keep blank values at the bottom in either direction.
      if (leftMissing !== rightMissing) return leftMissing ? 1 : -1;
      if (leftMissing && rightMissing) return 0;

      return numberValue(leftText) - numberValue(rightText);
    };

    result.sort((a, b) => {
      const aDraft = getDraft(a);
      const bDraft = getDraft(b);
      let comparison = 0;

      switch (sortKey) {
        case "meter":
          comparison = textCompare(a.meterid, b.meterid);
          break;
        case "facility":
          comparison = textCompare(a.facility_nbr, b.facility_nbr);
          break;
        case "previous_reading":
          comparison = numericCompare(
            a.previous_adjusted_reading || a.previous_reading,
            b.previous_adjusted_reading || b.previous_reading,
          );
          break;
        case "reading":
          comparison = numericCompare(aDraft.reading, bDraft.reading);
          break;
        case "reading_delta":
          comparison = numericCompare(
            getReadingDeltaPercent(a, aDraft.reading),
            getReadingDeltaPercent(b, bDraft.reading),
          );
          break;
        case "multiplier":
          comparison = numericCompare(a.multiplier, b.multiplier);
          break;
        case "consumption":
          comparison = numericCompare(a.consumption, b.consumption);
          break;
        case "previous_fy":
          comparison = numericCompare(
            getPreviousFYConsumption(a),
            getPreviousFYConsumption(b),
          );
          break;
        case "adjusted":
          comparison = numericCompare(
            aDraft.adjusted_consumption,
            bDraft.adjusted_consumption,
          );
          break;
        case "correction_rule":
          comparison = textCompare(
            aDraft.meter_correction_rule_cd,
            bDraft.meter_correction_rule_cd,
          );
          break;
        case "used":
          comparison = numericCompare(
            aDraft.used_in_calculation,
            bDraft.used_in_calculation,
          );
          break;
      }

      if (comparison === 0) {
        comparison = compareMeterReadings(a, b);
      }

      return sortDirection === "asc" ? comparison : -comparison;
    });

    return result;
  }, [displayReadings, search, sortKey, sortDirection, drafts]);

  const visible = useMemo(
    () => filtered.slice(page * pageSize, page * pageSize + pageSize),
    [filtered, page, pageSize],
  );

  const visibleReadingKeys =
    visible
      .filter((reading) => !reading.isMasterOnly)
      .map(rowKey);

  const allVisibleReadingsSelected =
    visibleReadingKeys.length > 0 &&
    visibleReadingKeys.every((key) =>
      selectedReadingKeys.has(key),
    );

  function toggleVisibleReadings() {
    setSelectedReadingKeys((current) => {
      const next = new Set(current);

      if (allVisibleReadingsSelected) {
        visibleReadingKeys.forEach((key) =>
          next.delete(key),
        );
      } else {
        visibleReadingKeys.forEach((key) =>
          next.add(key),
        );
      }

      return next;
    });
  }

  async function deleteSelectedReadings() {
    const selected =
      readings.filter((reading) =>
        selectedReadingKeys.has(
          rowKey(reading),
        ),
      );

    if (!selected.length) {
      return;
    }

    const confirmed =
      window.confirm(
        `Delete ${selected.length} selected meter reading${selected.length === 1 ? "" : "s"}?\n\nThis permanently deletes the selected DynamoDB record${selected.length === 1 ? "" : "s"}.`,
      );

    if (!confirmed) {
      return;
    }

    setDeletingReadings(true);

    try {
      const response =
        await fetch(
          "/api/monthly-data/meter-reading",
          {
            method: "DELETE",
            headers: {
              "Content-Type":
                "application/json",
            },
            body: JSON.stringify({
              items: selected.map(
                (reading) => ({
                  meterid:
                    reading.meterid,
                  period:
                    reading.period,
                  billing_period_id:
                    Number(
                      reading.billing_period_id,
                    ),
                }),
              ),
            }),
          },
        );

      const result =
        await response.json();

      if (!response.ok) {
        throw new Error(
          result.error ||
            "Unable to delete meter reading(s).",
        );
      }

      const deletedKeys =
        new Set(
          selected.map(
            rowKey,
          ),
        );

      setReadings((current) =>
        current.filter(
          (reading) =>
            !deletedKeys.has(
              rowKey(reading),
            ),
        ),
      );

      setSelectedReadingKeys(
        new Set(),
      );

      setDrafts((current) => {
        const next = {
          ...current,
        };

        deletedKeys.forEach(
          (key) =>
            delete next[key],
        );

        return next;
      });

      if (
        Number(
          result.notFound,
        ) > 0
      ) {
        window.alert(
          `Deleted ${result.deleted} meter reading(s). ${result.notFound} selected record(s) no longer existed.`,
        );
      }
    } catch (error) {
      window.alert(
        error instanceof Error
          ? error.message
          : "Unable to delete meter reading(s).",
      );
    } finally {
      setDeletingReadings(false);
    }
  }

  function getPreviousFYConsumption(reading: MeterReadingRecord) {
    const prior = getContext(reading).priorYear;
    return prior ? String(usableConsumption(prior) ?? "") : "";
  }

  function getPercentChange(
    reading: MeterReadingRecord,
    priorValue: string,
    currentAdjusted: string,
  ) {
    if (reading.isMasterOnly && !currentAdjusted.trim()) return null;
    if (!priorValue) return null;

    const previous = Number(priorValue);
    const current = Number(currentAdjusted || reading.consumption);

    if (!Number.isFinite(previous) || !Number.isFinite(current) || previous === 0) {
      return null;
    }

    return ((current - previous) / previous) * 100;
  }

  function getReadingDeltaPercent(
    reading: MeterReadingRecord,
    currentReadingText: string,
  ) {
    const previousText = String(
      reading.previous_reading ||
        reading.previous_adjusted_reading ||
        getContext(reading).previous1?.reading ||
        "",
    ).trim();
    const currentText = String(currentReadingText ?? "").trim();

    if (!previousText || !currentText) return null;

    const previous = Number(previousText.replace(/,/g, ""));
    const current = Number(currentText.replace(/,/g, ""));

    if (!Number.isFinite(previous) || !Number.isFinite(current) || previous === 0) {
      return null;
    }

    return ((current - previous) / previous) * 100;
  }

  async function saveMasterOnlyReading(
    reading: MeterReadingRecord,
    draft: MeterReadingDraft,
  ) {
    const key = rowKey(reading);
    setSavingKey(key);

    try {
      const response = await fetch("/api/monthly-data/meter-reading", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "save_manual_entry",
          meterid: reading.meterid,
          period: reading.period,
          billing_period_id: Number(billingPeriodId),
          fy: Number(fy),
          billing_month_nm: month,
          meter_correction_rule_cd: draft.meter_correction_rule_cd,
          adjusted_consumption: draft.adjusted_consumption,
          used_in_calculation: draft.used_in_calculation,
        }),
      });

      const result = await readApiResult(response);

      if (!response.ok) {
        throw new Error(result.error || "Unable to save the meter reading.");
      }

      if (!result.item) {
        throw new Error(
          "The meter reading was saved, but the server did not return the saved record.",
        );
      }

      applyPersistedReading(result.item);

      setDrafts((current) => {
        const next = { ...current };
        delete next[key];
        return next;
      });

      onSaved();
    } catch (error) {
      window.alert(
        error instanceof Error
          ? error.message
          : "Unable to save the meter reading.",
      );
    } finally {
      setSavingKey(null);
    }
  }

  async function updateReading(reading: MeterReadingRecord, draft: MeterReadingDraft) {
    if (reading.isMasterOnly) {
      await saveMasterOnlyReading(reading, draft);
      return;
    }

    const key = rowKey(reading);
    setSavingKey(key);

    try {
      const response = await fetch("/api/monthly-data/meter-reading", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          meterid: reading.meterid,
          period: reading.period,
          billing_period_id: Number(reading.billing_period_id),
          meter_correction_rule_cd: draft.meter_correction_rule_cd,
          used_in_calculation: draft.used_in_calculation,
          adjusted_consumption: draft.adjusted_consumption,
        }),
      });

      const result = await readApiResult(response);

      if (!response.ok) {
        throw new Error(result.error || "Unable to update meter reading.");
      }

      if (!result.item) {
        throw new Error(
          "The meter reading was saved, but the server did not return the saved record.",
        );
      }

      applyPersistedReading(result.item);

      setDrafts((current) => {
        const next = { ...current };
        delete next[key];
        return next;
      });

      onSaved();
    } catch (error) {
      window.alert(
        error instanceof Error ? error.message : "Unable to update meter reading.",
      );
    } finally {
      setSavingKey(null);
    }
  }

  function exportMeterReadingsToCsv() {
    if (filtered.length === 0) return;

    const headers = [
      "Meter",
      "Facility",
      "Previous Reading",
      "Reading",
      "Reading Delta %",
      "Multiplier",
      "Consumption",
      "Previous FY Same Month",
      "Adjusted Consumption",
      "Correction Rule",
      "Used",
    ];

    const escapeCsv = (value: unknown) => {
      const text = String(value ?? "");

      return /[",\r\n]/.test(text)
        ? `"${text.replace(/"/g, '""')}"`
        : text;
    };

    const rows = filtered.map((reading) => {
      const draft = getDraft(reading);
      const delta = getReadingDeltaPercent(reading, draft.reading);

      return [
        reading.meterid,
        reading.facility_nbr,
        reading.previous_adjusted_reading || reading.previous_reading,
        draft.reading,
        delta === null ? "" : `${delta.toFixed(2)}%`,
        reading.multiplier,
        reading.consumption,
        getPreviousFYConsumption(reading),
        draft.adjusted_consumption,
        draft.meter_correction_rule_cd,
        draft.used_in_calculation === "1" ? "Yes" : "No",
      ];
    });

    const csv = [
      headers.map(escapeCsv).join(","),
      ...rows.map((row) => row.map(escapeCsv).join(",")),
    ].join("\r\n");

    const blob = new Blob(["\uFEFF", csv], {
      type: "text/csv;charset=utf-8;",
    });

    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");

    link.href = url;
    link.download = `CUBE-Meter-Readings-FY${fy}-${month}.csv`;

    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    URL.revokeObjectURL(url);
  }

  return (
    <>
      <div className="md-action-row">
        <label className="bd-search">
          <Search size={18} />
          <input
            type="search"
            placeholder="Search meter readings"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>

        <div className="md-record-actions">
          <button
            type="button"
            className="md-delete-selected-button"
            disabled={
              deletingReadings ||
              selectedReadingKeys.size === 0
            }
            title={
              selectedReadingKeys.size === 0
                ? "Select one or more meter-reading rows to delete"
                : `Delete ${selectedReadingKeys.size} selected meter reading${selectedReadingKeys.size === 1 ? "" : "s"}`
            }
            onClick={() =>
              void deleteSelectedReadings()
            }
          >
            <Trash2 size={15} />
            {deletingReadings
              ? "Deleting..."
              : `Delete Selected (${selectedReadingKeys.size})`}
          </button>

          <button
            type="button"
            className="bd-add-button"
            onClick={exportMeterReadingsToCsv}
            disabled={filtered.length === 0}
            title={`Export ${filtered.length} meter readings to CSV`}
          >
            <Download size={15} />
            Export CSV
          </button>

          <span className="md-row-count">
            {filtered.length} meter readings
          </span>
        </div>
      </div>

      <div className="bd-table-panel">
        <div className="bd-table-scroll">
          <table className="bd-table md-reading-table">
            <thead>
              <tr>
                <th className="md-select-column">
                  <div className="md-select-header">
                    <span>Select</span>
                    <input
                      type="checkbox"
                      aria-label="Select visible meter readings"
                    checked={
                      allVisibleReadingsSelected
                    }
                    disabled={
                      visibleReadingKeys.length === 0 ||
                      deletingReadings
                    }
                      onChange={
                        toggleVisibleReadings
                      }
                    />
                  </div>
                </th>
                <th><button type="button" className="md-sort-header" onClick={() => changeMeterSort("meter")}>Meter{sortIndicator("meter")}</button></th>
                <th><button type="button" className="md-sort-header" onClick={() => changeMeterSort("facility")}>Facility{sortIndicator("facility")}</button></th>
                <th><button type="button" className="md-sort-header" onClick={() => changeMeterSort("previous_reading")}>Previous Reading{sortIndicator("previous_reading")}</button></th>
                <th><button type="button" className="md-sort-header" onClick={() => changeMeterSort("reading")}>Reading{sortIndicator("reading")}</button></th>
                <th><button type="button" className="md-sort-header" onClick={() => changeMeterSort("reading_delta")}>Reading Δ %{sortIndicator("reading_delta")}</button></th>
                <th><button type="button" className="md-sort-header" onClick={() => changeMeterSort("multiplier")}>Multiplier{sortIndicator("multiplier")}</button></th>
                <th><button type="button" className="md-sort-header" onClick={() => changeMeterSort("consumption")}>Consumption{sortIndicator("consumption")}</button></th>
                <th><button type="button" className="md-sort-header" onClick={() => changeMeterSort("previous_fy")}>Previous FY Same Month{sortIndicator("previous_fy")}</button></th>
                <th><button type="button" className="md-sort-header" onClick={() => changeMeterSort("adjusted")}>Adjusted Consumption{sortIndicator("adjusted")}</button></th>
                <th><button type="button" className="md-sort-header" onClick={() => changeMeterSort("correction_rule")}>Correction Rule{sortIndicator("correction_rule")}</button></th>
                <th><button type="button" className="md-sort-header" onClick={() => changeMeterSort("used")}>Used{sortIndicator("used")}</button></th>
                <th>Actions</th>
              </tr>
            </thead>

            <tbody>
              {visible.map((reading) => {
                const key = rowKey(reading);
                const saving = savingKey === key;
                const draft = getDraft(reading);
                const previousPeriodReading = getContext(reading).previous1;
                const manualAdjusted = isManualCorrectionRule(
                  draft.meter_correction_rule_cd,
                );
                const priorConsumption = getPreviousFYConsumption(reading);
                const percentChange = getPercentChange(
                  reading,
                  priorConsumption,
                  draft.adjusted_consumption,
                );
                const changed = rowHasChanges(reading, draft);
                const readingDeltaPercent = getReadingDeltaPercent(
                  reading,
                  draft.reading,
                );
                const readingDeltaAlert =
                  readingDeltaPercent !== null && Math.abs(readingDeltaPercent) >= 5;

                const previousReading =
                  reading.previous_adjusted_reading ||
                  reading.previous_reading ||
                  previousPeriodReading?.reading ||
                  "";

                return (
                  <tr
                    key={key}
                    className={`${changed ? "md-row-dirty " : ""}${reading.isMasterOnly ? "md-master-only-row" : ""}`}
                  >
                    <td className="md-select-column">
                      <input
                        type="checkbox"
                        aria-label={`Select meter reading ${reading.meterid}`}
                        checked={
                          selectedReadingKeys.has(
                            key,
                          )
                        }
                        disabled={
                          reading.isMasterOnly ||
                          deletingReadings ||
                          saving
                        }
                        onChange={(event) => {
                          setSelectedReadingKeys(
                            (current) => {
                              const next =
                                new Set(
                                  current,
                                );

                              if (
                                event.target.checked
                              ) {
                                next.add(
                                  key,
                                );
                              } else {
                                next.delete(
                                  key,
                                );
                              }

                              return next;
                            },
                          );
                        }}
                      />
                    </td>
                    <td className="bd-id-cell">{reading.meterid}</td>
                    <td>{reading.facility_nbr || "—"}</td>
                    <td>
                      {previousReading ||
                        "—"}
                    </td>
                    <td>
                      {reading.isMasterOnly ? (
                        <span
                          className="md-reading-value md-reading-missing"
                          title="No current reading has been uploaded"
                        >
                          —
                        </span>
                      ) : (
                        <span
                          className="md-reading-value"
                          title="Raw imported meter reading"
                        >
                          {reading.reading || "—"}
                        </span>
                      )}
                    </td>
                    <td
                      className={
                        readingDeltaAlert
                          ? "md-reading-delta md-reading-delta-alert"
                          : "md-reading-delta"
                      }
                    >
                      {readingDeltaPercent === null ? (
                        <span className="md-no-prior">—</span>
                      ) : (
                        <strong>
                          {readingDeltaPercent > 0 ? "+" : ""}
                          {readingDeltaPercent.toFixed(1)}%
                        </strong>
                      )}
                    </td>
                    <td>{reading.multiplier || "—"}</td>
                    <td>{reading.consumption || "—"}</td>
                    <td className="md-prior-consumption">
                      {priorConsumption ? (
                        <div className="md-prior-value">
                          <strong>{priorConsumption}</strong>
                          {percentChange !== null && (
                            <span
                              className={
                                percentChange > 0
                                  ? "md-percent-up"
                                  : percentChange < 0
                                    ? "md-percent-down"
                                    : "md-percent-flat"
                              }
                            >
                              {percentChange > 0 ? "+" : ""}
                              {percentChange.toFixed(1)}%
                            </span>
                          )}
                        </div>
                      ) : (
                        <span className="md-no-prior">—</span>
                      )}
                    </td>

                    <td>
                      <input
                        type="number"
                        step="any"
                        className="md-adjusted-input"
                        value={draft.adjusted_consumption}
                        disabled={saving}
                        placeholder={manualAdjusted ? "Enter value" : "Adjusted Consumption"}
                        onChange={(event) =>
                          changeDraft(reading, {
                            adjusted_consumption: event.target.value,
                          })
                        }
                      />
                    </td>

                    <td>
                      <select
                        className="md-inline-select"
                        value={draft.meter_correction_rule_cd}
                        disabled={saving}
                        onChange={(event) => {
                          const rule = event.target.value;
                          const adjusted = isManualCorrectionRule(rule)
                            ? draft.adjusted_consumption
                            : calculateAdjustedConsumption(reading, rule);

                          changeDraft(reading, {
                            meter_correction_rule_cd: rule,
                            adjusted_consumption: adjusted,
                          });
                        }}
                      >
                        <option value="">No correction</option>
                        {correctionRules.map((rule) => (
                          <option
                            key={rule.correction_rule_cd}
                            value={rule.correction_rule_cd}
                          >
                            {rule.correction_rule_cd} - {rule.correction_rule_name}
                          </option>
                        ))}
                      </select>
                    </td>

                    <td className="md-used-cell">
                      <label className="md-used-checkbox">
                        <input
                          type="checkbox"
                          checked={draft.used_in_calculation === "1"}
                          disabled={saving}
                          onChange={(event) =>
                            changeDraft(reading, {
                              used_in_calculation: event.target.checked ? "1" : "0",
                            })
                          }
                        />
                        <span>Used</span>
                      </label>
                    </td>

                    <td>
                      <button
                        type="button"
                        className="md-update-button"
                        disabled={
                          saving ||
                          !changed
                        }
                        onClick={() => updateReading(reading, draft)}
                      >
                        <Check size={15} />
                        {saving
                          ? "Updating..."
                          : reading.isMasterOnly
                            ? "Save"
                            : "Update"}
                      </button>
                    </td>
                  </tr>
                );
              })}

              {visible.length === 0 && (
                <tr>
                  <td colSpan={13} className="bd-empty-row">
                    No meter readings found for {month} FY {fy}.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <Pagination
        page={page}
        pageSize={pageSize}
        total={filtered.length}
        setPage={setPage}
        setPageSize={setPageSize}
      />
    </>
  );
}

// ============================================================
// INVOICE UPLOAD
// ============================================================

type InvoiceComparisonChange = {
  field: string;
  existing: string;
  uploaded: string;
};

type InvoiceComparisonRow = {
  status: "new" | "changed" | "removed";
  key: string;
  existing?: Record<string, unknown>;
  uploaded?: Record<string, unknown>;
  changes?: InvoiceComparisonChange[];
};

type InvoiceComparison = {
  existing: number;
  uploaded: number;
  new: number;
  changed: number;
  unchanged: number;
  removed: number;
  rows: InvoiceComparisonRow[];
  rowsTruncated?: boolean;
};

type InvoiceRateMonitoringResult = {
  utilityGroupId: number;
  utilityGroup: string;
  utilityType: string;
  utilitySystem: string;
  totalCost: number;
  totalConsumption: number;
  currentRate: number | null;
  baselineRate: number | null;
  variancePercent: number | null;
  thresholdPercent: number;
  status: InvoiceRateMonitoringStatus;
  baselineEffectiveDate?: string;
  baselineApprovedAt?: string;
};


function InvoiceUpload({
  fiscalYear,
  billingMonth,
  billingPeriodId,
  onComplete,
}: {
  fiscalYear: string;
  billingMonth: string;
  billingPeriodId: string;
  onComplete: () => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [comparison, setComparison] = useState<InvoiceComparison | null>(null);
  const [previewSkipped, setPreviewSkipped] = useState(0);
  const [showDifferences, setShowDifferences] = useState(false);
  const [rateMonitoring, setRateMonitoring] =
    useState<InvoiceRateMonitoringResult[]>([]);

  async function sendUpload(action: "preview" | "replace") {
    if (!file) return;

    if (!billingPeriodId) {
      window.alert("This month does not have a Billing Period ID yet.");
      return;
    }

    const formData = new FormData();
    formData.append("file", file);
    formData.append("fy", fiscalYear);
    formData.append("billing_month_nm", billingMonth);
    formData.append("billing_period_id", billingPeriodId);
    formData.append("action", action);
    formData.append("upload_type", "amr");

    setUploading(true);

    try {
      const response = await fetch(
        "/api/monthly-data/invoices/upload",
        {
          method: "POST",
          body: formData,
        },
      );

      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.error || "Upload failed.");
      }

      setRateMonitoring(
        Array.isArray(result.rateMonitoring)
          ? result.rateMonitoring
          : [],
      );

      if (result.requiresConfirmation) {
        setComparison(result.comparison);
        setPreviewSkipped(result.skipped ?? 0);
        setShowDifferences(false);
        return;
      }

      const skippedText =
        result.skipped > 0
          ? ` ${result.skipped} invalid row(s) were skipped.`
          : "";

      if (result.replaced) {
        window.alert(
          `Billing Period ${result.billingPeriodId} replaced. Deleted ${result.deleted} existing invoice row(s) and imported ${result.imported} new row(s).${skippedText}`,
        );
      } else {
        window.alert(
          `Imported ${result.imported} invoice row(s).${skippedText}`,
        );
      }

      setComparison(null);
      setFile(null);
      onComplete();
    } catch (error) {
      window.alert(
        error instanceof Error ? error.message : "Upload failed.",
      );
    } finally {
      setUploading(false);
    }
  }

  function cancelReplacement() {
    setComparison(null);
    setShowDifferences(false);
  }

  if (comparison) {
    return (
      <div className="md-replacement-panel">
        <div className="md-replacement-header">
          <div>
            <span className="md-invoice-summary-eyebrow">
              Existing Billing Period Detected
            </span>
            <h2>
              Billing Period {billingPeriodId} already contains invoice data
            </h2>
            <p>
              Nothing has been changed yet. Review the comparison below, then
              cancel or replace the entire billing period with the validated CSV.
            </p>
          </div>
        </div>

        <div className="md-replacement-summary">
          <ComparisonMetric label="Existing rows" value={comparison.existing} />
          <ComparisonMetric label="Uploaded rows" value={comparison.uploaded} />
          <ComparisonMetric label="Changed" value={comparison.changed} tone="changed" />
          <ComparisonMetric label="New" value={comparison.new} tone="new" />
          <ComparisonMetric label="Removed" value={comparison.removed} tone="removed" />
          <ComparisonMetric label="Unchanged" value={comparison.unchanged} />
        </div>

        {previewSkipped > 0 && (
          <div className="md-replacement-warning">
            {previewSkipped} invalid CSV row(s) will remain skipped if you replace this period.
          </div>
        )}

        <InvoiceRateMonitoringPanel rows={rateMonitoring} />

        <div className="md-replacement-actions">
          <button
            type="button"
            className="md-secondary-button"
            disabled={uploading}
            onClick={cancelReplacement}
          >
            Cancel
          </button>

          <button
            type="button"
            className="md-secondary-button"
            disabled={uploading}
            onClick={() => setShowDifferences((current) => !current)}
          >
            {showDifferences ? "Hide Differences" : "Review Differences"}
          </button>

          <button
            type="button"
            className="md-danger-button"
            disabled={uploading}
            onClick={() => {
              const confirmed = window.confirm(
                `Replace ALL invoice records for Billing Period ${billingPeriodId}?\n\nThis will delete ${comparison.existing} existing row(s) and import ${comparison.uploaded} validated row(s).`,
              );

              if (confirmed) {
                void sendUpload("replace");
              }
            }}
          >
            {uploading ? "Replacing..." : "Replace Entire Period"}
          </button>
        </div>

        {showDifferences && (
          <InvoiceDifferenceTable comparison={comparison} />
        )}
      </div>
    );
  }

  return (
    <>
      <InvoiceRateMonitoringPanel rows={rateMonitoring} />

      <UploadPanel
        title="Upload Invoice CSV"
        description="Upload the invoice CSV. CUBE validates the file and compares each Utility Group + Utility System invoice rate against the most recent FINAL 3556 Basic Cost A-3 baseline."
        file={file}
        setFile={setFile}
        uploading={uploading}
        onUpload={() => void sendUpload("preview")}
        periodText={`${billingMonth} FY ${fiscalYear}`}
        accept=".csv,text/csv"
        fileLabel="Choose CSV file"
      />
    </>
  );
}

function InvoiceRateMonitoringPanel({
  rows,
}: {
  rows: InvoiceRateMonitoringResult[];
}) {
  if (!rows.length) return null;

  const reviewCount =
    rows.filter((row) => row.status === "REVIEW_REQUIRED").length;

  return (
    <div className="md-replacement-panel">
      <div className="md-replacement-header">
        <div>
          <span className="md-invoice-summary-eyebrow">
            3556 Rate Monitoring
          </span>

          <h2>
            {reviewCount > 0
              ? `${reviewCount} rate review${reviewCount === 1 ? "" : "s"} required`
              : "Invoice rates are within the approved 3556 threshold"}
          </h2>

          <p>
            Current rate = total invoice cost ÷ total invoice consumption.
            The baseline is Basic Cost A-3 from the most recent FINAL 3556
            for the exact Utility Group + Utility System. A variance of
            ±5% or greater requires review.
          </p>
        </div>
      </div>

      {reviewCount > 0 && (
        <div className="md-replacement-warning">
          Utility company rate change detected. Review the affected
          Utility Group + Utility System rate before proceeding with billing.
        </div>
      )}

      <div className="bd-table-scroll">
        <table className="bd-table">
          <thead>
            <tr>
              <th>Utility Group</th>
              <th>Utility</th>
              <th>Total Cost</th>
              <th>Total Consumption</th>
              <th>Invoice Rate</th>
              <th>Approved A-3</th>
              <th>Variance</th>
              <th>Status</th>
            </tr>
          </thead>

          <tbody>
            {rows.map((row) => (
              <tr key={`${row.utilityGroup}-${row.utilitySystem}`}>
                <td><strong>{row.utilityGroup}</strong></td>
                <td>{row.utilitySystem}</td>
                <td>
                  {row.totalCost.toLocaleString(undefined, {
                    style: "currency",
                    currency: "USD",
                  })}
                </td>
                <td>
                  {row.totalConsumption.toLocaleString(undefined, {
                    maximumFractionDigits: 4,
                  })}
                </td>
                <td>
                  {row.currentRate === null
                    ? "—"
                    : row.currentRate.toLocaleString(undefined, {
                        style: "currency",
                        currency: "USD",
                        minimumFractionDigits: 5,
                        maximumFractionDigits: 8,
                      })}
                </td>
                <td>
                  {row.baselineRate === null
                    ? "—"
                    : row.baselineRate.toLocaleString(undefined, {
                        style: "currency",
                        currency: "USD",
                        minimumFractionDigits: 5,
                        maximumFractionDigits: 8,
                      })}
                </td>
                <td>
                  {row.variancePercent === null
                    ? "—"
                    : `${row.variancePercent >= 0 ? "+" : ""}${row.variancePercent.toFixed(2)}%`}
                </td>
                <td>
                  {row.status === "REVIEW_REQUIRED"
                    ? "3556 Rate Review Required"
                    : row.status === "NO_BASELINE"
                      ? "No FINAL 3556 Baseline"
                      : row.status === "NO_CONSUMPTION"
                        ? "No Consumption"
                        : "Within ±5%"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ComparisonMetric({
  label,
  value,
  tone = "",
}: {
  label: string;
  value: number;
  tone?: "" | "changed" | "new" | "removed";
}) {
  return (
    <div className={`md-comparison-metric ${tone ? `md-comparison-${tone}` : ""}`}>
      <span>{label}</span>
      <strong>{value.toLocaleString()}</strong>
    </div>
  );
}

function invoiceDifferenceLabel(row: InvoiceComparisonRow) {
  const item = row.uploaded ?? row.existing ?? {};

  const account =
    String(item.account_nbr ?? item.primary_account_nbr ?? "").trim();

  const utility =
    String(item.utility_type_cd ?? "").trim();

  const provider =
    utilityProviderName(String(item.utility_provider_cd ?? ""));

  return [account || "No account", utility, provider]
    .filter(Boolean)
    .join(" • ");
}

function InvoiceDifferenceTable({
  comparison,
}: {
  comparison: InvoiceComparison;
}) {
  return (
    <div className="md-difference-section">
      <div className="md-difference-heading">
        <div>
          <h3>Invoice Differences</h3>
          <p>
            Unchanged rows are summarized above and are not repeated here.
          </p>
        </div>

        {comparison.rowsTruncated && (
          <span className="md-row-count">
            Showing the first 500 differences
          </span>
        )}
      </div>

      <div className="bd-table-scroll md-difference-scroll">
        <table className="bd-table md-difference-table">
          <thead>
            <tr>
              <th>Status</th>
              <th>Invoice</th>
              <th>Field</th>
              <th>Existing</th>
              <th>Uploaded</th>
            </tr>
          </thead>

          <tbody>
            {comparison.rows.flatMap((row, rowIndex) => {
              if (row.status === "changed" && row.changes?.length) {
                return row.changes.map((change, changeIndex) => (
                  <tr key={`${row.key}-${rowIndex}-${change.field}-${changeIndex}`}>
                    <td>
                      <span className="md-diff-status md-diff-changed">Changed</span>
                    </td>
                    <td>{invoiceDifferenceLabel(row)}</td>
                    <td>{change.field}</td>
                    <td>{change.existing || "—"}</td>
                    <td>{change.uploaded || "—"}</td>
                  </tr>
                ));
              }

              return [
                <tr key={`${row.key}-${rowIndex}`}>
                  <td>
                    <span
                      className={`md-diff-status ${
                        row.status === "new"
                          ? "md-diff-new"
                          : "md-diff-removed"
                      }`}
                    >
                      {row.status === "new" ? "New" : "Removed"}
                    </span>
                  </td>
                  <td>{invoiceDifferenceLabel(row)}</td>
                  <td>Entire row</td>
                  <td>{row.status === "removed" ? "Exists" : "—"}</td>
                  <td>{row.status === "new" ? "New row" : "—"}</td>
                </tr>,
              ];
            })}

            {comparison.rows.length === 0 && (
              <tr>
                <td colSpan={5} className="bd-empty-row">
                  No differences found. The uploaded period matches the existing data.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ============================================================
// AMR UPLOAD
// ============================================================

type AMRPreviewRow = {
  status: "ready" | "error" | "existing" | "mapping";
  sourceMeterid: string;
  meterid: string;
  mappedBy: "direct" | "saved" | "";
  mappingAllowed: boolean;
  sourceFile: string;
  sourceRow: number;
  csvFacilityNbr: string;
  masterFacilityNbr: string;
  dataValue: number | null;
  adjustedConsumption: number | null;
  existingReading: number | null;
  existingConsumption: number | null;
  overwriteAllowed: boolean;
  correctionRule: string;
  usedInCalculation: number;
  reason: string;
  warnings: string[];
};

type AMRMeterOption = {
  meterid: string;
  facility_nbr: string;
  utility_type_cd: string;
  site_cd: string;
  sub_inst_cd: string;
  meter_type_cd: string;
  serial_nbr: string;
  narrative: string;
};

type AMRPreviewSummary = {
  files: number;
  sourceRows: number;
  uniqueMeters: number;
  ready: number;
  errors: number;
  existing: number;
  duplicateRowsRemoved: number;
  missingMeters: number;
  mappingsNeeded: number;
  savedMappingsUsed: number;
  blankDataValues: number;
  conflicts: number;
  facilityWarnings: number;
};

type AMRPreview = {
  success: boolean;
  billingPeriodId: number;
  period: string;
  summary: AMRPreviewSummary;
  rows: AMRPreviewRow[];
  meterOptions: AMRMeterOption[];
  rowsTruncated?: boolean;
};

function AMRUpload({
  fy,
  month,
  billingPeriodId,
  onComplete,
}: {
  fy: string;
  month: string;
  billingPeriodId: string;
  onComplete: () => void;
}) {
  const [files, setFiles] = useState<File[]>([]);
  const [working, setWorking] = useState(false);
  const [preview, setPreview] = useState<AMRPreview | null>(null);
  const [showRows, setShowRows] = useState<"issues" | "all">("issues");
  const [mappingSelections, setMappingSelections] = useState<Record<string, string>>({});
  const [savingMapping, setSavingMapping] = useState<string | null>(null);
  const [savingFacility, setSavingFacility] = useState<string | null>(null);
  const [overwriteMeterIds, setOverwriteMeterIds] = useState<Set<string>>(
    () => new Set(),
  );

  function resetSelection(nextFiles: File[]) {
    setFiles(nextFiles);
    setPreview(null);
    setShowRows("issues");
    setMappingSelections({});
    setOverwriteMeterIds(new Set());
  }

  async function send(action: "preview" | "import") {
    if (!files.length) return;

    if (!billingPeriodId) {
      window.alert("This month does not have a Billing Period ID yet.");
      return;
    }

    const formData = new FormData();

    files.forEach((file) =>
      formData.append("files", file),
    );

    formData.append("fy", fy);
    formData.append("billing_month_nm", month);
    formData.append("billing_period_id", billingPeriodId);
    formData.append("action", action);
    formData.append("upload_type", "amr");

    if (action === "import") {
      overwriteMeterIds.forEach((meterid) => {
        formData.append("overwrite_meterid", meterid);
      });
    }

    setWorking(true);

    try {
      const response = await fetch(
        "/api/monthly-data/meter-reading",
        {
          method: "POST",
          body: formData,
        },
      );

      const responseText = await response.text();

      let result: any;

      try {
        result = responseText
          ? JSON.parse(responseText)
          : {};
      } catch {
        throw new Error(
          responseText ||
            `AMR upload failed with HTTP ${response.status}.`,
        );
      }

      if (!response.ok) {
        throw new Error(
          result.error ||
            `AMR upload failed with HTTP ${response.status}.`,
        );
      }

      if (action === "preview") {
        const nextPreview = result as AMRPreview;

        setPreview(nextPreview);

        setOverwriteMeterIds((current) => {
          const allowed = new Set(
            nextPreview.rows
              .filter(
                (row) =>
                  row.status === "existing" &&
                  row.overwriteAllowed,
              )
              .map((row) => row.meterid),
          );

          return new Set(
            Array.from(current).filter((meterid) =>
              allowed.has(meterid),
            ),
          );
        });

        return;
      }

      const raceText =
        result.alreadyExistsDuringImport > 0
          ? ` ${result.alreadyExistsDuringImport} meter(s) were skipped because a reading was created after preview.`
          : "";

      const overwriteText =
        result.overwritten > 0
          ? ` Overwrote ${result.overwritten} existing meter reading(s).`
          : "";

      const missingOverwriteText =
        result.missingDuringOverwrite > 0
          ? ` ${result.missingDuringOverwrite} overwrite selection(s) were skipped because the existing row disappeared before import.`
          : "";

      window.alert(
        `Imported ${result.imported} new AMR meter reading(s) for Billing Period ${result.billingPeriodId}.${overwriteText}${raceText}${missingOverwriteText}`,
      );

      setFiles([]);
      setPreview(null);
      onComplete();
    } catch (error) {
      window.alert(
        error instanceof Error
          ? error.message
          : "AMR upload failed.",
      );
    } finally {
      setWorking(false);
    }
  }

  async function saveMapping(row: AMRPreviewRow) {
    const mappedMeterid =
      String(
        mappingSelections[row.sourceMeterid] ??
          row.meterid ??
          "",
      ).trim();

    if (!mappedMeterid) {
      window.alert("Select a CUBE meter first.");
      return;
    }

    setSavingMapping(row.sourceMeterid);

    try {
      const response =
        await fetch(
          "/api/monthly-data/meter-reading",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              action: "save_mapping",
              source_meterid: row.sourceMeterid,
              mapped_meterid: mappedMeterid,
              source_facility_nbr: row.csvFacilityNbr,
            }),
          },
        );

      const responseText =
        await response.text();

      let result: any;

      try {
        result =
          responseText
            ? JSON.parse(responseText)
            : {};
      } catch {
        throw new Error(
          responseText ||
            `Unable to save meter mapping. HTTP ${response.status}.`,
        );
      }

      if (!response.ok) {
        throw new Error(
          result.error ||
            "Unable to save meter mapping.",
        );
      }

      setMappingSelections((current) => ({
        ...current,
        [row.sourceMeterid]: mappedMeterid,
      }));

      // Re-run validation using the same selected CSV files.
      // The newly saved DynamoDB mapping will now resolve this row.
      await send("preview");
    } catch (error) {
      window.alert(
        error instanceof Error
          ? error.message
          : "Unable to save meter mapping.",
      );
    } finally {
      setSavingMapping(null);
    }
  }

  function meterOptionLabel(
    meter: AMRMeterOption,
  ) {
    return [
      meter.meterid,
      meter.facility_nbr
        ? `Facility ${meter.facility_nbr}`
        : "",
      meter.utility_type_cd,
      meter.meter_type_cd,
      meter.serial_nbr
        ? `Serial ${meter.serial_nbr}`
        : "",
    ]
      .filter(Boolean)
      .join(" • ");
  }

  async function updateMeterFacility(
    row: AMRPreviewRow,
    facilityNbr: string,
  ) {
    const meterid =
      String(row.meterid ?? "").trim();

    const normalizedFacility =
      String(facilityNbr ?? "").trim();

    if (!meterid || !normalizedFacility) {
      window.alert(
        "A CUBE meter and facility number are required.",
      );
      return;
    }

    const key =
      `${meterid}|${normalizedFacility}`;

    setSavingFacility(key);

    try {
      const response =
        await fetch(
          "/api/monthly-data/meter-reading",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              action: "update_meter_facility",
              meterid,
              facility_nbr: normalizedFacility,
            }),
          },
        );

      const responseText =
        await response.text();

      let result: any;

      try {
        result =
          responseText
            ? JSON.parse(responseText)
            : {};
      } catch {
        throw new Error(
          responseText ||
            `Unable to update meter facility. HTTP ${response.status}.`,
        );
      }

      if (!response.ok) {
        throw new Error(
          result.error ||
            "Unable to update meter facility.",
        );
      }

      // Re-run validation so the meter-master facility now matches
      // the user's selected correct facility.
      await send("preview");
    } catch (error) {
      window.alert(
        error instanceof Error
          ? error.message
          : "Unable to update meter facility.",
      );
    } finally {
      setSavingFacility(null);
    }
  }

  if (!preview) {
    return (
      <div className="md-upload-panel">
        <div className="md-upload-icon">
          <FileSpreadsheet size={28} />
        </div>

        <h2>Upload AMR CSV Files</h2>

        <p>
          Select one or more AMR CSV exports. CUBE will validate the meters,
          remove duplicate report rows, carry forward the previous period's
          correction rule and Used value, and show a preview before anything
          is imported.
        </p>

        <div className="md-upload-period">
          Importing for{" "}
          <strong>
            {month} FY {fy} • Billing Period {billingPeriodId || "Not defined"}
          </strong>
        </div>

        <label className="md-file-picker md-amr-file-picker">
          <Upload size={20} />

          <span>
            {files.length
              ? `${files.length} CSV file${files.length === 1 ? "" : "s"} selected`
              : "Choose AMR CSV files"}
          </span>

          <input
            type="file"
            accept=".csv,text/csv"
            multiple
            onChange={(event) =>
              resetSelection(
                Array.from(event.target.files ?? []),
              )
            }
          />
        </label>

        {files.length > 0 && (
          <div className="md-amr-selected-files">
            {files.map((file) => (
              <span key={`${file.name}-${file.size}`}>
                {file.name}
              </span>
            ))}
          </div>
        )}

        <button
          type="button"
          className="bd-add-button"
          disabled={
            !files.length ||
            working ||
            !billingPeriodId
          }
          onClick={() =>
            void send("preview")
          }
        >
          <Check size={17} />
          {working ? "Validating..." : "Validate AMR Files"}
        </button>
      </div>
    );
  }

  const previewRowsForDisplay =
    preview.rows.filter(
      (row) =>
        !(
          row.status === "existing" &&
          !row.overwriteAllowed
        ),
    );

  const issueRows =
    previewRowsForDisplay.filter(
      (row) =>
        row.status !== "ready" ||
        row.warnings.length > 0,
    );

  const visibleRows =
    showRows === "all"
      ? previewRowsForDisplay
      : issueRows;

  const allowedOverwriteMeterIds = new Set(
    preview.rows
      .filter(
        (row) =>
          row.status === "existing" &&
          row.overwriteAllowed,
      )
      .map((row) => row.meterid),
  );

  const selectedOverwriteCount =
    Array.from(overwriteMeterIds).filter((meterid) =>
      allowedOverwriteMeterIds.has(meterid),
    ).length;

  return (
    <div className="md-amr-preview">
      <div className="md-amr-preview-header">
        <div>
          <span className="md-invoice-summary-eyebrow">
            AMR Validation Preview
          </span>

          <h2>
            {month} FY {fy} • Billing Period {preview.billingPeriodId}
          </h2>

          <p>
            No AMR readings have been written yet. Review the validation
            results, then import the eligible meters.
          </p>
        </div>
      </div>

      <div className="md-amr-summary-grid">
        <AMRMetric label="Source rows" value={preview.summary.sourceRows} />
        <AMRMetric label="Unique meters" value={preview.summary.uniqueMeters} />
        <AMRMetric label="Ready" value={preview.summary.ready} tone="ready" />
        <AMRMetric label="Errors" value={preview.summary.errors} tone="error" />
        <AMRMetric label="Already exists" value={preview.summary.existing} tone="existing" />
        <AMRMetric label="Duplicates removed" value={preview.summary.duplicateRowsRemoved} />
        <AMRMetric label="Needs mapping" value={preview.summary.mappingsNeeded} tone="mapping" />
        <AMRMetric label="Saved mappings" value={preview.summary.savedMappingsUsed} tone="ready" />
        <AMRMetric label="Missing meters" value={preview.summary.missingMeters} tone="mapping" />
        <AMRMetric label="Blank values" value={preview.summary.blankDataValues} tone="error" />
        <AMRMetric label="Conflicts" value={preview.summary.conflicts} tone="error" />
        <AMRMetric label="Facility warnings" value={preview.summary.facilityWarnings} tone="warning" />
      </div>

      <div className="md-amr-preview-actions">
        <div className="md-amr-view-buttons">
          <button
            type="button"
            className="md-secondary-button"
            onClick={() => setShowRows("issues")}
          >
            Issues & Warnings ({issueRows.length})
          </button>

          <button
            type="button"
            className="md-secondary-button"
            onClick={() => setShowRows("all")}
          >
            All Parsed Meters ({previewRowsForDisplay.length})
          </button>
        </div>

        <div className="md-amr-import-buttons">
          <button
            type="button"
            className="md-secondary-button"
            disabled={working}
            onClick={() => {
              setPreview(null);
              setShowRows("issues");
            }}
          >
            Back
          </button>

          <button
            type="button"
            className="bd-add-button"
            disabled={
              working ||
              preview.summary.ready === 0 &&
              selectedOverwriteCount === 0
            }
            onClick={() =>
              void send("import")
            }
          >
            <Upload size={17} />
            {working
              ? "Importing..."
              : `Import ${preview.summary.ready} New${
                  selectedOverwriteCount
                    ? ` + Overwrite ${selectedOverwriteCount}`
                    : ""
                }`}
          </button>
        </div>
      </div>

      <div className="bd-table-panel md-amr-table-panel">
        <div className="bd-table-scroll md-amr-table-scroll">
          <table className="bd-table md-amr-preview-table">
            <thead>
              <tr>
                <th>Status</th>
                <th>Source Meter</th>
                <th>CUBE Meter</th>
                <th>CSV Facility</th>
                <th>Master Facility</th>
                <th>DataValue</th>
                <th>Adjusted Consumption</th>
                <th>Correction Rule</th>
                <th>Used</th>
                <th>Source</th>
                <th>Validation</th>
              </tr>
            </thead>

            <tbody>
              {visibleRows.map((row, index) => (
                <tr key={`${row.sourceFile}-${row.sourceRow}-${row.meterid}-${index}`}>
                  <td>
                    <span
                      className={`md-amr-status md-amr-status-${row.status}`}
                    >
                      {row.status === "ready"
                        ? "Ready"
                        : row.status === "existing"
                          ? "Exists"
                          : row.status === "mapping"
                            ? "Map"
                            : "Error"}
                    </span>
                  </td>

                  <td className="bd-id-cell">
                    {row.sourceMeterid || row.meterid || "—"}
                  </td>

                  <td>
                    {(row.status === "mapping" || row.mappingAllowed) ? (
                      <div className="md-amr-mapping-control">
                        <input
                          type="text"
                          list={`meter-options-${row.sourceMeterid}`}
                          value={
                            mappingSelections[row.sourceMeterid] ??
                            row.meterid ??
                            ""
                          }
                          placeholder="Search/select meter"
                          disabled={savingMapping === row.sourceMeterid}
                          onChange={(event) =>
                            setMappingSelections((current) => ({
                              ...current,
                              [row.sourceMeterid]: event.target.value,
                            }))
                          }
                        />

                        <datalist id={`meter-options-${row.sourceMeterid}`}>
                          {preview.meterOptions.map((meter) => (
                            <option
                              key={meter.meterid}
                              value={meter.meterid}
                            >
                              {meterOptionLabel(meter)}
                            </option>
                          ))}
                        </datalist>

                        <button
                          type="button"
                          className="md-mapping-save-button"
                          disabled={
                            savingMapping === row.sourceMeterid ||
                            !String(
                              mappingSelections[row.sourceMeterid] ??
                              row.meterid ??
                              "",
                            ).trim()
                          }
                          onClick={() =>
                            void saveMapping(row)
                          }
                        >
                          <Check size={14} />
                          {savingMapping === row.sourceMeterid
                            ? "Saving..."
                            : "Save"}
                        </button>
                      </div>
                    ) : (
                      <div className="md-amr-resolved-meter">
                        <strong>{row.meterid || "—"}</strong>
                        {row.mappedBy === "saved" &&
                          row.sourceMeterid !== row.meterid && (
                            <span>Saved mapping</span>
                          )}
                      </div>
                    )}
                  </td>

                  <td>
                    {row.csvFacilityNbr || "—"}
                  </td>

                  <td>
                    {row.masterFacilityNbr || "—"}
                  </td>

                  <td>
                    {row.dataValue === null
                      ? "—"
                      : row.dataValue.toLocaleString(undefined, {
                          maximumFractionDigits: 4,
                        })}
                  </td>

                  <td>
                    {row.adjustedConsumption === null
                      ? "—"
                      : row.adjustedConsumption.toLocaleString(undefined, {
                          maximumFractionDigits: 4,
                        })}
                  </td>

                  <td>
                    {row.correctionRule || "None"}
                  </td>

                  <td>
                    {row.usedInCalculation === 1 ? "Yes" : "No"}
                  </td>

                  <td className="md-amr-source-cell">
                    <strong>{row.sourceFile}</strong>
                    <span>Row {row.sourceRow}</span>
                  </td>

                  <td className="md-amr-validation-cell">
                    {row.reason && (
                      <div className="md-amr-error-text">
                        {row.reason}
                      </div>
                    )}

                    {row.mappingAllowed && (
                      <div className="md-amr-mapping-hint">
                        Select an existing CUBE meter above and save the mapping.
                        Future uploads will reuse it automatically.
                      </div>
                    )}

                    {row.status === "existing" && (
                      <div className="md-existing-overwrite">
                        <div className="md-existing-overwrite-values">
                          <span>
                            Existing: {" "}
                            <strong>
                              {row.existingReading === null
                                ? "—"
                                : row.existingReading.toLocaleString(undefined, {
                                    maximumFractionDigits: 4,
                                  })}
                            </strong>
                          </span>
                          <span>
                            Uploaded: {" "}
                            <strong>
                              {row.dataValue === null
                                ? "—"
                                : row.dataValue.toLocaleString(undefined, {
                                    maximumFractionDigits: 4,
                                  })}
                            </strong>
                          </span>
                        </div>

                        {row.overwriteAllowed ? (
                          <label className="md-overwrite-checkbox">
                            <input
                              type="checkbox"
                              checked={overwriteMeterIds.has(row.meterid)}
                              onChange={(event) => {
                                setOverwriteMeterIds((current) => {
                                  const next = new Set(current);

                                  if (event.target.checked) {
                                    next.add(row.meterid);
                                  } else {
                                    next.delete(row.meterid);
                                  }

                                  return next;
                                });
                              }}
                            />
                            <span>Overwrite existing AMR value on import</span>
                          </label>
                        ) : (
                          <div className="md-amr-ok-text">
                            Existing reading matches the uploaded AMR value. No overwrite is needed.
                          </div>
                        )}
                      </div>
                    )}

                    {row.csvFacilityNbr &&
                      row.masterFacilityNbr &&
                      row.csvFacilityNbr !== row.masterFacilityNbr && (
                        <div className="md-facility-resolution">
                          <div className="md-facility-resolution-title">
                            Which facility is correct?
                          </div>

                          <div className="md-facility-resolution-actions">
                            <button
                              type="button"
                              className="md-facility-choice-button"
                              disabled={Boolean(savingFacility)}
                              onClick={() => {
                                window.alert(
                                  `Keeping meter master facility ${row.masterFacilityNbr}. No meter-master change was made.`,
                                );
                              }}
                            >
                              Keep Master: {row.masterFacilityNbr}
                            </button>

                            <button
                              type="button"
                              className="md-facility-choice-button md-facility-choice-update"
                              disabled={Boolean(savingFacility)}
                              onClick={() =>
                                void updateMeterFacility(
                                  row,
                                  row.csvFacilityNbr,
                                )
                              }
                            >
                              {savingFacility === `${row.meterid}|${row.csvFacilityNbr}`
                                ? "Updating..."
                                : `Use CSV: ${row.csvFacilityNbr}`}
                            </button>
                          </div>

                          <div className="md-facility-resolution-note">
                            Choosing the CSV facility updates facility_nbr for meter {row.meterid} in p72-CUBE-METERS and then revalidates the upload.
                          </div>
                        </div>
                      )}

                    {row.warnings.map((warning, warningIndex) => (
                      <div
                        key={`${warning}-${warningIndex}`}
                        className="md-amr-warning-text"
                      >
                        {warning}
                      </div>
                    ))}

                    {!row.reason && row.warnings.length === 0 && (
                      <span className="md-amr-ok-text">
                        Valid
                      </span>
                    )}
                  </td>
                </tr>
              ))}

              {visibleRows.length === 0 && (
                <tr>
                  <td colSpan={11} className="bd-empty-row">
                    No changed or actionable AMR records were found.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {preview.rowsTruncated && (
        <div className="md-amr-truncated">
          Preview is limited to the first 1,000 parsed meter results.
        </div>
      )}
    </div>
  );
}

function AMRMetric({
  label,
  value,
  tone = "",
}: {
  label: string;
  value: number;
  tone?: "" | "ready" | "error" | "existing" | "warning" | "mapping";
}) {
  return (
    <div
      className={`md-amr-metric ${
        tone ? `md-amr-metric-${tone}` : ""
      }`}
    >
      <span>{label}</span>
      <strong>{value.toLocaleString()}</strong>
    </div>
  );
}

// ============================================================
// READING UPLOAD
// ============================================================

type ManualPreviewRow = {
  status: "ready" | "error" | "existing" | "mapping";
  sourceMeterid: string;
  meterid: string;
  sourceFile: string;
  sourceRow: number;
  facilityNbr: string;
  previousReading: number | null;
  currentReading: number | null;
  rollover: number | null;
  multiplier: number | null;
  consumption: number | null;
  adjustedConsumption: number | null;
  correctionRule: string;
  usedInCalculation: number;
  rolloverApplied: boolean;
  rolloverUsed?: boolean;
  existingReading: number | null;
  existingConsumption: number | null;
  existingAdjustedConsumption?: number | null;
  overwriteAllowed: boolean;
  reason: string;
  warnings: string[];
};

type ManualPreview = {
  success: boolean;
  billingPeriodId: number;
  period: string;
  summary: {
    files: number;
    sourceRows: number;
    ready: number;
    errors: number;
    mappingsNeeded: number;
    existing: number;
    blankReadings: number;
    missingMeters: number;
    missingPrevious: number;
    rolloverCount: number;
    missingRollover: number;
    duplicates: number;
    eligibleForWrite: number;
  };
  rows: ManualPreviewRow[];
  rowsTruncated?: boolean;
};

type ManualEdit = {
  currentReading: string;
  adjustedConsumption: string;
};

function ManualUpload({
  fy,
  month,
  billingPeriodId,
  onComplete,
}: {
  fy: string;
  month: string;
  billingPeriodId: string;
  onComplete: () => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [working, setWorking] = useState(false);
  const [preview, setPreview] = useState<ManualPreview | null>(null);
  const [showRows, setShowRows] = useState<"issues" | "all">("issues");
  const [edits, setEdits] = useState<Record<string, ManualEdit>>({});

  function editKey(row: ManualPreviewRow) {
    return (row.meterid || row.sourceMeterid).trim();
  }

  function currentReadingValue(row: ManualPreviewRow) {
    const key = editKey(row);
    return edits[key]?.currentReading ??
      (row.currentReading === null ? "" : String(row.currentReading));
  }

  function updateCurrentReading(row: ManualPreviewRow, value: string) {
    const key = editKey(row);
    if (!key) return;

    setEdits((current) => ({
      ...current,
      [key]: {
        currentReading: value,
        adjustedConsumption: current[key]?.adjustedConsumption ?? "",
      },
    }));
  }

  function resetFile(nextFile: File | null) {
    setFile(nextFile);
    setPreview(null);
    setShowRows("issues");
    setEdits({});
  }

  async function send(action: "preview" | "import") {
    if (!file) return;

    if (!billingPeriodId) {
      window.alert("This month does not have a Billing Period ID yet.");
      return;
    }

    const formData = new FormData();
    formData.append("files", file);
    formData.append("fy", fy);
    formData.append("billing_month_nm", month);
    formData.append("billing_period_id", billingPeriodId);
    formData.append("action", action);
    formData.append("upload_type", "manual");

    // Current Reading can be corrected only during the pre-import manual
    // preview. The API recalculates consumption, rollover, adjusted
    // consumption, validation and ZeroReadingStreak from this value.
    for (const [meterid, edit] of Object.entries(edits)) {
      if (!meterid || edit.currentReading.trim() === "") continue;

      formData.append(
        "manual_edit",
        JSON.stringify({
          meterid,
          current_reading: edit.currentReading,
        }),
      );
    }

    setWorking(true);

    try {
      const response = await fetch("/api/monthly-data/meter-reading", {
        method: "POST",
        body: formData,
      });

      const text = await response.text();
      let result: any;

      try {
        result = text ? JSON.parse(text) : {};
      } catch {
        throw new Error(text || `Manual upload failed with HTTP ${response.status}.`);
      }

      if (!response.ok) {
        throw new Error(result.error || "Manual upload failed.");
      }

      if (action === "preview") {
        setPreview(result as ManualPreview);
        return;
      }

      const skipped = result.summary?.authoritySkipped ?? 0;
      const invalid = result.summary?.invalidReadMethod ?? 0;
      const alreadyExists = result.alreadyExistsDuringImport ?? 0;

      window.alert(
        `Manual import complete. Imported ${result.imported ?? 0}; ` +
        `replaced ${result.overwritten ?? 0}; ` +
        `skipped by authoritative source ${skipped}; ` +
        `invalid read method ${invalid}; ` +
        `concurrent existing records ${alreadyExists}.`,
      );

      setFile(null);
      setPreview(null);
      setEdits({});
      onComplete();
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "Manual upload failed.");
    } finally {
      setWorking(false);
    }
  }

  if (!preview) {
    return (
      <div className="md-upload-panel">
        <div className="md-upload-icon">
          <FileSpreadsheet size={28} />
        </div>

        <h2>Upload Manual Readings</h2>

        <p>
          Select the manual-reading CSV and preview it before importing. CUBE
          validates each meter against its inventory read method and uses the
          inventory read method&apos;s ROLLOVER_USED setting to determine whether a
          lower current reading is treated as a meter rollover.
        </p>

        <div className="md-upload-period">
          <span>Selected period</span>
          <strong>
            {month} FY {fy} • Billing Period {billingPeriodId || "Not defined"}
          </strong>
        </div>

        <label className="md-file-picker">
          <span>{file ? file.name : "Choose manual reading CSV"}</span>
          <input
            type="file"
            accept=".csv,text/csv"
            disabled={working}
            onChange={(event) => resetFile(event.target.files?.[0] ?? null)}
          />
        </label>

        <div className="md-upload-actions">
          <button
            type="button"
            className="md-primary-button"
            disabled={!file || working || !billingPeriodId}
            onClick={() => void send("preview")}
          >
            {working ? "Validating..." : "Preview Manual Readings"}
          </button>
        </div>

        <div className="md-summary-note">
          <strong>Rollover:</strong>{" "}
          CUBE reads ROLLOVER_USED from p72-CUBE-INV-READ-METHODS. A lower
          current reading uses the meter-master rollover value only when that
          inventory method has ROLLOVER_USED = 1. Methods with ROLLOVER_USED = 0
          do not use rollover math.
        </div>
      </div>
    );
  }

  const visibleRows =
    showRows === "all"
      ? preview.rows
      : preview.rows.filter(
          (row) => row.status !== "ready" || row.warnings.length > 0 || row.rolloverApplied,
        );

  return (
    <div className="md-upload-panel md-amr-preview-panel">
      <div className="md-amr-preview-header">
        <div>
          <h2>Manual Reading Preview</h2>
          <p>
            Review calculated consumption and rollover handling before writing
            anything to DynamoDB. Current Reading is editable before import;
            leaving the field recalculates the preview from the corrected value.
          </p>
        </div>

        <div className="md-upload-actions">
          <button
            type="button"
            className="bd-button"
            disabled={working}
            onClick={() => resetFile(null)}
          >
            Choose Different File
          </button>

          <button
            type="button"
            className="bd-button"
            disabled={working}
            onClick={() => void send("preview")}
          >
            {working ? "Refreshing..." : "Refresh Preview"}
          </button>

          <button
            type="button"
            className="bd-add-button"
            disabled={working || preview.summary.eligibleForWrite === 0}
            onClick={() => void send("import")}
          >
            <Upload size={17} />
            {working
              ? "Importing..."
              : `Import ${preview.summary.eligibleForWrite} Reading${preview.summary.eligibleForWrite === 1 ? "" : "s"}`}
          </button>
        </div>
      </div>

      <div className="md-amr-metrics">
        <AMRMetric label="Source Rows" value={preview.summary.sourceRows} />
        <AMRMetric label="Ready" value={preview.summary.ready} tone="ready" />
        <AMRMetric label="Existing" value={preview.summary.existing} tone="existing" />
        <AMRMetric label="Errors" value={preview.summary.errors} tone="error" />
        <AMRMetric label="Rollover Applied" value={preview.summary.rolloverCount} tone="warning" />
        <AMRMetric label="Missing Rollover" value={preview.summary.missingRollover} tone="error" />
        <AMRMetric label="Eligible to Write" value={preview.summary.eligibleForWrite} tone="ready" />
      </div>

      <div className="md-amr-preview-controls">
        <button
          type="button"
          className={showRows === "issues" ? "bd-button bd-button-active" : "bd-button"}
          onClick={() => setShowRows("issues")}
        >
          Issues / Rollovers
        </button>
        <button
          type="button"
          className={showRows === "all" ? "bd-button bd-button-active" : "bd-button"}
          onClick={() => setShowRows("all")}
        >
          All Rows
        </button>
      </div>

      <div className="bd-table-panel md-amr-table-panel">
        <div className="bd-table-scroll md-amr-table-scroll">
          <table className="bd-table md-amr-preview-table">
            <thead>
              <tr>
                <th>Status</th>
                <th>Meter</th>
                <th>Facility</th>
                <th>Previous</th>
                <th>Current</th>
                <th>Multiplier</th>
                <th>Rollover Value</th>
                <th>Rollover Enabled</th>
                <th>Rollover Applied</th>
                <th>Consumption</th>
                <th>Adjusted Consumption</th>
                <th>Correction Rule</th>
                <th>Used</th>
                <th>Validation</th>
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((row, index) => (
                <tr key={`${row.sourceFile}-${row.sourceRow}-${row.meterid}-${index}`}>
                  <td>
                    <span className={`md-amr-status md-amr-status-${row.status}`}>
                      {row.status === "ready"
                        ? "Ready"
                        : row.status === "existing"
                          ? "Exists"
                          : row.status === "mapping"
                            ? "Map"
                            : "Error"}
                    </span>
                  </td>
                  <td className="bd-id-cell">{row.meterid || row.sourceMeterid || "—"}</td>
                  <td>{row.facilityNbr || "—"}</td>
                  <td>{row.previousReading === null ? "—" : row.previousReading.toLocaleString()}</td>
                  <td>
                    {row.status === "existing" ? (
                      <span title="Already imported raw readings are locked.">
                        {row.currentReading === null ? "—" : row.currentReading.toLocaleString()}
                      </span>
                    ) : (
                      <input
                        type="number"
                        step="any"
                        className="md-reading-input"
                        value={currentReadingValue(row)}
                        disabled={working || row.status === "mapping"}
                        aria-label={`Current reading for ${row.meterid || row.sourceMeterid}`}
                        onChange={(event) =>
                          updateCurrentReading(row, event.target.value)
                        }
                        onBlur={() => {
                          const key = editKey(row);
                          if (key && edits[key]) {
                            void send("preview");
                          }
                        }}
                      />
                    )}
                  </td>
                  <td>{row.multiplier === null ? "—" : row.multiplier.toLocaleString()}</td>
                  <td>{row.rollover === null ? "—" : row.rollover.toLocaleString()}</td>
                  <td>
                    {row.rolloverUsed === undefined ? "—" : row.rolloverUsed ? "Yes" : "No"}
                  </td>
                  <td>{row.rolloverApplied ? "Yes" : "No"}</td>
                  <td>{row.consumption === null ? "—" : row.consumption.toLocaleString(undefined, { maximumFractionDigits: 4 })}</td>
                  <td>{row.adjustedConsumption === null ? "—" : row.adjustedConsumption.toLocaleString(undefined, { maximumFractionDigits: 4 })}</td>
                  <td>{row.correctionRule || "None"}</td>
                  <td>{row.usedInCalculation === 1 ? "Yes" : "No"}</td>
                  <td className="md-amr-validation-cell">
                    {row.reason && <div className="md-amr-error-text">{row.reason}</div>}
                    {row.rolloverApplied && (
                      <div className="md-amr-ok-text">
                        Rollover applied because this inventory read method has ROLLOVER_USED = 1 and the current reading is below the previous reading.
                      </div>
                    )}
                    {row.warnings.map((warning, warningIndex) => (
                      <div className="md-amr-warning-text" key={`${warning}-${warningIndex}`}>
                        {warning}
                      </div>
                    ))}
                  </td>
                </tr>
              ))}

              {visibleRows.length === 0 && (
                <tr>
                  <td colSpan={14} className="bd-empty-row">
                    No issues or rollover rows. Select All Rows to review the complete preview.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {preview.rowsTruncated && (
        <div className="md-amr-truncated">
          Preview is limited to the first 1,000 parsed meter results.
        </div>
      )}

      <div className="md-summary-note">
        <strong>Calculation rule:</strong>{" "}
        If ROLLOVER_USED = 1 and Current Reading &lt; Previous Reading,
        consumption uses ((Rollover − Previous) + Current) × Multiplier.
        Otherwise consumption uses (Current − Previous) × Multiplier. The
        rollover value is required only when rollover is enabled and actually
        needed.
      </div>
    </div>
  );
}

// ============================================================
// SHARED UPLOAD PANEL
// ============================================================

function UploadPanel({
  title,
  description,
  file,
  setFile,
  uploading,
  onUpload,
  periodText,
  accept,
  fileLabel,
}: {
  title:
    string;

  description:
    string;

  file:
    File | null;

  setFile:
    (
      file:
        File | null,
    ) => void;

  uploading:
    boolean;

  onUpload:
    () => void;

  periodText:
    string;

  accept:
    string;

  fileLabel:
    string;
}) {
  return (
    <div className="md-upload-panel">
      <div className="md-upload-icon">
        <FileSpreadsheet
          size={28}
        />
      </div>

      <h2>
        {title}
      </h2>

      <p>
        {description}
      </p>

      <div className="md-upload-period">
        Importing for{" "}
        <strong>
          {
            periodText
          }
        </strong>
      </div>

      <label className="md-file-picker">
        <Upload
          size={20}
        />

        <span>
          {file
            ? file.name
            : fileLabel}
        </span>

        <input
          type="file"
          accept={
            accept
          }
          onChange={(
            event,
          ) =>
            setFile(
              event.target
                .files?.[0] ??
                null,
            )
          }
        />
      </label>

      <button
        type="button"
        className="bd-add-button"
        disabled={
          !file ||
          uploading
        }
        onClick={
          onUpload
        }
      >
        <Upload
          size={17}
        />

        {uploading
          ? "Importing..."
          : "Import File"}
      </button>
    </div>
  );
}
