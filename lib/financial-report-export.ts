import type { BuiltFinancialReport, InputBilling, ReportEntry, ReportKind } from "./financial-reporting";
import type { ExportCell, ExportTable } from "./report-file-export";
import { normalizeReportingUtility } from "./3556-reporting";

const fmt = (n: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);
const cents = (n: number) => Math.round(n * 100);
const money = (n: number) => Number((n / 100).toFixed(2));

/** Export presentation only. Does not recalculate any customer billing charges. */
export function financialExportHeaders(kind: ReportKind): string[] {
  return kind === "RCBL"
    ? ["Customer ID", "Customer", "Utility / Item", "Group", "Component Breakdown", "Classification Status", "3556 ID", "3556 Effective", "Amount"]
    : kind === "EEIC_SHORT"
      ? ["Customer ID", "Customer", "Utility", "EEIC", "Object Class", "Cost Component", "Source Classification", "Code Status", "Amount"]
      : ["Customer ID", "Customer", "Group", "Utility", "Facility", "Allocation Source", "Reconciliation ID", "3556 ID", "3556 Effective", "EEIC", "Object Class", "Component", "Source Classification", "Source 3556 Cost Rows", "Code Status", "Amount"];
}

export function financialExportRowValues(row: ReportEntry, kind: ReportKind): ExportCell[] {
  const componentText = (row.componentBreakdown ?? [])
    .map(part => `${part.component}: ${fmt(part.amount)} (${part.classificationStatus}; code ${part.mappingStatus})`)
    .join("; ") || "—";
  const sourceText = row.sourceCostRows
    .map(source => `${source.section}:${source.key} / ${source.account || "(no account)"} / ${fmt(source.amount)} / ${source.classificationStatus}`)
    .join("; ") || "—";
  return kind === "RCBL"
    ? [row.customerId, row.customerName, row.componentLabel, row.component === "OTHER" ? "ALL" : row.utilityGroup, componentText, row.classificationStatus, row.rateId, row.rateEffectiveDate, row.amount]
    : kind === "EEIC_SHORT"
      ? [row.customerId, row.customerName, row.utility, row.eeic, row.objectClass, row.componentLabel, row.classificationStatus, row.mappingStatus, row.amount]
      : [row.customerId, row.customerName, row.utilityGroup, row.utility, row.facilityNumber, row.allocationSource, row.reconciliationId, row.rateId, row.rateEffectiveDate, row.eeic, row.objectClass, row.componentLabel, row.classificationStatus, sourceText, row.mappingStatus, row.amount];
}

export type FinancialExportSelection = {
  report: BuiltFinancialReport;
  kind: ReportKind;
  customerId?: string;
  customerName?: string;
  period: number;
  fiscalYear: string;
  month: string;
  source: string;
};

