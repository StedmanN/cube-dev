// Pure, read-only export regression tests; no AWS, DynamoDB, or browser needed.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const ts = require("typescript");
const dir = path.dirname(fileURLToPath(import.meta.url));
const cache = new Map();
function runtime(name) {
  const file = path.resolve(dir, "../lib", name);
  if (cache.has(file)) return cache.get(file).exports;
  const mod = { exports: {} }; cache.set(file, mod);
  const js = ts.transpileModule(readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function("require", "module", "exports", js)(
    dependency => dependency.startsWith(".") ? runtime(`${path.basename(dependency).replace(/\.ts$/, "")}.ts`) : require(dependency),
    mod, mod.exports,
  );
  return mod.exports;
}
const { buildFinancialExportTable } = runtime("financial-report-export.ts");
const { exportCsv, exportXlsx, exportPdf } = runtime("report-file-export.ts");
const utf8 = bytes => Buffer.from(bytes).toString("utf8");
function pdfText(bytes) {
  const source = Buffer.from(bytes).toString("latin1");
  return [...source.matchAll(/\(((?:\\.|[^\\)])*)\) Tj/g)]
    .map(match => match[1]
      .replace(/\\([0-7]{3})/g, (_all, octal) => {
        const code = Number.parseInt(octal, 8);
        return code === 0x97 ? "—" : String.fromCharCode(code);
      })
      .replace(/\\([\\()])/g, "$1"))
    .join("\n");
}
function row(customerId, utility, component, amount, provisional = false) {
  return {
    customerId, customerName: customerId === "C1" ? "First Customer" : "Second Customer",
    customerType: "DOD", rateClass: "B", utility, utilityGroup: "WWYK",
    component, componentLabel: component === "UNCLASSIFIED" ? "Unclassified — Review Required" : "Other Utilities",
    eeic: provisional ? "61900" : "UNRESOLVED", objectClass: provisional ? "254.3101" : "UNRESOLVED",
    mappingStatus: provisional ? "PROVISIONAL" : component === "UNCLASSIFIED" ? "REVIEW" : "PENDING",
    classificationStatus: provisional ? "PROVISIONAL" : component === "UNCLASSIFIED" ? "REVIEW" : "IDENTIFIED",
    sourceCostRows: [], componentBreakdown: provisional ? [{component: "SRM_MATERIALS", amount, classificationStatus: "PROVISIONAL", mappingStatus: "PROVISIONAL", sourceCostRows: []}] : [],
    reconciliationId: `${customerId}-R-${component}`, facilityNumber: "100", allocationSource: "METERED",
    allocatedConsumption: 100, consumptionUnit: "kWh", appliedRate: 0.1,
    rateId: "JAN-FINAL", rateEffectiveDate: "2026-01-01", amount,
  };
}
const report = {
  rows: [
    row("C1", "EL", "OTHER", 100.25, true),
    row("C1", "PW", "UNCLASSIFIED", 30.05),
    row("C2", "EL", "EL", 200.75),
    row("C2", "SS", "UNCLASSIFIED", 6.25),
  ],
  customerTotals: { C1: 130.30, C2: 207.00 },
  billedTotal: 337.30, outputTotal: 337.30,
  ready: false, accountingVerified: false,
  issues: ["C1 / R-PW: blank annual cost", "C2 / R-SS: unresolved sewer source", "Provisional source classifications or EEIC/Object Class mappings are included; verify them before official use."],
};
const params = { report, period: 175, fiscalYear: "2026", month: "February", source: "LIVE REPORTING PREVIEW" };
for (const kind of ["RCBL", "EEIC_SHORT", "EEIC_DETAIL"]) {
  test(`${kind}: all-customer CSV, XLSX, PDF retain all amounts and counts`, () => {
    const table = buildFinancialExportTable({ ...params, kind });
    assert.equal(table.rows.length, 4);
    assert.equal(table.pdfSummary.customerTotal, 337.30);
    assert.equal(table.pdfSummary.reportTotal, 337.30);
    assert.equal(table.pdfSummary.reconciliationDifference, 0);
    assert.equal(table.pdfSummary.unclassifiedCount, 2);
    assert.equal(table.pdfSummary.unclassifiedTotal, 36.30);
    assert.equal(table.pdfSummary.provisionalCount, 1);
    assert.ok(!table.subtitle.includes("CUSTOMER C1"));
    const csv = utf8(exportCsv(table));
    const xlsx = utf8(exportXlsx(table));
    const pdf = pdfText(exportPdf(table));
    for (const rendered of [csv, xlsx, pdf]) {
      assert.match(rendered, /C1/);
      assert.match(rendered, /C2/);
    }
    assert.match(csv, /337\.30/);
    assert.match(xlsx, /<v>200\.75<\/v>/);
    assert.match(pdf, /\$337\.30/);
    assert.match(pdf, /2 unresolved billed charge\(s\); aggregate \$36\.30/);
    assert.doesNotMatch(pdf, /2 produced-water charge/);
  });

  test(`${kind}: selected customer C1 is consistently scoped in CSV, XLSX, PDF`, () => {
    const table = buildFinancialExportTable({ ...params, kind, customerId: "C1", customerName: "First Customer" });
    assert.equal(table.rows.length, 2);
    assert.equal(table.pdfSummary.customerTotal, 130.30);
    assert.equal(table.pdfSummary.reportTotal, 130.30);
    assert.equal(table.pdfSummary.reconciliationDifference, 0);
    assert.equal(table.pdfSummary.unclassifiedCount, 1);
    assert.equal(table.pdfSummary.unclassifiedTotal, 30.05);
    assert.deepEqual(table.pdfSummary.unclassifiedUtilities, ["PW"]);
    assert.equal(table.pdfSummary.provisionalCount, 1);
    assert.match(table.subtitle, /CUSTOMER C1/);
    assert.ok(table.notes.some(note => /Selected customer: C1 - First Customer/.test(note)));
    assert.ok(table.notes.some(note => /Unclassified — Review Required: 1 charge\(s\); aggregate \$30\.05/.test(note)));
    assert.ok(table.notes.some(note => /Provisional classifications: 1 report row/.test(note)));
    assert.ok(table.notes.some(note => /REVIEW: C1/.test(note)));
    assert.ok(table.notes.every(note => !note.includes("C2")));
    for (const rendered of [utf8(exportCsv(table)), utf8(exportXlsx(table)), pdfText(exportPdf(table))]) {
      assert.match(rendered, /C1/);
      assert.doesNotMatch(rendered, /C2/);
      assert.doesNotMatch(rendered, /\$337\.30/);
      assert.doesNotMatch(rendered, /\$207\.00/);
      assert.match(rendered, /130\.30/);
    }
    assert.match(pdfText(exportPdf(table)), /1 produced-water charge\(s\); aggregate \$30\.05/);
  });

  test(`${kind}: selected customer C2 uses separate unresolved SS scope`, () => {
    const table = buildFinancialExportTable({ ...params, kind, customerId: "C2", customerName: "Second Customer" });
    assert.equal(table.rows.length, 2);
    assert.equal(table.pdfSummary.customerTotal, 207);
    assert.equal(table.pdfSummary.reportTotal, 207);
    assert.equal(table.pdfSummary.unclassifiedCount, 1);
    assert.equal(table.pdfSummary.unclassifiedTotal, 6.25);
    assert.equal(table.pdfSummary.provisionalCount, 0);
    assert.ok(table.notes.every(note => !note.includes("C1")));
    const pdf = pdfText(exportPdf(table));
    assert.match(pdf, /\$207\.00/);
    assert.match(pdf, /1 unresolved billed charge\(s\); aggregate \$6\.25/);
    assert.doesNotMatch(pdf, /produced-water charge\(s\)/);
    assert.doesNotMatch(pdf, /\$337\.30/);
    assert.doesNotMatch(utf8(exportCsv(table)), /C1/);
  });
}

