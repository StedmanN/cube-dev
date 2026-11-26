// No GovCloud, DynamoDB or production writes. Uses TypeScript's dev dependency
// to execute the same pure reporting source without creating build artifacts.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const ts = require("typescript");
const baseDir=path.dirname(fileURLToPath(import.meta.url));
const cache=new Map();
function runtime(name) {
  const file=path.resolve(baseDir,"../lib",name);
  if(cache.has(file))return cache.get(file).exports;
  const out={exports:{}};cache.set(file,out);
  const js=ts.transpileModule(readFileSync(file,"utf8"),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  const factory=new Function("require","module","exports",js);
  factory((dependency)=>dependency.startsWith(".")?runtime(`${path.basename(dependency).replace(/\.ts$/," ").trim()}.ts`):require(dependency),out,out.exports);
  return out.exports;
}
const {compute3556ReportingSplit, read3556Rows, PROVISIONAL_ACCOUNT_COMPONENTS}=runtime("3556-reporting.ts");
const {buildFinancialReport, CANDIDATE_CROSSWALK}=runtime("financial-reporting.ts");
const {exportCsv,exportXlsx,exportPdf}=runtime("report-file-export.ts");
const source=()=>({id:"FINAL-EL-EXAMPLE",status:"FINAL",effectiveDate:"2026-08-01",utilitySystem:"ELECTRICITY",worksheet:{
  purchased:[{id:"purchase",accountProjectNumber:"OGE",totalAnnualCost:"18536268"}],
  purchasedServices:[
    {id:"rem",accountProjectNumber:"Resource Eff Mgr",totalAnnualCost:"401205"},
    {id:"cube",accountProjectNumber:"Utility Mgt / Asset M",totalAnnualCost:"1489451"},
    {id:"labor",accountProjectNumber:"BMC-PwrPro",totalAnnualCost:"389783"},
  ],
  produced:[],
  distribution:[
    {id:"mat1",accountProjectNumber:"811144",cost:"99169"},
    {id:"mat2",accountProjectNumber:"811149",cost:"88745"},
    {id:"mat3",accountProjectNumber:"812223",cost:"192863"},
    {id:"mat4",accountProjectNumber:"812225",cost:"94"},
    {id:"mat5",accountProjectNumber:"812226",cost:"234"},
  ],
}});
const split=(rate=source(),rateKey="dod",more={})=>compute3556ReportingSplit({rate,rateKey,utility:"EL",originalCharge:100,...more});
const mapping=()=>Object.fromEntries(source().worksheet.distribution.map(r=>[`distribution:${r.id}`,"SRM_MATERIALS"]));
const total=out=>Math.round(((out.purchasedUtilityAmount??0)+Object.values(out.components).reduce((a,b)=>a+b,0))*100);

test("D-class percentage uses the cost rows from selected FINAL, without hardcoded date or cost",()=>{
  const out=split();assert.equal(out.status,"READY");assert.equal(out.sourceBasis,20816707);
  assert.deepEqual([out.components.REM,out.components.CUBE,out.components.SRM_LABOR],[1.93,7.16,1.87]);
  assert.equal(total(out),10000);
});
test("B-class uses only configured provisional account candidates and leaves other O&M unidentified",()=>{
  const rate=source();rate.worksheet.distribution.push({id:"unrelated",accountProjectNumber:"OTHER-DIST-EXPENSE",cost:"90000"});
  const out=split(rate,"nonFederal");assert.equal(out.status,"PROVISIONAL");assert.ok(out.warnings[0].includes("811144"));
  assert.equal(out.sourceRows.filter(row=>row.classificationStatus==="PROVISIONAL").length,5);
  assert.equal(out.sourceRows.some(row=>row.account==="OTHER-DIST-EXPENSE"),false);
});
test("B-class provisional component amounts are calculated from selected FINAL rows and conserve the charge",()=>{
  const out=split(source(),"nonFederal",{classifications:mapping()});
  assert.equal(out.status,"PROVISIONAL");assert.equal(out.sourceBasis,21197812);assert.equal(out.components.SRM_MATERIALS,1.8);assert.equal(total(out),10000);
  const changed=source();changed.worksheet.distribution[0].cost="199169";
  const recalculated=split(changed,"nonFederal");assert.notEqual(recalculated.components.SRM_MATERIALS,out.components.SRM_MATERIALS);
});
test("provisional electricity candidates are not required or allocated to D, C, A or E classes",()=>{
  for(const key of ["dod","nonDodFederal","mfh","categoryCMwr"]){
    const out=split(source(),key);assert.notEqual(out.status,"PROVISIONAL");
    assert.equal(out.components.SRM_MATERIALS,undefined);
  }
});
test("an explicitly unclassified electricity candidate keeps its charge in review",()=>{
  const candidate=source().worksheet.distribution[0];
  const out=split(source(),"nonFederal",{classifications:{[`distribution:${candidate.id}`]:"UNCLASSIFIED"}});
  assert.equal(out.status,"REVIEW");assert.equal(out.purchasedUtilityAmount,null);
  assert.ok(out.issues.some(issue=>issue.includes("left unclassified")));
});
test("provisional account rules can be configured without storing annual costs",()=>{
  const rules={...PROVISIONAL_ACCOUNT_COMPONENTS,EL:{...PROVISIONAL_ACCOUNT_COMPONENTS.EL,"811144":"CUBE"}};
  const parsed=read3556Rows(source(),{},rules);
  const selected=parsed.rows.find(row=>row.account==="811144");
  assert.equal(selected.component,"CUBE");assert.equal(selected.classificationStatus,"PROVISIONAL");
  assert.equal(selected.amount,99169);
});
test("New 3556 cost and date revisions recalculate shares dynamically",()=>{
  const future=source();future.id="ANOTHER-FINAL";future.effectiveDate="2028-06-03";
  future.worksheet.purchased[0].totalAnnualCost="10000000";
  const next=split(future);assert.equal(next.status,"READY");assert.notEqual(next.components.CUBE,split().components.CUBE);
});
test("Services moved to Distribution section remain reportable",()=>{
  const rate=source();const sections=rate.worksheet.purchasedServices;
  rate.worksheet.purchasedServices=[];
  sections.forEach(row=>rate.worksheet.distribution.push({...row,cost:row.totalAnnualCost}));
  assert.equal(split(rate).status,"READY");
});
test("Missing, invalid and duplicated source rows fail closed",()=>{
  const missing=source();missing.worksheet.purchasedServices.pop();assert.equal(split(missing).status,"REVIEW");
  const wrong=source();wrong.worksheet.purchasedServices[0].totalAnnualCost="banana";assert.equal(split(wrong).status,"REVIEW");
  const duplicate=source();duplicate.worksheet.purchasedServices.push({...duplicate.worksheet.purchasedServices[0],id:"repeat"});assert.equal(split(duplicate).status,"REVIEW");
});
test("Mapped classifications cannot point to missing or contradictory source rows",()=>{
  const map={"distribution:nonexistent":"SRM_MATERIALS"};assert.equal(split(source(),"nonFederal",{classifications:map}).status,"REVIEW");
  const conflicting={"purchasedServices:rem":"CUBE"};assert.equal(split(source(),"dod",{classifications:conflicting}).status,"REVIEW");
});
test("Invalid arbitrary costs cannot be tagged as purchased utility services",()=>{
  const out=split(source(),"nonFederal",{classifications:{"purchased:purchase":"SRM_MATERIALS"}});
  assert.equal(out.status,"REVIEW");
});
test("A and E classes retain full existing charge, without components",()=>{
  for(const key of ["mfh","categoryCMwr"]){const out=split(source(),key);assert.equal(out.status,"NOT_APPLICABLE");assert.equal(out.purchasedUtilityAmount,100);assert.deepEqual(out.components,{});}
});
test("B non-electric utility uses only explicit FSRM identifier",()=>{
  const rate={id:"NG-2027",status:"FINAL",effectiveDate:"2027-03-01",worksheet:{
    purchased:[{id:"p",accountProjectNumber:"Utility Supplier",totalAnnualCost:"1000"}],
    purchasedServices:[],produced:[],distribution:[{id:"m",accountProjectNumber:"FSRM-CLIN 0001",cost:"100"}],
  }};
  const out=compute3556ReportingSplit({rate,rateKey:"nonFederal",utility:"NG",originalCharge:44});
  assert.equal(out.status,"READY");assert.equal(out.components.SRM_MATERIALS,4);assert.equal(total(out),4400);
});
test("Negative credit bills preserve original sign and cents",()=>{
  const out=split(source(),"dod",{originalCharge:-107.53});assert.equal(out.status,"READY");assert.equal(total(out),-10753);
});
test("Customer report conserved to existing charge and excludes CE-absorbed allocations",()=>{
  const data={customers:[{customerId:"C1",customerName:"Customer",customerType:"Reimbursable",rateClass:"D",totalAmount:100,lines:[
    {ready:true,amount:100,reportingSplit:split(),reimbursementDisposition:"CUSTOMER_REIMBURSABLE",rateId:"FINAL-EL-EXAMPLE"},
    {ready:true,amount:0,reportingSplit:split(),reimbursementDisposition:"CE_ABSORBED"},
  ]}]};
  const report=buildFinancialReport(data,"EEIC_SHORT");assert.equal(report.ready,false);assert.equal(report.billedTotal,100);assert.equal(report.outputTotal,100);assert.equal(report.accountingVerified,false);
  assert.ok(report.rows.some(row=>row.mappingStatus==="PROVISIONAL"));
});
test("EEIC component codes are provisional and appear with exact mappings in all report views",()=>{
  assert.deepEqual(CANDIDATE_CROSSWALK.REM,{eeic:"480RE",objectClass:"233.5541",status:"PROVISIONAL"});
  assert.deepEqual(CANDIDATE_CROSSWALK.CUBE,{eeic:"53317",objectClass:"254.2209",status:"PROVISIONAL"});
  assert.deepEqual(CANDIDATE_CROSSWALK.SRM_LABOR,{eeic:"5703A",objectClass:"254.3101",status:"PROVISIONAL"});
  assert.deepEqual(CANDIDATE_CROSSWALK.SRM_MATERIALS,{eeic:"61900",objectClass:"254.3101",status:"PROVISIONAL"});
  const lineSplit=split(source(),"nonFederal");
  for(const kind of ["RCBL","EEIC_SHORT","EEIC_DETAIL"]){
    const report=buildFinancialReport({customers:[{customerId:"B",customerName:"Class B",customerType:"Commercial",rateClass:"B",lines:[{ready:true,amount:100,utilityType:"EL",reportingSplit:lineSplit}]}]},kind);
    assert.equal(report.billedTotal,100);assert.equal(report.outputTotal,100);assert.equal(report.ready,false);
    const rows=report.rows.filter(row=>row.component!=="UNCLASSIFIED");
    assert.ok(rows.some(row=>row.mappingStatus==="PROVISIONAL"));
    if(kind==="RCBL")assert.ok(report.rows.find(row=>row.component==="OTHER")?.componentBreakdown?.some(row=>row.component==="SRM_MATERIALS"));
  }
});
test("confirmed sewer EEIC candidate remains provisional until accounting review",()=>{
  const report=buildFinancialReport({customers:[{customerId:"SS1",customerName:"Sewer Customer",customerType:"Reimbursable",rateClass:"D",lines:[{ready:true,amount:25,utilityType:"SS",reportingSplit:{status:"NOT_APPLICABLE",rateClass:"D",utility:"SS",rateId:"FINAL-SS",effectiveDate:"2026-01-01",originalCharge:25,sourceBasis:null,purchasedUtilityAmount:25,components:{},sourceRows:[],warnings:[],issues:[]}}]}]},"EEIC_SHORT");
  assert.equal(report.billedTotal,25);assert.equal(report.outputTotal,25);assert.equal(report.ready,false);
  assert.ok(report.rows.some(row=>row.utility==="SS"&&row.eeic==="48040"&&row.objectClass==="233.2310"&&row.mappingStatus==="PROVISIONAL"));
});
test("blank produced-water annual cost remains fully unclassified, never treated as zero",()=>{
  const rate={id:"FINAL-WWYK-PW",status:"FINAL",effectiveDate:"2026-01-01",utilitySystem:"PRODUCED WATER",worksheet:{
    purchased:[{id:"purchase",accountProjectNumber:"Water Supplier",totalAnnualCost:"1000"}],purchasedServices:[],
    produced:[{id:"produced",accountProjectNumber:"Well Water Production",annualConsumption:"463731",totalAnnualCost:""}],
    distribution:[{id:"materials",accountProjectNumber:"FSRM-CLIN 0001",cost:"10"}],
  }};
  const result=compute3556ReportingSplit({rate,rateKey:"nonFederal",utility:"PW",originalCharge:389.5});
  assert.equal(result.status,"REVIEW");assert.equal(result.purchasedUtilityAmount,null);
  assert.ok(result.issues.some(issue=>issue.includes("produced[0]")));
  const report=buildFinancialReport({customers:[{customerId:"P",customerName:"PW Customer",customerType:"Commercial",rateClass:"B",lines:[{ready:true,amount:389.5,utilityType:"PW",reportingSplit:result}]}]},"EEIC_DETAIL");
  assert.equal(report.billedTotal,389.5);assert.equal(report.outputTotal,389.5);
  assert.equal(report.rows[0].component,"UNCLASSIFIED");assert.equal(report.rows[0].amount,389.5);
});
test("Historical bill missing issued reporting snapshot MUST fail review",()=>{
  const data={persisted:true,customers:[{customerId:"C1",customerName:"C",customerType:"Reimbursable",rateClass:"D",lines:[{ready:true,amount:100}]}]};
  const report=buildFinancialReport(data,"EEIC_DETAIL");assert.equal(report.ready,false);assert.ok(report.issues.some(x=>/no issued reporting breakdown|historical bill/i.test(x)));
});
test("R-C-B-L single Other Utilities line aggregates fees across source utilities",()=>{
  const data={customers:[{customerId:"C1",customerName:"C",customerType:"Reimbursable",rateClass:"D",lines:[{ready:true,amount:100,reportingSplit:split()}]}]};
  const report=buildFinancialReport(data,"RCBL");const other=report.rows.find(x=>x.component==="OTHER");assert.ok(other);
  assert.equal(other.mappingStatus,"PROVISIONAL");
  assert.deepEqual(other.componentBreakdown?.map(x=>x.component).sort(),["CUBE","REM","SRM_LABOR"]);
});
test("PDF, XLSX, CSV generators create review-labeled files and protect spreadsheet text",()=>{
  const t={title:"EEIC Report",subtitle:"FY2026 BP175",headers:["Customer","EEIC","Amount"],rows:[["=1+1","480RE",60.86]],notes:["PENDING EEIC verification"]};
  const x=exportXlsx(t),p=exportPdf(t),c=exportCsv(t);
  assert.equal(Buffer.from(x).toString("ascii",0,2),"PK");assert.equal(Buffer.from(p).toString("ascii",0,8),"%PDF-1.4");
  assert.match(Buffer.from(c).toString("utf8"),/"'=1\+1"/);
});

function extractSimplePdfText(bytes) {
  const source = Buffer.from(bytes).toString("latin1");
  return [...source.matchAll(/\(((?:\\.|[^\\)])*)\) Tj/g)]
    .map((match) => match[1]
      .replace(/\\([0-7]{3})/g, (_all, octal) => {
        const byte = Number.parseInt(octal, 8);
        return byte === 0x97 ? "—" : String.fromCharCode(byte);
      })
      .replace(/\\([\\()])/g, "$1"))
    .join("\n");
}

