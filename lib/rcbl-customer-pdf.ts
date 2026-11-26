import { normalizeReportingUtility, type ComponentCode, type ReportingSplit } from "./3556-reporting";
import type { ExportTable } from "./report-file-export";

/** Presentation-only RCBL Short bill. Source amounts are never recomputed or written. */
export type CustomerBillPdfLine = {
  utilityGroup: string;
  utilitySystem: string;
  utilityType?: string;
  consumptionUM: string;
  allocatedConsumption: number;
  amount: number | null;
  reimbursementDisposition?: string;
  reportingSplit?: ReportingSplit;
};
export type CustomerBillPdfCustomer = {
  customerId: string;
  customerName: string;
  customerType: string;
  reportType: string;
  rateClass: string;
  rcblComment?: string;
  totalAmount: number | null;
  lines: CustomerBillPdfLine[];
};
export type CustomerBillPdfPreview = {
  billingPeriodId: number;
  billingMonth: string;
  fiscalYear: string;
};

const cents = (n: number) => Math.round(n * 100);
const currency = (n: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);
const number = (n: number) => new Intl.NumberFormat("en-US", { maximumFractionDigits: 5 }).format(n);

export function rcblUtilityLabel(system: string, group: string): string {
  const key = system.trim().toUpperCase().replace(/[\s_-]+/g, " ");
  if (["PW", "PRODUCED WATER", "PURCHASED WATER"].includes(key)) {
    const site = group.trim().toUpperCase();
    return site === "TAC" ? "Purchased Water" : site === "WWYK" ? "Produced Water" : "Purchased / Produced Water";
  }
  return system;
}

type UtilityRow = { utility: string; unit: string; consumption: number; amountCents: number; review: boolean };
const DISPLAY_COMPONENTS: ReadonlyArray<{ code: ComponentCode; title: string }> = [
  { code: "REM", title: "REM" },
  { code: "CUBE", title: "CUBE" },
  { code: "SRM_LABOR", title: "SRM Labor" },
  { code: "SRM_MATERIALS", title: "SRM Materials" },
];
const DISPLAY_COMPONENT_CODES = new Set<string>(DISPLAY_COMPONENTS.map(component => component.code));

/**
 * The commodity amount and Other Utilities are read directly from the issued
 * reporting split; they MUST sum to the original customer charge in cents.
 * Missing/invalid splits display the original charge as REVIEW, not a guessed
 * or approved component allocation.
 */
export function buildCustomerBillPdfLines(preview: CustomerBillPdfPreview, customer: CustomerBillPdfCustomer): string[] {
  const utilityRows = new Map<string, UtilityRow>();
  const componentCents: Record<ComponentCode, number> = {
    REM: 0, CUBE: 0, SRM_LABOR: 0, SRM_MATERIALS: 0,
  };
  let hasProvisional = false;
  let unresolvedCents = 0;
  let unresolvedCount = 0;

  for (const line of customer.lines) {
    if (line.reimbursementDisposition === "CE_ABSORBED") continue;
    const gross = line.amount;
    if (gross === null || !Number.isFinite(gross)) {
      unresolvedCount++;
      continue;
    }
    const grossCents = cents(gross);
    const split = line.reportingSplit;
    const entries = split ? Object.entries(split.components) : [];
    const components = entries.map(([, amount]) => amount);
    const identifiable = split && ["READY", "PROVISIONAL", "NOT_APPLICABLE"].includes(split.status) &&
      (normalizeReportingUtility(line.utilityType ?? line.utilitySystem) === split.utility) &&
      (split.originalCharge !== null && Number.isFinite(split.originalCharge) && cents(split.originalCharge) === grossCents) &&
      (split.status !== "NOT_APPLICABLE" || components.length === 0) &&
      split.purchasedUtilityAmount !== null && Number.isFinite(split.purchasedUtilityAmount) &&
      entries.every(([code, amount]) => DISPLAY_COMPONENT_CODES.has(code) && typeof amount === "number" && Number.isFinite(amount)) &&
      cents(split.purchasedUtilityAmount) + components.reduce((sum, n) => sum + cents(n), 0) === grossCents;

    const key = [line.utilityGroup, line.utilitySystem, line.consumptionUM, identifiable ? "COMMODITY" : "REVIEW"].join("|");
    const existing = utilityRows.get(key) ?? {
      utility: rcblUtilityLabel(line.utilitySystem, line.utilityGroup),
      unit: line.consumptionUM,
      consumption: 0, amountCents: 0, review: false,
    };
    existing.consumption += Number.isFinite(line.allocatedConsumption) ? line.allocatedConsumption : 0;
    if (identifiable) {
      existing.amountCents += cents(split.purchasedUtilityAmount!);
      for (const [code, amount] of entries) {
        componentCents[code as ComponentCode] += cents(amount);
      }
      if (split.status === "PROVISIONAL") hasProvisional = true;
    } else {
      existing.amountCents += grossCents;
      existing.review = true;
      unresolvedCents += grossCents;
      unresolvedCount++;
    }
    utilityRows.set(key, existing);
  }

  const billedCents = customer.lines.filter(line => line.reimbursementDisposition !== "CE_ABSORBED" && line.amount !== null && Number.isFinite(line.amount))
    .reduce((sum, line) => sum + cents(line.amount!), 0);
  const otherCents = DISPLAY_COMPONENTS.reduce((sum, component) => sum + componentCents[component.code], 0);
  const displayedCents = [...utilityRows.values()].reduce((sum, row) => sum + row.amountCents, 0) + otherCents;
  if (displayedCents !== billedCents || (customer.totalAmount !== null && cents(customer.totalAmount) !== billedCents)) {
    // A failed presentation invariant must be visible; never silently present a
    // nonreconciling customer bill as a complete accounting breakdown.
    return ["RCBL SHORT - CUSTOMER BILL", `Customer: ${customer.customerName}`, `Customer ID: ${customer.customerId}`,
      `Billing Period: ${preview.billingPeriodId}`, "REVIEW REQUIRED: Customer bill presentation does not reconcile.",
      "BILLING", `TOTAL BILL: ${customer.totalAmount === null ? "REVIEW REQUIRED" : currency(customer.totalAmount)}`];
  }

  const utilityLines = [...utilityRows.values()].map(row => {
    // Effective commodity amount / usage is a display ratio, not the approved
    // 3556 sales rate. The customer's original billed charge is unchanged.
    const equivalentRate = row.consumption === 0 ? "-" : (row.amountCents / 100 / row.consumption).toFixed(5);
    return [row.utility + (row.review ? " (REVIEW)" : ""), number(row.consumption), row.unit || "-", equivalentRate, currency(row.amountCents / 100)].join("|");
  });
  if (otherCents !== 0) {
    utilityLines.push(["Other Utilities", "-", "-", "-", currency(otherCents / 100)].join("|"));
  }

  return [
    "RCBL SHORT - CUSTOMER BILL", "",
    `Customer: ${customer.customerName}`, `Customer ID: ${customer.customerId}`,
    `Customer Type: ${customer.customerType}`, `Report Type: ${customer.reportType || "-"}`,
    `Rate Class: ${customer.rateClass || "-"}`, `Billing Period: ${preview.billingPeriodId}`,
    `Billing Month: ${preview.billingMonth} FY${preview.fiscalYear}`,
    "Bill Line of Accounting", `Customer Agreement/Document: ${customer.rcblComment?.trim() || "-"}`, "",
    ...(otherCents !== 0 ? [
      "Other Utility Costs reflect any authorized delivery, infrastructure, and production fees included as part of approved 3556 rates.",
      ...(hasProvisional ? ["These reporting classifications are provisional and are not approved accounting values."] : []),
    ] : []),
    ...(unresolvedCount ? [`Unclassified - Review Required: ${currency(unresolvedCents / 100)} (${unresolvedCount} ${unresolvedCount === 1 ? "line" : "lines"}).`] : []),
    "BILLING", ...utilityLines,
    `TOTAL BILL: ${customer.totalAmount === null ? "REVIEW REQUIRED" : currency(customer.totalAmount)}`,
  ];
}