/** Scope every exported row, amount, review count and issue to the same customer selection. */
export function buildFinancialExportTable({report, kind, customerId = "", customerName = "", period, fiscalYear, month, source}: FinancialExportSelection): ExportTable {
  const selected = customerId.length > 0;
  const rows = selected ? report.rows.filter(row => row.customerId === customerId) : report.rows;
  // customerTotals is computed from original customer charges by buildFinancialReport.
  // Do not derive this side of the reconciliation from the report output rows.
  const customerTotal = selected ? (report.customerTotals[customerId] ?? 0) : report.billedTotal;
  const reportTotal = selected ? money(rows.reduce((sum, row) => sum + cents(row.amount), 0)) : report.outputTotal;
  const unclassified = rows.filter(row => row.component === "UNCLASSIFIED");
  const provisional = rows.filter(row => row.mappingStatus === "PROVISIONAL" || row.classificationStatus === "PROVISIONAL");
  const unresolvedTotal = money(unclassified.reduce((sum, row) => sum + cents(row.amount), 0));
  const issues = selected
    ? report.issues.filter(issue => issue.startsWith(`${customerId}:`) || issue.startsWith(`${customerId} /`))
    : report.issues;
  const difference = money(cents(reportTotal) - cents(customerTotal));
  if (selected && cents(difference) !== 0) {
    issues.push(`Reported total ${reportTotal.toFixed(2)} does not equal original customer charges ${customerTotal.toFixed(2)}.`);
  }
  const subtitle = `BP ${period} FY${fiscalYear} ${month} — ${source}${selected ? ` — CUSTOMER ${customerId}` : ""}`;
  const scopeNotes = selected ? [
    `Selected customer: ${customerId}${customerName ? ` - ${customerName}` : ""}.`,
    `Unclassified — Review Required: ${unclassified.length} charge(s); aggregate ${fmt(unresolvedTotal)}.`,
    `Provisional classifications: ${provisional.length} report row(s).`,
  ] : [];
  return {
    title: kind.replaceAll("_", " ") + " — CUBE reporting",
    subtitle,
    headers: financialExportHeaders(kind),
    rows: rows.map(row => financialExportRowValues(row, kind)),
    pdfSummary: {
      customerTotal,
      reportTotal,
      reconciliationDifference: difference,
      unclassifiedCount: unclassified.length,
      unclassifiedTotal: unresolvedTotal,
      unclassifiedUtilities: Array.from(new Set(unclassified.map(row => row.utility))),
      provisionalCount: provisional.length,
    },
    pdfColumnGroups: kind === "EEIC_DETAIL" ? [
      {label: "Allocation references", columns: [0, 1, 2, 3, 4, 5, 6]},
      {label: "Rate and component details", columns: [0, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]},
    ] : undefined,
    notes: [
      "Source: existing billed customer amounts + effective FINAL 3556; original amounts unchanged.",
      "PROVISIONAL classifications and EEIC/Object Class values require Government/Finance review; they are not approved accounting values.",
      ...scopeNotes,
      `Customer billed total: ${fmt(customerTotal)}. Reported rows total: ${fmt(reportTotal)}.`,
      ...issues.slice(0, 20).map(issue => `REVIEW: ${issue}`),
    ],
  };
}

