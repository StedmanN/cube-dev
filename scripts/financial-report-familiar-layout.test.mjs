import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../lib");
const cache = new Map();
function runtime(name) {
  const file = path.join(root, name);
  if (cache.has(file)) return cache.get(file).exports;
  const mod = { exports: {} };
  cache.set(file, mod);
  const code = ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  new Function("require", "module", "exports", code)(dep => dep.startsWith(".") ? runtime(`${path.basename(dep).replace(/\.ts$/, "")}.ts`) : require(dep), mod, mod.exports);
  return mod.exports;
}
const { buildFamiliarFinancialTable } = runtime("financial-report-export.ts");
const { exportCsv, exportXlsx, exportPdf } = runtime("report-file-export.ts");
const entry = (customerId, utility, component, eeic, amount, group = "WWYK") => ({
  customerId, customerName: customerId === "C1" ? "First Customer" : "Second Customer",
  customerType: "DOD", rateClass: "D", utility, utilityGroup: group,
  component, componentLabel: component === "UNCLASSIFIED" ? "Unclassified — Review Required" : component,
  eeic, objectClass: eeic === "UNRESOLVED" ? "UNRESOLVED" : "000",
  mappingStatus: eeic === "UNRESOLVED" ? "REVIEW" : "PROVISIONAL",
  classificationStatus: eeic === "UNRESOLVED" ? "REVIEW" : "IDENTIFIED",
  sourceCostRows: [], reconciliationId: `${customerId}-${utility}-${component}`,
  facilityNumber: "100", allocationSource: "METER", allocatedConsumption: 0,
  consumptionUnit: "kWh", appliedRate: null, rateId: "FINAL", rateEffectiveDate: "2026-01-01", amount,
});
const report = {
  rows: [
    entry("C1", "EL", "EL", "48020", 80),
    entry("C1", "EL", "REM", "480RE", 5),
    entry("C1", "EL", "REM", "480RE", 3),
    entry("C1", "EL", "UNCLASSIFIED", "UNRESOLVED", 2),
    entry("C1", "SS", "SS", "48040", 10),
    entry("C2", "EL", "EL", "48020", 50, "TACX"),
  ],
  customerTotals: { C1: 100, C2: 50 }, billedTotal: 150, outputTotal: 150,
  ready: false, accountingVerified: false, issues: ["C1 / EL: review source classification"],
};
const params = { report, period: 174, fiscalYear: "2026", month: "January", source: "SAVED VERSION TEST" };

test("RCBL utility breakdown preserves every billed dollar and separates customer groups", () => {
  const billing = {customers: [{customerId: "C1", rateClass: "D-1&2", rcblComment: "Agreement 42", lines: [
    {utilityType: "EL", utilityGroup: "WWYK", consumptionUM: "kWh", allocatedConsumption: 12, rate: 0.25, rateId: "3556-A", rateEffectiveDate: "2026-01-01", amount: 90},
    {utilityType: "SS", utilityGroup: "WWYK", consumptionUM: "KGAL", allocatedConsumption: 3, rate: 1, rateId: "3556-B", rateEffectiveDate: "2026-01-01", amount: 10},
  ]}]};
  const table = buildFamiliarFinancialTable({ ...params, kind: "RCBL", billing });
  assert.equal(table.pdfSummary.reconciliationDifference, 0);
  const c1El = table.rows.find(row => row[0] === "C1" && row[5] === "EL");
  assert.deepEqual(c1El.slice(2), ["D-1&2", "Agreement 42", "WWYK", "EL", 12, "kWh", 0.25, "3556-A", "2026-01-01", 80, 8, 2, 90]);
  assert.equal(table.rows.find(row => row[0] === "C1" && row[5] === "SS")[11], 10);
  assert.equal(table.headers.includes("REM"), false);
  assert.equal(table.headers.includes("CUBE"), false);
  assert.equal(table.headers.includes("SRM"), false);
  assert.ok(table.notes.some(note => note.includes("Other Utility Costs reflect any authorized delivery, infrastructure, and production fees")));
  assert.equal(table.rows.find(row => row[0] === "C2")[4], "TACX");
  assert.equal(table.rows.filter(row => row[5] !== "Customer total").reduce((sum, row) => sum + row.at(-1), 0), 150);
  assert.equal(table.rows.find(row => row[0] === "C1" && row[5] === "Customer total").at(-1), 100);
  assert.ok(table.rows.every(row => row.length === table.headers.length));
  assert.deepEqual(table.currencyColumns, [11, 12, 13, 14]);
  assert.match(Buffer.from(exportPdf(table)).toString("latin1"), /\$80\.00/);
});