test("PDF reports print exact totals, unclassified aggregate, approval status, and full wrapped RCBL breakdowns", () => {
  const componentBreakdown = [
    "REM: $60.86 (IDENTIFIED; code PROVISIONAL)",
    "CUBE: $225.94 (IDENTIFIED; code PROVISIONAL)",
    "SRM_LABOR: $59.13 (IDENTIFIED; code PROVISIONAL)",
    "SRM_MATERIALS: $12.34 (PROVISIONAL; code PROVISIONAL)",
  ].join("; ");
  const table = {
    title: "RCBL — Other Utilities Breakdown",
    subtitle: "BP 175 FY2026 February — LIVE REPORTING PREVIEW",
    headers: ["Customer", "Component Breakdown", "Classification Status", "Amount"],
    rows: [
      ["CUST-000001", componentBreakdown, "PROVISIONAL", 358.27],
      ["CUST-000002", "Unclassified — Review Required", "REVIEW", 389.50],
    ],
    notes: [],
    pdfSummary: {
      customerTotal: 1876412.96,
      reportTotal: 1876412.96,
      reconciliationDifference: 0,
      unclassifiedCount: 5,
      unclassifiedTotal: 389.50,
      unclassifiedUtilities: ["Produced Water"],
      provisionalCount: 61,
    },
  };
  const bytes = exportPdf(table);
  const text = extractSimplePdfText(bytes).replace(/\s+/g, " ");
  assert.match(text, /CUSTOMER BILLING TOTAL/);
  assert.match(text, /REPORT TOTAL/);
  assert.match(text, /RECONCILIATION DIFFERENCE/);
  assert.match(text, /\$1,876,412\.96/);
  assert.match(text, /\$0\.00/);
  assert.match(text, /PROVISIONAL CLASSIFICATIONS ARE NOT APPROVED ACCOUNTING VALUES/);
  assert.match(text, /Unclassified — Review Required: 5 produced-water charge\(s\); aggregate \$389\.50\./);
  assert.match(text, /REM: \$60\.86/);
  assert.match(text, /CUBE: \$225\.94/);
  assert.match(text, /SRM_LABOR: \$59\.13/);
  assert.match(text, /SRM_MATERIALS: \$12\.34/);
  assert.match(text, /REVIEW/);
  assert.doesNotMatch(text, /\.\.\./);
});

