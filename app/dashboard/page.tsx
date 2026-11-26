import Link from "next/link";

import { redirect } from "next/navigation";

import { unstable_cache } from "next/cache";

import DevUserMenu from "@/dev-only/auth/user-menu";

import {

  QueryCommand,

  ScanCommand,

  type QueryCommandInput,

  type ScanCommandInput,

} from "@aws-sdk/lib-dynamodb";

import {

  BarChart3,

  Bell,

  CalendarDays,

  ChevronDown,

  Database,

  FileText,

  Home,

  ShieldCheck,

  Table2,

} from "lucide-react";

// ============================================================

// AUTHENTICATION (selected centrally through AUTH_MODE)

// Keep disabled for local development. Enable only when deploying with Auth.js.

// ============================================================

import { signOut } from "@/lib/auth";
import { getAppSession } from "@/lib/app-session";
import { isLocalAuth } from "@/lib/auth-mode";

import { ddb } from "@/lib/dynamo";

import { usesPeriodSnapshot } from "@/lib/real-property-effective-core";
import {
  filterActiveRealPropertyRecords,
  getRealPropertyPeriodState,
  logicalMonthlyRpId,
} from "@/lib/real-property-snapshot";

import { DashboardClient, type DashboardData } from "./dashboard-client";

import "./dashboard.css";

export const dynamic = "force-dynamic";

// ============================================================

// TABLES

// ============================================================

const METER_READINGS_TABLE = "p72-CUBE-METER-READINGS";

const METERS_TABLE = "p72-CUBE-METERS";

const INVOICES_TABLE = "p72-CUBE-INVOICES";

const ESTIMATES_TABLE = "p72-CUBE-ESTIMATES";

const RP_MONTHLY_TABLE = "p72-CUBE-RP-MONTHLY";

const RP_LEGACY_TABLE = "p72-CUBE-RP-LEGACY";

// ============================================================

// INDEXES

// ============================================================

const FY_INDEX = "fy-index";

const BILLING_PERIOD_INDEX = "billing-period-index";

// ============================================================

// MONTHS

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