test("mixed unresolved PW and SS rows never label entire PDF aggregate produced-water", () => {
  const table = buildFinancialExportTable({ ...params, kind: "RCBL" });
  const pdf = pdfText(exportPdf(table));
  assert.match(pdf, /2 unresolved billed charge\(s\); aggregate \$36\.30/);
  assert.doesNotMatch(pdf, /2 produced-water charge/);
});

test("selected customer reconciliation compares source charge totals independently of split rows", () => {
  const discrepancy = { ...report, rows: report.rows.map(r => r.customerId === "C1" && r.component === "OTHER" ? { ...r, amount: 99.25 } : r) };
  const table = buildFinancialExportTable({ ...params, report: discrepancy, kind: "EEIC_DETAIL", customerId: "C1" });
  assert.equal(table.pdfSummary.customerTotal, 130.30);
  assert.equal(table.pdfSummary.reportTotal, 129.30);
  assert.equal(table.pdfSummary.reconciliationDifference, -1);
  assert.ok(table.notes.some(note => note.includes("does not equal original customer charges")));
});

test("real report builder and customer-scoped export retain original source totals", () => {
  const { buildFinancialReport } = runtime("financial-reporting.ts");
  const billed = buildFinancialReport({customers: [
    {customerId: "FIRST", customerName: "First", rateClass: "D", customerType: "DOD", lines: [{
      ready: true, amount: 20.25, reimbursementDisposition: "CUSTOMER_REIMBURSABLE", utilityType: "PW",
      reportingSplit: {status: "NOT_APPLICABLE", rateClass: "D", utility: "PW", rateId: "JAN-FINAL",
        effectiveDate: "2026-01-01", originalCharge: 20.25, sourceBasis: null,
        purchasedUtilityAmount: 20.25, components: {}, sourceRows: [], warnings: [], issues: []},
    }]},
    {customerId: "SECOND", customerName: "Second", rateClass: "B", customerType: "DOD", lines: [{
      ready: true, amount: 4.25, reimbursementDisposition: "CUSTOMER_REIMBURSABLE", utilityType: "SS",
    }]},
  ]}, "RCBL");
  assert.equal(billed.billedTotal, 24.50);
  assert.equal(billed.outputTotal, 24.50);
  const first = buildFinancialExportTable({...params, report: billed, kind: "RCBL", customerId: "FIRST"});
  const second = buildFinancialExportTable({...params, report: billed, kind: "RCBL", customerId: "SECOND"});
  assert.equal(first.pdfSummary.customerTotal, 20.25);
  assert.equal(first.pdfSummary.reportTotal, 20.25);
  assert.equal(first.pdfSummary.unclassifiedCount, 0);
  assert.equal(second.pdfSummary.customerTotal, 4.25);
  assert.equal(second.pdfSummary.reportTotal, 4.25);
  assert.equal(second.pdfSummary.unclassifiedCount, 1);
  assert.match(pdfText(exportPdf(second)), /\$4\.25/);
  assert.doesNotMatch(pdfText(exportPdf(second)), /\$24\.50/);
});
