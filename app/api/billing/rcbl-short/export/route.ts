import { NextRequest } from "next/server";
import { savedCustomerExportData } from "@/lib/rcbl-saved-customer-export";
import { buildCustomerBillPdfLines, buildCustomerBillExcelTable } from "@/lib/rcbl-customer-pdf";
import { buildSimpleCustomerPdf } from "@/lib/customer-bill-pdf-engine";
import { exportXlsx } from "@/lib/report-file-export";
import { ScanCommand } from "@aws-sdk/lib-dynamodb";
import { getAppSession } from "@/lib/app-session";
import { ddb } from "@/lib/dynamo";
import {
  logDynamoError,
  publicDynamoErrorResponse,
} from "@/lib/dynamo-error";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

const TABLE = process.env.CUBE_RCBL_SHORT_TABLE_NAME || "p72-CUBE-RCBL-SHORT";
const CURRENT_POINTER_RECORD_TYPE = "BILL_VERSION_POINTER";
type Row = Record<string, unknown>;
const summaryColumns = [
  ["Billing Period", "billing_period_id"], ["FY", "FY"], ["Billing Month", "BillingMonth"],
  ["Customer ID", "CustomerID"], ["Customer Name", "CustomerName"],
  ["Customer Type", "CustomerType"], ["Report Type", "ReportType"],
  ["Rate Class", "RateClass"], ["Billing Status", "BillingStatus"],
  ["Total Amount", "TotalAmount"], ["Ready Amount", "ReadyAmount"],
  ["Line Count", "LineCount"], ["Ready Lines", "ReadyLineCount"],
  ["Issue Count", "IssueCount"], ["Saved At", "SavedAt"],
] as const;
const detailColumns = [
  ["Billing Period", "billing_period_id"], ["FY", "FY"], ["Billing Month", "BillingMonth"],
  ["Customer ID", "CustomerID"], ["Customer Name", "CustomerName"],
  ["Customer Type", "CustomerType"], ["Report Type", "ReportType"],
  ["Rate Class", "RateClass"], ["Reconciliation ID", "reconciliationId"],
  ["Facility ID", "facilityId"], ["Facility Number", "facilityNumber"],
  ["Category Code", "categoryCode"], ["Allocation Source", "allocationSource"],
  ["Source ID", "sourceId"], ["Meter ID", "meterId"],
  ["Utility Group", "utilityGroup"], ["Utility Type", "utilityType"],
  ["Utility System", "utilitySystem"], ["Consumption UOM", "consumptionUM"],
  ["Allocated Consumption", "allocatedConsumption"], ["Rate ID", "rateId"],
  ["Rate Effective Date", "rateEffectiveDate"], ["Rate Key", "rateKey"],
  ["Rate Label", "rateLabel"], ["Rate", "rate"], ["Amount", "amount"],
  ["Calculated Charge", "calculatedAmount"],
  ["Customer Charge", "customerChargeAmount"],
  ["CE Absorbed Amount", "ceAbsorbedAmount"],
  ["Reimbursement Utility", "reimbursementUtilityType"],
  ["Reimbursement Source", "reimbursementSource"],
  ["Reimbursement Override", "reimbursementOverride"],
  ["Effective Reimbursement Type", "effectiveReimbursementType"],
  ["Reimbursement Disposition", "reimbursementDisposition"],
  ["Ready", "ready"], ["Issues", "issues"], ["Saved At", "SavedAt"],
] as const;