/** Familiar, read-only layouts derived from the same billed charge splits. */
export function buildFamiliarFinancialTable(selection: FinancialExportSelection & { billing?: InputBilling }): ExportTable {
  const { report, kind, customerId = "" } = selection;
  const base = buildFinancialExportTable({ ...selection, kind: "EEIC_DETAIL" });
  const entries = customerId ? report.rows.filter(row => row.customerId === customerId) : report.rows;
  const add = (a: number, b: number) => money(cents(a) + cents(b));
  // The familiar reports show one SRM category while retaining both underlying charges.
  const reportComponent = (entry: ReportEntry): string =>
    entry.component === "SRM_LABOR" || entry.component === "SRM_MATERIALS" ? "SRM" : entry.componentLabel;
  const description = (entry: ReportEntry): string => {
    switch (entry.allocationSource) {
      case "PW_PUMPING": return "Electricity for produced-water pumping";
      case "SS_PUMPING": return "Electricity for sewage pumping";
      case "DERIVED_SS": return "Sewage derived from water consumption";
      case "SS_NONMETERED": return "Nonmetered sewage";
      case "METER": return `${entry.utility} metered consumption`;
      case "NONMETERED": return `${entry.utility} nonmetered allocation`;
      default: return entry.allocationSource || "Source not identified";
    }
  };
  const costCategory = (entry: ReportEntry): string => {
    if (entry.component === "UNCLASSIFIED") return "Review required";
    if (entry.component === "SRM_LABOR" || entry.component === "SRM_MATERIALS") return "SRM";
    if (entry.component === "REM" || entry.component === "CUBE") return "O&M";
    return "Utility (Usage, Rate, Charge)";
  };
  const facilityOps = (entry: ReportEntry): string => {
    if (entry.component === "SRM_LABOR" || entry.component === "SRM_MATERIALS") return "SRM";
    if (entry.component === "REM" || entry.component === "CUBE") return entry.component;
    return "N/A";
  };

  if (kind === "RCBL") {
    type UtilityRow = { id: string; name: string; group: string; utility: string; purchased: number; otherUtilities: number; review: number; total: number };
    const grouped = new Map<string, UtilityRow>();
    for (const entry of entries) {
      const key = `${entry.customerId}|${entry.utilityGroup}|${entry.utility}`;
      const row = grouped.get(key) ?? { id: entry.customerId, name: entry.customerName, group: entry.utilityGroup, utility: entry.utility, purchased: 0, otherUtilities: 0, review: 0, total: 0 };
      const field = entry.component === "UNCLASSIFIED" ? "review" : entry.component === entry.utility ? "purchased" : "otherUtilities";
      row[field] = add(row[field], entry.amount);
      row.total = add(row.total, entry.amount);
      grouped.set(key, row);
    }
    const billing = new Map<string, { consumption: number; unit: string; rate: number | null; mixedRate: boolean; rateId: string; rateDate: string }>();
    const customerDetails = new Map<string, { rateClass: string; agreement: string }>();
    for (const customer of selection.billing?.customers ?? []) for (const line of customer.lines) {
      const previousDetails = customerDetails.get(customer.customerId);
      customerDetails.set(customer.customerId, {
        rateClass: previousDetails && previousDetails.rateClass !== customer.rateClass ? "Multiple rate classes" : customer.rateClass || "-",
        agreement: previousDetails && previousDetails.agreement !== (customer.rcblComment || "-") ? "Multiple agreements" : customer.rcblComment || "-",
      });
      if (line.reimbursementDisposition === "CE_ABSORBED" || line.amount === null) continue;
      const utility = line.reportingSplit?.utility ?? normalizeReportingUtility(line.utilityType) ?? "UNRESOLVED";
      const key = `${customer.customerId}|${line.utilityGroup ?? ""}|${utility}`;
      const nextUnit = line.consumptionUM ?? "";
      const nextRate = line.rate ?? null;
      const nextRateId = line.rateId ?? "";
      const nextRateDate = line.rateEffectiveDate ?? "";
      const previous = billing.get(key);
      if (previous) {
        previous.consumption += line.allocatedConsumption ?? 0;
        if (previous.unit !== nextUnit) previous.unit = "MULTIPLE";
        if (previous.rate !== nextRate) previous.mixedRate = true;
        if (previous.rateId !== nextRateId) previous.rateId = "Multiple 3556 sources";
        if (previous.rateDate !== nextRateDate) previous.rateDate = "Multiple effective dates";
      } else billing.set(key, { consumption: line.allocatedConsumption ?? 0, unit: nextUnit, rate: nextRate, mixedRate: false, rateId: nextRateId, rateDate: nextRateDate });
    }
    const byCustomer = new Map<string, UtilityRow[]>();
    for (const row of grouped.values()) byCustomer.set(row.id, [...(byCustomer.get(row.id) ?? []), row]);
    const rows: ExportCell[][] = [];
    for (const [id, utilities] of byCustomer) {
      const details = customerDetails.get(id);
      for (const row of utilities) {
        const original = billing.get(`${row.id}|${row.group}|${row.utility}`);
        rows.push([row.id, row.name, details?.rateClass ?? "-", details?.agreement ?? "-", row.group, row.utility, original ? original.consumption : "-", original?.unit || "-", original ? original.mixedRate ? "Multiple rates" : original.rate ?? "-" : "-", original?.rateId || "-", original?.rateDate || "-", row.purchased, row.otherUtilities, row.review, row.total]);
      }
      const sum = (field: "purchased" | "otherUtilities" | "review" | "total") => money(utilities.reduce((value, row) => value + cents(row[field]), 0));
      rows.push([id, utilities[0].name, details?.rateClass ?? "-", details?.agreement ?? "-", "ALL", "Customer total", "-", "-", "-", "-", "-", sum("purchased"), sum("otherUtilities"), sum("review"), sum("total")]);
    }
    return { ...base, title: "RCBL - Customer Utility Cost Breakdown", headers: ["Customer ID", "Customer", "Rate class", "Customer agreement/document", "Group", "Utility", "Consumption", "Unit", "Unit rate", "3556 source", "3556 effective", "Utility base cost", "Other Utilities", "Unclassified - Review Required", "Total"], rows, currencyColumns: [11, 12, 13, 14], pdfColumnGroups: undefined, notes: [...base.notes, "Customer total rows summarize the utility rows above and are not additional charges.", "Consumption, unit rate, and 3556 source come from the original billing lines. Multiple rates or sources are labeled rather than averaged.", "Other Utility Costs reflect any authorized delivery, infrastructure, and production fees included as part of approved 3556 rates. REM, CUBE, and SRM component amounts are consolidated in Other Utilities; see EEIC reports for the detail.", "The old application account number and lock/approval dates are not stored on the CUBE billing/customer records; Customer ID remains the authoritative identifier."] };
  }

  if (kind === "EEIC_SHORT") {
    type CategoryRow = { id: string; name: string; category: string; eeic: string; objectClass: string; status: string; amount: number };
    const grouped = new Map<string, CategoryRow>();
    for (const entry of entries) {
      const category = reportComponent(entry);
      const key = `${entry.customerId}|${category}|${entry.eeic}|${entry.objectClass}|${entry.mappingStatus}`;
      const row = grouped.get(key) ?? { id: entry.customerId, name: entry.customerName, category, eeic: entry.eeic, objectClass: entry.objectClass, status: entry.mappingStatus, amount: 0 };
      row.amount = add(row.amount, entry.amount);
      grouped.set(key, row);
    }
    const byCustomer = new Map<string, CategoryRow[]>();
    for (const row of grouped.values()) byCustomer.set(row.id, [...(byCustomer.get(row.id) ?? []), row]);
    const agreements = new Map((selection.billing?.customers ?? []).map(customer => [customer.customerId, customer.rcblComment || "-"]));
    const rows: ExportCell[][] = [];
    for (const [id, items] of byCustomer) {
      for (const row of items) rows.push([row.id, row.name, agreements.get(id) ?? "-", row.category, row.eeic, row.objectClass, row.status, row.amount]);
      rows.push([id, items[0].name, agreements.get(id) ?? "-", "Customer total", "-", "-", "-", money(items.reduce((sum, row) => sum + cents(row.amount), 0))]);
    }
    return { ...base, title: "EEIC Short - Customer Accounting Summary", headers: ["Customer ID", "Customer", "Customer agreement/document", "Cost category", "EEIC", "Object Class", "Code status", "Amount"], rows, pdfColumnGroups: undefined, notes: [...base.notes, "Customer total rows summarize the category rows above and are not additional charges."] };
  }

  const byCustomer = new Map<string, Map<string, ReportEntry[]>>();
  for (const entry of entries) {
    const codes = byCustomer.get(entry.customerId) ?? new Map<string, ReportEntry[]>();
    codes.set(entry.eeic, [...(codes.get(entry.eeic) ?? []), entry]);
    byCustomer.set(entry.customerId, codes);
  }
  const rows: ExportCell[][] = [];
  for (const [id, codes] of byCustomer) {
    let customerCents = 0;
    let customerName = "";
    for (const [code, lines] of codes) {
      customerName = lines[0].customerName;
      for (const entry of lines) rows.push([id, entry.customerName, code, reportComponent(entry), entry.utility, description(entry), costCategory(entry), facilityOps(entry), entry.utilityGroup, entry.facilityNumber, entry.allocationSource, entry.sourceCostRows.map(row => `${row.section}:${row.key} ${row.account}`).join("; ") || "-", entry.mappingStatus, entry.amount]);
      const subtotalCents = lines.reduce((sum, entry) => sum + cents(entry.amount), 0);
      customerCents += subtotalCents;
      rows.push([id, lines[0].customerName, code, "EEIC subtotal", "-", "-", "-", "-", "-", "-", "-", "-", "-", money(subtotalCents)]);
    }
    const categoryTotals = new Map<string, number>();
    for (const lines of codes.values()) for (const entry of lines) {
      const key = `${reportComponent(entry)}|${entry.eeic}`;
      categoryTotals.set(key, (categoryTotals.get(key) ?? 0) + cents(entry.amount));
    }
    for (const [key, total] of categoryTotals) {
      const [category, code] = key.split("|");
      rows.push([id, customerName, code, category, "Category summary", "-", "-", "-", "-", "-", "-", "-", "-", money(total)]);
    }
    rows.push([id, customerName, "-", "Customer total", "-", "-", "-", "-", "-", "-", "-", "-", "-", money(customerCents)]);
  }
  return { ...base, title: "EEIC Detail - Customer Accounting Breakdown", headers: ["Customer ID", "Customer", "EEIC", "Reporting component", "Utility", "Utility description", "Cost category", "Facility Ops/SRM", "Group", "Facility", "Allocation source", "Source 3556 rows", "Code status", "Amount"], rows, pdfColumnGroups: undefined, notes: [...base.notes, "EEIC subtotals, category summary rows, and customer totals summarize preceding charge lines; they are not additional charges."] };
}