test("read-only reports combine SRM labor and materials without losing either charge", () => {
  const rows = [
    entry("C1", "EL", "EL", "48020", 80),
    entry("C1", "EL", "SRM_LABOR", "480SR", 3),
    entry("C1", "EL", "SRM_MATERIALS", "480SR", 4),
  ];
  const source = { ...report, rows, customerTotals: { C1: 87 }, billedTotal: 87, outputTotal: 87, issues: [] };
  for (const kind of ["RCBL", "EEIC_SHORT", "EEIC_DETAIL"]) {
    const table = buildFamiliarFinancialTable({ ...params, report: source, kind });
    assert.equal(table.pdfSummary.reconciliationDifference, 0);
    assert.equal(table.rows.find(row => row.includes("Customer total")).at(-1), 87);
    assert.doesNotMatch(table.headers.join(" ") + Buffer.from(exportCsv(table)).toString("utf8"), /SRM Labor|SRM Materials|UESC|ESPC/);
    assert.equal(Buffer.from(exportPdf(table)).subarray(0, 4).toString("latin1"), "%PDF");
  }
  const rcbl = buildFamiliarFinancialTable({ ...params, report: source, kind: "RCBL" });
  assert.equal(rcbl.rows.find(row => row[5] === "EL")[rcbl.headers.indexOf("Other Utilities")], 7);
  assert.equal(rcbl.headers.includes("REM"), false);
  assert.equal(rcbl.headers.includes("CUBE"), false);
  assert.equal(rcbl.headers.includes("SRM"), false);
  const short = buildFamiliarFinancialTable({ ...params, report: source, kind: "EEIC_SHORT" });
  assert.equal(short.rows.find(row => row[3] === "SRM")[7], 7);
  const detail = buildFamiliarFinancialTable({ ...params, report: source, kind: "EEIC_DETAIL" });
  assert.equal(detail.rows.filter(row => row[3] === "SRM" && row[4] === "EL").reduce((sum, row) => sum + row.at(-1), 0), 7);
});

test("EEIC Short groups the same charge by category and code without losing review amounts", () => {
  const table = buildFamiliarFinancialTable({ ...params, kind: "EEIC_SHORT", customerId: "C1", customerName: "First Customer" });
  assert.equal(table.rows.filter(row => row[3] !== "Customer total").reduce((sum, row) => sum + row.at(-1), 0), 100);
  assert.equal(table.rows.find(row => row[3] === "Customer total")[7], 100);
  assert.equal(table.rows.find(row => row[3] === "REM")[7], 8);
  assert.equal(table.rows.find(row => row[4] === "UNRESOLVED")[7], 2);
  assert.equal(table.pdfSummary.unclassifiedTotal, 2);
  assert.ok(table.rows.every(row => row[0] === "C1"));
  assert.ok(table.rows.every(row => row.length === table.headers.length));
});

test("EEIC Detail retains individual charge lines, current customer IDs, and filtered export", () => {
  const table = buildFamiliarFinancialTable({ ...params, kind: "EEIC_DETAIL", customerId: "C1", customerName: "First Customer" });
  assert.equal(table.rows.filter(row => row[3] !== "EEIC subtotal" && row[3] !== "Customer total" && row[4] !== "Category summary").length, 5);
  assert.equal(table.rows.filter(row => row[3] !== "EEIC subtotal" && row[3] !== "Customer total" && row[4] !== "Category summary").reduce((sum, row) => sum + row.at(-1), 0), 100);
  assert.equal(table.rows.find(row => row[3] === "Customer total").at(-1), 100);
  assert.equal(table.rows.filter(row => row[3] === "EEIC subtotal").reduce((sum, row) => sum + row.at(-1), 0), 100);
  assert.equal(table.rows.filter(row => row[4] === "Category summary").reduce((sum, row) => sum + row.at(-1), 0), 100);
  assert.equal(table.rows.find(row => row[2] === "48040")[4], "SS");
  assert.equal(table.rows.find(row => row[2] === "48040")[5], "SS metered consumption");
  assert.equal(table.rows.find(row => row[2] === "48040")[6], "Utility (Usage, Rate, Charge)");
  assert.equal(table.rows.find(row => row[3] === "REM")[6], "O&M");
  assert.equal(table.rows.find(row => row[3] === "REM")[7], "REM");
  assert.ok(table.rows.every(row => row.length === table.headers.length));
  const csv = Buffer.from(exportCsv(table)).toString("utf8");
  assert.match(csv, /First Customer/);
  assert.doesNotMatch(csv, /Second Customer/);
  assert.match(csv, /UNRESOLVED/);
});

test("EEIC Detail identifies pumping from the stored allocation source without changing its charge", () => {
  const pumping = { ...entry("C1", "EL", "EL", "48020", 4), allocationSource: "SS_PUMPING" };
  const localReport = { ...report, rows: [pumping], customerTotals: { C1: 4 }, billedTotal: 4, outputTotal: 4, issues: [] };
  const table = buildFamiliarFinancialTable({ ...params, report: localReport, kind: "EEIC_DETAIL" });
  assert.equal(table.rows[0][5], "Electricity for sewage pumping");
  assert.equal(table.rows[0].at(-1), 4);
});

test("all three familiar tables remain downloadable as CSV, Excel, and PDF", () => {
  for (const kind of ["RCBL", "EEIC_SHORT", "EEIC_DETAIL"]) {
    const table = buildFamiliarFinancialTable({ ...params, kind, customerId: "C1", customerName: "First Customer" });
    const csv = Buffer.from(exportCsv(table)).toString("utf8");
    const xlsx = Buffer.from(exportXlsx(table));
    const pdf = Buffer.from(exportPdf(table));
    assert.match(csv, /First Customer/);
    assert.doesNotMatch(csv, /Second Customer/);
    assert.equal(xlsx.subarray(0, 2).toString("latin1"), "PK");
    assert.match(pdf.subarray(0, 8).toString("latin1"), /%PDF/);
    assert.ok(pdf.length > 500);
  }
});