function value(row: Row, key: string): string | number | boolean {
  const input = row[key];
  if (input === undefined || input === null) return "";
  if (Array.isArray(input)) return input.map(String).join("; ");
  if (typeof input === "number" || typeof input === "boolean") return input;
  if (typeof input === "object") return JSON.stringify(input);
  // Prevent spreadsheet formula injection for user-controlled text.
  const str = String(input);
  return /^[\s]*[=+@-]/.test(str) ? "'" + str : str;
}
function csv(rows: Row[], columns: readonly (readonly [string, string])[]) {
  const escape = (v: string | number | boolean) => '"' + String(v).replace(/"/g, '""') + '"';
  return "\uFEFF" + [columns.map(c => escape(c[0])).join(","), ...rows.map(row => columns.map(c => escape(value(row, c[1]))).join(","))].join("\r\n");
}
function downloadable(data: string | Uint8Array, mime: string, name: string) {
  return new Response(data as BodyInit, { headers: {
    "Content-Type": mime,
    "Content-Disposition": `attachment; filename="${name}"`,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  }});
}
async function savedRows(period: number): Promise<Row[]> {
  const rows: Row[] = [];
  let key: Record<string, unknown> | undefined;
  do {
    const result = await ddb.send(new ScanCommand({
      TableName: TABLE,
      FilterExpression: "billing_period_id = :period",
      ExpressionAttributeValues: { ":period": period },
      ExclusiveStartKey: key,
    }));
    rows.push(...(result.Items || []));
    key = result.LastEvaluatedKey;
  } while (key);
  const pointer = rows.find(
    row => row.RecordType === CURRENT_POINTER_RECORD_TYPE,
  );
  const currentVersionId = String(pointer?.CurrentVersionId || "").trim();
  return rows.filter(row => {
    if (row.RecordType === CURRENT_POINTER_RECORD_TYPE) return true;
    if (!["BILL_METADATA", "CUSTOMER_BILL", "BILLING_LINE"].includes(String(row.RecordType || ""))) return false;
    return currentVersionId
      ? String(row.VersionId || "").trim() === currentVersionId
      : !String(row.VersionId || "").trim();
  });
}
export async function GET(request: NextRequest) {
  try {
    const session = await getAppSession();
    if (!session?.user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    const period = Number(request.nextUrl.searchParams.get("billing_period_id"));
    if (!Number.isSafeInteger(period) || period <= 0) return Response.json({ error: "Valid billing_period_id required." }, { status: 400 });
    const format = request.nextUrl.searchParams.get("format") || "summary-csv";
    if (!["status", "summary-csv", "detail-csv", "customer-pdf", "customer-xlsx", "all-pdfs"].includes(format)) return Response.json({ error: "Invalid export format." }, { status: 400 });
    const customerId = request.nextUrl.searchParams.get("customer_id");
    const saved = await savedRows(period);
    const allBills = saved.filter(r => r.RecordType === "CUSTOMER_BILL");
    const pointer = saved.find(row => row.RecordType === CURRENT_POINTER_RECORD_TYPE);
    if (format === "status") return Response.json({
      saved: allBills.length > 0,
      customerCount: allBills.length,
      versionId: pointer?.CurrentVersionId || "",
      versionNumber: pointer?.CurrentVersionNumber || 0,
      savedAt: pointer?.SavedAt || allBills[0]?.SavedAt || "",
    });
    if (!allBills.length) return Response.json({ error: "No saved bills exist for this billing period. Save the billing period before exporting." }, { status: 404 });
    if (format === "customer-pdf" || format === "customer-xlsx" || format === "all-pdfs") {
      if (format !== "all-pdfs" && !customerId) {
        return Response.json({ error: "Select a saved customer bill to export." }, { status: 400 });
      }
      if (format === "all-pdfs" && customerId) {
        return Response.json({ error: "Do not specify a customer for all-customer PDF export." }, { status: 400 });
      }
      const snapshot = savedCustomerExportData(saved, period, customerId || undefined);
      if (!snapshot) {
        return Response.json({ error: "No saved bill found for the selected customer." }, { status: 404 });
      }
      if (format === "customer-xlsx") {
        const bytes = exportXlsx(buildCustomerBillExcelTable(snapshot.period, snapshot.customers[0]));
        return downloadable(bytes, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          `RCBL-Short-${period}-Customer-${customerId?.replace(/[^a-zA-Z0-9_-]/g, "_")}.xlsx`);
      }
      const pages = snapshot.customers.map(customer => buildCustomerBillPdfLines(snapshot.period, customer));
      const bytes = buildSimpleCustomerPdf(pages);
      const suffix = format === "all-pdfs" ? "All-Customers" : `Customer-${customerId?.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
      return downloadable(bytes, "application/pdf", `RCBL-Short-${period}-${suffix}.pdf`);
    }
    const selected = customerId ? saved.filter(r => String(r.CustomerID || "") === customerId) : saved;
    const bills = selected.filter(r => r.RecordType === "CUSTOMER_BILL").sort((a,b) => String(a.CustomerName).localeCompare(String(b.CustomerName)));
    const lines = selected.filter(r => r.RecordType === "BILLING_LINE").sort((a,b) => String(a.CustomerName).localeCompare(String(b.CustomerName)) || String(a.RCBLShortID).localeCompare(String(b.RCBLShortID)));
    if (!bills.length) return Response.json({ error: "No saved bill found for the selected customer." }, { status: 404 });
    const suffix = customerId ? `-Customer-${customerId.replace(/[^a-zA-Z0-9_-]/g,"_")}` : "-All-Customers";
    const basename = `RCBL-Short-${period}${suffix}`;
    if (format === "summary-csv") return downloadable(csv(bills, summaryColumns), "text/csv; charset=utf-8", basename + "-Summary.csv");
    if (format === "detail-csv") return downloadable(csv(lines, detailColumns), "text/csv; charset=utf-8", basename + "-Details.csv");
    return Response.json({ error: "Unsupported export format." }, { status: 400 });
  } catch (error) {
    logDynamoError("RCBL saved export", error);
    const publicError = publicDynamoErrorResponse(error);
    if (publicError) {
      return Response.json(publicError.body, {
        status: publicError.status,
      });
    }
    return Response.json({ error: "Unable to export saved RCBL billing." }, { status: 500 });
  }
}
