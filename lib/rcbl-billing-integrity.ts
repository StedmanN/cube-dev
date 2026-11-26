import { createHash } from "node:crypto";

export type BillingPreviewValue = Record<string, unknown>;

export type OfficialCustomerBillingIssue = {
  customerId: string;
  customerName: string;
  reason: string;
};

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => key !== "generatedAt" && key !== "previewFingerprint")
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}

export function billingPreviewsMatch(
  left: BillingPreviewValue,
  right: BillingPreviewValue,
): boolean {
  return stableJson(left) === stableJson(right);
}

// Identifies the complete JSON preview that the user reviewed without returning
// thousands of customer/line items in the browser's save/replace POST.
// Round-trip through JSON first: this hashes exactly the data delivered over
// HTTP (not undefined fields or non-JSON values from the server object).
// generatedAt is intentionally excluded, matching billingPreviewsMatch.
export function billingPreviewFingerprint(preview: BillingPreviewValue): string {
  const json = JSON.parse(JSON.stringify(preview)) as BillingPreviewValue;
  return createHash("sha256").update(stableJson(json), "utf8").digest("hex");
}

function text(value: unknown): string {
  return value === undefined || value === null ? "" : String(value).trim();
}

function normalize(value: unknown): string {
  return text(value).toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function unresolvedOfficialCustomerBillingIssues(
  preview: BillingPreviewValue,
): OfficialCustomerBillingIssue[] {
  const customers = Array.isArray(preview.customers)
    ? (preview.customers as BillingPreviewValue[])
    : [];
  const issues: OfficialCustomerBillingIssue[] = [];

  for (const customer of customers) {
    const reasons: string[] = [];
    const lines = Array.isArray(customer.lines)
      ? (customer.lines as BillingPreviewValue[])
      : [];
    const reimbursableLines = lines.filter((line) => {
      const disposition = text(line.reimbursementDisposition).toUpperCase();
      if (disposition) return disposition === "CUSTOMER_REIMBURSABLE";
      return normalize(customer.customerType) === "REIMBURSABLE";
    });
    if (reimbursableLines.length === 0) continue;
    const issueCountText = text(customer.issueCount);
    const issueCount = issueCountText ? Number(issueCountText) : 0;

    if (text(customer.status).toUpperCase() !== "READY") {
      reasons.push("customer status is REVIEW");
    }
    if (issueCountText && (!Number.isFinite(issueCount) || issueCount > 0)) {
      reasons.push(`customer issue count is ${issueCountText}`);
    }
    if (customer.totalAmount === null || customer.totalAmount === undefined) {
      reasons.push("customer total amount is missing");
    }

    for (const line of reimbursableLines) {
      const lineIssues = Array.isArray(line.issues) ? line.issues : [];
      if (line.ready !== true || line.amount === null || line.amount === undefined || lineIssues.length > 0) {
        reasons.push(
          `billing line ${text(line.reconciliationId) || "is unresolved"}`,
        );
        break;
      }
    }

    if (reasons.length > 0) {
      issues.push({
        customerId: text(customer.customerId) || "UNKNOWN_CUSTOMER",
        customerName: text(customer.customerName) || "Unnamed Customer",
        reason: reasons.join("; "),
      });
    }
  }

  return issues;
}
