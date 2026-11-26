import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const loaded = new Map();
function load(name) {
  const file = path.resolve(root, "lib", name);
  if (loaded.has(file)) return loaded.get(file).exports;
  const result = { exports: {} };
  loaded.set(file, result);
  const compiled = ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  new Function("require", "module", "exports", compiled)(dependency =>
    dependency.startsWith(".") ? load(`${path.basename(dependency).replace(/\.ts$/, "")}.ts`) : require(dependency), result, result.exports);
  return result.exports;
}
const { savedCustomerExportData } = load("rcbl-saved-customer-export.ts");
const { buildCustomerBillPdfLines, buildCustomerBillExcelTable } = load("rcbl-customer-pdf.ts");
const { buildSimpleCustomerPdf } = load("customer-bill-pdf-engine.ts");
const { pumpingReimbursementUtility, resolveUtilityReimbursement, splitReimbursementCharge } = load("utility-reimbursement.ts");
const { exportXlsx } = load("report-file-export.ts");
const route = readFileSync(path.resolve(root, "app/api/billing/rcbl-short/export/route.ts"), "utf8");
const ui = readFileSync(path.resolve(root, "app/billing/billing-client.tsx"), "utf8");
const rec = readFileSync(path.resolve(root, "app/api/monthly-data/reconciliation/route.ts"), "utf8");

const saved = [
  { RecordType: "BILL_METADATA", FY: "2026", BillingMonth: "February" },
  { RecordType: "CUSTOMER_BILL", CustomerID: "C-TAC", CustomerName: "TAC Account", CustomerType: "Reimbursable", ReportType: "DOD", RateClass: "D", RCBLComment: "Current", TotalAmount: 100, FY: "2026", BillingMonth: "February" },
  { RecordType: "CUSTOMER_BILL", CustomerID: "C-WWY", CustomerName: "WWYK Account", CustomerType: "Reimbursable", ReportType: "DOD", RateClass: "D", TotalAmount: 50 },
  { RecordType: "BILLING_LINE", CustomerID: "C-TAC", utilityGroup: "TAC", utilityType: "EL", utilitySystem: "Electricity", consumptionUM: "kWh", allocatedConsumption: 1000, amount: 100, reimbursementDisposition: "CUSTOMER_REIMBURSABLE", reportingSplit: { status: "PROVISIONAL", utility: "EL", originalCharge: 100, purchasedUtilityAmount: 80, components: { REM: 10, CUBE: 5, SRM_LABOR: 5 } } },
  { RecordType: "BILLING_LINE", CustomerID: "C-WWY", utilityGroup: "WWYK", utilityType: "EL", utilitySystem: "Electricity", consumptionUM: "kWh", allocatedConsumption: 500, amount: 50, reimbursementDisposition: "CUSTOMER_REIMBURSABLE" },
];

test("no saved bills means no server export data, even with fake preview inputs", () => {
  assert.equal(savedCustomerExportData([], 175), null);
  assert.equal(savedCustomerExportData([{ preview: true, customers: [{customerId: "C-TAC"}] }], 175), null);
  assert.equal(savedCustomerExportData(saved, 175, "UNKNOWN"), null);
});

test("server export uses exactly the selected SAVED customer, never current preview", () => {
  const result = savedCustomerExportData(saved, 175, "C-TAC");
  assert.equal(result?.customers.length, 1);
  assert.equal(result?.customers[0].customerId, "C-TAC");
  assert.equal(result?.customers[0].totalAmount, 100);
  assert.equal(result?.customers[0].lines.length, 1);
  assert.deepEqual(result?.customers[0].lines[0].reportingSplit?.components, {REM:10, CUBE:5, SRM_LABOR:5});
  const lines = buildCustomerBillPdfLines(result.period, result.customers[0]);
  assert.ok(lines.includes("TOTAL BILL: $100.00"));
  assert.ok(lines.some(s => s === "Other Utilities|-|-|-|$20.00"));
  assert.ok(!lines.some(s => s.startsWith("REM (PROVISIONAL)|")));
  assert.ok(!lines.some(s => s.includes("$50.00")));
});

