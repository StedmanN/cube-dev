import { normalizeReportingUtility, type CostRow, type ReportingSplit, type UtilityCode } from "./3556-reporting";

import { CANDIDATE_CROSSWALK } from "./reporting-crosswalk";
import type { AccountingCode } from "./reporting-crosswalk";
export { CANDIDATE_CROSSWALK } from "./reporting-crosswalk";
export type ReportKind = "RCBL" | "EEIC_SHORT" | "EEIC_DETAIL";
export type ReportEntry = {
  customerId: string; customerName: string; customerType: string; rateClass: string;
  utility: string; utilityGroup: string; component: string; componentLabel: string;
  eeic: string; objectClass: string; mappingStatus: string;
  classificationStatus: string;
  sourceCostRows: CostRow[];
  componentBreakdown?: Array<{component:string;amount:number;classificationStatus:string;mappingStatus:string;sourceCostRows:CostRow[]}>;
  reconciliationId: string; facilityNumber: string; allocationSource: string;
  allocatedConsumption: number; consumptionUnit: string;
  appliedRate: number | null; rateId: string; rateEffectiveDate: string;
  amount: number;
};
export type BuiltFinancialReport = {
  rows: ReportEntry[];
  issues: string[];
  customerTotals: Record<string,number>;
  billedTotal: number;
  outputTotal: number;
  ready: boolean;
  accountingVerified: boolean;
};
export type InputCustomer = {
  customerId: string;
  customerName: string;
  customerType: string;
  rateClass: string;
  rcblComment?: string;
  totalAmount: number | null;
  lines: Array<{
    amount: number | null;
    ready: boolean;
    reimbursementDisposition?: string;
    utilitySystem?: string;
    utilityType?: string;
    utilityGroup?: string;
    reconciliationId?: string;
    facilityNumber?: string;
    allocationSource?: string;
    allocatedConsumption?: number;
    consumptionUM?: string;
    rate?: number | null;
    rateId?: string;
    rateEffectiveDate?: string;
    reportingSplit?: ReportingSplit;
    reportingCodes?: Record<string, AccountingCode>;
  }>;
};
export type InputBilling = {customers:InputCustomer[]; persisted?: boolean};
const labelNames: Record<string,string> = {
  EL:"Electricity", NG:"Natural Gas", PW:"Water", SS:"Sewage", REM:"Resource Efficiency Manager", CUBE:"CUBE", SRM_LABOR:"SRM Labor", SRM_MATERIALS:"SRM Materials",
};
const usd = (n: number) => Math.round(n * 100);
const money = (c: number) => Number((c / 100).toFixed(2));
function keyOf(entry: ReportEntry) {
  return [entry.customerId,entry.utility,entry.utilityGroup,entry.component,entry.eeic,entry.objectClass,entry.mappingStatus].join("|");
}


/**
 * Show the entire ORIGINAL customer charge when its reporting classification is
 * unresolved. This is NOT an Other Utilities amount and carries no accounting
 * code: it cannot be mistaken for an approved component or an adjusted bill.
 */
function unclassifiedEntry(customer: InputCustomer, line: InputCustomer["lines"][number]): ReportEntry {
  const utility = line.reportingSplit?.utility ?? normalizeReportingUtility(line.utilityType) ?? "UNRESOLVED";
  return {
    customerId: customer.customerId,
    customerName: customer.customerName,
    customerType: customer.customerType,
    rateClass: customer.rateClass,
    utility,
    utilityGroup: line.utilityGroup ?? "",
    component: "UNCLASSIFIED",
    componentLabel: "Unclassified — Review Required",
    eeic: "UNRESOLVED",
    objectClass: "UNRESOLVED",
    mappingStatus: "REVIEW",
    classificationStatus: "REVIEW",
    sourceCostRows: line.reportingSplit?.sourceRows ?? [],
    reconciliationId: line.reconciliationId ?? "",
    facilityNumber: line.facilityNumber ?? "",
    allocationSource: line.allocationSource ?? "",
    allocatedConsumption: line.allocatedConsumption ?? 0,
    consumptionUnit: line.consumptionUM ?? "",
    appliedRate: line.rate ?? null,
    rateId: line.rateId ?? line.reportingSplit?.rateId ?? "",
    rateEffectiveDate: line.rateEffectiveDate ?? line.reportingSplit?.effectiveDate ?? "",
    amount: line.amount ?? 0,
  };
}

