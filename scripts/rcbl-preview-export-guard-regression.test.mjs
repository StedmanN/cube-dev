import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ts = require('typescript');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ui = readFileSync(path.resolve(root, 'app/billing/billing-client.tsx'), 'utf8');
const css = readFileSync(path.resolve(root, 'app/billing/billing.css'), 'utf8');
const route = readFileSync(path.resolve(root, 'app/api/billing/rcbl-short/export/route.ts'), 'utf8');

test('Billing page transpiles without syntax errors', () => {
  const output = ts.transpileModule(ui, { fileName: 'billing-client.tsx', reportDiagnostics: true, compilerOptions: { jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }});
  const errors = output.diagnostics?.filter(d => d.category === ts.DiagnosticCategory.Error) || [];
  assert.equal(errors.length, 0, errors.map(e=>ts.flattenDiagnosticMessageText(e.messageText,' ')).join('; '));
});

test('Visible bill is explicitly named Current Preview, Saved Bill, or Historical Saved Bill', () => {
  assert.match(ui, /preview\.persisted \? \(selectedHistoryVersion \? "HISTORICAL SAVED BILL" : "SAVED BILL"\) : "CURRENT PREVIEW"/);
  assert.match(ui, /A separate saved bill exists/);
  assert.match(ui, /View Saved Bill/);
});

test('All saved-export controls require viewing the current saved bill', () => {
  assert.match(ui, /const canExportSavedBill =\s*saved === true &&\s*preview\?\.persisted === true &&\s*!selectedHistoryVersion/);
  for (const fmt of ['summary-csv','detail-csv','all-pdfs','customer-pdf','customer-xlsx']) {
    assert.match(ui, new RegExp('disabled=\\{!canExportSavedBill\\}[\\s\\S]{0,120}downloadSavedCustomerBill\\("'+fmt+'"'));
  }
  assert.match(ui, /disabled=\{!canExportSavedBill\} onClick=\{\(\) => void downloadSavedCustomerBill\("detail-csv", customer.customerId\)\}/);
  assert.doesNotMatch(ui, /window\.location\.href\s*=\s*`\/api\/billing\/rcbl-short\/export/);
});

test('CSS visibly greys out disabled export controls and preview explains the rule', () => {
  assert.match(css, /\.history-open-button:disabled/);
  assert.match(css, /cursor: not-allowed/);
  assert.match(ui, /Save the bill before exporting PDF, Excel, or CSV/);
});

test('All exports use fetch and preserve HTTP errors, then download a saved blob', () => {
  assert.match(ui, /async function downloadSavedCustomerBill\(/);
  assert.match(ui, /const response = await fetch\(`\/api\/billing\/rcbl-short\/export/);
  assert.match(ui, /const blob = await response\.blob\(\)/);
  assert.match(ui, /setError\(err instanceof Error \? err\.message/);
  assert.match(route, /if \(!allBills\.length\).*No saved bills/s);
  assert.match(route, /const saved = await savedRows\(period\)/);
});