test("server bulk PDF is generated using two persisted bills", () => {
  const result = savedCustomerExportData(saved, 175);
  assert.equal(result.customers.length, 2);
  const pages = result.customers.map(c => buildCustomerBillPdfLines(result.period, c));
  const bytes = buildSimpleCustomerPdf(pages);
  assert.ok(bytes.byteLength > 1000);
  assert.equal(new TextDecoder().decode(bytes.slice(0, 8)), "%PDF-1.4");
  assert.match(new TextDecoder().decode(bytes), /\/Count 2/);
});

test("saved customer Excel has original total, does not double-bill Other Utilities", () => {
  const result = savedCustomerExportData(saved, 175, "C-TAC");
  const sheet = buildCustomerBillExcelTable(result.period, result.customers[0]);
  assert.equal(sheet.rows.find(row => row[0] === "TOTAL DUE (original bill)")[4], 100);
  const bytes = exportXlsx(sheet);
  assert.equal(new TextDecoder().decode(bytes.slice(0, 2)), "PK");
});

test("legacy saved bill with no reporting split remains review, never invents split", () => {
  const result = savedCustomerExportData(saved, 175, "C-WWY");
  const lines = buildCustomerBillPdfLines(result.period, result.customers[0]);
  assert.ok(lines.some(s => s.includes("Unclassified - Review Required: $50.00")));
  assert.ok(lines.some(s => s.includes("Electricity (REVIEW)")));
});

test("UI and endpoint require saved data for EVERY customer export, no unsaved PDF download", () => {
  assert.match(ui, /Save the bill before exporting/);
  assert.match(ui, /Current Preview — validation inside CUBE only/);
  assert.match(ui, /downloadSavedCustomerBill\("customer-pdf", customer.customerId\)/);
  assert.match(ui, /downloadSavedCustomerBill\("customer-xlsx", customer.customerId\)/);
  assert.match(ui, /downloadSavedCustomerBill\("all-pdfs"\)/);
  assert.doesNotMatch(ui, /downloadSimplePdf\(/);
  assert.match(route, /if \(!allBills.length\)/);
  assert.match(route, /savedCustomerExportData\(saved, period, customerId/);
  for (const format of ["customer-pdf", "customer-xlsx", "all-pdfs"]) {
    assert.ok(route.includes(`"${format}"`));
  }
});

test("SS Pumping follows SS toggle, PW Pumping follows EL toggle; calculated amounts conserved", () => {
  assert.equal(pumpingReimbursementUtility("SS_PUMPING"), "SS");
  assert.equal(pumpingReimbursementUtility("PW_PUMPING"), "EL");
  for (const [ss,el] of [[false,true],[true,false]]) {
    const overrides={SS:ss,EL:el};
    const ssResult=resolveUtilityReimbursement({ utilityType:pumpingReimbursementUtility("SS_PUMPING"),customerType:"Reimbursable",overrides });
    const pwResult=resolveUtilityReimbursement({ utilityType:pumpingReimbursementUtility("PW_PUMPING"),customerType:"Reimbursable",overrides });
    assert.equal(ssResult.effectiveReimbursable,ss);
    assert.equal(pwResult.effectiveReimbursable,el);
    const split=splitReimbursementCharge(15.26,ssResult.disposition);
    assert.equal(split.customerChargeAmount+split.ceAbsorbedAmount,15.26);
  }
  assert.match(rec,/\.\.\.sewerPumpingReimbursementFields/);
  assert.match(rec,/pumpingReimbursementUtility\("SS_PUMPING"\)/);
  assert.match(rec,/UtilityType: "EL",\s+ConsumptionUM: "KWH",\s+AllocationSource: "SS_PUMPING"/);
  assert.match(rec,/CalculationMethod: "SS_KGAL_TIMES_2_18_KWH_PER_KGAL"/);
});
