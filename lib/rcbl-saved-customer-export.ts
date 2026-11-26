import type { CustomerBillPdfCustomer, CustomerBillPdfPreview, CustomerBillPdfLine } from "./rcbl-customer-pdf";
import type { ReportingSplit } from "./3556-reporting";

type SavedRow = Record<string, unknown>;
const string = (value: unknown) => value == null ? "" : String(value).trim();
const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : null;

/**
 * Only accepts CUSTOMER_BILL and BILLING_LINE rows loaded from the active
 * persisted bill version. No preview JSON is accepted anywhere on this path.
 * The stored reportingSplit is retained verbatim; an older bill with no saved
 * split is never retroactively recomputed from a newer 3556 worksheet.
 */
export function savedCustomerExportData(
  savedRecords: SavedRow[],
  billingPeriodId: number,
  customerId?: string,
): { period: CustomerBillPdfPreview; customers: CustomerBillPdfCustomer[] } | null {
  const bills = savedRecords.filter(row => row.RecordType === "CUSTOMER_BILL");
  if (!bills.length) return null;
  const selected = customerId ? bills.filter(row => string(row.CustomerID) === customerId) : bills;
  if (!selected.length) return null;
  const metadata = savedRecords.find(row => row.RecordType === "BILL_METADATA");
  const linesByCustomer = new Map<string, CustomerBillPdfLine[]>();
  for (const row of savedRecords) {
    if (row.RecordType !== "BILLING_LINE") continue;
    const id = string(row.CustomerID);
    const lines = linesByCustomer.get(id) ?? [];
    const rawAmount = row.amount ?? row.Amount;
    const rawConsumption = row.allocatedConsumption ?? row.AllocatedTotalConsumption;
    lines.push({
      utilityGroup: string(row.utilityGroup ?? row.UtilityGroup),
      utilityType: string(row.utilityType ?? row.UtilityType),
      utilitySystem: string(row.utilitySystem ?? row.UtilitySystem),
      consumptionUM: string(row.consumptionUM ?? row.ConsumptionUM),
      allocatedConsumption: number(rawConsumption) ?? 0,
      amount: rawAmount === null ? null : number(rawAmount),
      reimbursementDisposition: string(row.reimbursementDisposition ?? row.ReimbursementDisposition),
      reportingSplit: row.reportingSplit as ReportingSplit | undefined,
    });
    linesByCustomer.set(id, lines);
  }
  const first = selected[0];
  return {
    period: {
      billingPeriodId,
      billingMonth: string(metadata?.BillingMonth ?? first.BillingMonth),
      fiscalYear: string(metadata?.FY ?? first.FY),
    },
    customers: selected.map(bill => ({
      customerId: string(bill.CustomerID),
      customerName: string(bill.CustomerName),
      customerType: string(bill.CustomerType),
      reportType: string(bill.ReportType),
      rateClass: string(bill.RateClass),
      rcblComment: string(bill.RCBLComment),
      totalAmount: bill.TotalAmount === null ? null : number(bill.TotalAmount),
      lines: linesByCustomer.get(string(bill.CustomerID)) ?? [],
    })),
  };
}
