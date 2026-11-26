"use client";

import { useMemo, useState } from "react";
import { buildFinancialReport, type InputBilling, type ReportKind } from "@/lib/financial-reporting";
import { exportCsv, exportPdf, exportXlsx } from "@/lib/report-file-export";
import { buildFamiliarFinancialTable } from "@/lib/financial-report-export";
import type { ComponentCode, CostRow } from "@/lib/3556-reporting";
import { COMPONENT_KEYS, type AccountingCode, type AccountingComponent, type AccountingCrosswalk } from "@/lib/reporting-crosswalk";

const MONTHS = ["October","November","December","January","February","March","April","May","June","July","August","September"];
const CATEGORIES: Array<{value:string,label:string}> = [
  {value:"",label:"No classification"},
  {value:"REM",label:"REM"},
  {value:"CUBE",label:"CUBE"},
  {value:"SRM_LABOR",label:"SRM Labor"},
  {value:"SRM_MATERIALS",label:"SRM Materials / FSRM (provisional candidate)"},
  {value:"UNCLASSIFIED",label:"Leave unclassified — Review Required"},
];
const fmt = (n:number)=>new Intl.NumberFormat("en-US",{style:"currency",currency:"USD"}).format(n);

type MappingResponse = {
  id: string;
  sourceFingerprint: string;
  mappings: Record<string,ComponentCode|"UNCLASSIFIED">;
  updatedAt: string | null;
  rows: CostRow[];
  errors: string[];
  mapStatus: string;
};
function offerFile(filename:string,data:Uint8Array,mime:string) {
  const bytes = new Uint8Array(data.length);
  bytes.set(data);
  const url=URL.createObjectURL(new Blob([bytes.buffer],{type:mime}));
  const link=document.createElement("a");link.href=url;link.download=filename;link.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
}

/** Editable component classifications: metadata only; never edits the 3556 costs or rates. */
function WorksheetClassification({ids, afterSave}:{ids:string[];afterSave:()=>void}) {
  const [selected,setSelected]=useState("");
  const [record,setRecord]=useState<MappingResponse|null>(null);
  const [assignments,setAssignments]=useState<Record<string,ComponentCode|"UNCLASSIFIED">>({});
  const [reason,setReason]=useState("");
  const [error,setError]=useState("");
  const [success,setSuccess]=useState("");
  const [working,setWorking]=useState(false);
  async function load(id:string) {
    setSelected(id);setRecord(null);setError("");setSuccess("");setAssignments({});
    if (!id) return;
    setWorking(true);
    try {
      const response=await fetch(`/api/billing/3556/reporting-mapping?worksheet_id=${encodeURIComponent(id)}`,{cache:"no-store"});
      const body=await response.json();if(!response.ok)throw new Error(body.error??"Unable to load FINAL 3556 mapping");
      setRecord(body);setAssignments(body.mappings??{});
    } catch (e) {setError(e instanceof Error ? e.message : "Unable to load mapping");}
    finally {setWorking(false);}
  }
  async function save() {
    if(!record)return;setError("");setSuccess("");setWorking(true);
    try {
      const response=await fetch("/api/billing/3556/reporting-mapping",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({worksheet_id:selected,assignments,reason,sourceFingerprint:record.sourceFingerprint,expectedUpdatedAt:record.updatedAt})});
      const body=await response.json();if(!response.ok)throw new Error(body.error??"Unable to save mapping");
      setSuccess("Classification saved with an audit entry. Regenerate the report to apply it.");setReason("");await load(selected);afterSave();
    } catch(e){setError(e instanceof Error ? e.message : "Save failed");}
    finally {setWorking(false);}
  }
  return <details className="finance-classification">
    <summary>3556 cost classification — identify unlabeled source rows (authorized review required)</summary>
    <p>These assignments identify cost categories on the <strong>existing FINAL 3556</strong>. They do not change the form, rates, bills, or customer charges. Do not classify a row without accounting confirmation.</p>
    <label>Finalized worksheet: <select value={selected} onChange={event=>void load(event.target.value)}><option value="">Select 3556</option>{ids.map(id=><option key={id} value={id}>{id}</option>)}</select></label>
    {working && <p>Loading…</p>}
    {record && <>
      <p>Mapping status: {record.mapStatus}. Source fingerprint: <code>{record.sourceFingerprint.slice(0,16)}…</code></p>
      {record.errors.map(x=><p key={x} role="alert">{x}</p>)}
      <div className="finance-scroll"><table className="finance-table"><thead><tr><th>Section / Row</th><th>Account</th><th>Description</th><th>Annual 3556 Cost</th><th>Reporting Component</th></tr></thead><tbody>
        {record.rows.map(row=>{const key=`${row.section}:${row.key}`;const hasAssignment=Object.hasOwn(assignments,key);const selected=hasAssignment?assignments[key]??"":row.classificationStatus==="PROVISIONAL"?row.component??"":"";return <tr key={key}><td>{key}</td><td>{row.account||"—"}</td><td>{row.description||"—"}</td><td className="finance-money">{fmt(row.amount)}</td><td><select aria-label={`Category for ${key}`} value={selected} onChange={event=>setAssignments(old=>{const next={...old};if(event.target.value)next[key]=event.target.value as ComponentCode|"UNCLASSIFIED";else delete next[key];return next;})}>{CATEGORIES.map(x=><option key={x.value} value={x.value}>{x.label}</option>)}</select>{row.classificationStatus==="PROVISIONAL"&&<small> Provisional account-based candidate</small>}{row.component && row.classificationStatus!=="PROVISIONAL"&&!assignments[key]&&<small> Recognized: {row.component}</small>}</td></tr>})}
      </tbody></table></div>
      <label>Why these classifications are valid: <input value={reason} onChange={e=>setReason(e.target.value)} placeholder="Reference the approved 3556 / accounting guidance"/></label>
      <button type="button" disabled={working||reason.trim().length<8} onClick={()=>void save()}>Save reviewed classification</button>
    </>}
    {error&&<p role="alert" className="finance-error">{error}</p>}{success&&<p role="status">{success}</p>}
  </details>;
}