export function buildFinancialReport(data: InputBilling, kind: ReportKind): BuiltFinancialReport {
  const issues: string[] = [];
  const entries: ReportEntry[] = [];
  const billed = new Map<string, number>();
  let hasProvisionalClassification = false;

  for (const customer of data.customers ?? []) {
    const charged = customer.lines.filter(
      line => line.reimbursementDisposition !== "CE_ABSORBED" && line.amount !== null,
    );
    const customerDue = charged.reduce((n, line) => n + usd(Number(line.amount)), 0);
    // One CustomerID can be represented by more than one customer object.
    billed.set(customer.customerId, (billed.get(customer.customerId) ?? 0) + customerDue);

    for (const line of customer.lines) {
      if (line.reimbursementDisposition === "CE_ABSORBED") continue;
      if (line.amount === null) {
        if (!line.ready) issues.push(`${customer.customerId}: unfinished original billing line ${line.reconciliationId ?? ""}`);
        continue; // No known customer charge to carry into the report.
      }
      const grossCents = usd(line.amount);
      if (grossCents === 0) continue;
      const reference = [customer.customerId, line.reconciliationId, line.rateId].filter(Boolean).join(" / ");
      const carryForReview = (reason: string) => {
        issues.push(`${reference}: ${reason}`);
        entries.push(unclassifiedEntry(customer, line));
      };

      // A bill with an unresolved source MUST still appear in the reporting
      // total. It cannot be assigned to Other Utilities or to an EEIC code.
      if (!line.ready) {
        carryForReview("original billing line is not ready; full charge shown as unclassified");
        continue;
      }
      const split = line.reportingSplit;
      if (!split || split.status === "REVIEW" || split.purchasedUtilityAmount === null) {
        carryForReview(split?.issues.join("; ") || "historical bill has no issued reporting breakdown");
        continue;
      }
      if (split.status === "PROVISIONAL") {
        hasProvisionalClassification = true;
        if (split.warnings?.length) issues.push(`${reference}: ${split.warnings.join("; ")}`);
      }
      const utility = split.utility as UtilityCode | null;
      if (!utility) {
        carryForReview("unrecognized utility; full charge shown as unclassified");
        continue;
      }
      const parts: Array<[string, number]> = [[utility, split.purchasedUtilityAmount], ...Object.entries(split.components)];
      if (parts.some(([, amount]) => !Number.isFinite(amount)) ||
          parts.reduce((n, [, amount]) => n + usd(amount), 0) !== grossCents) {
        carryForReview("report split does not reconcile to saved customer charge");
        continue;
      }

      // Build the split atomically. If a historical EEIC snapshot is missing,
      // do not emit only some of the line's component amounts.
      const lineEntries: ReportEntry[] = [];
      let missingComponent: string | null = null;
      for (const [component, amount] of parts) {
        if (usd(amount) === 0) continue;
        const crosswalk = line.reportingCodes?.[component] ?? (data.persisted ? undefined : CANDIDATE_CROSSWALK[component as keyof typeof CANDIDATE_CROSSWALK]);
        if (!crosswalk) {
          missingComponent = component;
          break;
        }
        hasProvisionalClassification = true; // Every supported accounting-code status is currently unapproved.
        const sourceCostRows = split.sourceRows.filter(source => source.component === component);
        const classificationStatus = sourceCostRows.some(source => source.classificationStatus === "PROVISIONAL")
          ? "PROVISIONAL"
          : sourceCostRows.length ? "IDENTIFIED" : "3556 RATE RESIDUAL";
        lineEntries.push({
          customerId: customer.customerId,
          customerName: customer.customerName,
          customerType: customer.customerType,
          rateClass: customer.rateClass,
          utility,
          utilityGroup: line.utilityGroup ?? "",
          component,
          componentLabel: labelNames[component] ?? component,
          eeic: crosswalk.eeic ?? "UNRESOLVED",
          objectClass: crosswalk.objectClass,
          mappingStatus: crosswalk.status,
          classificationStatus,
          sourceCostRows,
          ...(component !== utility ? {
            componentBreakdown: [{component, amount, classificationStatus, mappingStatus: crosswalk.status, sourceCostRows}],
          } : {}),
          reconciliationId: line.reconciliationId ?? "",
          facilityNumber: line.facilityNumber ?? "",
          allocationSource: line.allocationSource ?? "",
          allocatedConsumption: line.allocatedConsumption ?? 0,
          consumptionUnit: line.consumptionUM ?? "",
          appliedRate: line.rate ?? null,
          rateId: line.rateId ?? "",
          rateEffectiveDate: line.rateEffectiveDate ?? "",
          amount,
        });
      }
      if (missingComponent !== null) {
        carryForReview(`no issued EEIC snapshot for ${missingComponent}; historical code cannot be reconstructed safely`);
      } else {
        entries.push(...lineEntries);
      }
    }
  }

  const reviewRows: ReportEntry[] = [];
  const grouped = new Map<string, ReportEntry>();
  if (kind !== "EEIC_DETAIL") {
    for (const row of entries) {
      // Preserve the 3556 and reconciliation identities for each unresolved
      // charge so the user can locate and correct its underlying classification.
      // NEVER combine unresolved charges into the RCBL line.
      if (row.component === "UNCLASSIFIED") {
        reviewRows.push({ ...row });
        continue;
      }
      const key = kind === "RCBL"
        ? `${row.customerId}|${row.component === row.utility ? row.utility : "OTHER"}`
        : keyOf(row);
      const previous = grouped.get(key);
      if (previous) {
        previous.amount = money(usd(previous.amount) + usd(row.amount));
        if (kind === "RCBL" && row.component !== row.utility && row.componentBreakdown?.[0]) {
          const incoming = row.componentBreakdown[0];
          const existingBreakdown = previous.componentBreakdown ?? [];
          const existingComponent = existingBreakdown.find(item => item.component === incoming.component);
          if (existingComponent) {
            existingComponent.amount = money(usd(existingComponent.amount) + usd(incoming.amount));
            existingComponent.sourceCostRows = [...existingComponent.sourceCostRows, ...incoming.sourceCostRows];
          } else {
            existingBreakdown.push({...incoming});
          }
          previous.componentBreakdown = existingBreakdown;
          if (incoming.mappingStatus === "PROVISIONAL") previous.mappingStatus = "PROVISIONAL";
          if (incoming.classificationStatus === "PROVISIONAL") previous.classificationStatus = "PROVISIONAL";
        }
        if (row.sourceCostRows.length) previous.sourceCostRows.push(...row.sourceCostRows);
        if (previous.rateId !== row.rateId) previous.rateId = "MULTIPLE FINAL 3556 SOURCES";
        if (previous.rateEffectiveDate !== row.rateEffectiveDate) previous.rateEffectiveDate = "MULTIPLE EFFECTIVE DATES";
        if (kind === "RCBL") previous.appliedRate = null;
      } else {
        grouped.set(key, kind === "RCBL" ? {
          ...row,
          component: row.component === row.utility ? row.component : "OTHER",
          componentLabel: row.component === row.utility ? row.componentLabel : "Other Utilities",
          eeic: "N/A", objectClass: "N/A",
          allocatedConsumption: 0, consumptionUnit: "N/A", appliedRate: null,
        } : { ...row });
      }
    }
  }
  const rows = kind === "EEIC_DETAIL" ? entries : [...grouped.values(), ...reviewRows];
  const billedTotal = money(Array.from(billed.values()).reduce((a, b) => a + b, 0));
  const outputTotal = money(entries.reduce((n, row) => n + usd(row.amount), 0));
  if (usd(billedTotal) !== usd(outputTotal)) {
    issues.push(`Reported total ${outputTotal.toFixed(2)} does not equal original customer charges ${billedTotal.toFixed(2)}.`);
  }
  if (hasProvisionalClassification) {
    issues.push("Provisional source classifications or EEIC/Object Class mappings are included; verify them before official use.");
  }
  const customerTotals = Object.fromEntries(Array.from(billed.entries()).map(([id, total]) => [id, money(total)]));
  return { rows, issues, customerTotals, billedTotal, outputTotal, ready: issues.length === 0, accountingVerified: false };
}