const FISCAL_MONTHS = [

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

const UTILITY_NAMES: Record<string, string> = {

  EL: "Electric",

  NG: "Natural Gas",

  PW: "Purchase/Produced Water",

  SS: "Sewer",

};

const NATURAL_GAS_MMBTU_PER_CF = 0.001031;

function normalizeInvoiceConsumption(

  utility: string,

  consumption: number,

  unitValue: unknown,

): number {

  const unit = text(unitValue).toUpperCase().replace(/\s+/g, "");

  if (utility === "EL") {

    if (unit === "MWH") return consumption * 1000;

    return consumption;

  }

  if (utility === "NG") {

    if (unit === "CF") return consumption * NATURAL_GAS_MMBTU_PER_CF;

    if (unit === "MCF") return consumption * 1000 * NATURAL_GAS_MMBTU_PER_CF;

    if (unit === "THERM" || unit === "THERMS") return consumption * 0.1;

    return consumption;

  }

  if (utility === "PW" || utility === "SS") {

    if (unit === "GAL" || unit === "GALLON" || unit === "GALLONS") {

      return consumption / 1000;

    }

    return consumption;

  }

  return consumption;

}

// ============================================================

// NAVIGATION

// ============================================================

const navItems = [

  { label: "Dashboard", icon: Home, href: "/dashboard", active: true },

  { label: "Background Data", icon: Database, href: "/backgrounddata" },

  { label: "Billing", icon: FileText, href: "/billing" },

  { label: "Data Validation", icon: ShieldCheck, href: "/data-validation" },

  { label: "Monthly Data", icon: CalendarDays, href: "/monthly-data" },

  { label: "Yearly Data", icon: Table2, href: "/yearly-data" },

  { label: "Report & Analysis", icon: BarChart3, href: "/reports" },

];

// ============================================================

// BASIC HELPERS

// ============================================================

type Item = Record<string, unknown>;

function text(value: unknown): string {

  return value === undefined || value === null ? "" : String(value).trim();

}

function numberValue(value: unknown): number {

  const parsed = Number(text(value).replace(/[$,]/g, ""));

  return Number.isFinite(parsed) ? parsed : 0;

}

function getCurrentFY(): string {

  const now = new Date();

  const month = now.getMonth() + 1;

  return String(month >= 10 ? now.getFullYear() + 1 : now.getFullYear());

}

function getCurrentMonth(): string {

  return MONTHS[new Date().getMonth()];

}

function getFiscalYears(selectedFY: string): string[] {

  const currentFY = Number(getCurrentFY());

  const requestedFY = Number(selectedFY);

  const highestFY = Math.max(

    currentFY,

    Number.isFinite(requestedFY) ? requestedFY : currentFY,

  );

  return Array.from({ length: 12 }, (_, index) =>

    String(highestFY - index),

  );

}

function variancePercent(

  actual: number,

  comparison: number,

): number | null {

  if (comparison === 0) {

    return null;

  }

  return ((actual - comparison) / comparison) * 100;

}

function isEnabledFlag(value: unknown): boolean {

  const normalized = text(value).toUpperCase();

  return ["1", "Y", "YES", "TRUE", "X"].includes(normalized);

}

function getReadingConsumption(item: Item): number {

  const adjusted = text(item.adjusted_consumption);

  return adjusted !== ""

    ? numberValue(adjusted)

    : numberValue(item.consumption);

}

// ============================================================

// FULL TABLE SCAN

// Used only for relatively small reference/master tables.

// ============================================================

async function scanAll(

  tableName: string,

  projectionExpression?: string,

): Promise<Item[]> {

  const items: Item[] = [];

  let exclusiveStartKey:

    | ScanCommandInput["ExclusiveStartKey"]

    | undefined;

  do {

    const result = await ddb.send(

      new ScanCommand({

        TableName: tableName,

        ProjectionExpression: projectionExpression,

        ExclusiveStartKey: exclusiveStartKey,

      }),

    );

    items.push(...((result.Items ?? []) as Item[]));

    exclusiveStartKey = result.LastEvaluatedKey;

  } while (exclusiveStartKey);

  return items;

}

// ============================================================

// QUERY BY FY

// Meter readings and invoices already use fy-index.

// ============================================================

async function queryByFY(

  tableName: string,

  fy: string,

  projectionExpression: string,

): Promise<Item[]> {

  const items: Item[] = [];

  let exclusiveStartKey:

    | QueryCommandInput["ExclusiveStartKey"]

    | undefined;

  do {

    const result = await ddb.send(

      new QueryCommand({

        TableName: tableName,

        IndexName: FY_INDEX,

        KeyConditionExpression: "#fy = :fy",

        ExpressionAttributeNames: {

          "#fy": "fy",

        },

        ExpressionAttributeValues: {

          ":fy": Number(fy),

        },

        ProjectionExpression: projectionExpression,

        ExclusiveStartKey: exclusiveStartKey,

      }),

    );

    items.push(...((result.Items ?? []) as Item[]));

    exclusiveStartKey = result.LastEvaluatedKey;

  } while (exclusiveStartKey);

  return items;

}

// ============================================================

// QUERY BY BILLING PERIOD

// Used by estimates and monthly RP.

// ============================================================

async function queryByBillingPeriod(

  tableName: string,

  billingPeriodId: number,

): Promise<Item[]> {

  const items: Item[] = [];

  let exclusiveStartKey:

    | QueryCommandInput["ExclusiveStartKey"]

    | undefined;

  do {

    const result = await ddb.send(

      new QueryCommand({

        TableName: tableName,

        IndexName: BILLING_PERIOD_INDEX,

        KeyConditionExpression: "#bp = :bp",

        ExpressionAttributeNames: {

          "#bp": "billing_period_id",

        },

        ExpressionAttributeValues: {

          ":bp": billingPeriodId,

        },

        ExclusiveStartKey: exclusiveStartKey,

      }),

    );

    items.push(...((result.Items ?? []) as Item[]));

    exclusiveStartKey = result.LastEvaluatedKey;

  } while (exclusiveStartKey);

  return filterActiveRealPropertyRecords(tableName, billingPeriodId, items);

}

// ============================================================

// SHORT-LIVED SERVER CACHE

//

// The dashboard remains dynamic, but expensive DynamoDB reads are

// reused briefly across navigation/refreshes. This keeps newly

// imported data reasonably fresh without rebuilding the dashboard

// from scratch on every request.

//

// Change these values if you want a different freshness window.

// ============================================================

const DASHBOARD_CACHE_SECONDS = 30;

const REFERENCE_CACHE_SECONDS = 120;

const loadMetersCached = unstable_cache(

  async () =>

    scanAll(

      METERS_TABLE,

      [

        "meterid",

        "utility_type_cd",

        "ZeroReadingStreak",

        "zerostreak",

        "ZeroStreak",

      ].join(", "),

    ),

  ["cube-dashboard-meters"],

  { revalidate: REFERENCE_CACHE_SECONDS },

);

const loadReadingsByFYCached = unstable_cache(

  async (fy: string) =>

    queryByFY(

      METER_READINGS_TABLE,

      fy,

      [

        "meterid",

        "fy",

        "billing_month_nm",

        "billing_period_id",

        "consumption",

        "adjusted_consumption",

        "used_in_calculation",

        "meter_correction_rule_cd",

      ].join(", "),

    ),

  ["cube-dashboard-readings-by-fy"],

  { revalidate: DASHBOARD_CACHE_SECONDS },

);

const loadInvoicesByFYCached = unstable_cache(

  async (fy: string) =>

    queryByFY(

      INVOICES_TABLE,

      fy,

      [

        "fy",

        "billing_month_nm",

        "billing_period_id",

        "utility_type_cd",

        "consumption",

        "consumption_um",

        "charge",

      ].join(", "),

    ),

  ["cube-dashboard-invoices-by-fy"],

  { revalidate: DASHBOARD_CACHE_SECONDS },

);

const loadEstimatesByBillingPeriodCached = unstable_cache(

  async (billingPeriodId: number) =>

    queryByBillingPeriod(ESTIMATES_TABLE, billingPeriodId),

  ["cube-dashboard-estimates-by-billing-period"],

  { revalidate: DASHBOARD_CACHE_SECONDS },

);

const loadMonthlyRPByBillingPeriodCached = unstable_cache(

  async (billingPeriodId: number) =>

    queryByBillingPeriod(RP_MONTHLY_TABLE, billingPeriodId),

  ["cube-dashboard-rp-monthly-by-billing-period"],

  { revalidate: DASHBOARD_CACHE_SECONDS },

);

// ============================================================

// LEGACY RP

//

// Legacy RP is an annual FY snapshot. It does not use the

// monthly billing_period_id field used by current RP.

// ============================================================

async function loadLegacyRP(fy: number): Promise<Item[]> {

  const allLegacy = await scanAll(RP_LEGACY_TABLE);

  return allLegacy.filter(

    (item) => numberValue(item.FY ?? item.fy) === fy,

  );

}

// ============================================================

// DATA LOAD

// ============================================================

async function loadDashboardData(

  selectedFY: string,

  selectedMonth: string,

): Promise<DashboardData> {

  // ----------------------------------------------------------

  // Core FY data

  // ----------------------------------------------------------

  const [

    meterItems,

    readingItems,

    invoiceItems,

  ] = await Promise.all([

    loadMetersCached(),

    loadReadingsByFYCached(selectedFY),

    loadInvoicesByFYCached(selectedFY),

  ]);

  // ----------------------------------------------------------

  // Meter -> utility lookup

  // ----------------------------------------------------------

  const meterUtility = new Map<string, string>();

  for (const item of meterItems) {

    const meterId = text(item.meterid);

    if (!meterId) {

      continue;

    }

    meterUtility.set(

      meterId,

      text(item.utility_type_cd).toUpperCase() || "UNKNOWN",

    );

  }

  // ----------------------------------------------------------

  // Build billing period map from readings + invoices

  // ----------------------------------------------------------

  type WorkingPeriod = {

    billingPeriodId: number | null;

    metered: number;

    invoiced: number;

    estimated: number;

    invoiceCharges: number;

    readingCount: number;

    approvedCount: number;

    correctedCount: number;

    invoiceCount: number;

    meterByUtility: Map<string, number>;

    invoiceByUtility: Map<string, number>;

    estimateByUtility: Map<string, number>;

    invoiceChargeByUtility: Map<string, number>;

  };

  const workingPeriods = new Map<string, WorkingPeriod>();

  function ensurePeriod(month: string): WorkingPeriod {

    const existing = workingPeriods.get(month);

    if (existing) {

      return existing;

    }

    const created: WorkingPeriod = {

      billingPeriodId: null,

      metered: 0,

      invoiced: 0,

      estimated: 0,

      invoiceCharges: 0,

      readingCount: 0,

      approvedCount: 0,

      correctedCount: 0,

      invoiceCount: 0,

      meterByUtility: new Map(),

      invoiceByUtility: new Map(),

      estimateByUtility: new Map(),

      invoiceChargeByUtility: new Map(),

    };

    workingPeriods.set(month, created);

    return created;

  }

  for (const item of readingItems) {

  const month = text(item.billing_month_nm);

  if (!month) {

    continue;

  }

  const period = ensurePeriod(month);

  const billingPeriodId = numberValue(item.billing_period_id);

  // Keep billing-period discovery independent of whether

  // this particular reading is used in calculations.

  if (

    billingPeriodId > 0 &&

    period.billingPeriodId === null

  ) {

    period.billingPeriodId = billingPeriodId;

  }

  // ----------------------------------------------------------

  // Readings marked used_in_calculation = 1 or 0 contribute

  // to dashboard meter consumption.

  // ----------------------------------------------------------

  const usedInCalculation =

      numberValue(item.used_in_calculation);

    if (

      usedInCalculation !== 1

      // &&

      // usedInCalculation !== 0

    ) {

      continue;

    }

  const meterId = text(item.meterid);

    const utility =

      meterUtility.get(meterId) ?? "UNKNOWN";

    const rawConsumption =

      getReadingConsumption(item);

    // NG meter consumption is stored in CF.

    // Convert raw or adjusted NG consumption to MMBtu before totals.

    const consumption =

      utility === "NG"

        ? rawConsumption * NATURAL_GAS_MMBTU_PER_CF

        : rawConsumption;

    period.metered += consumption;

    period.readingCount += 1;

    period.approvedCount += 1;

    if (

      text(item.meter_correction_rule_cd) !== ""

    ) {

      period.correctedCount += 1;

    }

    period.meterByUtility.set(

      utility,

      (period.meterByUtility.get(utility) ?? 0) + consumption,

    );

}

  for (const item of invoiceItems) {

    const month = text(item.billing_month_nm);

    if (!month) {

      continue;

    }

    const period = ensurePeriod(month);

    const billingPeriodId = numberValue(item.billing_period_id);

    if (billingPeriodId > 0 && period.billingPeriodId === null) {

      period.billingPeriodId = billingPeriodId;

    }

    const rawConsumption = numberValue(item.consumption);

    const charge = numberValue(item.charge);

    const utility = text(item.utility_type_cd).toUpperCase() || "UNKNOWN";

    // Canonical dashboard units:

    // EL = KWH, NG = MMBtu, PW/SS = KGAL.

    const consumption = normalizeInvoiceConsumption(

      utility,

      rawConsumption,

      item.consumption_um,

    );

    period.invoiced += consumption;

    period.invoiceCharges += charge;

    period.invoiceCount += 1;

    period.invoiceByUtility.set(

      utility,

      (period.invoiceByUtility.get(utility) ?? 0) + consumption,

    );

    period.invoiceChargeByUtility.set(

      utility,

      (period.invoiceChargeByUtility.get(utility) ?? 0) + charge,

    );

  }

  // ----------------------------------------------------------

  // Estimates for each FY billing period

  // ----------------------------------------------------------

  const billingPeriodIds = Array.from(

    new Set(

      Array.from(workingPeriods.values())

        .map((period) => period.billingPeriodId)

        .filter(

          (value): value is number =>

            value !== null && Number.isInteger(value) && value > 0,

        ),

    ),

  );

  const estimateGroups = await Promise.all(
    billingPeriodIds.map(async (billingPeriodId) => {
      const state = await getRealPropertyPeriodState(billingPeriodId);
      return state
        ? queryByBillingPeriod(ESTIMATES_TABLE, billingPeriodId)
        : loadEstimatesByBillingPeriodCached(billingPeriodId);
    }),
  );

  const estimateItems = estimateGroups.flat();

  const monthByBillingPeriod = new Map<number, string>();

  workingPeriods.forEach((period, month) => {

    if (period.billingPeriodId !== null) {

      monthByBillingPeriod.set(period.billingPeriodId, month);

    }

  });

  for (const item of estimateItems) {

    const billingPeriodId = numberValue(item.billing_period_id);

    const month =

      monthByBillingPeriod.get(billingPeriodId) ||

      text(item.BillingMonth);

    if (!month) {

      continue;

    }

    const period = ensurePeriod(month);

    const estimatedUsage = numberValue(item.EstimatedUsage);

    const utility = text(item.UtilityType).toUpperCase() || "UNKNOWN";

    period.estimated += estimatedUsage;

    period.estimateByUtility.set(

      utility,

      (period.estimateByUtility.get(utility) ?? 0) + estimatedUsage,

    );

  }

  // ----------------------------------------------------------

  // Selected period

  // ----------------------------------------------------------

  const selectedPeriod =

    workingPeriods.get(selectedMonth) ?? ensurePeriod(selectedMonth);

  const selectedBillingPeriodId =

    selectedPeriod.billingPeriodId;

  // ----------------------------------------------------------

  // Selected-period RP

  // Earlier periods use annual legacy RP until a month-specific override
  // snapshot exists. The annual baseline remains unchanged.

  // ----------------------------------------------------------

  let realPropertyItems: Item[] = [];

  const selectedRpState =
    selectedBillingPeriodId !== null
      ? await getRealPropertyPeriodState(selectedBillingPeriodId)
      : null;

  if (
    selectedBillingPeriodId !== null &&
    usesPeriodSnapshot(selectedBillingPeriodId, selectedRpState !== null)
  ) {
    const selectedRpItems = selectedRpState
      ? await queryByBillingPeriod(RP_MONTHLY_TABLE, selectedBillingPeriodId)
      : await loadMonthlyRPByBillingPeriodCached(selectedBillingPeriodId);
    realPropertyItems = selectedRpItems.map((item) => ({
      ...item,
      StorageMonthlyRPID: item.MonthlyRPID,
      MonthlyRPID: logicalMonthlyRpId(item),
    }));

  } else {

    realPropertyItems = await loadLegacyRP(Number(selectedFY));

  }

  const selectedEstimates =

    selectedBillingPeriodId !== null

      ? estimateItems.filter(

          (item) =>

            numberValue(item.billing_period_id) ===

            selectedBillingPeriodId,

        )

      : [];

  // ----------------------------------------------------------

  // Processing status

  // ----------------------------------------------------------

  const realPropertyLoaded = realPropertyItems.length > 0;

  const estimatesGenerated = selectedEstimates.length > 0;

  const meterDataLoaded = selectedPeriod.readingCount > 0;

  const invoicesLoaded = selectedPeriod.invoiceCount > 0;

  // For now, validation attention is derived from readings not

  // yet approved for calculation. This uses data already present

  // in the meter-reading table and avoids inventing a separate

  // validation table dependency.

  const validationReviews = 0;

  // ----------------------------------------------------------

  // Zero streak meter count

  // ----------------------------------------------------------

  const zeroReadingMeters = meterItems.filter((item) => {

    const streak = numberValue(

      item.ZeroReadingStreak ??

        item.zerostreak ??

        item.ZeroStreak,

    );

    return streak > 0;

  }).length;

  // ----------------------------------------------------------

  // RP health

  // ----------------------------------------------------------

  const rpRecords = realPropertyItems.length;

  const customerMapped = realPropertyItems.filter(

    (item) => text(item.CustomerID) !== "",

  ).length;

  const facilityMapped = realPropertyItems.filter(

    (item) => text(item.FacilityID) !== "",

  ).length;

  const categoryMapped = realPropertyItems.filter(

    (item) => text(item.CategoryCode) !== "",

  ).length;

  const missingCategoryMappings = realPropertyItems.filter(

    (item) => {

      const hasEnabledUtility =

        isEnabledFlag(item.EL ?? item.ELUsage) ||

        isEnabledFlag(item.NG ?? item.NGUsage) ||

        isEnabledFlag(item.PW ?? item.PWUsage) ||

        isEnabledFlag(item.SS ?? item.SSUsage);

      return hasEnabledUtility && text(item.CategoryCode) === "";

    },

  ).length;

  const priorFYIntensityFallbacks = selectedEstimates.filter(

    (item) => {

      const estimateFY = numberValue(item.FY ?? item.fy);

      const intensityFY = numberValue(item.IntensityFY);

      return (

        intensityFY > 0 &&

        estimateFY > 0 &&

        intensityFY < estimateFY

      );

    },

  ).length;

  const missingIntensityMappings = realPropertyItems.reduce(

    (count, rp) => {

      const sourceId =

        text(rp.MonthlyRPID) ||

        text(rp.LegacyRPID);

      if (!sourceId) {

        return count;

      }

      const expectedUtilities = [

        ["EL", rp.EL ?? rp.ELUsage],

        ["NG", rp.NG ?? rp.NGUsage],

        ["PW", rp.PW ?? rp.PWUsage],

        ["SS", rp.SS ?? rp.SSUsage],

      ].filter(([, enabled]) => isEnabledFlag(enabled));

      for (const [utility] of expectedUtilities) {

        const found = selectedEstimates.some((estimate) => {

          const estimateSource =

            text(estimate.SourceMonthlyRPID) ||

            text(estimate.MonthlyRPID) ||

            text(estimate.SourceLegacyRPID) ||

            text(estimate.LegacyRPID);

          return (

            estimateSource === sourceId &&

            text(estimate.UtilityType).toUpperCase() === utility

          );

        });

        if (!found) {

          count += 1;

        }

      }

      return count;

    },

    0,

  );

  // ----------------------------------------------------------

  // FY reconciliation trend

  // ----------------------------------------------------------

  const reconciliation = FISCAL_MONTHS.map((month) => {

    const period = workingPeriods.get(month);

    return {

      month,

      short: month.slice(0, 3),

      billingPeriodId: period?.billingPeriodId ?? null,

      metered: period?.metered ?? 0,

      invoiced: period?.invoiced ?? 0,

      estimated: period?.estimated ?? 0,

    };

  });

  // ----------------------------------------------------------

  // Utility reconciliation for selected month

  // ----------------------------------------------------------

  const utilities = ["EL", "NG", "PW", "SS"].map(

    (utility) => {

      const metered =

        selectedPeriod.meterByUtility.get(utility) ?? 0;

      const invoiced =

        selectedPeriod.invoiceByUtility.get(utility) ?? 0;

      const estimated =

        selectedPeriod.estimateByUtility.get(utility) ?? 0;

      const invoiceCharges =

        selectedPeriod.invoiceChargeByUtility.get(utility) ?? 0;

      return {

        utility,

        name: UTILITY_NAMES[utility] ?? utility,

        metered,

        invoiced,

        estimated,

        invoiceCharges,

        meterInvoiceVariance: variancePercent(

          metered,

          invoiced,

        ),

        invoiceEstimateVariance: variancePercent(

          invoiced,

          estimated,

        ),

        meterEstimateVariance: variancePercent(

          metered,

          estimated,

        ),

      };

    },

  );

  // ----------------------------------------------------------

  // Final dashboard contract

  // ----------------------------------------------------------

  return {

    selectedFY,

    selectedMonth,

    billingPeriodId: selectedBillingPeriodId,

    fiscalYears: getFiscalYears(selectedFY),

    processing: {

      realPropertyLoaded,

      estimatesGenerated,

      meterDataLoaded,

      validationReviews,

      invoicesLoaded,

    },

    kpis: {

      meteredConsumption: selectedPeriod.metered,

      invoicedConsumption: selectedPeriod.invoiced,

      estimatedConsumption: selectedPeriod.estimated,

      invoiceCharges: selectedPeriod.invoiceCharges,

      validationReviews,

      zeroReadingMeters,

    },

    reconciliation,

    utilities,

    attention: {

      validationReviews,

      zeroReadingMeters,

      missingCategoryMappings,

      missingIntensityMappings,

    },

    realProperty: {

      records: rpRecords,

      estimates: selectedEstimates.length,

      customerMapped,

      facilityMapped,

      categoryMapped,

      currentFYIntensities:

        selectedEstimates.length - priorFYIntensityFallbacks,

      priorFYIntensityFallbacks,

    },

  };

}

// ============================================================

// PAGE PROPS

// ============================================================

type DashboardPageProps = {

  searchParams?: Promise<{

    fy?: string;

    month?: string;

  }>;

};

// ============================================================

// PAGE

// ============================================================

export default async function Dashboard({

  searchParams,

}: DashboardPageProps) {

  // ==========================================================

  // AUTHENTICATION (selected centrally through AUTH_MODE)

  // Keep disabled for local development. Enable only when deploying with Auth.js.

  // ==========================================================

  const session = await getAppSession();

  

  if (!session?.user) {

    redirect("/");

  }

  // ==========================================================

  // LOCAL DEVELOPMENT SESSION (provided centrally when AUTH_MODE=local)

  // Before production: comment out this local session, uncomment auth import and guard above.

  // ==========================================================

  // Local development sessions are provided by lib/local-session.ts.

  const displayName =

    session.user.name?.trim() ||

    session.user.email?.trim() ||

    "CUBE User";

  const params = searchParams

    ? await searchParams

    : {};

  const requestedFY = text(params.fy);

  const requestedMonth = text(params.month);

  const selectedFY = /^\d{4}$/.test(requestedFY)

    ? requestedFY

    : getCurrentFY();

  const selectedMonth = MONTHS.includes(requestedMonth)

    ? requestedMonth

    : getCurrentMonth();

  const dashboardData = await loadDashboardData(

    selectedFY,

    selectedMonth,

  );

  return (

    <div className="ce-app">

      <header className="ce-topbar">

        <div className="ce-topbar-left">

          <button

            className="ce-app-grid"

            aria-label="Application menu"

          >

            {Array.from({ length: 9 }).map((_, index) => (

              <span key={index} />

            ))}

          </button>

          <span className="ce-power-apps">

            Centralized Utility and Billing Environment

          </span>

        </div>

        <div className="ce-topbar-right">

          <button

            className="ce-notification-button"

            aria-label="Notifications"

          >

            <Bell size={21} />

            <span className="ce-notification-count">3</span>

          </button>

          <div className="ce-top-divider" />

          {isLocalAuth ? (
            <DevUserMenu name={displayName} />
          ) : (
            <div className="ce-user">
              <div className="ce-avatar">
                {displayName
                  .split(" ")
                  .map((part) => part[0])
                  .join("")
                  .slice(0, 2)
                  .toUpperCase()}
              </div>

              <span className="ce-user-name">
                {displayName}
              </span>

              <ChevronDown size={17} />
            </div>
          )}
          {/*

          ======================================================

          PRODUCTION SIGN OUT

          ======================================================
          */}
          {!isLocalAuth && (
          <form

            action={async () => {

              "use server";

              await signOut({ redirectTo: "/" });

            }}

          >

            <button type="submit">

              Sign out

            </button>

          </form>
          )}

          

        </div>

      </header>

      <div className="ce-body">

        <aside className="ce-sidebar">

          <nav

            className="ce-nav"

            aria-label="Primary navigation"

          >

            {navItems.map((item) => {

              const Icon = item.icon;

              return (

                <Link

                  key={item.label}

                  href={item.href}

                  className={`ce-nav-item ${

                    item.active ? "ce-nav-active" : ""

                  }`}

                >

                  <Icon size={25} />

                  <span>{item.label}</span>

                </Link>

              );

            })}

          </nav>

        </aside>

        <main className="ce-main">

          <DashboardClient data={dashboardData} />

        </main>

      </div>

    </div>

  );

}