type CrosswalkResponse = {
  codes: AccountingCrosswalk;
  source: "CONFIGURED" | "DEFAULT_CANDIDATES";
  updatedAt: string | null;
  updatedBy: string | null;
  canEdit: boolean;
  accountingApproved: false;
};

/** Only crosswalk metadata is changed. A save creates a current pointer + audit snapshot. */
function AccountingCrosswalkEditor({afterSave}:{afterSave:()=>void}) {
  const [record,setRecord] = useState<CrosswalkResponse|null>(null);
  const [codes,setCodes] = useState<AccountingCrosswalk|null>(null);
  const [reason,setReason] = useState("");
  const [working,setWorking] = useState(false);
  const [error,setError] = useState("");
  const [message,setMessage] = useState("");
  async function load() {
    setWorking(true);setError("");
    try {
      const response = await fetch("/api/billing/3556/accounting-crosswalk",{cache:"no-store"});
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Could not load accounting crosswalk");
      setRecord(data);setCodes(data.codes);
    } catch(e) {setError(e instanceof Error ? e.message : "Could not load crosswalk");}
    finally {setWorking(false);}
  }
  function change(component:AccountingComponent,field:keyof AccountingCode,value:string) {
    setCodes(old=>old ? {...old,[component]:{...old[component],[field]:field==="eeic"?(value.trim().toUpperCase()||null):field==="objectClass"?value.trim():value}} : old);
    setMessage("");
  }
  async function save() {
    if (!record || !codes) return;
    setWorking(true);setError("");setMessage("");
    try {
      const response = await fetch("/api/billing/3556/accounting-crosswalk",{
        method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({codes,reason,expectedUpdatedAt:record.updatedAt}),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Crosswalk save failed");
      setReason("");
      await load();
      afterSave();
      setMessage("Crosswalk saved with an audit record. Regenerate the preview to use the updated codes. Existing saved bills retain their original issued code snapshots.");
    } catch(e) {setError(e instanceof Error ? e.message : "Crosswalk save failed");}
    finally {setWorking(false);}
  }
  return <details className="finance-classification">
    <summary>EEIC / Object Class crosswalk — provisional, editable and audited</summary>
    <p>These eight accounting-code entries do not change FINAL 3556 rates, bill amounts, or customer allocations. All codes remain unapproved until Government accounting authority confirms them. Historical saved RCBLs retain their issued snapshots.</p>
    <button type="button" disabled={working} onClick={()=>void load()}>{working?"Loading…":record?"Reload crosswalk":"Load crosswalk"}</button>
    {record&&codes&&<>
      <p>Source: {record.source === "CONFIGURED"?`Reviewed configuration, saved ${record.updatedAt ?? "unknown"} by ${record.updatedBy || "unknown"}`:"Built-in provisional candidates; no reviewed configuration saved"}.</p>
      {!record.canEdit&&<p role="status">Read-only. An administrator must explicitly authorize your Cognito group or email for accounting crosswalk edits.</p>}
      <div className="finance-scroll"><table className="finance-table"><thead><tr><th>Component</th><th>EEIC</th><th>Object Class</th><th>Unapproved status</th></tr></thead><tbody>
        {COMPONENT_KEYS.map(key=><tr key={key}>
          <td>{key}</td>
          <td><input aria-label={`${key} EEIC`} value={codes[key].eeic??""} placeholder="Unresolved" disabled={!record.canEdit||working} onChange={e=>change(key,"eeic",e.target.value)}/></td>
          <td><input aria-label={`${key} Object Class`} value={codes[key].objectClass} disabled={!record.canEdit||working} onChange={e=>change(key,"objectClass",e.target.value)}/></td>
          <td><select aria-label={`${key} status`} value={codes[key].status} disabled={!record.canEdit||working} onChange={e=>change(key,"status",e.target.value)}><option value="PROVISIONAL">PROVISIONAL</option><option value="PENDING">PENDING</option><option value="DISPUTED">DISPUTED</option></select></td>
        </tr>)}
      </tbody></table></div>
      {record.canEdit&&<><label>Documented Government/Finance reason: <input value={reason} maxLength={500} onChange={e=>setReason(e.target.value)} placeholder="Explain the accounting reference and proposed change" /></label>
      <button type="button" disabled={working||reason.trim().length<8} onClick={()=>void save()}>Save versioned crosswalk</button></>}
    </>}
    {error&&<p className="finance-error" role="alert">{error}</p>}{message&&<p role="status">{message}</p>}
  </details>;
}

export function FinancialReportingPanel({kind}:{kind:ReportKind}) {
  const [fiscalYear,setFiscalYear]=useState("2026");
  const [month,setMonth]=useState("February");
  const [view,setView]=useState<"live"|"saved">("live");
  const [data,setData]=useState<(InputBilling & {billingPeriodId:number;billingMonth:string;fiscalYear:string;persisted:boolean;savedVersionId?:string})|null>(null);
  const [filter,setFilter]=useState("");
  const [loading,setLoading]=useState(false);
  const [error,setError]=useState("");
  const period=171+(Number(fiscalYear)-2026)*12+MONTHS.indexOf(month);
  const report=useMemo(()=>data?buildFinancialReport(data,"EEIC_DETAIL"):null,[data]);
  const unresolvedRows=report?.rows.filter(row=>(!filter||row.customerId===filter)&&row.component==="UNCLASSIFIED")??[];
  const unresolvedCents=unresolvedRows.reduce((total,row)=>total+Math.round(row.amount*100),0);
  const provisionalRows=report?.rows.filter(row=>(!filter||row.customerId===filter)&&(row.mappingStatus==="PROVISIONAL"||row.classificationStatus==="PROVISIONAL"))??[];
  const provisionalCents=provisionalRows.reduce((total,row)=>total+Math.round(row.amount*100),0);
  const customers=useMemo(()=>Array.from(new Map((data?.customers??[]).map(c=>[c.customerId,{id:c.customerId,label:`${c.customerId} - ${c.customerName}`}])).values()),[data]);
  function table() {
    if (!report) throw new Error("No report loaded for export");
    const source = view === "saved" ? `SAVED VERSION ${data?.savedVersionId ?? "UNKNOWN"}` : "LIVE REPORTING PREVIEW";
    const customerName = data?.customers.find(customer => customer.customerId === filter)?.customerName ?? "";
    return buildFamiliarFinancialTable({report, billing: data ?? undefined, kind, customerId: filter, customerName, period, fiscalYear, month, source});
  }
  async function generate() {
    setLoading(true);setError("");setData(null);setFilter("");
    try {
      const url=`/api/billing/rcbl-short?billing_period_id=${period}${view==="saved"?"&view=saved":""}`;
      const response=await fetch(url,{cache:"no-store"});const body=await response.json();
      if(!response.ok)throw new Error(body.error??"Cannot read RCBL records");
      setData(body);
    }catch(e){setError(e instanceof Error?e.message:"Unable to generate report");}
    finally{setLoading(false);}
  }
  function download(format:"csv"|"xlsx"|"pdf") {
    const payload=table();const filename=`CUBE-${kind}-BP${period}-${view}-REVIEW.${format}`;
    const bytes=format==="csv"?exportCsv(payload):format==="xlsx"?exportXlsx(payload):exportPdf(payload);
    offerFile(filename,bytes,format==="csv"?"text/csv":format==="xlsx"?"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":"application/pdf");
  }
  const displayedTable=report?table():null;
  return <div className="finance-workspace">
    <h2>{kind==="RCBL"?"RCBL — Utility Cost Breakdown":kind==="EEIC_SHORT"?"EEIC Short — Accounting Summary":"EEIC Detail — Accounting Breakdown"}</h2>
    <p>{kind === "RCBL" ? "Read-only view of the same customer charges. RCBL shows each utility's consumption and utility base cost, with REM, CUBE, and SRM combined in one Other Utilities subtotal. Other Utility Costs reflect any authorized delivery, infrastructure, and production fees included as part of approved 3556 rates. The detailed component breakdown is available in EEIC reports. Amounts and rates are unchanged." : "Read-only views of the same customer charges. EEIC Short summarizes by accounting category; EEIC Detail shows the charge lines behind those totals. Amounts and rates are unchanged."}</p>
    <div className="finance-controls"><label>Fiscal year <select value={fiscalYear} disabled={loading} onChange={e=>{setFiscalYear(e.target.value);setData(null);setFilter("");}}>{Array.from({length:11},(_,i)=>2025+i).map(y=><option key={y}>{y}</option>)}</select></label><label>Billing month <select value={month} disabled={loading} onChange={e=>{setMonth(e.target.value);setData(null);setFilter("");}}>{MONTHS.map(m=><option key={m}>{m}</option>)}</select></label><label>Source <select value={view} disabled={loading} onChange={e=>{setView(e.target.value as "live"|"saved");setData(null);setFilter("");}}><option value="live">Current reconciliation preview</option><option value="saved">Issued saved RCBL version (immutable)</option></select></label><button type="button" disabled={loading} onClick={()=>void generate()}>{loading?"Generating…":"Generate report"}</button></div>
    {error&&<p className="finance-error" role="alert">{error}</p>}
    {report && <>
      <div className="finance-summary"><div><strong>{filter?"Selected customer total":"All customer charges"}</strong><span>{fmt(displayedTable?.pdfSummary?.customerTotal??report.billedTotal)}</span></div><div><strong>Report sum</strong><span>{fmt(displayedTable?.pdfSummary?.reportTotal??report.outputTotal)}</span></div><div><strong>Full report status</strong><span>{report.ready?"Reconciled":"REVIEW REQUIRED"}</span></div><div><strong>EEIC authority</strong><span>Pending verification</span></div></div>
      {unresolvedRows.length>0 && <p className="finance-notice" role="status"><strong>{unresolvedRows.length} billed line(s) need accounting review — {fmt(unresolvedCents/100)}.</strong> Their full charges are included as <strong>Unclassified — Review Required</strong>. Review the source 3556 in Accounting Setup, then generate this report again. Incorrect source costs must be corrected through the authorized 3556 process.</p>}
      {provisionalRows.length>0 && <p className="finance-notice" role="status"><strong>{provisionalRows.length} report row(s) contain provisional classifications — {fmt(provisionalCents/100)}.</strong> Candidate rows and EEIC/Object Class values are labeled PROVISIONAL and require Government/Finance verification before official use.</p>}
      {report.issues.length>0 && <details className="finance-issues"><summary>{report.issues.length} reporting issue(s) need review — show details</summary><p>These messages identify the customer charge and 3556 source row that needs an accounting decision. They do not change the bill total.</p><ul>{Array.from(new Set(report.issues)).slice(0,30).map((issue,i)=><li key={i}>{issue}</li>)}{report.issues.length>30&&<li>More issues exist; review the report and source 3556 records.</li>}</ul></details>}
      <p className="finance-notice">Accounting codes have not been validated against an approved cross-reference. Downloads are marked REVIEW, not official submissions. Saved legacy bills are never silently recalculated from newer 3556 data.</p>
      <div className="finance-controls"><label>Customer <select value={filter} onChange={e=>setFilter(e.target.value)}><option value="">All customers</option>{customers.map(c=><option key={c.id} value={c.id}>{c.label}</option>)}</select></label><button type="button" onClick={()=>download("csv")}>CSV</button><button type="button" onClick={()=>download("xlsx")}>Excel</button><button type="button" onClick={()=>download("pdf")}>PDF</button></div>
      {displayedTable && <div className="finance-scroll"><table className="finance-table"><thead><tr>{displayedTable.headers.map(x=><th key={x}>{x}</th>)}</tr></thead><tbody>{displayedTable.rows.map((row,i)=><tr key={i} className={row.includes("Customer total")||row.includes("EEIC subtotal")||row.includes("Category summary")?"finance-total-row":undefined}>{row.map((cell,j)=><td key={j} className={typeof cell==="number"?"finance-money":""}>{typeof cell==="number"?(displayedTable.headers[j]==="Consumption"?cell.toLocaleString("en-US",{maximumFractionDigits:15}):displayedTable.headers[j]==="Unit rate"?cell.toLocaleString("en-US",{minimumFractionDigits:5,maximumFractionDigits:15}):fmt(cell)):cell}</td>)}</tr>)}{!displayedTable.rows.length&&<tr><td colSpan={displayedTable.headers.length}>No reportable customer charge lines. Check issues above.</td></tr>}</tbody></table></div>}
    </>}
  </div>;
}

export function FinancialReportingSetup() {
  const [fiscalYear, setFiscalYear] = useState("2026");
  const [month, setMonth] = useState("February");
  const [ids, setIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const period = 171 + (Number(fiscalYear) - 2026) * 12 + MONTHS.indexOf(month);

  async function loadWorksheets() {
    setLoading(true);
    setError("");
    setIds([]);
    try {
      const response = await fetch(`/api/billing/rcbl-short?billing_period_id=${period}`, { cache: "no-store" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Unable to find the period's 3556 worksheets");
      const billing = body as InputBilling;
      setIds(Array.from(new Set((billing.customers ?? []).flatMap(customer => customer.lines.map(line => line.rateId ?? "")).filter(Boolean))).sort());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to load worksheets");
    } finally {
      setLoading(false);
    }
  }

  return <div className="finance-workspace">
    <h2>Accounting Setup</h2>
    <p>Review how existing 3556 costs appear in accounting reports. These settings do not change customer bills or utility rates.</p>
    <div className="finance-controls">
      <label>Fiscal year <select value={fiscalYear} onChange={event => { setFiscalYear(event.target.value); setIds([]); }}>{Array.from({length:11},(_,i)=>2025+i).map(year=><option key={year}>{year}</option>)}</select></label>
      <label>Billing month <select value={month} onChange={event => { setMonth(event.target.value); setIds([]); }}>{MONTHS.map(value=><option key={value}>{value}</option>)}</select></label>
      <button type="button" disabled={loading} onClick={() => void loadWorksheets()}>{loading ? "Loading…" : "Find 3556 worksheets"}</button>
    </div>
    {error && <p className="finance-error" role="alert">{error}</p>}
    {ids.length > 0 && <WorksheetClassification ids={ids} afterSave={() => setIds([])} />}
    {!loading && ids.length === 0 && !error && <p>Select a month and find its 3556 worksheets to review cost classifications.</p>}
    <AccountingCrosswalkEditor afterSave={() => {}} />
  </div>;
}