/** Customer-facing XLSX uses the SAME verified bill rows as the PDF.
 * Amounts in the billed-breakdown column reconcile to the original bill.
 * The original total due is a reference value and is not charged again.
 */
export function buildCustomerBillExcelTable(preview: CustomerBillPdfPreview, customer: CustomerBillPdfCustomer): ExportTable {
  const pdfLines = buildCustomerBillPdfLines(preview, customer);
  const billingIndex = pdfLines.indexOf("BILLING");
  const entries = billingIndex === -1 ? [] : pdfLines.slice(billingIndex + 1);
  const rows: Array<Array<string | number>> = [];
  for (const entry of entries) {
    if (entry.startsWith("TOTAL BILL:")) {
      rows.push(["TOTAL DUE (original bill)", "", "", "", customer.totalAmount ?? "REVIEW REQUIRED", ""]);
    } else if (entry.includes("|")) {
      const columns = entry.split("|");
      if (columns.length === 5) {
        const title = columns[0];
        const numeric = Number(columns[4].replace(/[$,]/g, ""));
        const amount: number | string = Number.isFinite(numeric) ? numeric : columns[4];
        if (title === "Other Utilities") {
          rows.push([title, "", "", "", "", amount]);
        } else {
          rows.push([title, columns[1], columns[2], columns[3], "", amount]);
        }
      }
    }
  }
  const review = pdfLines.filter(line => line.startsWith("REVIEW REQUIRED:") || line.startsWith("Unclassified - Review Required:"));
  return {
    title: "RCBL Short - Customer Bill Breakdown",
    subtitle: `${customer.customerName} (${customer.customerId}) — BP ${preview.billingPeriodId}, ${preview.billingMonth} FY${preview.fiscalYear}`,
    headers: ["Utility / Other Utilities", "Consumption", "Unit", "Rate / Bill Share", "Reference Only (USD)", "Billed Breakdown"],
    rows,
    notes: [
      "Presentation-only breakout; original customer charges are unchanged.",
      "Other Utility Costs reflect any authorized delivery, infrastructure, and production fees included as part of approved 3556 rates.",
      "REM, CUBE, and SRM amounts are consolidated in Other Utilities; detailed component amounts are available in the EEIC Short report.",
      "Other Utilities reporting classifications are provisional and are not approved accounting values.",
      "The Billed Breakdown column includes utility amounts and the Other Utilities subtotal once. Original total due is reference-only.",
      ...review,
    ],
  };
}