test("PDF long cell text continues onto further pages without dropping the following report row", () => {
  const longValue = `${"SOURCEDETAIL ".repeat(3600)}CONTINUATION-END`;
  const bytes = exportPdf({
    title: "EEIC Detail",
    subtitle: "BP 175",
    headers: ["Customer", "Source 3556 Cost Rows", "Amount"],
    rows: [["CUST-LONG", longValue, 10], ["CUST-AFTER", "NEXT-ROW-PRESERVED", 20]],
    notes: [],
    pdfSummary: {
      customerTotal: 30,
      reportTotal: 30,
      reconciliationDifference: 0,
      unclassifiedCount: 0,
      unclassifiedTotal: 0,
      unclassifiedUtilities: [],
      provisionalCount: 0,
    },
  });
  const text = extractSimplePdfText(bytes);
  assert.match(text, /CONTINUATION-END/);
  assert.match(text, /CUST-AFTER/);
  assert.match(text, /NEXT-ROW-PRESERVED/);
  assert.match(text, /Page 2 of/);
  assert.doesNotMatch(text, /\.\.\./);
});

test("PDF wide detail uses linked panels and displays each charge amount only once", () => {
  const bytes = exportPdf({
    title: "EEIC Detail",
    subtitle: "BP 175",
    headers: ["Customer ID", "Customer", "Reconciliation ID", "EEIC", "Component", "Amount"],
    rows: [["CUST-42", "Bowling Center", "ALLOC#METER#42", "61900", "SRM_MATERIALS", 123.45]],
    notes: [],
    pdfColumnGroups: [
      { label: "Allocation references", columns: [0, 1, 2] },
      { label: "Rate and component details", columns: [0, 2, 3, 4, 5] },
    ],
    pdfSummary: {
      customerTotal: 123.45,
      reportTotal: 123.45,
      reconciliationDifference: 0,
      unclassifiedCount: 0,
      unclassifiedTotal: 0,
      unclassifiedUtilities: [],
      provisionalCount: 1,
    },
  });
  const source = Buffer.from(bytes).toString("latin1");
  const text = extractSimplePdfText(bytes);
  assert.match(text, /Allocation references/);
  assert.match(text, /Rate and component details/);
  assert.match(text, /CUST-42/);
  assert.match(text, /ALLOC#METER#42/);
  assert.match(text, /SRM_MATERIALS/);
  assert.equal((source.match(/\$123\.45/g) ?? []).length, 5); // two summary totals on each page plus one amount cell
  assert.match(text, /Page 1 of 2/);
});


test("Unresolved source charges remain visible and reconcile without inventing a cost category", () => {
  // Amounts reproduced from the February 2026 BP175 local-data diagnostic.
  const wwykElectric = [156.67,50.75,2110.93,4219.01,581.02,278.60,0.27,1.12,15.96,2.68,4.39,0.09,0.38,5.35,0.90,1.47];
  const wwykWater = [4.24,17.91,254.63,42.72,70.00];
  const makeReview = (amount, utility, group, id) => ({
    ready:true, amount, utilityType:utility, utilityGroup:group, reconciliationId:id,
    rateId:`FINAL-${group}-${utility}-2026-01-01`, rateEffectiveDate:"2026-01-01",
    reportingSplit:{status:"REVIEW",utility,issues:[utility==="EL"?"SRM_MATERIALS: unidentified row":"produced[0]: blank cost"],purchasedUtilityAmount:null,components:{}},
  });
  const lines = [
    ...wwykElectric.map((amount,i)=>makeReview(amount,"EL","WWYK",`E${i}`)),
    makeReview(190.39,"EL","TAC","TAC-E"),
    ...wwykWater.map((amount,i)=>makeReview(amount,"PW","WWYK",`W${i}`)),
    {ready:false,amount:null,utilityType:"EL",reconciliationId:"PLACEHOLDER"},
    {ready:true,amount:75,utilityType:"EL",reimbursementDisposition:"CE_ABSORBED",reconciliationId:"CE"},
  ];
  const data={customers:[{customerId:"C1",customerName:"Customer",rateClass:"B",customerType:"Commercial",lines}]};
  for(const kind of ["RCBL","EEIC_SHORT","EEIC_DETAIL"]){
    const result=buildFinancialReport(data,kind);
    assert.equal(result.billedTotal,8009.48);
    assert.equal(result.outputTotal,8009.48);
    assert.equal(result.ready,false);
    const flagged=result.rows.filter(r=>r.component==="UNCLASSIFIED");
    assert.equal(flagged.length,22);
    assert.equal(Math.round(flagged.reduce((sum,r)=>sum+r.amount,0)*100),800948);
    assert.ok(flagged.every(r=>r.mappingStatus==="REVIEW" && r.eeic==="UNRESOLVED" && r.objectClass==="UNRESOLVED"));
    assert.ok(flagged.every(r=>r.componentLabel.includes("Review Required")));
    assert.equal(result.rows.some(r=>r.component==="OTHER"),false);
    assert.ok(flagged.some(r=>r.rateId==="FINAL-TAC-EL-2026-01-01" && r.reconciliationId==="TAC-E"));
  }
});

test("Mixed valid and unresolved sources reconcile without classifying the unresolved amount as Other Utilities",()=>{
  const valid=split();
  const pending={...valid,status:"REVIEW",purchasedUtilityAmount:null,components:{},issues:["SRM_MATERIALS: needs reviewed classification"]};
  const data={customers:[{customerId:"C",customerName:"C",customerType:"Commercial",rateClass:"B",lines:[
    {ready:true,amount:100,reportingSplit:valid,utilityGroup:"WWYK",utilityType:"EL",reconciliationId:"good"},
    {ready:true,amount:37.19,reportingSplit:pending,utilityGroup:"WWYK",utilityType:"EL",reconciliationId:"review",rateId:"FINAL-EL"},
  ]}]};
  const result=buildFinancialReport(data,"RCBL");
  assert.equal(result.billedTotal,137.19);
  assert.equal(result.outputTotal,137.19);
  assert.equal(result.ready,false);
  assert.equal(result.rows.find(r=>r.component==="UNCLASSIFIED")?.amount,37.19);
  assert.equal(result.rows.filter(r=>r.component==="OTHER").length,1);
});

test("Historical code snapshots either produce the full split or one full-charge REVIEW row, never partial money",()=>{
  const valid=split();
  const codes={EL:{eeic:"48020",objectClass:"233.2110",status:"PENDING"}};
  const data={persisted:true,customers:[{customerId:"C",customerName:"C",customerType:"Commercial",rateClass:"B",lines:[
    {ready:true,amount:100,reportingSplit:valid,reportingCodes:codes,utilityType:"EL",reconciliationId:"OLD"},
  ]}]};
  const report=buildFinancialReport(data,"EEIC_DETAIL");
  assert.equal(report.ready,false);
  assert.equal(report.outputTotal,100);
  assert.equal(report.rows.length,1);
  assert.equal(report.rows[0].component,"UNCLASSIFIED");
  assert.match(report.issues.join(" "),/no issued EEIC snapshot/i);
});

test("Invalid split or unready existing line keeps the entire known customer charge visible",()=>{
  const inconsistent={...split(),purchasedUtilityAmount:70,components:{REM:20},status:"READY"};
  const data={customers:[{customerId:"C",customerName:"C",rateClass:"D",customerType:"DOD",lines:[
    {ready:true,amount:100,reportingSplit:inconsistent,reconciliationId:"BAD"},
    {ready:false,amount:10,utilityType:"PW",reconciliationId:"UNREADY"},
  ]}]};
  const report=buildFinancialReport(data,"EEIC_DETAIL");
  assert.equal(report.billedTotal,110);
  assert.equal(report.outputTotal,110);
  assert.equal(report.rows.filter(r=>r.component==="UNCLASSIFIED").length,2);
  assert.equal(report.ready,false);
});

test("Credits and repeated CustomerIDs preserve amounts and flagged classification",()=>{
  const data={customers:[
    {customerId:"C",customerName:"C",rateClass:"B",customerType:"B",lines:[{ready:true,amount:-3.25,utilityType:"EL",reconciliationId:"CR"}]},
    {customerId:"C",customerName:"C",rateClass:"B",customerType:"B",lines:[{ready:true,amount:6.10,utilityType:"PW",reconciliationId:"C2"}]},
  ]};
  const report=buildFinancialReport(data,"EEIC_DETAIL");
  assert.equal(report.billedTotal,2.85);
  assert.equal(report.customerTotals.C,2.85);
  assert.equal(report.outputTotal,2.85);
  assert.equal(report.rows.length,2);
});


test("CSV and workbook outputs visibly label an unclassified charge and do not assign an EEIC",()=>{
  const record={customers:[{customerId:"C1",customerName:"C",customerType:"B",rateClass:"B",lines:[{ready:true,amount:389.50,utilityType:"PW",rateId:"3556-FINAL-WWYK-PW",reconciliationId:"W0646"}]}]};
  const report=buildFinancialReport(record,"EEIC_DETAIL");
  const row=report.rows[0];
  const table={title:"EEIC Detail REVIEW",subtitle:"Original charges unchanged",headers:["Component","EEIC","Status","Amount"],rows:[[row.componentLabel,row.eeic,row.mappingStatus,row.amount]],notes:report.issues};
  const csv=Buffer.from(exportCsv(table)).toString("utf8");
  assert.match(csv,/Unclassified/);
  assert.match(csv,/UNRESOLVED/);
  assert.match(csv,/389\.5/);
  const xlsx=exportXlsx(table);
  assert.equal(Buffer.from(xlsx).toString("ascii",0,2),"PK");
});
