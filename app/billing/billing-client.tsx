"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { FinancialReportingPanel, FinancialReportingSetup } from "./financial-reporting-panel";
import { rcblUtilityLabel, buildCustomerBillPdfLines } from "@/lib/rcbl-customer-pdf";
import {
  BarChart3,
  CalendarDays,
  Database,
  FileText,
  Home,
  Plus,
  Save,
  ShieldCheck,
  Table2,
  Trash2,
} from "lucide-react";
// ============================================================
// TYPES
// ============================================================
type ActiveTab =
  | "afers"
  | "customer-billing"
  | "accounting-reports"
  | "accounting-setup"
  | "direct-rate-entry"
  | "3556-history";
type CustomerBillingTab =
  | "eeic-detail"
  | "eeic-short"
  | "rcbl";

const navItems = [
  { label: "Dashboard", icon: Home, href: "/dashboard" },
  { label: "Background Data", icon: Database, href: "/backgrounddata" },
  { label: "Billing", icon: FileText, href: "/billing" },
  { label: "Data Validation", icon: ShieldCheck, href: "/data-validation" },
  { label: "Monthly Data", icon: CalendarDays, href: "/monthly-data" },
  { label: "Yearly Data", icon: Table2, href: "/yearly-data" },
  { label: "Report & Analysis", icon: BarChart3, href: "/reports" },
];


type RcblPreviewLine = {
  reconciliationId: string;
  customerId: string;
  customerName: string;
  customerType: string;
  reportType: string;
  rateClass: string;
  facilityId: string;
  facilityNumber: string;
  categoryCode: string;
  allocationSource: string;
  sourceId: string;
  meterId: string;
  utilityGroup: string;
  utilityType: string;
  utilitySystem: string;
  consumptionUM: string;
  allocatedConsumption: number;
  rateId: string;
  rateEffectiveDate: string;
  rateKey: string;
  rateLabel: string;
  rate: number | null;
  amount: number | null;
  calculatedAmount?: number | null;
  customerChargeAmount?: number | null;
  ceAbsorbedAmount?: number | null;
  reimbursementUtilityType?: string;
  reimbursementSource?: string;
  reimbursementOverride?: boolean | null;
  reimbursementOverrideApplied?: boolean;
  effectiveReimbursementType?: string;
  reimbursementDisposition?: "CUSTOMER_REIMBURSABLE" | "CE_ABSORBED";
  ready: boolean;
  issues: string[];
  reportingSplit?: import("@/lib/3556-reporting").ReportingSplit;
};

type RcblPreviewCustomer = {
  customerId: string;
  customerName: string;
  customerType: string;
  reportType: string;
  rateClass: string;
  rcblComment?: string;
  totalAmount: number | null;
  readyAmount: number;
  lineCount: number;
  readyLineCount: number;
  issueCount: number;
  status: "READY" | "REVIEW";
  lines: RcblPreviewLine[];
};

type RcblCostRecoveryLine = {
  utilityGroup: string;
  utilitySystem: string;
  invoiceCost: number;
  customerBilling: number;
  ceAbsorbed?: number;
  calculatedBilling?: number;
  difference: number;
  recoveryPercent: number | null;
  status: "COVERED" | "SHORT";
};

type RcblPreviewResponse = {
  ok: boolean;
  preview: boolean;
  persisted: boolean;
  readOnly?: boolean;
  billingPeriodId: number;
  billingMonth: string;
  fiscalYear: string;
  generatedAt: string;
  savedAt?: string;
  savedVersionId?: string;
  savedVersionNumber?: number;
  reconciliationReady?: boolean;
  reconciliationSnapshotId?: string;
  previewFingerprint?: string;
  reconciliationIssues?: Array<{
    utilityGroup: string;
    utilityType: string;
    reason: string;
  }>;
  summary: {
    allocationCount: number;
    customerCount: number;
    reimbursableCustomerCount: number;
    nonReimbursableCustomerCount: number;
    readyCustomerCount: number;
    reviewCustomerCount: number;
    readyBillTotal: number;
    totalInvoiceCost: number;
    totalCustomerBilling: number;
    totalCEAbsorbed?: number;
    totalCalculatedBilling?: number;
    totalRecoveryDifference: number;
    allUtilitiesCovered: boolean;
  };
  costRecovery: RcblCostRecoveryLine[];
  customers: RcblPreviewCustomer[];
};

type RcblHistoryVersion = {
  versionId: string;
  versionNumber: number;
  actionAt: string;
  actorUserId: string;
  actorDisplayName: string;
  action: string;
  replacementReason: string;
  customerCount: number;
  recordCount: number;
};

type DataInputRow = {
  id: string;
  description: string;
  accountProjectNumber: string;
  totalAnnualCost: string;
  annualConsumption: string;
  militaryLabor: string;
  notes: string;
};
type OmRow = {
  id: string;
  description: string;
  accountProjectNumber: string;
  cost: string;
  militaryLabor: string;
  notes: string;
};
type WorksheetForm = {
  // Header
  nameOfBase: string;
  utilitySystem: string;
  uom: string;
  capitalizedInvestmentCost: string;
  effectiveDate: string;
  managerContact: string;
  maximumAnnualCapacity: string;
  capacityUom: string;
  replacedDate: string;
  // Data header
  dataPeriodDescription: string;
  // Repeatable sections
  purchased: DataInputRow[];
  purchasedServices: DataInputRow[];
  produced: DataInputRow[];
  distribution: OmRow[];
};

type History3556 = {
  id: string;
  fiscalYear: string;
  utilityGroup: string;
  utilitySystem: string;
  uom: string;
  effectiveDate: string;
  status: "DRAFT" | "FINAL" | "ARCHIVED";
  preparedDate: string;
  createdAt?: string;
  updatedAt?: string;
  approvedAt?: string;
  approvedBy?: string;
  worksheet: WorksheetForm;
  rateInputs?: {
    a3OmCost?: string;
    lineLossPercentage?: string;
    lessConnectionFeeAmount?: string;
    localPrevailingUtilityProviderRate?: string;
  };
  otherUtilityWorksheet?: {
    part1Quantities?: { water?: string; wastewater?: string; naturalGas?: string; electricity?: string };
    part2Rates?: { water?: string; wastewater?: string; naturalGas?: string; electricity?: string; otherE?: string; otherF?: string };
    part2OtherQty?: { otherE?: string; otherF?: string };
    periodsPerYear?: string;
    part3Units?: string;
  };
  calculatedRates?: Record<string, number>;
  calculatedSalesRates?: Record<string, number | string>;
  rateMonitoring?: {
    baselineType?: "A3_BASIC_COST";
    baselineRate?: number;
    thresholdPercent?: number;
    effectiveDate?: string;
  };
};
// ============================================================
// CONSTANTS
// ============================================================
const RATE_COLUMNS = [
  {
    code: "A-3",
    label: "MFH and Privatized MFH",
  },
  {
    code: "B-6",
    label: "Non-Federal & Commercial Organization",
  },
  {
    code: "C-5",
    label: "Non-DoD (Federal) Agency",
  },
  {
    code: "D-1&2",
    label: "DoD (Federal) Agency (Include Golf Courses)",
  },
  {
    code: "E-7",
    label: "MWR (DoD) / AAFES / PCS/TDY Lodging (Excl Golf Courses)",
  },
] as const;
const RATE_ROWS = [
  "Basic Cost",
  "O&M Costs",
  "Other Utility Cost",
  "Line Losses",
  "Less Connection Fee",
  "Capitalized Charges",
  "Subtotal",
  "Administrative Overhead (3%)",
] as const;
const SALES_RATE_ROWS = [
  "Wheeling Charge (if applicable)",
  "MFH USAF Utility Rate",
  "Non-Federal Organization USAF Utility Rate",
  "Local Prevailing or Utility Provider Rate",
  "Non-DoD Federal Agency USAF Utility Rate",
  "DoD Agency USAF Utility Rate (includes MWR Golf Courses)",
  "Category C MWR USAF Utility Rate (Except Golf Courses)",
] as const;
// ============================================================
// HELPERS
// ============================================================
function createDataRow(): DataInputRow {
  return {
    id: crypto.randomUUID(),
    description: "",
    accountProjectNumber: "",
    totalAnnualCost: "",
    annualConsumption: "",
    militaryLabor: "",
    notes: "",
  };
}
function createOmRow(): OmRow {
  return {
    id: crypto.randomUUID(),
    description: "",
    accountProjectNumber: "",
    cost: "",
    militaryLabor: "",
    notes: "",
  };
}

function getPreviousFiscalYearLabel(): string {
  const today = new Date();
  const calendarYear = today.getFullYear();
  const month = today.getMonth();

  // Federal fiscal year begins October 1.
  const currentFiscalYear =
    month >= 9
      ? calendarYear + 1
      : calendarYear;

  const previousFiscalYear =
    currentFiscalYear - 1;

  return `FY${String(previousFiscalYear).slice(-2)}`;
}

function buildBaseName(
  fiscalYear: string,
  utilityGroup: string,
): string {
  if (!utilityGroup) {
    return "";
  }

  return `${fiscalYear} Tinker AFB - ${utilityGroup}`;
}

function createEmptyWorksheet(): WorksheetForm {
  return {
    nameOfBase: "",
    utilitySystem: "",
    uom: "kWh",
    capitalizedInvestmentCost: "",
    effectiveDate: "",
    managerContact: "",
    maximumAnnualCapacity: "",
    capacityUom: "kWh",
    replacedDate: "",
    dataPeriodDescription: "",
    purchased: [],
    purchasedServices: [],
    produced: [],
    distribution: [],
  };
}

function parseNumber(value: string): number {
  if (!value.trim()) {
    return 0;
  }
  const parsed = Number(
    value.replace(/[$,%\s,]/g, ""),
  );
  return Number.isFinite(parsed)
    ? parsed
    : 0;
}
function formatCurrency(value: number): string {
  return new Intl.NumberFormat(
    "en-US",
    {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    },
  ).format(value);
}
function formatRate(
  value: number,
): string {
  return value.toFixed(5);
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat(
    "en-US",
    {
      maximumFractionDigits: 5,
    },
  ).format(value);
}


const RCBL_FISCAL_MONTHS = [
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
] as const;

const RCBL_FISCAL_YEARS = Array.from(
  { length: 11 },
  (_, index) => 2025 + index,
);

function rcblBillingPeriodId(
  fiscalYear: string,
  billingMonth: string,
): string {
  const fy = Number(fiscalYear);
  const monthIndex = RCBL_FISCAL_MONTHS.indexOf(
    billingMonth as (typeof RCBL_FISCAL_MONTHS)[number],
  );

  if (!Number.isInteger(fy) || monthIndex < 0) return "";

  // CUBE billing-period sequence anchor:
  // FY2026 October = Billing Period 171.
  return String(171 + (fy - 2026) * 12 + monthIndex);
}

