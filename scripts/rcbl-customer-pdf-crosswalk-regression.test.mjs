import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const loaded = new Map();
function load(name) {
  const file = path.resolve(root,"lib",name);
  if (loaded.has(file)) return loaded.get(file).exports;
  const output = {exports:{}}; loaded.set(file,output);
  const compiled = ts.transpileModule(readFileSync(file,"utf8"), {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  new Function("require","module","exports",compiled)((dependency)=>dependency.startsWith(".") ? load(`${path.basename(dependency).replace(/\.ts$/,'')}.ts`) : require(dependency),output,output.exports);
  return output.exports;
}
const { buildCustomerBillPdfLines, buildCustomerBillExcelTable } = load("rcbl-customer-pdf.ts");
const { buildSimpleCustomerPdf } = load("customer-bill-pdf-engine.ts");
const { exportXlsx } = load("report-file-export.ts");
test("saved-only RCBL customer PDF buttons use a server-side saved snapshot",()=>{
  const ui = readFileSync(path.join(root,"app/billing/billing-client.tsx"),"utf8");
  const api = readFileSync(path.join(root,"app/api/billing/rcbl-short/export/route.ts"),"utf8");
  assert.match(ui,/downloadSavedCustomerBill\("all-pdfs"\)/);
  assert.match(ui,/downloadSavedCustomerBill\("customer-pdf", customer.customerId\)/);
  assert.match(ui,/disabled=\{!canExportSavedBill\}/);
  assert.match(api,/savedCustomerExportData\(saved, period/);
  assert.match(api,/buildCustomerBillPdfLines\(snapshot.period, customer\)/);
});
const { CANDIDATE_CROSSWALK, resolveAccountingCrosswalkRecord, validateAccountingCrosswalk, resolveAccountingCrosswalkFromScannedRecords, ACCOUNTING_CROSSWALK_PK, ACCOUNTING_CROSSWALK_RECORD_TYPE } = load("reporting-crosswalk.ts");
const { buildFinancialReport } = load("financial-reporting.ts");
const preview = {billingPeriodId:175,billingMonth:"February",fiscalYear:"2026"};
const sourceLine = ({amount=100, split, utility="Electricity", group="WWYK", disposition="CUSTOMER_REIMBURSABLE", consumption=1000}={}) => ({
  utilitySystem:utility,utilityType:utility,utilityGroup:group,consumptionUM:"kWh",allocatedConsumption:consumption,amount,
  reportingSplit:split,reimbursementDisposition:disposition,ready:true,reconciliationId:Math.random().toString(16),
});
const readySplit = (gross=100,commodity=80,parts={REM:10,CUBE:5,SRM_LABOR:5}) => ({
  status:"READY",utility:"EL",originalCharge:gross,purchasedUtilityAmount:commodity,components:parts,sourceRows:[],issues:[],warnings:[],
  rateId:"test",effectiveDate:"2026-01-01",rateClass:"D",sourceBasis:10000,
});
const customer = (lines,totalAmount) => ({customerId:"C1",customerName:"Customer Test",customerType:"dod",reportType:"D",rateClass:"D",rcblComment:"DLA",lines,totalAmount});
const rows = out => out.slice(out.indexOf("BILLING")+1,-1).map(s=>s.split("|"));

test("actual customer PDF: utility consumption and one additive Other Utilities subtotal are shown",()=>{
  const out=buildCustomerBillPdfLines(preview,customer([sourceLine({split:readySplit()})],100));
  assert.ok(out.includes("TOTAL BILL: $100.00"));
  assert.ok(out.some(s=>s.startsWith("Electricity|1,000|kWh|0.08000|$80.00")));
  assert.ok(out.some(s=>s==="Other Utilities|-|-|-|$20.00"));
  assert.ok(!out.some(s=>/^(REM|CUBE|SRM Labor|SRM Materials) \(PROVISIONAL\)\|/.test(s)));
  assert.ok(out.some(s=>s.includes("Other Utility Costs reflect any authorized delivery, infrastructure, and production fees")));
  assert.ok(!out.some(s=>s.includes("consumption is not adjusted for Other Utilities")));
  assert.ok(!out.some(s=>s.includes("see the EEIC Short report for the component breakdown")));
});
test("actual customer PDF omits the Other Utilities line and statement when the charge is zero",()=>{
  const split = readySplit(100,100,{});
  const out = buildCustomerBillPdfLines(preview,customer([sourceLine({split})],100));
  assert.equal(out.some(line=>line.startsWith("Other Utilities|")),false);
  assert.equal(out.some(line=>line.includes("Other Utility Costs reflect any authorized delivery")),false);
});
test("saved customer PDF wraps long Customer Agreement/Document values",()=>{
  const agreement="N0969725MP00154 (Water) / N0969725MP00151 (Elec) / N0969725MP00155 (NG) / N0969725MP00152 (Sewer)";
  const bytes=buildSimpleCustomerPdf([[`Customer Agreement/Document: ${agreement}`,"BILLING","Electricity|100|KWH|0.06|$6.00","TOTAL BILL: $6.00"]]);
  const pdf=Buffer.from(bytes).toString("latin1");
  assert.ok(pdf.includes("N0969725MP00154 \\(Water\\) / N0969725MP00151 \\(Elec\\) / N0969725MP00155 \\(NG\\)"));
  assert.ok(pdf.includes("N0969725MP00152 \\(Sewer\\)"));
  assert.ok(!pdf.includes(`(${agreement}) Tj`));
  assert.ok(pdf.includes("190 688 Td"));
  assert.ok(pdf.includes("190 676 Td"));
});
test("extremely long agreement text continues safely and keeps the billing total on a page",()=>{
  const agreement=`AGREEMENT-START-${"0123456789".repeat(1100)}-AGREEMENT-END`;
  const bytes=buildSimpleCustomerPdf([[
    "Customer: Layout Test",
    "Customer ID: C-LAYOUT",
    "Billing Period: 182",
    `Customer Agreement/Document: ${agreement}`,
    "BILLING",
    "Electricity|100|KWH|0.06|$6.00",
    "TOTAL BILL: $6.00",
  ]]);
  const pdf=Buffer.from(bytes).toString("latin1");
  const pageCount=Number(pdf.match(/\/Count (\d+)/)?.[1] ?? 0);
  assert.ok(pageCount >= 2,`Expected continuation pages, got ${pageCount}`);
  assert.ok(pdf.includes("AGREEMENT-START-"));
  assert.ok(pdf.includes("-AGREEMENT-END"));
  assert.ok(pdf.includes("Customer Agreement/Document \\(continued\\):"));
  const totalY=Number(pdf.match(/510 (\d+) Td[\s\S]*?\(\$6\.00\) Tj/)?.[1] ?? 0);
  assert.ok(totalY >= 40,`Billing total is below the page content area: y=${totalY}`);
});
test("actual customer PDF: original A/E no-component amount is never split",()=>{
  for(const cls of ["A","E"]){
    const line=sourceLine({split:readySplit(100,100,{})});line.reportingSplit.status="NOT_APPLICABLE";
    const out=buildCustomerBillPdfLines(preview,{...customer([line],100),rateClass:cls});
    assert.equal(rows(out).length,1);assert.ok(rows(out)[0][4]==="$100.00");
    assert.ok(!out.some(s=>s.startsWith("Other Utilities|")));
  }
});
test("actual customer PDF: CE-absorbed line is excluded and reimbursable due preserved",()=>{
  const out=buildCustomerBillPdfLines(preview,customer([sourceLine({split:readySplit()}),sourceLine({amount:500,disposition:"CE_ABSORBED",split:readySplit(500,500,{})})],100));
  assert.ok(out.includes("TOTAL BILL: $100.00"));assert.ok(!out.some(s=>s.includes("$500.00")));
});
test("actual customer PDF: unclassified PW remains distinct from supported split and is never Other",()=>{
  const classified=sourceLine({split:readySplit(100,80,{REM:20})});
  const unresolved=sourceLine({amount:74.24,split:{...readySplit(74.24,0,{}),status:"REVIEW",purchasedUtilityAmount:null},utility:"PW",group:"WWYK",consumption:25});
  const out=buildCustomerBillPdfLines(preview,customer([classified,unresolved],174.24));
  assert.ok(out.some(s=>s.includes("Unclassified - Review Required: $74.24")));
  assert.ok(out.some(s=>s.startsWith("Produced Water (REVIEW)|25|kWh|2.96960|$74.24")));
  assert.ok(out.some(s=>s==="Other Utilities|-|-|-|$20.00"));
  assert.ok(!out.some(s=>s.startsWith("REM (PROVISIONAL)|")));
  assert.equal(out.at(-1),"TOTAL BILL: $174.24");
});
test("actual customer PDF: invalid split never silently changes billed amount",()=>{
  const out=buildCustomerBillPdfLines(preview,customer([sourceLine({split:readySplit(100,90,{REM:20})})],100));
  assert.ok(out.some(s=>s.includes("Unclassified - Review Required: $100.00")));
  assert.ok(out.some(s=>s.includes("(REVIEW)|")));
  assert.ok(!out.some(s=>s.startsWith("Other Utilities|")));
});
test("actual customer PDF: mixed groups and negative refunds conserve original pennies",()=>{
  const out=buildCustomerBillPdfLines(preview,customer([
    sourceLine({split:readySplit(100.01,80.00,{REM:20.01}) ,amount:100.01}),
    sourceLine({split:readySplit(-5,-4,{REM:-1}),amount:-5,group:"TAC",consumption:-10}),
  ],95.01));
  assert.ok(out.some(s=>s==="Other Utilities|-|-|-|$19.01"));
  assert.equal(out.at(-1),"TOTAL BILL: $95.01");
});

test("actual customer PDF: B-class shows one combined Other Utilities subtotal",()=>{
  const split = readySplit(200,150,{REM:10,CUBE:20,SRM_LABOR:15,SRM_MATERIALS:5});
  const out=buildCustomerBillPdfLines(preview,customer([sourceLine({amount:200,split})],200));
  assert.ok(!out.some(line=>/^(REM|CUBE|SRM Labor|SRM Materials) \(PROVISIONAL\)\|/.test(line)));
  assert.ok(out.includes("TOTAL BILL: $200.00"));
  assert.ok(out.some(line=>line==="Other Utilities|-|-|-|$50.00"));
});
test("actual customer PDF: zero and negative component amounts preserve cents and rate class exempt",()=>{
  const line=sourceLine({amount:-20,split:readySplit(-20,-14,{REM:-6,CUBE:0})});
  const out=buildCustomerBillPdfLines(preview,customer([line],-20));
  assert.ok(out.some(s=>s==="Other Utilities|-|-|-|-$6.00"));
  assert.ok(!out.some(s=>s.startsWith("REM (PROVISIONAL)|")));
  assert.equal(out.at(-1),"TOTAL BILL: -$20.00");
});
test("actual customer PDF: unknown component fails closed instead of dropping billed dollars",()=>{
  const split=readySplit(100,80,{REM:10,FAKE_UNLISTED_CODE:10});
  const out=buildCustomerBillPdfLines(preview,customer([sourceLine({split})],100));
  assert.ok(out.some(line=>line.includes("Unclassified - Review Required: $100.00")));
  assert.ok(!out.some(line=>line.startsWith("REM (PROVISIONAL)|")));
});
test("customer Excel: combined Other Utilities row reconciles to the original total",()=>{
  const cust=customer([sourceLine({split:readySplit()})],100);
  const table=buildCustomerBillExcelTable(preview,cust);
  assert.equal(table.rows.filter(row=>/^(REM|CUBE|SRM Labor|SRM Materials) \(PROVISIONAL\)$/.test(String(row[0]))).length,0);
  assert.equal(table.rows.find(row=>row[0]==="Other Utilities")?.[5],20);
  assert.equal(table.rows.find(row=>row[0]==="Other Utilities")?.[4],"");
  assert.equal(table.rows.find(row=>row[0]==="TOTAL DUE (original bill)")?.[4],100);
  assert.equal(table.rows.reduce((sum,row)=>sum+(typeof row[5]==="number"?Math.round(row[5]*100):0),0),10000);
  assert.ok(table.notes.some(note=>note.includes("Other Utility Costs reflect any authorized delivery, infrastructure, and production fees")));
  assert.ok(table.notes.some(note=>note.includes("detailed component amounts are available in the EEIC Short report")));
  const xlsx=exportXlsx(table);
  assert.equal(Buffer.from(xlsx).subarray(0,2).toString("ascii"),"PK");
  assert.match(Buffer.from(xlsx).toString("utf8"),/Other Utilities/);
});
test("customer Excel: review-only rows are retained, never reclassified as utility components",()=>{
  const review = sourceLine({amount:74.24,utility:"PW",split:{...readySplit(74.24,0,{}),status:"REVIEW",purchasedUtilityAmount:null}});
  const table=buildCustomerBillExcelTable(preview,customer([review],74.24));
  assert.ok(table.rows.some(row=>String(row[0]).includes("(REVIEW)") && row[5]===74.24));
  assert.ok(table.notes.some(note=>note.includes("Unclassified - Review Required: $74.24")));
  assert.ok(!table.rows.some(row=>String(row[0]).includes("subtotal")));
});
test("TFCU-sized February fixture preserves $3,474.96 with $258.17 component subtotal and $74.24 review",()=>{
  // Known customer-level values; component distribution here is synthetic.
  const parts={REM:60.86,CUBE:138.18,SRM_LABOR:59.13};
  const electricity=sourceLine({amount:2749.64,split:readySplit(2749.64,2491.47,parts)});
  const sewer=sourceLine({amount:50.84,utility:"SS",split:{...readySplit(50.84,50.84,{}),utility:"SS",status:"NOT_APPLICABLE"}});
  const water=sourceLine({amount:74.24,utility:"PW",split:{...readySplit(74.24,0,{}),utility:"PW",status:"REVIEW",purchasedUtilityAmount:null}});
  const gas=sourceLine({amount:600.24,utility:"NG",split:{...readySplit(600.24,600.24,{}),utility:"NG",status:"NOT_APPLICABLE"}});
  const c=customer([electricity,sewer,water,gas],3474.96);
  const out=buildCustomerBillPdfLines(preview,c);
  assert.equal(out.at(-1),"TOTAL BILL: $3,474.96");
  assert.ok(out.some(row=>row.startsWith("Electricity|1,000|kWh|2.49147|$2,491.47")));
  assert.ok(out.some(row=>row==="Other Utilities|-|-|-|$258.17"));
  assert.ok(out.some(line=>line.includes("Unclassified - Review Required: $74.24")));
  const sheet=buildCustomerBillExcelTable(preview,c);
  assert.equal(sheet.rows.reduce((sum,row)=>sum+(typeof row[5]==="number"?Math.round(row[5]*100):0),0),347496);
  assert.equal(sheet.rows.find(row=>row[0]==="Other Utilities")?.[5],258.17);
  assert.equal(sheet.rows.find(row=>row[0]==="TOTAL DUE (original bill)")?.[4],3474.96);
});
test("PDF rate/share column is explicitly labeled for utility rates versus invoice component percentages",()=>{
  const pdf=readFileSync(path.join(root,"lib/customer-bill-pdf-engine.ts"),"utf8");
  assert.match(pdf,/title: "Rate \/ Share"/);
  const out=buildCustomerBillPdfLines(preview,customer([sourceLine({split:readySplit()})],100));
  assert.ok(out.some(row=>row==="Other Utilities|-|-|-|$20.00"));
  assert.ok(!out.some(row=>row.startsWith("REM (PROVISIONAL)|")));
  assert.ok(out.some(row=>row.startsWith("Electricity|1,000|kWh|0.08000|$80.00")));
});
test("customer PDF and Excel exports use only the saved server-side snapshot",()=>{
  const ui=readFileSync(path.join(root,"app/billing/billing-client.tsx"),"utf8");
  const api=readFileSync(path.join(root,"app/api/billing/rcbl-short/export/route.ts"),"utf8");
  assert.match(ui,/downloadSavedCustomerBill\("customer-xlsx", customer.customerId\)/);
  assert.match(api,/exportXlsx\(buildCustomerBillExcelTable\(snapshot.period, snapshot.customers\[0\]\)\)/);
  assert.doesNotMatch(ui,/buildCustomerBillExcelTable\(preview, customer\)/);
});
test("RCBL page shows only the approved Other Utilities statement when its line exists",()=>{
  const ui=readFileSync(path.join(root,"app/billing/billing-client.tsx"),"utf8");
  assert.match(ui,/hasOtherUtilitiesLine = presentationLines\.some/);
  assert.match(ui,/hasOtherUtilitiesLine \? \(/);
  assert.ok(ui.includes("Other Utility Costs reflect any authorized delivery, infrastructure, and production fees included as part of approved 3556 rates."));
  assert.doesNotMatch(ui,/Utility consumption is not adjusted for Other Utilities/);
  assert.doesNotMatch(ui,/REM, CUBE, and SRM totals are combined here; see EEIC Short/);
});
test("crosswalk defaults have exactly eight working (unapproved) entries",()=>{
  const initial=resolveAccountingCrosswalkRecord(null);
  assert.equal(initial.source,"DEFAULT_CANDIDATES");
  assert.equal(Object.keys(initial.codes).length,8);
  assert.equal(initial.codes.SS.eeic,"48040");
  assert.equal(initial.codes.CUBE.eeic,"53317");
  assert.ok(Object.values(initial.codes).every(code=>code.status!=="APPROVED"));
});
test("crosswalk editor strict schema: no missing keys, invalid codes, status approved, malformed classes",()=>{
  const fixture=structuredClone(CANDIDATE_CROSSWALK);
  delete fixture.SS;assert.throws(()=>validateAccountingCrosswalk(fixture));
  fixture.SS=structuredClone(CANDIDATE_CROSSWALK.SS);
  fixture.SS.status="APPROVED";assert.throws(()=>validateAccountingCrosswalk(fixture));
  fixture.SS.status="PROVISIONAL";fixture.SS.eeic="480 30";assert.throws(()=>validateAccountingCrosswalk(fixture));
  fixture.SS.eeic=null;fixture.REM.objectClass="notaclass";assert.throws(()=>validateAccountingCrosswalk(fixture));
});
test("reviewed crosswalk version resolves separately from FINAL 3556 source entries",()=>{
  const codes=structuredClone(CANDIDATE_CROSSWALK);codes.SS.eeic="48040";codes.SS.status="DISPUTED";
  const item={PK:ACCOUNTING_CROSSWALK_PK,SK:"CURRENT",RecordType:ACCOUNTING_CROSSWALK_RECORD_TYPE,Codes:codes,UpdatedAt:"2026-11-07T00:00:00.000Z",UpdatedBy:"reviewer"};
  const resolved=resolveAccountingCrosswalkFromScannedRecords([{PK:"3556#test",SK:"FINAL",status:"FINAL"},item]);
  assert.equal(resolved.codes.SS.eeic,"48040");assert.equal(resolved.source,"CONFIGURED");
  assert.equal(CANDIDATE_CROSSWALK.SS.eeic,"48040");
});
test("malformed saved crosswalk fails closed instead of reverting silently",()=>{
  assert.throws(()=>resolveAccountingCrosswalkRecord({PK:ACCOUNTING_CROSSWALK_PK,SK:"CURRENT",RecordType:ACCOUNTING_CROSSWALK_RECORD_TYPE,Codes:{SS:{}}}));
});
test("preview uses configured EEIC, saved bill uses issued historical snapshot",()=>{
  const base=sourceLine({amount:100,split:readySplit()});
  const line={...base,utilityType:"EL",ready:true,rateId:"test",reportingCodes:{...CANDIDATE_CROSSWALK,REM:{eeic:"99999",objectClass:"233.5541",status:"DISPUTED"}}};
  const input={customers:[{...customer([line],100),customerType:"dod"}]};
  const current=buildFinancialReport({...input,persisted:false},"EEIC_DETAIL");
  const historic=buildFinancialReport({...input,persisted:true},"EEIC_DETAIL");
  assert.equal(current.rows.find(r=>r.component==="REM").eeic,"99999");
  assert.equal(historic.rows.find(r=>r.component==="REM").eeic,"99999");
  const noSnapshot=buildFinancialReport({...input,persisted:true,customers:[{...customer([{...line,reportingCodes:undefined}],100)}]},"EEIC_DETAIL");
  assert.ok(noSnapshot.rows.some(r=>r.component==="UNCLASSIFIED"));
});