function RCBLShortPreview() {
  const [selectedFiscalYear, setSelectedFiscalYear] = useState("");
  const [selectedBillingMonth, setSelectedBillingMonth] = useState("");
  const billingPeriodId = rcblBillingPeriodId(
    selectedFiscalYear,
    selectedBillingMonth,
  );
  const [preview, setPreview] =
    useState<RcblPreviewResponse | null>(null);
  const [loading, setLoading] =
    useState(false);
  const [error, setError] =
    useState("");
  const [customerTypeFilter, setCustomerTypeFilter] =
    useState<
      "ALL" | "REIMBURSABLE" | "NON-REIMBURSABLE"
    >("ALL");
  const [expandedCustomerId, setExpandedCustomerId] =
    useState<string | null>(null);
  const [costRecoveryView, setCostRecoveryView] =
    useState<"BY_GROUP" | "ALL_GROUPS">("BY_GROUP");
  const [saving, setSaving] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [saved, setSaved] = useState<boolean | null>(null);
  const [readOnlyView, setReadOnlyView] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyVersions, setHistoryVersions] = useState<RcblHistoryVersion[]>([]);
  const [selectedHistoryVersion, setSelectedHistoryVersion] = useState("");
  const [saveMessage, setSaveMessage] = useState("");

  // Look up persisted bills independently of the live preview.
  useEffect(() => {
    if (!billingPeriodId) {
      setSaved(null);
      setPreview(null);
      setReadOnlyView(false);
      setHistoryOpen(false);
      setHistoryVersions([]);
      setSelectedHistoryVersion("");
      return;
    }
    let cancelled = false;
    setSaved(null);
    setPreview(null);
    setReadOnlyView(false);
    setHistoryOpen(false);
    setHistoryVersions([]);
    setSelectedHistoryVersion("");
    fetch(`/api/billing/rcbl-short/export?billing_period_id=${encodeURIComponent(billingPeriodId)}&format=status`, { cache: "no-store" })
      .then(async (response) => {
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "Unable to check saved billing status.");
        if (!cancelled) setSaved(Boolean(result.saved));
      })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : "Unable to check saved bills."); });
    return () => { cancelled = true; };
  }, [billingPeriodId]);

  async function viewSavedBill() {
    if (!billingPeriodId) return;
    setLoading(true);
    setError("");
    setSaveMessage("");
    try {
      const response = await fetch(
        `/api/billing/rcbl-short?billing_period_id=${encodeURIComponent(billingPeriodId)}&view=saved`,
        { cache: "no-store" },
      );
      const data = await response.json();
      if (!response.ok) throw new Error(data?.error || "Unable to load the saved bill.");
      setPreview(data as RcblPreviewResponse);
      setSelectedHistoryVersion("");
      setReadOnlyView(true);
      setExpandedCustomerId(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load the saved bill.");
    } finally {
      setLoading(false);
    }
  }

  async function loadHistory() {
    if (!billingPeriodId) return;
    setError("");
    try {
      const response = await fetch(
        `/api/billing/rcbl-short?billing_period_id=${encodeURIComponent(billingPeriodId)}&view=history`,
        { cache: "no-store" },
      );
      const data = await response.json();
      if (!response.ok) throw new Error(data?.error || "Unable to load bill history.");
      setHistoryVersions((data.versions ?? []) as RcblHistoryVersion[]);
      setHistoryOpen(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load bill history.");
    }
  }

  async function viewHistoricalVersion(versionId: string) {
    if (!billingPeriodId || !versionId) return;
    setLoading(true);
    setError("");
    try {
      const response = await fetch(
        `/api/billing/rcbl-short?billing_period_id=${encodeURIComponent(billingPeriodId)}&view=history&version_id=${encodeURIComponent(versionId)}`,
        { cache: "no-store" },
      );
      const data = await response.json();
      if (!response.ok) throw new Error(data?.error || "Unable to load the historical bill.");
      setPreview(data as RcblPreviewResponse);
      setSelectedHistoryVersion(versionId);
      setReadOnlyView(true);
      setExpandedCustomerId(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load the historical bill.");
    } finally {
      setLoading(false);
    }
  }

  async function generatePreview() {
    const period = Number(billingPeriodId);

    if (!Number.isInteger(period)) {
      setError(
        "Select a Fiscal Year and Billing Month.",
      );
      return;
    }

    setLoading(true);
    setError("");
    setSaveMessage("");
    setReadOnlyView(false);
    setSelectedHistoryVersion("");
    setExpandedCustomerId(null);

    try {
      const response = await fetch(
        `/api/billing/rcbl-short?billing_period_id=${encodeURIComponent(
          String(period),
        )}`,
        {
          method: "GET",
          cache: "no-store",
        },
      );

      const data = await response.json();

      if (!response.ok) {
        throw new Error(
          data?.error ||
            "Unable to generate RCBL Short preview.",
        );
      }

      setPreview(data as RcblPreviewResponse);
    } catch (error) {
      setPreview(null);
      setError(
        error instanceof Error
          ? error.message
          : "Unable to generate RCBL Short preview.",
      );
    } finally {
      setLoading(false);
    }
  }

  async function saveBill(replace = false) {
    if (!preview || preview.persisted) return;
    if (!preview.previewFingerprint || !preview.reconciliationSnapshotId) {
      setError("Generate a new Current Preview before saving. Refresh CUBE if needed.");
      return;
    }
    let replacementReason = "";
    if (replace) {
      if (saved !== true) return;
      replacementReason = window.prompt("Enter the reason for replacing the saved RCBL Short bill:", "")?.trim() ?? "";
      if (!replacementReason) {
        setError("A reason is required before replacing the saved bill.");
        return;
      }
      if (!window.confirm(`Replace the saved RCBL Short bill for Billing Period ${preview.billingPeriodId}?\n\nReason: ${replacementReason}`)) return;
    }

    setSaving(true);
    setError("");
    setSaveMessage("");
    try {
      const response = await fetch("/api/billing/rcbl-short", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          billing_period_id: preview.billingPeriodId,
          replace,
          replacement_reason: replacementReason,
          preview_fingerprint: preview.previewFingerprint,
          reconciliation_snapshot_id: preview.reconciliationSnapshotId,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data?.error || "Unable to save RCBL Short billing records.");
      setSaved(true);
      setReadOnlyView(false);
      setSaveMessage(replace ? `Saved bill replaced. ${data.savedRecordCount} records saved.` : `Billing saved. ${data.savedRecordCount} records saved.`);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Unable to save RCBL Short billing records.");
    } finally {
      setSaving(false);
    }
  }

  // Saved exports are available only while explicitly viewing the current saved bill.
  // A newer preview must never unlock or be used as a customer-bill export source.
  const canExportSavedBill =
    saved === true &&
    preview?.persisted === true &&
    !selectedHistoryVersion &&
    !loading &&
    !saving &&
    !exporting;

  async function downloadSavedCustomerBill(
    format: "summary-csv" | "detail-csv" | "customer-pdf" | "customer-xlsx" | "all-pdfs",
    customerId?: string,
  ) {
    if (!canExportSavedBill || !billingPeriodId) {
      setError("View the saved bill to export. Current previews are for validation inside CUBE only.");
      return;
    }
    setError("");
    setExporting(true);
    try {
      const query = new URLSearchParams({ billing_period_id: billingPeriodId, format });
      if (customerId) query.set("customer_id", customerId);
      // The server reads the active saved bill, never the currently displayed preview.
      const response = await fetch(`/api/billing/rcbl-short/export?${query.toString()}`, { cache: "no-store" });
      if (!response.ok) {
        const result = await response.json().catch(() => ({}));
        throw new Error(result.error || `Unable to export saved bill (HTTP ${response.status}).`);
      }
      // Using a single blob-download path for CSV, PDF and Excel avoids silent
      // navigation errors and makes server-side export failures visible in CUBE.
      const mime = response.headers.get("Content-Type") || "";
      if (/text\/html/i.test(mime)) {
        throw new Error("The saved export returned a web page rather than a file. Check your session and try again.");
      }
      const blob = await response.blob();
      const disposition = response.headers.get("Content-Disposition") || "";
      const serverFileName = /filename="([^"]+)"/.exec(disposition)?.[1];
      const extension = format.endsWith("-csv") ? "csv" : format === "customer-xlsx" ? "xlsx" : "pdf";
      const fallbackName = `RCBL-Short-${billingPeriodId}-${customerId || "All-Customers"}.${extension}`;
      const filename = serverFileName || fallbackName;
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to export the saved bill.");
    } finally {
      setExporting(false);
    }
  }

  const visibleCustomers =
    preview?.customers.filter((customer) => {
      const normalized = customer.customerType
        .trim()
        .toUpperCase();

      if (customerTypeFilter === "ALL") {
        return true;
      }

      if (
        customerTypeFilter === "REIMBURSABLE"
      ) {
        return normalized === "REIMBURSABLE";
      }

      return normalized !== "REIMBURSABLE";
    }) ?? [];

  const collapsedCostRecovery: RcblCostRecoveryLine[] = preview
    ? Array.from(
        preview.costRecovery.reduce(
          (map, item) => {
            const existing = map.get(item.utilitySystem) ?? {
              utilityGroup: "ALL",
              utilitySystem: item.utilitySystem,
              invoiceCost: 0,
              customerBilling: 0,
              ceAbsorbed: 0,
              calculatedBilling: 0,
              difference: 0,
              recoveryPercent: null,
              status: "COVERED" as const,
            };

            existing.invoiceCost += item.invoiceCost;
            existing.customerBilling += item.customerBilling;
            existing.ceAbsorbed =
              (existing.ceAbsorbed ?? 0) + (item.ceAbsorbed ?? 0);
            existing.calculatedBilling =
              (existing.calculatedBilling ?? 0) +
              (item.calculatedBilling ?? item.customerBilling);
            map.set(item.utilitySystem, existing);
            return map;
          },
          new Map<string, RcblCostRecoveryLine>(),
        ).values(),
      )
        .map((item) => {
          const invoiceCost = Math.round(item.invoiceCost * 100) / 100;
          const customerBilling =
            Math.round(item.customerBilling * 100) / 100;
          const ceAbsorbed = Math.round((item.ceAbsorbed ?? 0) * 100) / 100;
          const calculatedBilling =
            Math.round(
              (item.calculatedBilling ?? customerBilling + ceAbsorbed) * 100,
            ) / 100;
          const difference =
            Math.round((calculatedBilling - invoiceCost) * 100) / 100;
          const recoveryPercent =
            invoiceCost > 0
              ? Math.round((customerBilling / invoiceCost) * 10000) / 100
              : null;

          return {
            ...item,
            invoiceCost,
            customerBilling,
            ceAbsorbed,
            calculatedBilling,
            difference,
            recoveryPercent,
            status: difference >= 0 ? "COVERED" : "SHORT",
          } as RcblCostRecoveryLine;
        })
        .sort((a, b) =>
          a.utilitySystem.localeCompare(b.utilitySystem),
        )
    : [];

  const displayedCostRecovery =
    costRecoveryView === "ALL_GROUPS"
      ? collapsedCostRecovery
      : preview?.costRecovery ?? [];

  // Billing READY and a validated REM/CUBE/SRM presentation are separate checks.
  // Use the same presentation result as the customer PDF so the page explains
  // why an older saved bill may show its full charges as REVIEW.
  const breakoutReviewCustomers = preview?.persisted
    ? preview.customers.filter((customer) =>
        buildCustomerBillPdfLines(preview, customer).some((line) =>
          line.startsWith("Unclassified - Review Required:") ||
          line.startsWith("REVIEW REQUIRED:"),
        ),
      ).length
    : 0;

  return (
    <div className="rcbl-preview">
      <section className="rcbl-preview-hero">
        <div>
          <p className="billing-control-eyebrow">
            Customer Billing
          </p>
          <h2>RCBL Short Customer Billing</h2>
          <p>
            Generate a current preview for validation inside CUBE. Save or replace the bill
            when it is ready; customer-bill downloads are available only while viewing
            the saved bill.
          </p>
        </div>

        <div className="rcbl-preview-badge">
          <strong>{preview ? (preview.persisted ? (selectedHistoryVersion ? "HISTORICAL SAVED BILL" : "SAVED BILL") : "CURRENT PREVIEW") : "SELECT BILLING PERIOD"}</strong>
          <span>{saved === null ? "Checking saved records..." : saved ? (preview?.persisted ? "Saved records displayed" : "A separate saved bill exists") : "No saved bill exists"}</span>
        </div>
      </section>

      <div className="rcbl-preview-controls">
        <label>
          <span>Fiscal Year</span>
          <select
            value={selectedFiscalYear}
            onChange={(event) => {
              setSelectedFiscalYear(event.target.value);
              setPreview(null);
              setSaved(null);
              setReadOnlyView(false);
              setHistoryOpen(false);
              setHistoryVersions([]);
              setSelectedHistoryVersion("");
              setSaveMessage("");
              setError("");
            }}
          >
            <option value="">Select FY</option>
            {RCBL_FISCAL_YEARS.map((fy) => (
              <option key={fy} value={String(fy)}>
                FY{fy}
              </option>
            ))}
          </select>
        </label>

        <label>
          <span>Billing Month</span>
          <select
            value={selectedBillingMonth}
            onChange={(event) => {
              setSelectedBillingMonth(event.target.value);
              setPreview(null);
              setSaved(null);
              setReadOnlyView(false);
              setHistoryOpen(false);
              setHistoryVersions([]);
              setSelectedHistoryVersion("");
              setSaveMessage("");
              setError("");
            }}
          >
            <option value="">Select Month</option>
            {RCBL_FISCAL_MONTHS.map((month) => (
              <option key={month} value={month}>
                {month}
              </option>
            ))}
          </select>
        </label>

        <button
          type="button"
          className="bd-add-button"
          disabled={
            loading || !selectedFiscalYear || !selectedBillingMonth || !billingPeriodId
          }
          onClick={() =>
            void generatePreview()
          }
        >
          {loading
            ? "Generating..."
            : "Generate Bill Preview"}
        </button>

        {billingPeriodId ? (
          <>
            <button type="button" className="history-open-button" disabled={!canExportSavedBill} onClick={() => void downloadSavedCustomerBill("summary-csv")}>Export Saved Summary CSV</button>
            <button type="button" className="history-open-button" disabled={!canExportSavedBill} onClick={() => void downloadSavedCustomerBill("detail-csv")}>Export Saved Detail CSV</button>
          </>
        ) : null}

        {saved === true && !saving ? (
          <>
            <button type="button" className="history-open-button" disabled={loading} onClick={() => void viewSavedBill()}>{loading ? "Loading..." : "View Saved Bill"}</button>
            <button type="button" className="history-open-button" onClick={() => void loadHistory()}>View History</button>
          </>
        ) : null}

        {saved === false && !preview && !saving ? (
          <span className="billing-control-note">No saved bill for this billing period.</span>
        ) : null}

        {preview ? (
          <>
            {!readOnlyView ? (
              saved === true ? (
                <button type="button" className="billing-save-button" disabled={saving || preview.reconciliationReady !== true} onClick={() => void saveBill(true)}>
                  {saving ? "Replacing..." : "Replace Saved Bill"}
                </button>
              ) : (
                <button type="button" className="billing-save-button" disabled={saving || saved === null || preview.reconciliationReady !== true} onClick={() => void saveBill(false)}>
                  {saving ? "Saving..." : "Save Bill"}
                </button>
              )
            ) : (
              <span className="billing-control-note">Read-only bill view</span>
            )}
            <button type="button" className="history-open-button" disabled={!canExportSavedBill} onClick={() => void downloadSavedCustomerBill("all-pdfs")}>
              Export Saved Customer PDFs
            </button>
          </>
        ) : null}
      </div>

      {preview && !preview.persisted ? (
        <div className="rcbl-preview-alert">
          <strong>Current Preview — validation inside CUBE only.</strong>
          <div>Save the bill before exporting PDF, Excel, or CSV. If a saved bill already exists, replace it to export updated charges. Then select View Saved Bill to enable downloads. This preview cannot be exported.</div>
        </div>
      ) : null}

      {error ? (
        <div className="rcbl-preview-alert rcbl-preview-alert-error">
          {error}
        </div>
      ) : null}

      {preview?.preview && preview.reconciliationReady === false ? (
        <div className="rcbl-preview-alert rcbl-preview-alert-error">
          <strong>Preview only — not approved for saving.</strong>
          <div>
            Monthly Reconciliation contains blocking readiness issues. Correct and regenerate the reconciliation before saving or replacing this bill.
          </div>
          {preview.reconciliationIssues?.map((issue) => (
            <div key={`${issue.utilityGroup}-${issue.utilityType}-${issue.reason}`}>
              {issue.utilityGroup} {issue.utilityType}: {issue.reason}
            </div>
          ))}
        </div>
      ) : null}

      {historyOpen ? (
        <div className="rcbl-preview-alert">
          <strong>Historical bill versions</strong>
          {historyVersions.length > 0 ? (
            <label>
              <span>Select a version to view</span>
              <select
                value={selectedHistoryVersion}
                onChange={(event) => {
                  const value = event.target.value;
                  setSelectedHistoryVersion(value);
                  void viewHistoricalVersion(value);
                }}
              >
                <option value="">Select version</option>
                {historyVersions.map((version) => (
                  <option key={version.versionId} value={version.versionId}>
                    Version {version.versionNumber} — {version.actionAt} — {version.actorDisplayName}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <span>No historical replacement versions exist for this billing period.</span>
          )}
        </div>
      ) : null}

      {saveMessage ? (
        <div className="rcbl-preview-alert rcbl-preview-alert-success">{saveMessage}</div>
      ) : null}

      {preview ? (
        <>
          <div className="rcbl-preview-period">
            <div>
              <span>Billing Period</span>
              <strong>
                {preview.billingPeriodId}
              </strong>
            </div>
            <div>
              <span>Month</span>
              <strong>
                {preview.billingMonth || "—"}
              </strong>
            </div>
            <div>
              <span>Fiscal Year</span>
              <strong>
                {preview.fiscalYear || "—"}
              </strong>
            </div>
            <div>
              <span>Saved Status</span>
              <strong>{preview.persisted ? "SAVED BILL" : "CURRENT PREVIEW"}</strong>
            </div>
          </div>

          {preview.persisted && breakoutReviewCustomers > 0 ? (
            <div className="rcbl-preview-alert rcbl-preview-alert-error" role="status">
              <strong>Saved bill breakout needs review: {breakoutReviewCustomers} customer{breakoutReviewCustomers === 1 ? "" : "s"}.</strong>
              <div>The saved charges are still included in each bill. Some saved lines lack a validated REM, CUBE, or SRM breakdown. In the customer table, open View Bill to see which charges are marked REVIEW. Generate Bill Preview to inspect a new calculation; it will not change the saved bill.</div>
            </div>
          ) : null}

          <div className="rcbl-preview-summary">
            <article>
              <span>Customers</span>
              <strong>
                {preview.summary.customerCount}
              </strong>
            </article>
            <article>
              <span>Reimbursable</span>
              <strong>
                {
                  preview.summary
                    .reimbursableCustomerCount
                }
              </strong>
            </article>
            <article>
              <span>Non-Reimbursable</span>
              <strong>
                {
                  preview.summary
                    .nonReimbursableCustomerCount
                }
              </strong>
            </article>
            <article>
              <span>Ready</span>
              <strong>
                {
                  preview.summary
                    .readyCustomerCount
                }
              </strong>
            </article>
            <article>
              <span>Needs Review</span>
              <strong>
                {
                  preview.summary
                    .reviewCustomerCount
                }
              </strong>
            </article>
            <article>
              <span>Ready Bill Total</span>
              <strong>
                {formatCurrency(
                  preview.summary.readyBillTotal,
                )}
              </strong>
            </article>
          </div>

          <section className="rcbl-bill">
            <div className="rcbl-bill-heading">
              <div>
                <span>INVOICE COST RECOVERY</span>
                <h3>Utility Cost Recovery</h3>
                <p>
                  Provider invoice charges are compared against calculated utility allocations
                  (customer charges plus CE-absorbed costs). A shortfall is not automatically a billing error;
                  review the utility-level differences below.
                </p>
              </div>
              <div className="rcbl-bill-total">
                <span>Overall Status</span>
                <strong>
                  {preview.summary.allUtilitiesCovered
                    ? "COVERED"
                    : "SHORT"}
                </strong>
              </div>
            </div>

            <div className="rcbl-preview-summary">
              <article>
                <span>Invoice Cost</span>
                <strong>
                  {formatCurrency(
                    preview.summary.totalInvoiceCost,
                  )}
                </strong>
              </article>
              <article>
                <span>Customer Billing</span>
                <strong>
                  {formatCurrency(
                    preview.summary.totalCustomerBilling,
                  )}
                </strong>
              </article>
              <article>
                <span>CE Absorbed</span>
                <strong>
                  {formatCurrency(preview.summary.totalCEAbsorbed ?? 0)}
                </strong>
              </article>
              <article>
                <span>Total Calculated</span>
                <strong>
                  {formatCurrency(
                    preview.summary.totalCalculatedBilling ??
                      preview.summary.totalCustomerBilling,
                  )}
                </strong>
              </article>
              <article>
                <span>Difference</span>
                <strong>
                  {formatCurrency(
                    preview.summary.totalRecoveryDifference,
                  )}
                </strong>
              </article>
              <article>
                <span>Recovery</span>
                <strong>
                  {preview.summary.totalInvoiceCost > 0
                    ? `${(
                        ((preview.summary.totalCalculatedBilling ??
                          preview.summary.totalCustomerBilling) /
                          preview.summary.totalInvoiceCost) *
                        100
                      ).toFixed(2)}%`
                    : "—"}
                </strong>
              </article>
            </div>

            <div
              className="rcbl-preview-toolbar"
              style={{ marginTop: "14px", marginBottom: "10px" }}
            >
              <div>
                <strong>Recovery View</strong>
                <span>
                  {costRecoveryView === "BY_GROUP"
                    ? "Utility Group + Utility"
                    : "All utility groups combined by utility"}
                </span>
              </div>
              <label>
                <span>View</span>
                <select
                  value={costRecoveryView}
                  onChange={(event) =>
                    setCostRecoveryView(
                      event.target.value as
                        | "BY_GROUP"
                        | "ALL_GROUPS",
                    )
                  }
                >
                  <option value="BY_GROUP">
                    By Utility Group
                  </option>
                  <option value="ALL_GROUPS">
                    All Utility Groups
                  </option>
                </select>
              </label>
            </div>

            <div className="rcbl-line-table-shell">
              <table className="rcbl-line-table">
                <thead>
                  <tr>
                    <th>
                      {costRecoveryView === "ALL_GROUPS"
                        ? "Scope"
                        : "Utility Group"}
                    </th>
                    <th>Utility</th>
                    <th>Invoice Cost</th>
                    <th>Customer Billing</th>
                    <th>CE Absorbed</th>
                    <th>Total Calculated</th>
                    <th>Difference</th>
                    <th>Recovery</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {displayedCostRecovery.length > 0 ? (
                    displayedCostRecovery.map((item) => (
                      <tr
                        key={`${item.utilityGroup}-${item.utilitySystem}`}
                      >
                        <td>
                          <strong>{item.utilityGroup}</strong>
                        </td>
                        <td>{rcblUtilityLabel(item.utilitySystem, item.utilityGroup)}</td>
                        <td className="rcbl-money">
                          {formatCurrency(item.invoiceCost)}
                        </td>
                        <td className="rcbl-money">
                          {formatCurrency(item.customerBilling)}
                        </td>
                        <td className="rcbl-money">
                          {formatCurrency(item.ceAbsorbed ?? 0)}
                        </td>
                        <td className="rcbl-money">
                          {formatCurrency(
                            item.calculatedBilling ?? item.customerBilling,
                          )}
                        </td>
                        <td className="rcbl-money">
                          {formatCurrency(item.difference)}
                        </td>
                        <td>
                          {item.recoveryPercent === null
                            ? "—"
                            : `${item.recoveryPercent.toFixed(2)}%`}
                        </td>
                        <td>
                          <span
                            className={`rcbl-status ${
                              item.status === "COVERED"
                                ? "rcbl-status-ready"
                                : "rcbl-status-review"
                            }`}
                          >
                            {item.status}
                          </span>
                        </td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan={9}>
                        No invoice cost recovery data was returned for this
                        billing period.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>

          <div className="rcbl-preview-toolbar">
            <div>
              <strong>
                Consolidated Customer Bills
              </strong>
              <span>
                {
                  preview.summary
                    .allocationCount
                }{" "}
                reconciliation allocation lines
              </span>
            </div>

            <label>
              <span>Customer Type</span>
              <select
                value={customerTypeFilter}
                onChange={(event) =>
                  setCustomerTypeFilter(
                    event.target.value as
                      | "ALL"
                      | "REIMBURSABLE"
                      | "NON-REIMBURSABLE",
                  )
                }
              >
                <option value="ALL">
                  All Customers
                </option>
                <option value="REIMBURSABLE">
                  Reimbursable
                </option>
                <option value="NON-REIMBURSABLE">
                  Non-Reimbursable
                </option>
              </select>
            </label>
          </div>

          <div className="rcbl-preview-table-shell">
            <table className="rcbl-preview-table">
              <thead>
                <tr>
                  <th>Customer ID</th>
                  <th>Customer</th>
                  <th>Type</th>
                  <th>Report Type</th>
                  <th>Rate Class</th>
                  <th>Lines</th>
                  <th>Status</th>
                  <th>Bill Total</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {visibleCustomers.map(
                  (customer) => {
                    const expanded =
                      expandedCustomerId ===
                      customer.customerId;
                    const presentationLines = buildCustomerBillPdfLines(preview, customer);
                    const hasOtherUtilitiesLine = presentationLines.some((line) =>
                      line.startsWith("Other Utilities|"),
                    );
                    const breakoutReview = preview.persisted
                      ? presentationLines.find((line) =>
                          line.startsWith("Unclassified - Review Required:") ||
                          line.startsWith("REVIEW REQUIRED:"),
                        )
                      : undefined;

                    return (
                      <>
                        <tr
                          key={
                            customer.customerId ||
                            customer.customerName
                          }
                        >
                          <td>
                            <strong>
                              {customer.customerId ||
                                "MISSING"}
                            </strong>
                          </td>
                          <td>
                            {customer.customerName}
                          </td>
                          <td>
                            {customer.customerType}
                          </td>
                          <td>
                            {customer.reportType ||
                              "—"}
                          </td>
                          <td>
                            {customer.rateClass ||
                              "—"}
                          </td>
                          <td>
                            {customer.lineCount}
                          </td>
                          <td>
                            <span
                              className={`rcbl-status ${
                                customer.status ===
                                "READY"
                                  ? "rcbl-status-ready"
                                  : "rcbl-status-review"
                              }`}
                            >
                              {customer.status}
                            </span>
                            {breakoutReview ? (
                              <div className="rcbl-preview-alert rcbl-preview-alert-error" role="status">
                                Breakout needs review
                              </div>
                            ) : null}
                          </td>
                          <td className="rcbl-money">
                            {customer.totalAmount ===
                            null
                              ? "—"
                              : formatCurrency(
                                  customer.totalAmount,
                                )}
                          </td>
                          <td>
                            <button
                              type="button"
                              className="history-open-button"
                              onClick={() =>
                                setExpandedCustomerId(
                                  expanded
                                    ? null
                                    : customer.customerId,
                                )
                              }
                            >
                              {expanded
                                ? "Close"
                                : "View Bill"}
                            </button>
                            <button
                              type="button"
                              className="history-open-button"
                              disabled={!canExportSavedBill}
                              onClick={() => void downloadSavedCustomerBill("customer-pdf", customer.customerId)}
                            >
                              Saved PDF
                            </button>
                            <button
                              type="button"
                              className="history-open-button"
                              disabled={!canExportSavedBill}
                              onClick={() => void downloadSavedCustomerBill("customer-xlsx", customer.customerId)}
                            >
                              Saved Excel
                            </button>
                            <button type="button" className="history-open-button" disabled={!canExportSavedBill} onClick={() => void downloadSavedCustomerBill("detail-csv", customer.customerId)}>
                              Export Saved Detail CSV
                            </button>
                          </td>
                        </tr>

                        {expanded ? (
                          <tr
                            key={`${customer.customerId}-detail`}
                            className="rcbl-detail-row"
                          >
                            <td colSpan={9}>
                              <div className="rcbl-bill">
                                {breakoutReview ? (
                                  <div className="rcbl-preview-alert rcbl-preview-alert-error" role="status">
                                    <strong>Breakout needs review.</strong> {breakoutReview} The saved total is unchanged; these charges cannot be divided into REM, CUBE, and SRM amounts from this saved version.
                                  </div>
                                ) : null}
                                <div className="rcbl-bill-heading">
                                  <div>
                                    <span>
                                      RCBL SHORT —
                                      {preview.persisted ? "SAVED BILL" : "CURRENT PREVIEW"}
                                    </span>
                                    <h3>
                                      {
                                        customer.customerName
                                      }
                                    </h3>
                                    <p>
                                      {
                                        customer.customerId
                                      }{" "}
                                      •{" "}
                                      {
                                        customer.customerType
                                      }{" "}
                                      •{" "}
                                      {preview.billingMonth}{" "}
                                      FY{" "}
                                      {
                                        preview.fiscalYear
                                      }
                                    </p>
                                  </div>
                                  <div className="rcbl-bill-total">
                                    <span>
                                      Consolidated Bill
                                    </span>
                                    <strong>
                                      {customer.totalAmount ===
                                      null
                                        ? "REVIEW REQUIRED"
                                        : formatCurrency(
                                            customer.totalAmount,
                                          )}
                                    </strong>
                                  </div>
                                </div>

                                <div className="rcbl-preview-alert">
                                  <strong>Customer Bill Preview — for validation inside CUBE only</strong>
                                  {hasOtherUtilitiesLine ? (
                                    <div>
                                      Other Utility Costs reflect any authorized delivery, infrastructure, and production fees included as part of approved 3556 rates.
                                    </div>
                                  ) : null}
                                </div>
                                <div className="rcbl-line-table-shell">
                                  <table className="rcbl-line-table">
                                    <thead>
                                      <tr><th>Utility / Other Utilities</th><th>Consumption</th><th>Unit</th><th>Rate / Bill Share</th><th>Customer Amount</th></tr>
                                    </thead>
                                    <tbody>
                                      {presentationLines
                                        .filter((line) => line.split("|").length === 5)
                                        .map((line, itemIndex) => {
                                          const [component, consumption, unit, share, amount] = line.split("|");
                                          return (
                                            <tr key={`${customer.customerId}-itemized-${itemIndex}`}>
                                              <td>{component}</td>
                                              <td>{consumption}</td>
                                              <td>{unit}</td>
                                              <td>{share}</td>
                                              <td className="rcbl-money">{amount}</td>
                                            </tr>
                                          );
                                        })}
                                    </tbody>
                                  </table>
                                </div>
                                <div className="rcbl-line-table-shell">
                                  <table className="rcbl-line-table">
                                    <thead>
                                      <tr>
                                        <th>
                                          Utility
                                        </th>
                                        <th>
                                          Group
                                        </th>
                                        <th>
                                          Facility
                                        </th>
                                        <th>
                                          Source
                                        </th>
                                        <th>
                                          Consumption
                                        </th>
                                        <th>
                                          U/M
                                        </th>
                                        <th>
                                          Applied Rate
                                        </th>
                                        <th>
                                          Rate Source
                                        </th>
                                        <th>Responsibility</th>
                                        <th>Calculated Charge</th>
                                        <th>CE Absorbed</th>
                                        <th>Customer Due</th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {customer.lines.map(
                                        (
                                          line,
                                          index,
                                        ) => (
                                          <tr
                                            key={
                                              line.reconciliationId ||
                                              `${customer.customerId}-${index}`
                                            }
                                          >
                                            <td>
                                              {
                                                rcblUtilityLabel(line.utilitySystem, line.utilityGroup)
                                              }
                                            </td>
                                            <td>
                                              {
                                                line.utilityGroup
                                              }
                                            </td>
                                            <td>
                                              {line.facilityNumber ||
                                                line.facilityId ||
                                                "—"}
                                            </td>
                                            <td>
                                              {
                                                line.allocationSource
                                              }
                                              {line.sourceId
                                                ? ` / ${line.sourceId}`
                                                : ""}
                                            </td>
                                            <td>
                                              {formatNumber(
                                                line.allocatedConsumption,
                                              )}
                                            </td>
                                            <td>
                                              {line.consumptionUM ||
                                                "—"}
                                            </td>
                                            <td>
                                              {line.rate ===
                                              null
                                                ? "—"
                                                : formatRate(
                                                    line.rate,
                                                  )}
                                            </td>
                                            <td>
                                              {line.rateId
                                                ? `${line.rateLabel} • ${line.rateId}`
                                                : line.rateLabel}
                                            </td>
                                            <td className="rcbl-money">
                                              {line.reimbursementDisposition === "CE_ABSORBED"
                                                ? "CE Absorbed"
                                                : "Customer Reimbursable"}
                                              {line.reimbursementUtilityType
                                                ? ` (${line.reimbursementUtilityType})`
                                                : ""}
                                            </td>
                                            <td className="rcbl-money">
                                              {line.calculatedAmount === null
                                                ? "—"
                                                : formatCurrency(
                                                    line.calculatedAmount ??
                                                      line.amount ??
                                                      0,
                                                  )}
                                            </td>
                                            <td className="rcbl-money">
                                              {formatCurrency(
                                                line.ceAbsorbedAmount ?? 0,
                                              )}
                                            </td>
                                            <td className="rcbl-money">
                                              {line.amount === null
                                                ? "—"
                                                : formatCurrency(line.amount)}
                                            </td>
                                          </tr>
                                        ),
                                      )}
                                    </tbody>
                                  </table>
                                </div>

                                {customer.lines.some(
                                  (line) =>
                                    line.issues
                                      .length > 0,
                                ) ? (
                                  <div className="rcbl-issues">
                                    <strong>
                                      Validation Issues
                                    </strong>
                                    {customer.lines.flatMap(
                                      (
                                        line,
                                        lineIndex,
                                      ) =>
                                        line.issues.map(
                                          (
                                            issue,
                                            issueIndex,
                                          ) => (
                                            <p
                                              key={`${lineIndex}-${issueIndex}`}
                                            >
                                              {
                                                line.utilitySystem
                                              }{" "}
                                              /{" "}
                                              {
                                                line.utilityGroup
                                              }
                                              : {issue}
                                            </p>
                                          ),
                                        ),
                                    )}
                                  </div>
                                ) : (
                                  <div className="rcbl-preview-alert rcbl-preview-alert-success">
                                    All allocation
                                    lines found a
                                    FINAL 3556 and a
                                    numeric rate.
                                  </div>
                                )}
                              </div>
                            </td>
                          </tr>
                        ) : null}
                      </>
                    );
                  },
                )}

                {visibleCustomers.length ===
                0 ? (
                  <tr>
                    <td
                      colSpan={9}
                      className="rcbl-empty-cell"
                    >
                      No customers match this
                      filter.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <div className="customer-billing-empty rcbl-preview-empty">
          Select a Fiscal Year and Billing Month and generate the preview.
          Save Bill persists the generated billing snapshot after review.
        </div>
      )}
    </div>
  );
}

// ============================================================
// CLIENT
// ============================================================
export function BillingClient() {
  const [activeTab, setActiveTab] =
    useState<ActiveTab>("customer-billing");
  const [customerBillingTab, setCustomerBillingTab] =
    useState<CustomerBillingTab>("rcbl");

  const [status, setStatus] =
    useState<"DRAFT" | "FINAL" | "ARCHIVED">("DRAFT");
  const [historyRecords, setHistoryRecords] = useState<History3556[]>([]);
  const [current3556Id, setCurrent3556Id] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const [saveMessage, setSaveMessage] = useState("");
  const [saveError, setSaveError] = useState("");

  const [a3OmCost, setA3OmCost] =
    useState("");

  const [lineLossPercentage, setLineLossPercentage] =
    useState("");

  const [lessConnectionFeeAmount, setLessConnectionFeeAmount] =
    useState("");

  const [
    localPrevailingUtilityProviderRate,
    setLocalPrevailingUtilityProviderRate,
  ] = useState("");

  // ==========================================================
  // OTHER UTILITY COST WORKSHEET - PART I QUANTITY MAPPING
  //
  // Part II mirrors these Part I quantities.
  // No calculations are being added here.
  // ==========================================================

  const [otherUtilityPart1Quantities, setOtherUtilityPart1Quantities] =
    useState({
      water: "",
      wastewater: "",
      naturalGas: "",
      electricity: "",
    });
  const [otherUtilityPart2Rates, setOtherUtilityPart2Rates] = useState({
    water: "", wastewater: "", naturalGas: "", electricity: "", otherE: "", otherF: "",
  });
  const [otherUtilityPart2OtherQty, setOtherUtilityPart2OtherQty] = useState({
    otherE: "", otherF: "",
  });
  const [otherUtilityPeriodsPerYear, setOtherUtilityPeriodsPerYear] = useState("1");
  const [otherUtilityPart3Units, setOtherUtilityPart3Units] = useState("");
  const [utilityGroup, setUtilityGroup] =
    useState("");

  const [baseFiscalYear, setBaseFiscalYear] =
    useState(() => getPreviousFiscalYearLabel());
  const [form, setForm] =
    useState<WorksheetForm>(
      createEmptyWorksheet,
    );
  const [selectedHistory3556, setSelectedHistory3556] =
    useState<History3556 | null>(null);

  const isHistoryView =
    activeTab === "3556-history" &&
    selectedHistory3556 !== null &&
    selectedHistory3556.status !== "DRAFT";
  // ==========================================================
  // 3556 PERSISTENCE
  // ==========================================================
  async function load3556History() {
    setIsLoadingHistory(true);
    setSaveError("");
    try {
      const response = await fetch("/api/billing/3556", { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data?.error || "Unable to load 3556 history.");
      setHistoryRecords(Array.isArray(data?.records) ? data.records : []);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "Unable to load 3556 history.");
    } finally {
      setIsLoadingHistory(false);
    }
  }

  useEffect(() => { void load3556History(); }, []);

  function load3556Record(record: History3556) {
    setCurrent3556Id(record.id);
    setStatus(record.status);
    setBaseFiscalYear(record.fiscalYear);
    setUtilityGroup(record.utilityGroup);
    setForm(record.worksheet);
    setA3OmCost(record.rateInputs?.a3OmCost ?? "");
    setLineLossPercentage(record.rateInputs?.lineLossPercentage ?? "");
    setLessConnectionFeeAmount(record.rateInputs?.lessConnectionFeeAmount ?? "");
    setLocalPrevailingUtilityProviderRate(record.rateInputs?.localPrevailingUtilityProviderRate ?? "");
    setOtherUtilityPart1Quantities({
      water: record.otherUtilityWorksheet?.part1Quantities?.water ?? "",
      wastewater: record.otherUtilityWorksheet?.part1Quantities?.wastewater ?? "",
      naturalGas: record.otherUtilityWorksheet?.part1Quantities?.naturalGas ?? "",
      electricity: record.otherUtilityWorksheet?.part1Quantities?.electricity ?? "",
    });
    setOtherUtilityPart2Rates({
      water: record.otherUtilityWorksheet?.part2Rates?.water ?? "",
      wastewater: record.otherUtilityWorksheet?.part2Rates?.wastewater ?? "",
      naturalGas: record.otherUtilityWorksheet?.part2Rates?.naturalGas ?? "",
      electricity: record.otherUtilityWorksheet?.part2Rates?.electricity ?? "",
      otherE: record.otherUtilityWorksheet?.part2Rates?.otherE ?? "",
      otherF: record.otherUtilityWorksheet?.part2Rates?.otherF ?? "",
    });
    setOtherUtilityPart2OtherQty({
      otherE: record.otherUtilityWorksheet?.part2OtherQty?.otherE ?? "",
      otherF: record.otherUtilityWorksheet?.part2OtherQty?.otherF ?? "",
    });
    setOtherUtilityPeriodsPerYear(record.otherUtilityWorksheet?.periodsPerYear ?? "1");
    setOtherUtilityPart3Units(record.otherUtilityWorksheet?.part3Units ?? "");
    setSaveMessage(""); setSaveError("");
    if (record.status === "DRAFT") {
      setSelectedHistory3556(null);
      setActiveTab("direct-rate-entry");
    } else {
      setSelectedHistory3556(record);
    }
  }

  function startNew3556() {
    setCurrent3556Id(null); setSelectedHistory3556(null); setStatus("DRAFT");
    setUtilityGroup(""); setBaseFiscalYear(getPreviousFiscalYearLabel()); setForm(createEmptyWorksheet());
    setA3OmCost(""); setLineLossPercentage(""); setLessConnectionFeeAmount(""); setLocalPrevailingUtilityProviderRate("");
    setOtherUtilityPart1Quantities({ water: "", wastewater: "", naturalGas: "", electricity: "" });
    setOtherUtilityPart2Rates({ water: "", wastewater: "", naturalGas: "", electricity: "", otherE: "", otherF: "" });
    setOtherUtilityPart2OtherQty({ otherE: "", otherF: "" }); setOtherUtilityPeriodsPerYear("1"); setOtherUtilityPart3Units("");
    setSaveMessage(""); setSaveError(""); setActiveTab("direct-rate-entry");
  }

  // ==========================================================
  // CURRENT DISPLAY TOTALS
  //
  // These are only section arithmetic totals.
  // Government rate formulas are intentionally NOT implemented.
  // ==========================================================
  const totals = (() => {
    const purchasedRows = [
      ...form.purchased,
      ...form.purchasedServices,
    ];
    const subtotalPurchasedCost =
      purchasedRows.reduce(
        (sum, row) =>
          sum +
          parseNumber(
            row.totalAnnualCost,
          ),
        0,
      );
    const subtotalPurchasedConsumption =
      purchasedRows.reduce(
        (sum, row) =>
          sum +
          parseNumber(
            row.annualConsumption,
          ),
        0,
      );
    const subtotalPurchasedMilitaryLabor =
      purchasedRows.reduce(
        (sum, row) =>
          sum +
          parseNumber(
            row.militaryLabor,
          ),
        0,
      );
    const purchasedServicesUescEspcCost =
      form.purchasedServices.reduce(
        (sum, row) => {
          const description =
            row.description
              .trim()
              .toUpperCase();

          const isUescOrEspc =
            description === "UESC" ||
            description === "ESPC";

          return isUescOrEspc
            ? sum +
                parseNumber(
                  row.totalAnnualCost,
                )
            : sum;
        },
        0,
      );

    // A-3 excludes UESC, ESPC, and Utility Priv purchased-service costs.
    // E-7 retains its separate UESC/ESPC-only calculation.
    const purchasedServicesA3DeductionCost =
      form.purchasedServices.reduce((sum, row) => {
        const description = row.description.trim().toUpperCase();
        return description === "UESC" ||
          description === "ESPC" ||
          description === "UTILITY PRIV"
          ? sum + parseNumber(row.totalAnnualCost)
          : sum;
      }, 0);

    const subtotalProducedCost =
      form.produced.reduce(
        (sum, row) =>
          sum +
          parseNumber(
            row.totalAnnualCost,
          ),
        0,
      );
    const subtotalProducedConsumption =
      form.produced.reduce(
        (sum, row) =>
          sum +
          parseNumber(
            row.annualConsumption,
          ),
        0,
      );
    const subtotalProducedMilitaryLabor =
      form.produced.reduce(
        (sum, row) =>
          sum +
          parseNumber(
            row.militaryLabor,
          ),
        0,
      );
    const totalCost =
      subtotalPurchasedCost +
      subtotalProducedCost;
    const totalConsumption =
      subtotalPurchasedConsumption +
      subtotalProducedConsumption;
    const totalMilitaryLabor =
      subtotalPurchasedMilitaryLabor +
      subtotalProducedMilitaryLabor;
    const totalCostLessMilitaryLabor =
      totalCost -
      totalMilitaryLabor;
    const totalSystemOm =
      form.distribution.reduce(
        (sum, row) =>
          sum +
          parseNumber(
            row.cost,
          ),
        0,
      );
    const totalOmMilitaryLabor =
      form.distribution.reduce(
        (sum, row) =>
          sum +
          parseNumber(
            row.militaryLabor,
          ),
        0,
      );
    const totalOmLessMilitaryLabor =
      totalSystemOm -
      totalOmMilitaryLabor;

    // A-3 BASIC COST
    //
    // If Total Cost Less Military Labor > 0:
    //
    //   (
    //     Total Cost Less Military Labor
    //     - UESC, ESPC, and Utility Priv annual costs
    //   )
    //   / Total Annual Consumption
    //
    // Other PURCHASED SERVICES and regular PURCHASED rows are NOT subtracted.
    // Otherwise 0.

    const a3BasicCost =
      totalCostLessMilitaryLabor > 0 &&
      totalConsumption !== 0
        ? (
            totalCostLessMilitaryLabor -
            purchasedServicesA3DeductionCost
          ) / totalConsumption
        : 0;

    // B-6 / C-5 / D-1&2 BASIC COST
    //
    // Total Cost and Consumption (cost)
    // divided by Total Annual Consumption.
    //
    // All three classifications use the same Basic Cost.

    const standardBasicCost =
      totalConsumption !== 0
        ? totalCost / totalConsumption
        : 0;

    // E-7 BASIC COST
    //
    // If Total Cost Less Military Labor > 0:
    //
    //   (
    //     Total Cost Less Military Labor
    //     - PURCHASED SERVICES UESC and/or ESPC
    //       line-item annual cost only
    //   )
    //   / Total Annual Consumption
    //
    // Other PURCHASED SERVICES rows are not subtracted.
    // Otherwise 0.

    const e7BasicCost =
      totalCostLessMilitaryLabor > 0 &&
      totalConsumption !== 0
        ? (
            totalCostLessMilitaryLabor -
            purchasedServicesUescEspcCost
          ) / totalConsumption
        : 0;

    // B-6 O&M COST
    //
    // If Total System O&M > 0:
    //
    //   Total System O&M
    //   / Total Annual Consumption
    //
    // Otherwise 0.

    const b6OmCost =
      totalSystemOm > 0 &&
      totalConsumption !== 0
        ? totalSystemOm /
          totalConsumption
        : 0;

    // C-5 / D-1&2 O&M COST
    //
    // Sum Distribution / Utility System O&M rows classified as
    // "Non-DoD (Federal) Agency Unit Cost".
    //
    // If that sum > 0:
    //   qualifying O&M cost / Total Annual Consumption
    // Otherwise 0.
    //
    // The Distribution / Utility System O&M column is select-or-type:
    // standard classifications are suggested while free text is allowed.

    const nonDodFederalAgencyOmTotal =
      form.distribution.reduce(
        (sum, row) => {
          const classification =
            (row.description ?? "")
              .trim()
              .toLowerCase();

          const isNonDodFederalAgency =
            classification ===
            "non-dod (federal) agency unit cost";

          return isNonDodFederalAgency
            ? sum +
                parseNumber(
                  row.cost,
                )
            : sum;
        },
        0,
      );

    const c5D12OmCost =
      nonDodFederalAgencyOmTotal > 0 &&
      totalConsumption !== 0
        ? nonDodFederalAgencyOmTotal /
          totalConsumption
        : 0;

    // OTHER UTILITY COST
    //
    // A-3, B-6, C-5, and D-1&2 all use the result from
    // Part III of the Other Utility Cost Calculation Worksheet:
    //
    //   Annualized Total Cost / Part III Units
    //
    // E-7 does not use Other Utility Cost.

    const parseOtherUtilityNumber = (
      value: string | number,
    ) => {
      const number = Number(
        String(value).replace(/[$,%\\s,]/g, ""),
      );

      return Number.isFinite(number)
        ? number
        : 0;
    };

    // IMPORTANT: Keep full numeric precision for all worksheet math.
    // formatRate() is display-only; do not round rates before multiplying.
    const otherUtilityWorksheetTotalCost =
      parseOtherUtilityNumber(
        otherUtilityPart1Quantities.water,
      ) *
        parseOtherUtilityNumber(
          otherUtilityPart2Rates.water,
        ) +
      parseOtherUtilityNumber(
        otherUtilityPart1Quantities.wastewater,
      ) *
        parseOtherUtilityNumber(
          otherUtilityPart2Rates.wastewater,
        ) +
      parseOtherUtilityNumber(
        otherUtilityPart1Quantities.naturalGas,
      ) *
        parseOtherUtilityNumber(
          otherUtilityPart2Rates.naturalGas,
        ) +
      parseOtherUtilityNumber(
        otherUtilityPart1Quantities.electricity,
      ) *
        parseOtherUtilityNumber(
          otherUtilityPart2Rates.electricity,
        ) +
      parseOtherUtilityNumber(
        otherUtilityPart2OtherQty.otherE,
      ) *
        parseOtherUtilityNumber(
          otherUtilityPart2Rates.otherE,
        ) +
      parseOtherUtilityNumber(
        otherUtilityPart2OtherQty.otherF,
      ) *
        parseOtherUtilityNumber(
          otherUtilityPart2Rates.otherF,
        );

    const otherUtilityAnnualizedTotalCost =
      otherUtilityWorksheetTotalCost *
      parseOtherUtilityNumber(
        otherUtilityPeriodsPerYear,
      );

    const parsedOtherUtilityPart3Units =
      parseOtherUtilityNumber(
        otherUtilityPart3Units,
      );

    const otherUtilityCostPerUnit =
      parsedOtherUtilityPart3Units > 0
        ? otherUtilityAnnualizedTotalCost /
          parsedOtherUtilityPart3Units
        : 0;

    const a3OtherUtilityCost =
      otherUtilityCostPerUnit;
    const b6OtherUtilityCost =
      otherUtilityCostPerUnit;
    const c5OtherUtilityCost =
      otherUtilityCostPerUnit;
    const d12OtherUtilityCost =
      otherUtilityCostPerUnit;
    const e7OtherUtilityCost = 0;

    // LINE LOSSES
    //
    // Each used customer classification follows:
    //
    //   Line Losses % × .01 ×
    //   (Basic Cost + Other Utility Cost)
    //
    // E-7 does not use Line Losses.

    const lineLossPercent =
      parseNumber(
        lineLossPercentage,
      );

    const calculateLineLoss = (
      basicCost: number,
      otherUtilityCost: number,
    ) =>
      lineLossPercent > 0
        ? lineLossPercent *
          0.01 *
          (
            basicCost +
            otherUtilityCost
          )
        : 0;

    const a3LineLoss =
      calculateLineLoss(
        a3BasicCost,
        a3OtherUtilityCost,
      );

    const b6LineLoss =
      calculateLineLoss(
        standardBasicCost,
        b6OtherUtilityCost,
      );

    const c5LineLoss =
      calculateLineLoss(
        standardBasicCost,
        c5OtherUtilityCost,
      );

    const d12LineLoss =
      calculateLineLoss(
        standardBasicCost,
        d12OtherUtilityCost,
      );

    const e7LineLoss =
      calculateLineLoss(
        e7BasicCost,
        e7OtherUtilityCost,
      );

    // E-7 LESS CONNECTION FEE
    //
    // Only E-7 uses this rate component.
    //
    // If the entered Less Connection Fee dollar amount > 0:
    //
    //   Less Connection Fee
    //   / Subtotal Purchased Annual Consumption
    //
    // Otherwise 0.

    const connectionFeeAmount =
      parseNumber(
        lessConnectionFeeAmount,
      );

    const e7LessConnectionFee =
      connectionFeeAmount > 0 &&
      subtotalPurchasedConsumption > 0
        ? connectionFeeAmount /
          subtotalPurchasedConsumption
        : 0;

    // B-6 CAPITALIZED CHARGES
    //
    // Only B-6 uses this rate component.
    //
    // If Capitalized Investment Cost of Facilities > 0:
    //
    //   (
    //     Capitalized Investment Cost of Facilities
    //     / Maximum Annual Capacity of Utility System
    //   ) * 0.1
    //
    // Otherwise 0.

    const capitalizedInvestmentCost =
      parseNumber(
        form.capitalizedInvestmentCost,
      );

    const maximumAnnualCapacity =
      parseNumber(
        form.maximumAnnualCapacity,
      );

    const b6CapitalizedCharges =
      capitalizedInvestmentCost > 0 &&
      maximumAnnualCapacity > 0
        ? (
            capitalizedInvestmentCost /
            maximumAnnualCapacity
          ) * 0.1
        : 0;

    // B-6 SUBTOTAL
    //
    // Only B-6 uses this row.
    //
    // Sum:
    //   Basic Cost
    // + O&M Costs
    // + Other Utility Cost
    // + Line Losses
    // + Capitalized Charges

    const b6Subtotal =
      standardBasicCost +
      b6OmCost +
      b6OtherUtilityCost +
      b6LineLoss +
      b6CapitalizedCharges;

    // B-6 ADMINISTRATIVE OVERHEAD (3%)
    //
    // Only B-6 uses this row.
    //
    // Formula:
    //   B-6 Subtotal × 0.03

    const b6AdministrativeOverhead =
      b6Subtotal * 0.03;

    // B-6 WHEELING CHARGE
    //
    // Only B-6 uses this row.
    //
    // Sum:
    //   O&M Costs
    // + Other Utility Cost
    // + Capitalized Charges
    // + Administrative Overhead (3%)

    const b6WheelingCharge =
      b6OmCost +
      b6OtherUtilityCost +
      b6CapitalizedCharges +
      b6AdministrativeOverhead;

    // MFH USAF UTILITY RATE
    //
    // Uses the A-3 column:
    //
    //   A-3 Basic Cost
    // + A-3 Other Utility Cost
    // + A-3 Line Losses

    const mfhUsafUtilityRate =
      a3BasicCost +
      a3OtherUtilityCost +
      a3LineLoss;

    // NON-FEDERAL ORGANIZATION USAF UTILITY RATE
    //
    // Uses B-6:
    //
    //   B-6 Subtotal
    // + B-6 Administrative Overhead (3%)

    const nonFederalOrganizationUsafUtilityRate =
      b6Subtotal +
      b6AdministrativeOverhead;

    // NON-DOD FEDERAL AGENCY USAF UTILITY RATE
    //
    // Uses C-5:
    //
    //   C-5 Basic Cost
    // + C-5 Line Losses
    // + C-5 O&M Costs
    // + C-5 Other Utility Cost

    const nonDodFederalAgencyUsafUtilityRate =
      standardBasicCost +
      c5LineLoss +
      c5D12OmCost +
      c5OtherUtilityCost;

    // DOD AGENCY USAF UTILITY RATE
    // (INCLUDES MWR GOLF COURSES)
    //
    // Uses D-1&2:
    //
    //   D-1&2 Basic Cost
    // + D-1&2 Line Losses
    // + D-1&2 O&M Costs
    // + D-1&2 Other Utility Cost

    const dodAgencyUsafUtilityRate =
      standardBasicCost +
      d12LineLoss +
      c5D12OmCost +
      d12OtherUtilityCost;

    // CATEGORY C MWR USAF UTILITY RATE
    // (EXCEPT GOLF COURSES)
    //
    // Uses E-7:
    //
    //   E-7 Basic Cost
    // - E-7 Less Connection Fee

    const categoryCMwrUsafUtilityRate =
      e7BasicCost -
      e7LessConnectionFee;

    return {
      subtotalPurchasedCost,
      subtotalPurchasedConsumption,
      subtotalPurchasedMilitaryLabor,
      subtotalProducedCost,
      subtotalProducedConsumption,
      subtotalProducedMilitaryLabor,
      totalCost,
      totalConsumption,
      totalMilitaryLabor,
      totalCostLessMilitaryLabor,
      totalSystemOm,
      totalOmMilitaryLabor,
      totalOmLessMilitaryLabor,
      a3BasicCost,
      standardBasicCost,
      e7BasicCost,
      b6OmCost,
      c5D12OmCost,
      a3OtherUtilityCost,
      b6OtherUtilityCost,
      c5OtherUtilityCost,
      d12OtherUtilityCost,
      e7OtherUtilityCost,
      a3LineLoss,
      b6LineLoss,
      c5LineLoss,
      d12LineLoss,
      e7LineLoss,
      e7LessConnectionFee,
      b6CapitalizedCharges,
      b6Subtotal,
      b6AdministrativeOverhead,
      b6WheelingCharge,
      mfhUsafUtilityRate,
      nonFederalOrganizationUsafUtilityRate,
      nonDodFederalAgencyUsafUtilityRate,
      dodAgencyUsafUtilityRate,
      categoryCMwrUsafUtilityRate,
    };
  })();
  function build3556Payload() {
    return {
      id: current3556Id ?? undefined, fiscalYear: baseFiscalYear, utilityGroup, utilitySystem: form.utilitySystem,
      uom: form.uom, effectiveDate: form.effectiveDate, status: "DRAFT", worksheet: form,
      rateInputs: { a3OmCost, lineLossPercentage, lessConnectionFeeAmount, localPrevailingUtilityProviderRate },
      otherUtilityWorksheet: { part1Quantities: otherUtilityPart1Quantities, part2Rates: otherUtilityPart2Rates, part2OtherQty: otherUtilityPart2OtherQty, periodsPerYear: otherUtilityPeriodsPerYear, part3Units: otherUtilityPart3Units },
      calculatedRates: {
        a3BasicCost: totals.a3BasicCost, b6BasicCost: totals.standardBasicCost, c5BasicCost: totals.standardBasicCost, d12BasicCost: totals.standardBasicCost, e7BasicCost: totals.e7BasicCost,
        b6OmCost: totals.b6OmCost, c5OmCost: totals.c5D12OmCost, d12OmCost: totals.c5D12OmCost,
        a3OtherUtilityCost: totals.a3OtherUtilityCost, b6OtherUtilityCost: totals.b6OtherUtilityCost, c5OtherUtilityCost: totals.c5OtherUtilityCost, d12OtherUtilityCost: totals.d12OtherUtilityCost, e7OtherUtilityCost: totals.e7OtherUtilityCost,
        a3LineLoss: totals.a3LineLoss, b6LineLoss: totals.b6LineLoss, c5LineLoss: totals.c5LineLoss, d12LineLoss: totals.d12LineLoss, e7LineLoss: totals.e7LineLoss, e7LessConnectionFee: totals.e7LessConnectionFee, b6CapitalizedCharges: totals.b6CapitalizedCharges, b6Subtotal: totals.b6Subtotal, b6AdministrativeOverhead: totals.b6AdministrativeOverhead,
      },
      calculatedSalesRates: { wheelingCharge: totals.b6WheelingCharge, mfh: totals.mfhUsafUtilityRate, nonFederal: totals.nonFederalOrganizationUsafUtilityRate, localPrevailing: localPrevailingUtilityProviderRate, nonDodFederal: totals.nonDodFederalAgencyUsafUtilityRate, dod: totals.dodAgencyUsafUtilityRate, categoryCMwr: totals.categoryCMwrUsafUtilityRate },
    };
  }

  async function saveDraft() {
    if (!utilityGroup) { setSaveError("Select a Utility Group before saving."); return; }
    if (!form.utilitySystem) { setSaveError("Select a Utility System before saving."); return; }
    setIsSaving(true); setSaveError(""); setSaveMessage("");
    try {
      const response = await fetch("/api/billing/3556", { method: current3556Id ? "PUT" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(build3556Payload()) });
      const data = await response.json();
      if (!response.ok) throw new Error(data?.error || "Unable to save 3556 draft.");
      setCurrent3556Id(data.record.id); setStatus(data.record.status); setSaveMessage("3556 draft saved."); await load3556History();
    } catch (error) { setSaveError(error instanceof Error ? error.message : "Unable to save 3556 draft."); } finally { setIsSaving(false); }
  }

  async function finalize3556() {
    if (!current3556Id) { setSaveError("Save the 3556 as a draft before finalizing it."); return; }
    if (!window.confirm("Finalize this 3556? Once FINAL, this historical snapshot will be read-only.")) return;
    setIsSaving(true); setSaveError(""); setSaveMessage("");
    try {
      const saveResponse = await fetch("/api/billing/3556", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(build3556Payload()) });
      const saveData = await saveResponse.json(); if (!saveResponse.ok) throw new Error(saveData?.error || "Unable to save latest values.");
      const response = await fetch("/api/billing/3556", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: current3556Id, action: "FINALIZE" }) });
      const data = await response.json(); if (!response.ok) throw new Error(data?.error || "Unable to finalize 3556.");
      setStatus("FINAL"); setSaveMessage("3556 finalized. Basic Cost A-3 is now the approved ±5% monitoring baseline for this utility."); await load3556History();
    } catch (error) { setSaveError(error instanceof Error ? error.message : "Unable to finalize 3556."); } finally { setIsSaving(false); }
  }

  // ==========================================================
  // FORM HELPERS
  // ==========================================================
  function updateHeaderField<
    K extends keyof WorksheetForm
  >(
    field: K,
    value: WorksheetForm[K],
  ) {
    setForm((current) => ({
      ...current,
      [field]: value,
    }));
  }
  function addDataRow(
    section:
      | "purchased"
      | "purchasedServices"
      | "produced",
  ) {
    setForm((current) => ({
      ...current,
      [section]: [
        ...current[section],
        createDataRow(),
      ],
    }));
  }
  function updateDataRow(
    section:
      | "purchased"
      | "purchasedServices"
      | "produced",
    id: string,
    field: keyof Omit<
      DataInputRow,
      "id"
    >,
    value: string,
  ) {
    setForm((current) => ({
      ...current,
      [section]:
        current[section].map(
          (row) =>
            row.id === id
              ? {
                  ...row,
                  [field]: value,
                }
              : row,
        ),
    }));
  }
  function removeDataRow(
    section:
      | "purchased"
      | "purchasedServices"
      | "produced",
    id: string,
  ) {
    setForm((current) => ({
      ...current,
      [section]:
        current[section].filter(
          (row) =>
            row.id !== id,
        ),
    }));
  }
  function addOmRow() {
    setForm((current) => ({
      ...current,
      distribution: [
        ...current.distribution,
        createOmRow(),
      ],
    }));
  }
  function updateOmRow(
    id: string,
    field: keyof Omit<
      OmRow,
      "id"
    >,
    value: string,
  ) {
    setForm((current) => ({
      ...current,
      distribution:
        current.distribution.map(
          (row) =>
            row.id === id
              ? {
                  ...row,
                  [field]: value,
                }
              : row,
        ),
    }));
  }
  function removeOmRow(
    id: string,
  ) {
    setForm((current) => ({
      ...current,
      distribution:
        current.distribution.filter(
          (row) =>
            row.id !== id,
        ),
    }));
  }
  // ==========================================================
  // OTHER UTILITY COST WORKSHEET CALCULATIONS
  // Quantity × Rate = Cost
  // Total Cost × Periods/Year = Annualized Total Cost
  // ==========================================================
  const parseOucwNumber = (value: string) => {
    const number = Number(value.replace(/[$,%\\s,]/g, ""));
    return Number.isFinite(number) ? number : 0;
  };

  const oucwQuantities = {
    water: otherUtilityPart1Quantities.water,
    wastewater: otherUtilityPart1Quantities.wastewater,
    naturalGas: otherUtilityPart1Quantities.naturalGas,
    electricity: otherUtilityPart1Quantities.electricity,
    otherE: otherUtilityPart2OtherQty.otherE,
    otherF: otherUtilityPart2OtherQty.otherF,
  };

  const oucwCosts = {
    water: parseOucwNumber(oucwQuantities.water) * parseOucwNumber(otherUtilityPart2Rates.water),
    wastewater: parseOucwNumber(oucwQuantities.wastewater) * parseOucwNumber(otherUtilityPart2Rates.wastewater),
    naturalGas: parseOucwNumber(oucwQuantities.naturalGas) * parseOucwNumber(otherUtilityPart2Rates.naturalGas),
    electricity: parseOucwNumber(oucwQuantities.electricity) * parseOucwNumber(otherUtilityPart2Rates.electricity),
    otherE: parseOucwNumber(oucwQuantities.otherE) * parseOucwNumber(otherUtilityPart2Rates.otherE),
    otherF: parseOucwNumber(oucwQuantities.otherF) * parseOucwNumber(otherUtilityPart2Rates.otherF),
  };

  const oucwTotalCost = Object.values(oucwCosts).reduce((sum, value) => sum + value, 0);
  const oucwAnnualizedTotalCost =
    oucwTotalCost * parseOucwNumber(otherUtilityPeriodsPerYear);

  // PART III
  //
  // Annualized Total Cost
  // ÷ Total Purchased and Produced Units
  // = Other Utility Cost / Unit
  const oucwPart3Units =
    parseOucwNumber(otherUtilityPart3Units);

  const oucwOtherUtilityCostPerUnit =
    oucwPart3Units > 0
      ? oucwAnnualizedTotalCost / oucwPart3Units
      : 0;

  const formatOucwCurrency = (value: number) =>
    value.toLocaleString("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });

  const formatOucwRate = (value: number) =>
    `$${value.toFixed(5)}`;

  // ==========================================================
  // RENDER
  // ==========================================================
  const billingSections = <>
    <p className="ce-section-heading">Customer bills</p>
    <button type="button" className={`ce-section-item ${activeTab === "customer-billing" ? "ce-section-item-active" : ""}`} aria-pressed={activeTab === "customer-billing"} onClick={() => setActiveTab("customer-billing")}>RCBL Short</button>
    <p className="ce-section-heading">Accounting reports</p>
    {([
      ["rcbl", "RCBL"],
      ["eeic-short", "EEIC Short"],
      ["eeic-detail", "EEIC Detail"],
    ] as const).map(([id, label]) => (
      <button key={id} type="button" className={`ce-section-item ${activeTab === "accounting-reports" && customerBillingTab === id ? "ce-section-item-active" : ""}`} aria-pressed={activeTab === "accounting-reports" && customerBillingTab === id} onClick={() => { setCustomerBillingTab(id); setActiveTab("accounting-reports"); }}>{label}</button>
    ))}
    <p className="ce-section-heading">Accounting setup</p>
    <button type="button" className={`ce-section-item ${activeTab === "accounting-setup" ? "ce-section-item-active" : ""}`} aria-pressed={activeTab === "accounting-setup"} onClick={() => setActiveTab("accounting-setup")}>3556 classifications &amp; EEIC codes</button>
    <p className="ce-section-heading">Other billing tools</p>
    <button type="button" className={`ce-section-item ${activeTab === "direct-rate-entry" ? "ce-section-item-active" : ""}`} aria-pressed={activeTab === "direct-rate-entry"} onClick={() => setActiveTab("direct-rate-entry")}>3556 Rate Worksheet</button>
    <button type="button" className={`ce-section-item ${activeTab === "3556-history" ? "ce-section-item-active" : ""}`} aria-pressed={activeTab === "3556-history"} onClick={() => { setSelectedHistory3556(null); setActiveTab("3556-history"); void load3556History(); }}>3556 History</button>
    <button type="button" className={`ce-section-item ${activeTab === "afers" ? "ce-section-item-active" : ""}`} aria-pressed={activeTab === "afers"} onClick={() => setActiveTab("afers")}>AFERS</button>
  </>;

  return (
    <div className="ce-body">
      <aside className="ce-sidebar">
        <nav className="ce-nav" aria-label="Primary navigation">
          {navItems.map(item => {
            const Icon = item.icon;
            return <div key={item.label}>
              <Link href={item.href} className={`ce-nav-item ${item.label === "Billing" ? "ce-nav-active" : ""}`} aria-expanded={item.label === "Billing" ? true : undefined}>
                <Icon size={25} /><span>{item.label}</span>
              </Link>
              {item.label === "Billing" && <nav className="ce-section-nav" aria-label="Billing sections">{billingSections}</nav>}
            </div>;
          })}
        </nav>
      </aside>
      <main className="ce-main billing-main">
        <section className="billing-title-row">
          <div><p className="bd-eyebrow">Billing processing</p><h1>Billing</h1><p className="bd-subtitle">Manage customer billing, accounting reports, and utility rate worksheets.</p></div>
        </section>
        <nav className="ce-mobile-section-nav" aria-label="Billing sections">{billingSections}</nav>
        <section className="bd-workspace billing-workspace">
      {/* ====================================================
          AFERS
      ==================================================== */}
      {activeTab === "afers" && (
        <Placeholder
          title="AFERS"
          description="AFERS billing processing will be built in this section."
        />
      )}
      {/* ====================================================
          CUSTOMER BILLING
      ==================================================== */}
      {activeTab === "customer-billing" && (
        <div className="billing-content customer-billing-content">
          <RCBLShortPreview />
        </div>
      )}
      {activeTab === "accounting-reports" && (
        <div className="billing-content">
          <FinancialReportingPanel kind={customerBillingTab === "rcbl" ? "RCBL" : customerBillingTab === "eeic-short" ? "EEIC_SHORT" : "EEIC_DETAIL"} />
        </div>
      )}
      {activeTab === "accounting-setup" && (
        <div className="billing-content">
          <FinancialReportingSetup />
        </div>
      )}
      {/* ====================================================
          3556 HISTORY
      ==================================================== */}
      {activeTab === "3556-history" &&
        selectedHistory3556 === null && (
          <div className="billing-content">
            <div className="billing-control-bar">
              <div>
                <p className="billing-control-eyebrow">Historical Records</p>
                <h2>3556 History</h2>
                <p>View previously completed Utility Sales Rates Computation Worksheets.</p>
              </div>
            </div>
            <div className="history-table-shell">
              <table className="history-table">
                <thead>
                  <tr>
                    <th>Fiscal Year</th>
                    <th>Name of Base</th>
                    <th>Utility Group</th>
                    <th>Utility System</th>
                    <th>UoM</th>
                    <th>Effective Date</th>
                    <th>Status</th>
                    <th>Prepared Date</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {historyRecords.map((record) => (
                    <tr key={record.id}>
                      <td><strong>{record.fiscalYear}</strong></td>
                      <td>{record.worksheet.nameOfBase}</td>
                      <td>{record.utilityGroup}</td>
                      <td>{record.utilitySystem}</td>
                      <td>{record.uom}</td>
                      <td>{record.effectiveDate}</td>
                      <td>
                        <span
                          className={`history-status ${
                            record.status === "FINAL"
                              ? "history-status-final"
                              : record.status === "DRAFT"
                                ? "history-status-draft"
                                : "history-status-archived"
                          }`}
                        >
                          {record.status}
                        </span>
                      </td>
                      <td>{record.preparedDate}</td>
                      <td className="history-open-cell">
                        <button
                          type="button"
                          className="history-open-button"
                          onClick={() => {
                            load3556Record(record);
                          }}
                        >
                          {record.status === "DRAFT" ? "Edit" : "View"}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

      {/* ====================================================
          DIRECT RATE ENTRY
      ==================================================== */}
      {(activeTab === "direct-rate-entry" || isHistoryView) && (
        <div className="billing-content">
          {/* =================================================
              WORKSHEET CONTROLS
          ================================================= */}
          <div className="billing-control-bar">
            <div>
              <p className="billing-control-eyebrow">
                {isHistoryView ? "Historical 3556" : "Direct Rate Entry"}
              </p>
              <h2>
                {isHistoryView
                  ? `${selectedHistory3556?.fiscalYear} — ${selectedHistory3556?.utilitySystem}`
                  : "Utility Sales Rates"}
              </h2>
              <p>
                {isHistoryView
                  ? "View the saved Utility Sales Rates Computation Worksheet in read-only format."
                  : "Build the utility sales rate computation worksheet for a utility group and utility system."}
              </p>
            </div>
            <div className="billing-control-actions">
              {isHistoryView ? (
                <>
                  <span className="history-readonly-badge">VIEW ONLY</span>
                  <span className="billing-status-badge">
                    {selectedHistory3556?.status}
                  </span>
                  <button
                    type="button"
                    className="history-open-button"
                    onClick={() => setSelectedHistory3556(null)}
                  >
                    ← Back to History
                  </button>
                </>
              ) : (
                <>
                  <span className="billing-status-badge">
                    {status}
                  </span>
                  <button type="button" className="history-open-button" onClick={startNew3556} disabled={isSaving}>New 3556</button>
                  <button type="button" className="billing-save-button" onClick={() => void saveDraft()} disabled={isSaving || status === "FINAL"}>
                    <Save size={15} />
                    {isSaving ? "Saving..." : "Save Draft"}
                  </button>
                  {current3556Id && status === "DRAFT" && (
                    <button type="button" className="billing-save-button" onClick={() => void finalize3556()} disabled={isSaving}>Finalize 3556</button>
                  )}
                </>
              )}
            </div>
          </div>
          {(saveMessage || saveError) && (
            <div role={saveError ? "alert" : "status"} style={{ margin: "0 0 12px", padding: "10px 12px", border: "1px solid #d1d5db", borderRadius: "6px", background: saveError ? "#fff7f7" : "#f7fff8", fontSize: "0.9rem" }}>
              {saveError || saveMessage}
            </div>
          )}

          <div
            style={{
              margin: "0 0 14px",
              padding: "12px 14px",
              border: "1px solid #d1d5db",
              borderRadius: "8px",
              background: "#fafafa",
              display: "flex",
              gap: "24px",
              alignItems: "center",
              flexWrap: "wrap",
            }}
          >
            <div>
              <div style={{ fontSize: "0.75rem", fontWeight: 700, textTransform: "uppercase", color: "#6b7280" }}>
                3556 Rate Monitoring Baseline
              </div>
              <div style={{ marginTop: "3px", fontWeight: 700 }}>
                Basic Cost — A-3
              </div>
            </div>
            <div>
              <div style={{ fontSize: "0.75rem", color: "#6b7280" }}>
                {isHistoryView && selectedHistory3556?.status === "FINAL" ? "Approved baseline" : "Baseline preview"}
              </div>
              <div style={{ fontSize: "1.05rem", fontWeight: 700 }}>
                {formatRate(
                  isHistoryView && selectedHistory3556?.rateMonitoring?.baselineRate != null
                    ? selectedHistory3556.rateMonitoring.baselineRate
                    : totals.a3BasicCost,
                )}
                {form.uom ? ` / ${form.uom}` : ""}
              </div>
            </div>
            <div>
              <div style={{ fontSize: "0.75rem", color: "#6b7280" }}>Threshold</div>
              <div style={{ fontWeight: 700 }}>±5%</div>
            </div>
            <div style={{ fontSize: "0.82rem", color: "#4b5563", maxWidth: "560px" }}>
              When this 3556 is FINAL, its Basic Cost A-3 becomes the approved baseline used to compare new invoice cost ÷ consumption.
            </div>
          </div>

          <div className="billing-selector-bar">
            <label>
              <span>
                Utility Group
              </span>
              <select
                value={utilityGroup}
                disabled={isHistoryView}
                onChange={(event) => {
                  const nextUtilityGroup =
                    event.target.value;

                  setUtilityGroup(
                    nextUtilityGroup,
                  );

                  updateHeaderField(
                    "nameOfBase",
                    buildBaseName(
                      baseFiscalYear,
                      nextUtilityGroup,
                    ),
                  );
                }}
              >
                <option value="">
                  Select Utility Group
                </option>
                <option value="WWYK">
                  WWYK
                </option>
                <option value="TAC">
                  TAC
                </option>
              </select>
            </label>
            <label>
              <span>
                Utility System
              </span>
              <select
                value={
                  form.utilitySystem
                }
                disabled={isHistoryView}
                onChange={(event) =>
                  updateHeaderField(
                    "utilitySystem",
                    event.target.value,
                  )
                }
              >
                <option value="">
                  Select Utility System
                </option>
                <option value="ELECTRICITY">
                  Electricity
                </option>
                <option value="NATURAL GAS">
                  Natural Gas
                </option>
                <option value="PRODUCED WATER">
                  {utilityGroup === "TAC" ? "Purchased Water" : "Produced Water"}
                </option>
                <option value="SEWER">
                  Sewer
                </option>
              </select>
            </label>
          </div>
          {/* =================================================
              3556 WORKSHEET
          ================================================= */}
          <fieldset
            className="history-worksheet-fieldset"
            disabled={isHistoryView}
          >
          <div className="rate-sheet-shell">
            <div className="rate-sheet">
              <div className="rate-sheet-title">
                UTILITY SALES RATES
                COMPUTATION WORKSHEET
              </div>
              {/* =============================================
                  GENERAL INFORMATION
              ============================================= */}
              <div className="rate-header-grid rate-header-grid-top">
                <BaseNameField
                  fiscalYear={baseFiscalYear}
                  utilityGroup={utilityGroup}
                  onFiscalYearChange={(value) => {
                    setBaseFiscalYear(value);

                    updateHeaderField(
                      "nameOfBase",
                      buildBaseName(
                        value,
                        utilityGroup,
                      ),
                    );
                  }}
                />
                <WorksheetDisplayField
                  label="Utility System"
                  value={
                    form.utilitySystem
                  }
                />
                <WorksheetField
                  label="UoM"
                  value={form.uom}
                  onChange={(value) =>
                    updateHeaderField(
                      "uom",
                      value,
                    )
                  }
                />
                <WorksheetField
                  label="Capitalized Investment Cost of Facilities"
                  value={
                    form.capitalizedInvestmentCost
                  }
                  type="number"
                  onChange={(value) =>
                    updateHeaderField(
                      "capitalizedInvestmentCost",
                      value,
                    )
                  }
                />
                <WorksheetField
                  label="Effective Date"
                  value={
                    form.effectiveDate
                  }
                  type="date"
                  onChange={(value) =>
                    updateHeaderField(
                      "effectiveDate",
                      value,
                    )
                  }
                />
              </div>
              <div className="rate-header-grid rate-header-grid-bottom">
                <WorksheetField
                  className="rate-manager-field"
                  label="Energy-Utility/Manager Name/Phone/E-mail Address"
                  value={
                    form.managerContact
                  }
                  onChange={(value) =>
                    updateHeaderField(
                      "managerContact",
                      value,
                    )
                  }
                />
                <WorksheetField
                  label="Maximum Annual Capacity of Utility System"
                  value={
                    form.maximumAnnualCapacity
                  }
                  type="number"
                  onChange={(value) =>
                    updateHeaderField(
                      "maximumAnnualCapacity",
                      value,
                    )
                  }
                />
                <WorksheetField
                  label="UoM"
                  value={
                    form.capacityUom
                  }
                  onChange={(value) =>
                    updateHeaderField(
                      "capacityUom",
                      value,
                    )
                  }
                />
                <WorksheetField
                  label="Replaced Date"
                  value={
                    form.replacedDate
                  }
                  type="date"
                  onChange={(value) =>
                    updateHeaderField(
                      "replacedDate",
                      value,
                    )
                  }
                />
              </div>
              {/* =============================================
                  DATA INPUT
              ============================================= */}
              <WorksheetSectionTitle>
                DATA INPUT
              </WorksheetSectionTitle>
              <div className="data-period-row">
                <label>
                  <span>
                    Data Period /
                    Description
                  </span>
                  <input
                    value={
                      form.dataPeriodDescription
                    }
                    onChange={(event) =>
                      updateHeaderField(
                        "dataPeriodDescription",
                        event.target.value,
                      )
                    }
                    placeholder="DATA - Oct 2022-Sep 2023 / Audit REDO 051425"
                  />
                </label>
              </div>
              <div className="worksheet-table-shell">
                <table className="worksheet-table data-input-table">
                  <thead>
                    <tr>
                      <th className="section-column">
                        Section /
                        Description
                      </th>
                      <th>
                        Account Code /
                        Project Number
                      </th>
                      <th>
                        Total Annual Cost
                      </th>
                      <th>
                        Annual Consumption
                      </th>
                      <th>
                        Military Labor
                      </th>
                      <th>
                        Notes
                      </th>
                      <th className="action-column" />
                    </tr>
                  </thead>
                  <tbody>
                    <DataParentRow
                      title="PURCHASED"
                      onAdd={() =>
                        addDataRow(
                          "purchased",
                        )
                      }
                    />
                    {form.purchased.map(
                      (row) => (
                        <DataEntryRow
                          key={row.id}
                          row={row}
                          onUpdate={(
                            field,
                            value,
                          ) =>
                            updateDataRow(
                              "purchased",
                              row.id,
                              field,
                              value,
                            )
                          }
                          onRemove={() =>
                            removeDataRow(
                              "purchased",
                              row.id,
                            )
                          }
                        />
                      ),
                    )}
                    <DataParentRow
                      title="PURCHASED SERVICES"
                      onAdd={() =>
                        addDataRow(
                          "purchasedServices",
                        )
                      }
                    />
                    {form.purchasedServices.map(
                      (row) => (
                        <DataEntryRow
                          key={row.id}
                          row={row}
                          onUpdate={(
                            field,
                            value,
                          ) =>
                            updateDataRow(
                              "purchasedServices",
                              row.id,
                              field,
                              value,
                            )
                          }
                          onRemove={() =>
                            removeDataRow(
                              "purchasedServices",
                              row.id,
                            )
                          }
                        />
                      ),
                    )}
                    <SummaryRow
                      label="Subtotal Purchased"
                      cost={
                        totals.subtotalPurchasedCost
                      }
                      consumption={
                        totals.subtotalPurchasedConsumption
                      }
                      militaryLabor={
                        totals.subtotalPurchasedMilitaryLabor
                      }
                    />
                    <DataParentRow
                      title="BASE PRODUCED UTILITY - COST TO PRODUCE"
                      onAdd={() =>
                        addDataRow(
                          "produced",
                        )
                      }
                    />
                    {form.produced.map(
                      (row) => (
                        <DataEntryRow
                          key={row.id}
                          row={row}
                          onUpdate={(
                            field,
                            value,
                          ) =>
                            updateDataRow(
                              "produced",
                              row.id,
                              field,
                              value,
                            )
                          }
                          onRemove={() =>
                            removeDataRow(
                              "produced",
                              row.id,
                            )
                          }
                        />
                      ),
                    )}
                    <SummaryRow
                      label="Subtotal Produced"
                      cost={
                        totals.subtotalProducedCost
                      }
                      consumption={
                        totals.subtotalProducedConsumption
                      }
                      militaryLabor={
                        totals.subtotalProducedMilitaryLabor
                      }
                    />
                    <SummaryRow
                      label="Total Cost and Consumption"
                      cost={
                        totals.totalCost
                      }
                      consumption={
                        totals.totalConsumption
                      }
                      militaryLabor={
                        totals.totalMilitaryLabor
                      }
                      strong
                    />
                    <tr className="worksheet-summary-row worksheet-strong-summary">
                      <th>
                        Total Cost Less
                        Military Labor
                      </th>
                      <td />
                      <td>
                        {formatCurrency(
                          totals.totalCostLessMilitaryLabor,
                        )}
                      </td>
                      <td />
                      <td />
                      <td />
                      <td />
                    </tr>
                  </tbody>
                </table>
              </div>
              {/* =============================================
                  DISTRIBUTION / SYSTEM O&M
              ============================================= */}
              <div className="worksheet-table-shell">
                <table className="worksheet-table om-table">
                  <thead>
                    <tr>
                      <th className="section-column">
                        Distribution /
                        Utility System O&amp;M
                      </th>
                      <th>
                        Account Code /
                        Project Number
                      </th>
                      <th>
                        Cost
                      </th>
                      <th>
                        Military Labor
                      </th>
                      <th>
                        Notes
                      </th>
                      <th className="action-column">
                        <button
                          type="button"
                          className="worksheet-add-row"
                          onClick={
                            addOmRow
                          }
                        >
                          <Plus
                            size={13}
                          />
                          Add Row
                        </button>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {form.distribution.length ===
                    0 ? (
                      <tr className="worksheet-empty-row">
                        <td
                          colSpan={6}
                        >
                          No distribution
                          or utility
                          system O&amp;M
                          entries added.
                        </td>
                      </tr>
                    ) : (
                      form.distribution.map(
                        (row) => (
                          <OmEntryRow
                            key={row.id}
                            row={row}
                            onUpdate={(
                              field,
                              value,
                            ) =>
                              updateOmRow(
                                row.id,
                                field,
                                value,
                              )
                            }
                            onRemove={() =>
                              removeOmRow(
                                row.id,
                              )
                            }
                          />
                        ),
                      )
                    )}
                    <tr className="worksheet-summary-row">
                      <th>
                        Total System
                        O&amp;M
                      </th>
                      <td />
                      <td>
                        {formatCurrency(
                          totals.totalSystemOm,
                        )}
                      </td>
                      <td>
                        {formatCurrency(
                          totals.totalOmMilitaryLabor,
                        )}
                      </td>
                      <td />
                      <td />
                    </tr>
                    <tr className="worksheet-summary-row worksheet-strong-summary">
                      <th>
                        Total O&amp;M Cost
                        Less Military Labor
                      </th>
                      <td />
                      <td>
                        {formatCurrency(
                          totals.totalOmLessMilitaryLabor,
                        )}
                      </td>
                      <td />
                      <td />
                      <td />
                    </tr>
                  </tbody>
                </table>
              </div>
              {/* =============================================
                  RATE CALCULATIONS
              ============================================= */}
              <WorksheetSectionTitle>
                RATE CALCULATIONS
              </WorksheetSectionTitle>
              <div className="rate-category-note">
                Category Codes can be
                found on Attachment 2 of
                the DAFPAM 32-10144
              </div>
              <div className="worksheet-table-shell">
                <table className="worksheet-table rate-calculation-table">
                  <thead>
                    <tr>
                      <th className="rate-component-column">
                        Customer
                        Classifications
                      </th>

                      <th className="rate-static-input-column">
                        Input
                      </th>

                      {RATE_COLUMNS.map(
                        (column) => (
                          <th
                            key={
                              column.code
                            }
                          >
                            <strong>
                              {
                                column.code
                              }
                            </strong>
                            <span>
                              {
                                column.label
                              }
                            </span>
                          </th>
                        ),
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {RATE_ROWS.map(
                      (row) => (
                        <tr key={row}>
                          <th>
                            <div className="rate-description-with-note">
                              <span>{row}</span>
                              <span className="rate-math-note">
                                {row === "Basic Cost"
                                  ? "A-3: (Total Cost Less Military Labor − UESC/ESPC/Utility Priv only) ÷ Total Annual Consumption. B-6/C-5/D-1&2: Total Cost ÷ Total Annual Consumption. E-7: (Total Cost Less Military Labor − UESC/ESPC Purchased Services) ÷ Total Annual Consumption."
                                  : row === "O&M Costs"
                                    ? "A-3: free text (*as incurred). B-6: Total System O&M ÷ Total Annual Consumption. C-5/D-1&2: qualifying Non-DoD Federal O&M ÷ Total Annual Consumption. E-7: not used."
                                    : row === "Other Utility Cost"
                                      ? "A-3/B-6/C-5/D-1&2: Part III Other Utility Cost / Unit. E-7: not used."
                                      : row === "Line Losses"
                                        ? "Line Loss % × 0.01 × (that column's Basic Cost + Other Utility Cost). E-7 is not used."
                                        : row === "Less Connection Fee"
                                          ? "E-7 only: connection fee dollar amount ÷ Subtotal Purchased Annual Consumption."
                                          : row === "Capitalized Charges"
                                            ? "B-6 only: (Capitalized Investment Cost ÷ Maximum Annual Capacity) × 0.1."
                                            : row === "Subtotal"
                                              ? "B-6 only: Basic Cost + O&M + Other Utility Cost + Line Losses + Capitalized Charges."
                                              : row === "Administrative Overhead (3%)"
                                                ? "B-6 only: B-6 Subtotal × 0.03."
                                                : ""}
                              </span>
                            </div>
                          </th>

                          <td className="rate-static-input-cell">
                            {row === "Line Losses" ? (
                              <div className="rate-static-input-wrap">
                                <input
                                  value={lineLossPercentage}
                                  onChange={(event) =>
                                    setLineLossPercentage(
                                      event.target.value,
                                    )
                                  }
                                  inputMode="decimal"
                                  placeholder="0"
                                  aria-label="Line Losses percentage"
                                />
                                <span>%</span>
                              </div>
                            ) : row === "Less Connection Fee" ? (
                              <div className="rate-static-input-wrap rate-static-currency">
                                <span>$</span>
                                <input
                                  value={lessConnectionFeeAmount}
                                  onChange={(event) =>
                                    setLessConnectionFeeAmount(
                                      event.target.value,
                                    )
                                  }
                                  inputMode="decimal"
                                  placeholder="0.00"
                                  aria-label="Less Connection Fee dollar amount"
                                />
                              </div>
                            ) : (
                              <span className="rate-static-empty">
                                —
                              </span>
                            )}
                          </td>

                          {RATE_COLUMNS.map(
                            (
                              column,
                            ) => {
                              const isA3BasicCost =
                                row === "Basic Cost" &&
                                column.code === "A-3";

                              const isA3OmCost =
                                row === "O&M Costs" &&
                                column.code === "A-3";

                              const isB6OmCost =
                                row === "O&M Costs" &&
                                column.code === "B-6";

                              const isC5D12OmCost =
                                row === "O&M Costs" &&
                                (
                                  column.code === "C-5" ||
                                  column.code === "D-1&2"
                                );

                              const isOtherUtilityCost =
                                row === "Other Utility Cost" &&
                                column.code !== "E-7";

                              const otherUtilityCostValue =
                                column.code === "A-3"
                                  ? totals.a3OtherUtilityCost
                                  : column.code === "B-6"
                                    ? totals.b6OtherUtilityCost
                                    : column.code === "C-5"
                                      ? totals.c5OtherUtilityCost
                                      : column.code === "D-1&2"
                                        ? totals.d12OtherUtilityCost
                                        : null;

                              const isLineLoss =
                                row === "Line Losses";

                              const lineLossValue =
                                column.code === "A-3"
                                  ? totals.a3LineLoss
                                  : column.code === "B-6"
                                    ? totals.b6LineLoss
                                    : column.code === "C-5"
                                      ? totals.c5LineLoss
                                      : column.code === "D-1&2"
                                        ? totals.d12LineLoss
                                        : column.code === "E-7"
                                          ? totals.e7LineLoss
                                          : null;

                              const isUnusedE7RateComponent =
                                column.code === "E-7" &&
                                (
                                  row === "O&M Costs" ||
                                  row === "Other Utility Cost" ||
                                  row === "Line Losses"
                                );

                              const isE7LessConnectionFee =
                                row === "Less Connection Fee" &&
                                column.code === "E-7";

                              const isUnusedConnectionFeeCell =
                                row === "Less Connection Fee" &&
                                column.code !== "E-7";

                              const isB6CapitalizedCharges =
                                row === "Capitalized Charges" &&
                                column.code === "B-6";

                              const isUnusedCapitalizedChargesCell =
                                row === "Capitalized Charges" &&
                                column.code !== "B-6";

                              const isB6Subtotal =
                                row === "Subtotal" &&
                                column.code === "B-6";

                              const isUnusedSubtotalCell =
                                row === "Subtotal" &&
                                column.code !== "B-6";

                              const isB6AdministrativeOverhead =
                                row === "Administrative Overhead (3%)" &&
                                column.code === "B-6";

                              const isUnusedAdministrativeOverheadCell =
                                row === "Administrative Overhead (3%)" &&
                                column.code !== "B-6";

                              const isStandardBasicCost =
                                row === "Basic Cost" &&
                                (
                                  column.code === "B-6" ||
                                  column.code === "C-5" ||
                                  column.code === "D-1&2"
                                );

                              const isE7BasicCost =
                                row === "Basic Cost" &&
                                column.code === "E-7";

                              const basicCostValue =
                                isA3BasicCost
                                  ? totals.a3BasicCost
                                  : isStandardBasicCost
                                    ? totals.standardBasicCost
                                    : isE7BasicCost
                                      ? totals.e7BasicCost
                                      : null;

                              return (
                                <td
                                  key={`${row}-${column.code}`}
                                  className="calculated-cell"
                                >
                                  {isUnusedE7RateComponent ? (
                                    <span
                                      className="rate-not-used"
                                      aria-label={`${row} ${column.code} not used`}
                                    >
                                      —
                                    </span>
                                  ) : basicCostValue !== null ? (
                                    <output
                                      className="live-rate-value"
                                      aria-label={`${row} ${column.code}`}
                                    >
                                      {formatRate(
                                        basicCostValue,
                                      )}
                                    </output>
                                  ) : isB6OmCost ? (
                                    <output
                                      className="live-rate-value"
                                      aria-label={`${row} ${column.code}`}
                                    >
                                      {formatRate(
                                        totals.b6OmCost,
                                      )}
                                    </output>
                                  ) : isC5D12OmCost ? (
                                    <output
                                      className="live-rate-value"
                                      aria-label={`${row} ${column.code}`}
                                    >
                                      {formatRate(
                                        totals.c5D12OmCost,
                                      )}
                                    </output>
                                  ) : isOtherUtilityCost &&
                                    otherUtilityCostValue !== null ? (
                                    <output
                                      className="live-rate-value"
                                      aria-label={`${row} ${column.code}`}
                                    >
                                      {formatRate(
                                        otherUtilityCostValue,
                                      )}
                                    </output>
                                  ) : isLineLoss &&
                                    lineLossValue !== null ? (
                                    <output
                                      className="live-rate-value"
                                      aria-label={`${row} ${column.code}`}
                                    >
                                      {formatRate(
                                        lineLossValue,
                                      )}
                                    </output>
                                  ) : isE7LessConnectionFee ? (
                                    <output
                                      className="live-rate-value"
                                      aria-label={`${row} ${column.code}`}
                                    >
                                      {formatRate(
                                        totals.e7LessConnectionFee,
                                      )}
                                    </output>
                                  ) : isUnusedConnectionFeeCell ? (
                                    <span
                                      className="rate-not-used"
                                      aria-label={`${row} ${column.code} not used`}
                                    >
                                      —
                                    </span>
                                  ) : isB6CapitalizedCharges ? (
                                    <output
                                      className="live-rate-value"
                                      aria-label={`${row} ${column.code}`}
                                    >
                                      {formatRate(
                                        totals.b6CapitalizedCharges,
                                      )}
                                    </output>
                                  ) : isUnusedCapitalizedChargesCell ? (
                                    <span
                                      className="rate-not-used"
                                      aria-label={`${row} ${column.code} not used`}
                                    >
                                      —
                                    </span>
                                  ) : isB6Subtotal ? (
                                    <output
                                      className="live-rate-value"
                                      aria-label={`${row} ${column.code}`}
                                    >
                                      {formatRate(
                                        totals.b6Subtotal,
                                      )}
                                    </output>
                                  ) : isUnusedSubtotalCell ? (
                                    <span
                                      className="rate-not-used"
                                      aria-label={`${row} ${column.code} not used`}
                                    >
                                      —
                                    </span>
                                  ) : isB6AdministrativeOverhead ? (
                                    <output
                                      className="live-rate-value"
                                      aria-label={`${row} ${column.code}`}
                                    >
                                      {formatRate(
                                        totals.b6AdministrativeOverhead,
                                      )}
                                    </output>
                                  ) : isUnusedAdministrativeOverheadCell ? (
                                    <span
                                      className="rate-not-used"
                                      aria-label={`${row} ${column.code} not used`}
                                    >
                                      —
                                    </span>
                                  ) : isA3OmCost ? (
                                    <input
                                      value={a3OmCost}
                                      onChange={(event) =>
                                        setA3OmCost(
                                          event.target.value,
                                        )
                                      }
                                      placeholder="*as incurred"
                                      aria-label={`${row} ${column.code}`}
                                    />
                                  ) : (
                                    <input
                                      value=""
                                      readOnly
                                      placeholder="Calculated"
                                      aria-label={`${row} ${column.code}`}
                                    />
                                  )}
                                </td>
                              );
                            },
                          )}
                        </tr>
                      ),
                    )}
                  </tbody>
                </table>
              </div>
              {/* =============================================
                  UTILITY SALES RATES
              ============================================= */}
              <WorksheetSectionTitle>
                UTILITY SALES RATE
                CHARGED TO THE CUSTOMER
              </WorksheetSectionTitle>
              <div className="worksheet-table-shell">
                <table className="worksheet-table sales-rate-table">
                  <thead>
                    <tr>
                      <th>
                        Rate
                      </th>
                      <th>
                        Calculated /
                        Applied Rate
                      </th>
                      <th>
                        Notes
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {SALES_RATE_ROWS.map(
                      (row) => {
                        const isWheelingCharge =
                          row ===
                          "Wheeling Charge (if applicable)";

                        const isMfhUsafUtilityRate =
                          row ===
                          "MFH USAF Utility Rate";

                        const isNonFederalOrganizationUsafUtilityRate =
                          row ===
                          "Non-Federal Organization USAF Utility Rate";

                        const isLocalPrevailingUtilityProviderRate =
                          row ===
                          "Local Prevailing or Utility Provider Rate";

                        const isNonDodFederalAgencyUsafUtilityRate =
                          row ===
                          "Non-DoD Federal Agency USAF Utility Rate";

                        const isDodAgencyUsafUtilityRate =
                          row ===
                          "DoD Agency USAF Utility Rate (includes MWR Golf Courses)";

                        const isCategoryCMwrUsafUtilityRate =
                          row ===
                          "Category C MWR USAF Utility Rate (Except Golf Courses)";

                        const salesRateValue =
                          isWheelingCharge
                            ? totals.b6WheelingCharge
                            : isMfhUsafUtilityRate
                              ? totals.mfhUsafUtilityRate
                              : isNonFederalOrganizationUsafUtilityRate
                                ? totals.nonFederalOrganizationUsafUtilityRate
                                : isNonDodFederalAgencyUsafUtilityRate
                                  ? totals.nonDodFederalAgencyUsafUtilityRate
                                  : isDodAgencyUsafUtilityRate
                                    ? totals.dodAgencyUsafUtilityRate
                                    : isCategoryCMwrUsafUtilityRate
                                      ? totals.categoryCMwrUsafUtilityRate
                                      : null;

                        return (
                          <tr key={row}>
                            <th>
                              <div className="rate-description-with-note">
                                <span>{row}</span>
                                <span className="rate-math-note">
                                  {row === "Wheeling Charge (if applicable)"
                                    ? "B-6: O&M + Other Utility Cost + Capitalized Charges + Administrative Overhead."
                                    : row === "MFH USAF Utility Rate"
                                      ? "A-3: Basic Cost + Other Utility Cost + Line Losses."
                                      : row === "Non-Federal Organization USAF Utility Rate"
                                        ? "B-6: Subtotal + Administrative Overhead."
                                        : row === "Local Prevailing or Utility Provider Rate"
                                          ? "Free-text entry."
                                          : row === "Non-DoD Federal Agency USAF Utility Rate"
                                            ? "C-5: Basic Cost + Line Losses + O&M Costs + Other Utility Cost."
                                            : row === "DoD Agency USAF Utility Rate (includes MWR Golf Courses)"
                                              ? "D-1&2: Basic Cost + Line Losses + O&M Costs + Other Utility Cost."
                                              : row === "Category C MWR USAF Utility Rate (Except Golf Courses)"
                                                ? "E-7: Basic Cost − Less Connection Fee."
                                                : ""}
                                </span>
                              </div>
                            </th>
                            <td
                              className={
                                isLocalPrevailingUtilityProviderRate
                                  ? "calculated-cell sales-rate-free-text"
                                  : "calculated-cell"
                              }
                            >
                              {isLocalPrevailingUtilityProviderRate ? (
                                <input
                                  value={
                                    localPrevailingUtilityProviderRate
                                  }
                                  onChange={(event) =>
                                    setLocalPrevailingUtilityProviderRate(
                                      event.target.value,
                                    )
                                  }
                                  placeholder="Enter rate or text"
                                  aria-label="Local Prevailing or Utility Provider Rate"
                                />
                              ) : salesRateValue !== null ? (
                                <output
                                  className="live-rate-value"
                                  aria-label={row}
                                >
                                  {formatRate(
                                    salesRateValue,
                                  )}
                                </output>
                              ) : (
                                <input
                                  value=""
                                  readOnly
                                  placeholder="Calculated"
                                />
                              )}
                            </td>
                            <td>
                              <textarea
                                rows={2}
                                placeholder="Notes"
                              />
                            </td>
                          </tr>
                        );
                      },
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            {/* =============================================
                OTHER UTILITY COST CALCULATION WORKSHEET
                Separate worksheet. Free-text fields only.
            ============================================= */}
            <section className="oucw-section">
              <div className="oucw-title">
                <div>
                  <h2>
                    Other Utility Cost Calculation Worksheet - Water
                  </h2>
                  <p>
                    Use this form to calculate the cost of
                    &quot;Other Utilities&quot; used in the production and
                    distribution of Water.
                  </p>
                </div>

                <label className="oucw-period-field">
                  <span>
                    Enter Time Selected for Qualification Period
                  </span>
                  <input
                    type="text"
                    placeholder="Day, Week, Month, Quarter, or Year"
                  />
                </label>
              </div>

              <div className="oucw-part-title">
                <strong>
                  PART I. Quantities of Other Utilities Used to Produce Water
                </strong>
                <span>
                  Document assumptions on separate sheet.
                </span>
              </div>

              <div className="worksheet-table-shell">
                <table className="worksheet-table oucw-table oucw-part-one">
                  <thead>
                    <tr>
                      <th>Utility</th>
                      <th>Examples / Use</th>
                      <th>Quantity</th>
                      <th>UoM</th>
                      <th>Notes</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <th>A. Water</th>
                      <td>
                        (1) For system cleaning, washdowns<br />
                        (2) For plant operations<br />
                        (3) For production and distribution facilities
                      </td>
                      <td>
                        <input
                          type="text"
                          value={otherUtilityPart1Quantities.water}
                          onChange={(event) =>
                            setOtherUtilityPart1Quantities(
                              (current) => ({
                                ...current,
                                water: event.target.value,
                              }),
                            )
                          }
                          placeholder="0.0"
                        />
                      </td>
                      <td>
                        <span className="oucw-fixed-uom">KGal</span>
                      </td>
                      <td>
                        <textarea rows={3} placeholder="Notes" />
                      </td>
                    </tr>

                    <tr>
                      <th>B. Wastewater</th>
                      <td>
                        (1) For production and distribution facilities
                      </td>
                      <td>
                        <input
                          type="text"
                          value={otherUtilityPart1Quantities.wastewater}
                          onChange={(event) =>
                            setOtherUtilityPart1Quantities(
                              (current) => ({
                                ...current,
                                wastewater: event.target.value,
                              }),
                            )
                          }
                          placeholder="0.0"
                        />
                      </td>
                      <td>
                        <span className="oucw-fixed-uom">KGal</span>
                      </td>
                      <td>
                        <textarea rows={2} placeholder="Notes" />
                      </td>
                    </tr>

                    <tr>
                      <th>C. Natural Gas</th>
                      <td>
                        (1) For heating power production and distribution facilities<br />
                        (2) For production processes (steam production)
                      </td>
                      <td>
                        <input
                          type="text"
                          value={otherUtilityPart1Quantities.naturalGas}
                          onChange={(event) =>
                            setOtherUtilityPart1Quantities(
                              (current) => ({
                                ...current,
                                naturalGas: event.target.value,
                              }),
                            )
                          }
                          placeholder="0.0"
                        />
                      </td>
                      <td>
                        <span className="oucw-fixed-uom">MCF</span>
                      </td>
                      <td>
                        <textarea rows={3} placeholder="Notes" />
                      </td>
                    </tr>

                    <tr>
                      <th>D. Electricity</th>
                      <td>
                        (1) For production and distribution facilities<br />
                        (2) For powering production and distribution facilities
                      </td>
                      <td>
                        <input
                          type="text"
                          value={otherUtilityPart1Quantities.electricity}
                          onChange={(event) =>
                            setOtherUtilityPart1Quantities(
                              (current) => ({
                                ...current,
                                electricity: event.target.value,
                              }),
                            )
                          }
                          placeholder="0.0"
                        />
                      </td>
                      <td>
                        <span className="oucw-fixed-uom">kWh</span>
                      </td>
                      <td>
                        <textarea rows={3} placeholder="Notes" />
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>

              <p className="oucw-footnote">
                * When not metered, use best engineering judgment to estimate
                utility consumption.
              </p>

              <div className="oucw-part-title">
                <strong>
                  PART II. Cost
                </strong>
                <span>
                  Use DoD Agency Sales Rate Per Unit.
                </span>
              </div>

              <div className="worksheet-table-shell">
                <table className="worksheet-table oucw-table oucw-part-two">
                  <thead>
                    <tr>
                      <th>Utility</th>
                      <th>Enter Quantities from Part I Above</th>
                      <th>UoM</th>
                      <th />
                      <th>
                        Enter Local Rate and/or Calculated Cost per Unit
                      </th>
                      <th />
                      <th>Cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[
                      ["A. Water", "KGal", "water", "water"],
                      ["B. Wastewater", "KGal", "wastewater", "wastewater"],
                      ["C. Natural Gas", "MCF", "naturalGas", "naturalGas"],
                      ["D. Electricity", "kWh", "electricity", "electricity"],
                      ["E. Other", "Unit", "", "otherE"],
                      ["F. Other", "Unit", "", "otherF"],
                    ].map(([label, unit, part1Key, rowKey]) => (
                      <tr key={label}>
                        <th>{label}</th>
                        <td>
                          {part1Key ? (
                            <input
                              type="text"
                              value={
                                otherUtilityPart1Quantities[
                                  part1Key as keyof typeof otherUtilityPart1Quantities
                                ]
                              }
                              readOnly
                              placeholder="0.00"
                              aria-label={`${label} quantity from Part I`}
                            />
                          ) : (
                            <input
                              type="text"
                              value={otherUtilityPart2OtherQty[rowKey as "otherE" | "otherF"]}
                              onChange={(event) =>
                                setOtherUtilityPart2OtherQty((current) => ({
                                  ...current,
                                  [rowKey]: event.target.value,
                                }))
                              }
                              placeholder="0.00"
                            />
                          )}
                        </td>
                        <td>
                          <span className="oucw-fixed-uom">
                            {unit}
                          </span>
                        </td>
                        <td className="oucw-symbol">×</td>
                        <td>
                          <input
                            type="text"
                            value={otherUtilityPart2Rates[rowKey as keyof typeof otherUtilityPart2Rates]}
                            onChange={(event) =>
                              setOtherUtilityPart2Rates((current) => ({
                                ...current,
                                [rowKey]: event.target.value,
                              }))
                            }
                            placeholder="$0.00000"
                          />
                        </td>
                        <td className="oucw-symbol">=</td>
                        <td className="oucw-calculated-cell">
                          <output>
                            {formatOucwCurrency(oucwCosts[rowKey as keyof typeof oucwCosts])}
                          </output>
                        </td>
                      </tr>
                    ))}

                    <tr className="oucw-total-row">
                      <th colSpan={6}>Total Cost</th>
                      <td className="oucw-calculated-cell">
                        <output>{formatOucwCurrency(oucwTotalCost)}</output>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>

              <div className="oucw-annualize">
                <div className="oucw-annualize-copy">
                  <strong>
                    Annualize the Total Cost of &quot;Other Utilities Required
                    to Produce and Distribute Water&quot;.
                  </strong>
                </div>

                <div className="oucw-equation-grid">
                  <label>
                    <span>Total Cost</span>
                    <output className="oucw-equation-output">
                      {formatOucwCurrency(oucwTotalCost)}
                    </output>
                  </label>

                  <span className="oucw-symbol">×</span>

                  <label>
                    <span>Periods/Year</span>
                    <input
                      type="text"
                      value={otherUtilityPeriodsPerYear}
                      onChange={(event) => setOtherUtilityPeriodsPerYear(event.target.value)}
                      placeholder="1"
                    />
                  </label>

                  <span className="oucw-symbol">=</span>

                  <label>
                    <span>Annualized Total Cost</span>
                    <output className="oucw-equation-output">
                      {formatOucwCurrency(oucwAnnualizedTotalCost)}
                    </output>
                  </label>
                </div>
              </div>

              <div className="oucw-part-title">
                <strong>
                  PART III. Calculation of Other Utility Cost
                </strong>
                <span>
                  Divide total cost from Part II by the total purchased and
                  produced units for the same period of time and show this
                  amount on the Utility Sales Rates Computation Worksheet.
                </span>
              </div>

              <div className="oucw-part-three">
                <label>
                  <span>Annualized Total Cost</span>
                  <output className="oucw-equation-output">
                    {formatOucwCurrency(
                      oucwAnnualizedTotalCost,
                    )}
                  </output>
                </label>

                <span className="oucw-equation-word">
                  Divided by
                </span>

                <label>
                  <span>Total Purchased and Produced Units</span>
                  <input
                    type="text"
                    value={otherUtilityPart3Units}
                    onChange={(event) =>
                      setOtherUtilityPart3Units(
                        event.target.value,
                      )
                    }
                    placeholder="0"
                  />
                </label>

                <div className="oucw-unit-field">
                  <span>Unit</span>
                  <div className="oucw-fixed-uom oucw-fixed-uom-box">
                    Unit
                  </div>
                </div>

                <span className="oucw-symbol">=</span>

                <label>
                  <span>Other Utility Cost / Unit</span>
                  <output className="oucw-equation-output">
                    {formatOucwRate(
                      oucwOtherUtilityCostPerUnit,
                    )}
                  </output>
                </label>
              </div>
            </section>
          </div>
          </fieldset>
        </div>
      )}
        </section>
      </main>
    </div>
  );
}
// ============================================================
// WORKSHEET FIELD
// ============================================================
function BaseNameField({
  fiscalYear,
  utilityGroup,
  onFiscalYearChange,
}: {
  fiscalYear: string;
  utilityGroup: string;
  onFiscalYearChange: (
    value: string,
  ) => void;
}) {
  const numericFiscalYear =
    fiscalYear.replace(/^FY/i, "");

  return (
    <label className="worksheet-field base-name-field">
      <span>
        Name of Base
      </span>

      <div className="base-name-value">
        <span className="base-name-prefix">
          FY
        </span>

        <input
          className="base-name-fy-input"
          inputMode="numeric"
          maxLength={2}
          value={numericFiscalYear}
          onChange={(event) => {
            const nextValue =
              event.target.value
                .replace(/\D/g, "")
                .slice(0, 2);

            onFiscalYearChange(
              `FY${nextValue}`,
            );
          }}
          aria-label="Fiscal year"
        />

        <span className="base-name-fixed-text">
          Tinker AFB
          {utilityGroup
            ? ` - ${utilityGroup}`
            : ""}
        </span>
      </div>
    </label>
  );
}

function WorksheetDisplayField({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div className="worksheet-field worksheet-display-field">
      <span>
        {label}
      </span>
      <div className="worksheet-display-value">
        {value || "—"}
      </div>
    </div>
  );
}

function WorksheetField({
  label,
  value,
  onChange,
  type = "text",
  className = "",
}: {
  label: string;
  value: string;
  onChange: (
    value: string,
  ) => void;
  type?: "text" | "number" | "date";
  className?: string;
}) {
  return (
    <label
      className={`worksheet-field ${className}`}
    >
      <span>
        {label}
      </span>
      <input
        type={type}
        step={
          type === "number"
            ? "any"
            : undefined
        }
        value={value}
        onChange={(event) =>
          onChange(
            event.target.value,
          )
        }
      />
    </label>
  );
}
// ============================================================
// SECTION TITLE
// ============================================================
function WorksheetSectionTitle({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="worksheet-section-title">
      {children}
    </div>
  );
}
// ============================================================
// DATA PARENT ROW
// ============================================================
function DataParentRow({
  title,
  onAdd,
}: {
  title: string;
  onAdd: () => void;
}) {
  return (
    <tr className="worksheet-parent-row">
      <th>
        {title}
      </th>
      <td colSpan={5}>
        <span className="worksheet-parent-help">
          Add information only
          when applicable.
        </span>
      </td>
      <td>
        <button
          type="button"
          className="worksheet-add-row"
          onClick={onAdd}
        >
          <Plus size={13} />
          Add Row
        </button>
      </td>
    </tr>
  );
}
// ============================================================
// DATA ENTRY ROW
// ============================================================
function DataEntryRow({
  row,
  onUpdate,
  onRemove,
}: {
  row: DataInputRow;
  onUpdate: (
    field: keyof Omit<
      DataInputRow,
      "id"
    >,
    value: string,
  ) => void;
  onRemove: () => void;
}) {
  return (
    <tr className="worksheet-entry-row">
      <td>
        <input
          value={row.description}
          onChange={(event) => onUpdate("description", event.target.value)}
          placeholder="Description"
        />
      </td>
      <td>
        <input
          value={
            row.accountProjectNumber
          }
          onChange={(event) =>
            onUpdate(
              "accountProjectNumber",
              event.target.value,
            )
          }
          placeholder="Account / project"
        />
      </td>
      <td>
        <input
          type="number"
          step="any"
          value={
            row.totalAnnualCost
          }
          onChange={(event) =>
            onUpdate(
              "totalAnnualCost",
              event.target.value,
            )
          }
          placeholder="0.00"
        />
      </td>
      <td>
        <input
          type="number"
          step="any"
          value={
            row.annualConsumption
          }
          onChange={(event) =>
            onUpdate(
              "annualConsumption",
              event.target.value,
            )
          }
          placeholder="0"
        />
      </td>
      <td>
        <input
          type="number"
          step="any"
          value={
            row.militaryLabor
          }
          onChange={(event) =>
            onUpdate(
              "militaryLabor",
              event.target.value,
            )
          }
          placeholder="0.00"
        />
      </td>
      <td>
        <textarea
          rows={2}
          value={row.notes}
          onChange={(event) =>
            onUpdate(
              "notes",
              event.target.value,
            )
          }
          placeholder="Notes"
        />
      </td>
      <td className="worksheet-action-cell">
        <button
          type="button"
          className="worksheet-delete-row"
          onClick={onRemove}
          aria-label="Remove row"
        >
          <Trash2 size={14} />
        </button>
      </td>
    </tr>
  );
}
// ============================================================
// SUMMARY ROW
// ============================================================
function SummaryRow({
  label,
  cost,
  consumption,
  militaryLabor,
  strong = false,
}: {
  label: string;
  cost: number;
  consumption: number;
  militaryLabor: number;
  strong?: boolean;
}) {
  return (
    <tr
      className={`worksheet-summary-row ${
        strong
          ? "worksheet-strong-summary"
          : ""
      }`}
    >
      <th>
        {label}
      </th>
      <td />
      <td>
        {formatCurrency(cost)}
      </td>
      <td>
        {formatNumber(
          consumption,
        )}
      </td>
      <td>
        {formatCurrency(
          militaryLabor,
        )}
      </td>
      <td />
      <td />
    </tr>
  );
}
// ============================================================
// O&M ENTRY ROW
// ============================================================
function OmEntryRow({
  row,
  onUpdate,
  onRemove,
}: {
  row: OmRow;
  onUpdate: (
    field: keyof Omit<
      OmRow,
      "id"
    >,
    value: string,
  ) => void;
  onRemove: () => void;
}) {
  return (
    <tr className="worksheet-entry-row">
      <td>
        <input
          list={`om-description-options-${row.id}`}
          value={
            row.description
          }
          onChange={(event) =>
            onUpdate(
              "description",
              event.target.value,
            )
          }
          placeholder="Select or enter O&M classification"
        />

        <datalist
          id={`om-description-options-${row.id}`}
        >
          <option value="MFH and Privatized MFH Unit Cost" />
          <option value="Non-Federal & Commercial Organization Unit Cost" />
          <option value="Non-DoD (Federal) Agency Unit Cost" />
          <option value="DoD (Federal) Agency Unit Cost (Include Golf Courses)" />
          <option value="MWR (DoD) / AAFES / PCS/TDY Lodging Unit Cost (Excl Golf Courses)" />
        </datalist>
      </td>
      <td>
        <input
          value={
            row.accountProjectNumber
          }
          onChange={(event) =>
            onUpdate(
              "accountProjectNumber",
              event.target.value,
            )
          }
          placeholder="Account / project"
        />
      </td>
      <td>
        <input
          type="number"
          step="any"
          value={row.cost}
          onChange={(event) =>
            onUpdate(
              "cost",
              event.target.value,
            )
          }
          placeholder="0.00"
        />
      </td>
      <td>
        <input
          type="number"
          step="any"
          value={
            row.militaryLabor
          }
          onChange={(event) =>
            onUpdate(
              "militaryLabor",
              event.target.value,
            )
          }
          placeholder="0.00"
        />
      </td>
      <td>
        <textarea
          rows={2}
          value={row.notes}
          onChange={(event) =>
            onUpdate(
              "notes",
              event.target.value,
            )
          }
          placeholder="Notes"
        />
      </td>
      <td className="worksheet-action-cell">
        <button
          type="button"
          className="worksheet-delete-row"
          onClick={onRemove}
          aria-label="Remove row"
        >
          <Trash2 size={14} />
        </button>
      </td>
    </tr>
  );
}
// ============================================================
// PLACEHOLDER
// ============================================================
function Placeholder({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="billing-content">
      <div className="billing-placeholder">
        <FileText size={30} />
        <h3>
          {title}
        </h3>
        <p>
          {description}
        </p>
      </div>
    </div>
  );
}
