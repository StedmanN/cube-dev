"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import {

  AlertTriangle,

  ArrowLeft,

  CheckCircle2,

  ChevronRight,

  Layers3,

  Download,

  RefreshCw,

  Search,

  X,

} from "lucide-react";

type BillingPeriodSummary = {

  billingPeriodId: number;

  fy: number;

  month: string;

  totalReadings: number;

  deviations: number;

  monthDeviations: number;

  yearDeviations: number;

  autoCorrected: number;

  reviewRequired: number;

};

type DeviationRow = {

  meterid: string;

  period: string;

  billingPeriodId: number;

  fy: number;

  month: string;

  facilityNbr: string;

  utilityType: string;

  currentReading: number;

  previousMonthReading: number | null;

  previousYearReading: number | null;

  currentConsumption: number | null;

  previousMonthConsumption: number | null;

  previous2MonthConsumption: number | null;

  previous3MonthConsumption: number | null;

  nextMonthConsumption: number | null;

  previousYearConsumption: number | null;

  previousMonthPercent: number | null;

  previousYearPercent: number | null;

  monthFlag: boolean;

  yearFlag: boolean;

  reason: string;

  consumption: number | null;

  adjustedConsumption: number | null;

  correctionRule: string;

  usedInCalculation: number;

  recommendedCorrectionRule: string;

  validationStatus: string;

  validationCheckedAt: string;

  autoCorrected: boolean;

  bulkCorrected: boolean;

  validationAction: string;

};

type SummaryResponse = {

  success: boolean;

  thresholdPercent: number;

  selectedFy: number;

  fiscalYears: number[];

  periods: BillingPeriodSummary[];

};

type CorrectionRuleRecord = {

  correction_rule_cd: string;

  correction_rule_name: string;

  correction_rule_description: string;

};

type DetailResponse = {

  success: boolean;

  thresholdPercent: number;

  summary: BillingPeriodSummary;

  rows: DeviationRow[];

  correctionRules: CorrectionRuleRecord[];

};

type CorrectionDraft = {

  reading: string;

  adjustedConsumption: string;

  correctionRule: string;

  usedInCalculation: string;

};



type BulkPreviewRow = {

  meterid: string;

  period: string;

  eligible: boolean;

  adjustedConsumption: string;

  formula: string;

  reason: string;

};

function formatNumber(value: number | null) {

  if (value === null || !Number.isFinite(value)) return "—";

  return value.toLocaleString(undefined, { maximumFractionDigits: 4 });

}

function formatPercent(value: number | null, flagged: boolean) {

  if (value === null) return flagged ? "Baseline 0" : "—";

  const sign = value > 0 ? "+" : "";

  return `${sign}${value.toFixed(1)}%`;

}

const MANUAL_CORRECTION_RULES = new Set(["f", "g", "h", "i", "k", "m"]);

function normalizeRule(rule: string) {

  return String(rule ?? "").trim().toLowerCase();

}

function isManualCorrectionRule(rule: string) {

  return MANUAL_CORRECTION_RULES.has(normalizeRule(rule));

}

function roundAdjusted(value: number) {

  if (!Number.isFinite(value)) return "";

  return String(Math.round(value * 10000) / 10000);

}

function calculateRuleAdjustment(row: DeviationRow, ruleValue: string) {

  const rule = normalizeRule(ruleValue);

  if (!rule) {

    return {

      value: row.consumption === null ? "" : roundAdjusted(row.consumption),

      formula: "No correction: adjusted consumption equals calculated consumption.",

      automatic: true,

    };

  }

  if (isManualCorrectionRule(rule)) {

    return {

      value: "",

      formula: "Manual correction rule: enter the adjusted consumption.",

      automatic: false,

    };

  }

  const p1 = row.previousMonthConsumption;

  const p2 = row.previous2MonthConsumption;

  const p3 = row.previous3MonthConsumption;

  const n1 = row.nextMonthConsumption;

  const py = row.previousYearConsumption;

  switch (rule) {

    case "a":

      return p1 !== null && n1 !== null

        ? {

            value: roundAdjusted((p1 + n1) / 2),

            formula: `(${formatNumber(p1)} + ${formatNumber(n1)}) / 2`,

            automatic: true,

          }

        : { value: "", formula: "Rule A requires previous and next month.", automatic: true };

    case "b":

      return p1 !== null && p2 !== null && p3 !== null

        ? {

            value: roundAdjusted((p1 + p2 + p3) / 3),

            formula: `(${formatNumber(p1)} + ${formatNumber(p2)} + ${formatNumber(p3)}) / 3`,

            automatic: true,

          }

        : { value: "", formula: "Rule B requires the previous three months.", automatic: true };

    case "c":

      return p1 !== null

        ? { value: roundAdjusted(p1), formula: `Previous month = ${formatNumber(p1)}`, automatic: true }

        : { value: "", formula: "Rule C requires previous-month consumption.", automatic: true };

    case "d":

      return n1 !== null

        ? { value: roundAdjusted(n1), formula: `Next month = ${formatNumber(n1)}`, automatic: true }

        : { value: "", formula: "Rule D requires next-month consumption.", automatic: true };

    case "e":

      return py !== null

        ? { value: roundAdjusted(py), formula: `Same month prior FY = ${formatNumber(py)}`, automatic: true }

        : { value: "", formula: "Rule E requires same-month prior-FY consumption.", automatic: true };

    case "j":

    case "l":

      return {

        value: "0",

        formula: `Rule ${rule.toUpperCase()} sets adjusted consumption to 0.`,

        automatic: true,

      };

    default:

      return {

        value: "",

        formula: "This rule does not have an automatic calculation configured.",

        automatic: false,

      };

  }

}

function csvCell(value: unknown) {

  const cell = value === undefined || value === null ? "" : String(value);

  return `"${cell.replace(/"/g, '""')}"`;

}

function exportDivaCsv(period: BillingPeriodSummary, rows: DeviationRow[]) {

  const headers = [

    "Billing Period", "FY", "Month", "Meter", "Facility", "Utility",

    "DIVA Status", "Original Consumption", "Previous Year Consumption",

    "Previous Year Deviation %", "Previous Month Consumption",

    "Previous Month Deviation %", "Correction Rule",

    "Adjusted Consumption", "Action", "Validation Checked At",

  ];

  const lines = [

    headers.map(csvCell).join(","),

    ...rows.map((row) => [

      row.billingPeriodId, row.fy, row.month, row.meterid, row.facilityNbr,

      row.utilityType, row.validationStatus, row.consumption,

      row.previousYearConsumption, row.previousYearPercent,

      row.previousMonthConsumption, row.previousMonthPercent,

      row.correctionRule, row.adjustedConsumption,

      row.validationAction === "AMR_QUARANTINED"
          ? "AMR Quarantined - Review Required"
          : row.validationAction === "AMR_INSUFFICIENT_HISTORY"
            ? "AMR Quarantined - Insufficient History"
            : row.validationAction ||
              (row.autoCorrected ? "Rule E - Previous Year" : "Review Required"),

      row.validationCheckedAt,

    ].map(csvCell).join(",")),

  ];

  const blob = new Blob([lines.join("\r\n")], {

    type: "text/csv;charset=utf-8",

  });

  const url = URL.createObjectURL(blob);

  const anchor = document.createElement("a");

  anchor.href = url;

  anchor.download =

    `DIVA_${period.month}_FY${period.fy}_BP${period.billingPeriodId}.csv`;

  document.body.appendChild(anchor);

  anchor.click();

  anchor.remove();

  URL.revokeObjectURL(url);

}



function getCurrentCalendarYear() {
  return new Date().getFullYear();
}

export function DataValidationClient() {

  const [periods, setPeriods] = useState<BillingPeriodSummary[]>([]);

  const [selectedFy, setSelectedFy] = useState(getCurrentCalendarYear);

  const [fiscalYears, setFiscalYears] = useState<number[]>([]);

  const [selectedPeriod, setSelectedPeriod] =

    useState<BillingPeriodSummary | null>(null);

  const [rows, setRows] = useState<DeviationRow[]>([]);

  const [correctionRules, setCorrectionRules] =

    useState<CorrectionRuleRecord[]>([]);

  const [threshold, setThreshold] = useState(50);

  const [loading, setLoading] = useState(true);

  const [detailLoading, setDetailLoading] = useState(false);

  const [error, setError] = useState("");

  const [search, setSearch] = useState("");

  const [filter, setFilter] = useState<"all" | "month" | "year" | "both">("all");

  const [editing, setEditing] = useState<DeviationRow | null>(null);

  const [saving, setSaving] = useState(false);

  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());

  const [bulkRule, setBulkRule] = useState("e");

  const [bulkPreviewOpen, setBulkPreviewOpen] = useState(false);

  const [bulkSaving, setBulkSaving] = useState(false);

  const [draft, setDraft] = useState<CorrectionDraft>({

    reading: "",

    adjustedConsumption: "",

    correctionRule: "",

    usedInCalculation: "1",

  });

  const loadSummary = useCallback(async () => {

    setLoading(true);

    setError("");

    try {

      const response = await fetch(

        `/api/data-validation?fy=${selectedFy}`,

        { cache: "no-store" },

      );

      const result = (await response.json()) as SummaryResponse & { error?: string };

      if (!response.ok) throw new Error(result.error || "Unable to load validation summary.");

      setPeriods(result.periods ?? []);

      setFiscalYears(result.fiscalYears ?? [selectedFy]);

      setThreshold(result.thresholdPercent ?? 50);

    } catch (err) {

      setError(err instanceof Error ? err.message : "Unable to load validation summary.");

    } finally {

      setLoading(false);

    }

  }, [selectedFy]);

  useEffect(() => {

    void loadSummary();

  }, [loadSummary]);

  async function openPeriod(period: BillingPeriodSummary) {

    setSelectedPeriod(period);

    setDetailLoading(true);

    setError("");

    setRows([]);

    setSearch("");

    setFilter("all");

    setSelectedKeys(new Set());

    setBulkPreviewOpen(false);

    try {

      const response = await fetch(

        `/api/data-validation?billing_period_id=${period.billingPeriodId}`,

        { cache: "no-store" },

      );

      const result = (await response.json()) as DetailResponse & { error?: string };

      if (!response.ok) throw new Error(result.error || "Unable to load deviations.");

      setRows(result.rows ?? []);

      setCorrectionRules(result.correctionRules ?? []);

      setThreshold(result.thresholdPercent ?? 50);

    } catch (err) {

      setError(err instanceof Error ? err.message : "Unable to load deviations.");

    } finally {

      setDetailLoading(false);

    }

  }

  function startCorrection(row: DeviationRow) {

    const existingRule =

      row.correctionRule ||

      row.recommendedCorrectionRule ||

      "";

    const calculation = calculateRuleAdjustment(row, existingRule);

    setEditing(row);

    setDraft({

      reading: String(row.currentReading),

      adjustedConsumption:

        existingRule && calculation.automatic

          ? calculation.value

          : row.adjustedConsumption === null

            ? ""

            : String(row.adjustedConsumption),

      correctionRule: existingRule,

      usedInCalculation: String(row.usedInCalculation ?? 1),

    });

  }

  async function saveCorrection() {

    if (!editing) return;

    const reading = Number(draft.reading);

    if (!Number.isFinite(reading)) {

      window.alert("Current reading must be a valid number.");

      return;

    }

    setSaving(true);

    try {

      const response = await fetch("/api/data-validation", {

        method: "PATCH",

        headers: { "Content-Type": "application/json" },

        body: JSON.stringify({

          meterid: editing.meterid,

          period: editing.period,

          billing_period_id: editing.billingPeriodId,

          reading,

          adjusted_consumption:

            draft.adjustedConsumption.trim() === ""

              ? null

              : Number(draft.adjustedConsumption),

          meter_correction_rule_cd: draft.correctionRule.trim(),

          used_in_calculation: Number(draft.usedInCalculation),

        }),

      });

      const result = await response.json();

      if (!response.ok) {
        if (
          response.status === 409 &&
          result.code === "PREVIOUS_PERIOD_VALIDATION_REQUIRED"
        ) {
          throw new Error(
            result.error ||
              "The previous billing period still requires validation. Resolve it first.",
          );
        }
        throw new Error(result.error || "Unable to save correction.");
      }

      setEditing(null);

      if (selectedPeriod) {

        await openPeriod(selectedPeriod);

      }

      await loadSummary();

    } catch (err) {

      window.alert(err instanceof Error ? err.message : "Unable to save correction.");

    } finally {

      setSaving(false);

    }

  }

  function rowKey(row: DeviationRow) {

    return `${row.meterid}::${row.period}`;

  }



  function isReviewRow(row: DeviationRow) {

    return !row.autoCorrected && !row.bulkCorrected;

  }



  function toggleSelected(row: DeviationRow) {

    if (!isReviewRow(row)) return;

    const key = rowKey(row);

    setSelectedKeys((current) => {

      const next = new Set(current);

      if (next.has(key)) next.delete(key);

      else next.add(key);

      return next;

    });

  }



  function setVisibleSelection(visibleRows: DeviationRow[], selected: boolean) {

    const keys = visibleRows.filter(isReviewRow).map(rowKey);

    setSelectedKeys((current) => {

      const next = new Set(current);

      for (const key of keys) {

        if (selected) next.add(key);

        else next.delete(key);

      }

      return next;

    });

  }



  const selectedRows = useMemo(

    () => rows.filter((row) => selectedKeys.has(rowKey(row)) && isReviewRow(row)),

    [rows, selectedKeys],

  );



  const bulkPreviewRows = useMemo<BulkPreviewRow[]>(

    () =>

      selectedRows.map((row) => {

        const calculation = calculateRuleAdjustment(row, bulkRule);

        const eligible =

          calculation.automatic &&

          calculation.value.trim() !== "" &&

          Number.isFinite(Number(calculation.value));



        return {

          meterid: row.meterid,

          period: row.period,

          eligible,

          adjustedConsumption: calculation.value,

          formula: calculation.formula,

          reason: eligible

            ? ""

            : calculation.formula || "This rule cannot be calculated for this meter.",

        };

      }),

    [selectedRows, bulkRule],

  );



  const bulkEligibleRows = useMemo(

    () => bulkPreviewRows.filter((row) => row.eligible),

    [bulkPreviewRows],

  );



  async function applyBulkCorrection() {

    if (!selectedPeriod || bulkEligibleRows.length === 0) return;



    setBulkSaving(true);

    try {

      const response = await fetch("/api/data-validation", {

        method: "PATCH",

        headers: { "Content-Type": "application/json" },

        body: JSON.stringify({

          bulk: true,

          billing_period_id: selectedPeriod.billingPeriodId,

          meter_correction_rule_cd: bulkRule,

          items: bulkEligibleRows.map((row) => ({

            meterid: row.meterid,

            period: row.period,

          })),

        }),

      });



      const result = await response.json();

      if (!response.ok) {

        throw new Error(result.error || "Unable to apply bulk correction.");

      }



      setBulkPreviewOpen(false);

      setSelectedKeys(new Set());

      await openPeriod(selectedPeriod);

      await loadSummary();



      if (result.failed > 0) {

        const firstFailure = result.failures?.[0];

        window.alert(

          `${result.updated} meter(s) corrected. ${result.failed} meter(s) could not be updated.` +

            (firstFailure

              ? `\n\nFirst failure: ${firstFailure.meterid || "Unknown meter"} — ${firstFailure.reason}`

              : ""),

        );

      }

    } catch (err) {

      window.alert(

        err instanceof Error ? err.message : "Unable to apply bulk correction.",

      );

    } finally {

      setBulkSaving(false);

    }

  }



  const filteredRows = useMemo(() => {

    const q = search.trim().toLowerCase();

    return rows.filter((row) => {

      if (filter === "month" && !row.monthFlag) return false;

      if (filter === "year" && !row.yearFlag) return false;

      if (filter === "both" && !(row.monthFlag && row.yearFlag)) return false;

      if (!q) return true;

      return [

        row.meterid,

        row.facilityNbr,

        row.utilityType,

        row.reason,

      ].some((value) => String(value ?? "").toLowerCase().includes(q));

    });

  }, [rows, search, filter]);

  const visibleReviewRows = useMemo(

    () => filteredRows.filter(isReviewRow),

    [filteredRows],

  );



  const allVisibleReviewSelected =

    visibleReviewRows.length > 0 &&

    visibleReviewRows.every((row) => selectedKeys.has(rowKey(row)));



  const totals = useMemo(

    () =>

      periods.reduce(

        (acc, period) => {

          acc.readings += period.totalReadings;

          acc.deviations += period.deviations;

          return acc;

        },

        { readings: 0, deviations: 0 },

      ),

    [periods],

  );

  if (!selectedPeriod) {

    return (

      <section className="dv-workspace">

        <div className="dv-summary-grid">

          <div className="dv-stat">

            <span>Months with DIVA Activity</span>

            <strong>{periods.length}</strong>

          </div>

          <div className="dv-stat">

            <span>Readings Evaluated</span>

            <strong>{totals.readings.toLocaleString()}</strong>

          </div>

          <div className="dv-stat dv-stat-warning">

            <span>DIVA Exceptions / Actions</span>

            <strong>{totals.deviations.toLocaleString()}</strong>

          </div>

          <div className="dv-stat">

            <span>Rule Threshold</span>

            <strong>±{threshold}%</strong>

          </div>

        </div>

        <div className="dv-card">

          <div className="dv-card-header">

            <div>

              <h2>Deviation Summary — FY {selectedFy}</h2>

              <p>

                Only fiscal-year months with DIVA activity are shown. Rule 1 compares the
                same month in the previous fiscal year; Rule 2 is evaluated only
                after Rule 1 fails. A deviation of ±{threshold}% or greater is a
                failure. Manual-reading workflows may apply an automatic correction
                when configured. AMR exceptions are quarantined from billing totals
                until reviewed; the original AMR value is preserved.

              </p>

            </div>

            <div className="dv-header-actions">

              <label className="dv-fy-selector">

                <span>Fiscal Year</span>

                <select

                  value={selectedFy}

                  onChange={(event) => {

                    setSelectedPeriod(null);

                    setSelectedFy(Number(event.target.value));

                  }}

                >

                  {fiscalYears.map((fy) => (

                    <option key={fy} value={fy}>

                      FY {fy}

                    </option>

                  ))}

                </select>

              </label>

              <button className="dv-secondary-button" onClick={() => void loadSummary()}>

                <RefreshCw size={17} />

                Refresh

              </button>

            </div>

          </div>

          {error && <div className="dv-error">{error}</div>}

          {loading && <div className="dv-empty">Loading validation results...</div>}

          {!loading && (

            <div className="dv-table-scroll">

              <table className="dv-table">

                <thead>

                  <tr>

                    <th>Billing Period</th>

                    <th>Month</th>

                    <th>FY</th>

                    <th>Total Readings</th>

                    <th>Month Deviations</th>

                    <th>Prior-Year Deviations</th>

                    <th>Auto Corrected</th>

                    <th>Review Required</th>

                    <th>DIVA Activity</th>

                    <th />

                  </tr>

                </thead>

                <tbody>

                  {periods.map((period) => (

                    <tr

                      key={period.billingPeriodId}

                      className={period.deviations ? "dv-row-flagged" : ""}

                    >

                      <td className="dv-id-cell">{period.billingPeriodId}</td>

                      <td>{period.month}</td>

                      <td>FY {period.fy}</td>

                      <td>{period.totalReadings.toLocaleString()}</td>

                      <td>{period.monthDeviations.toLocaleString()}</td>

                      <td>{period.yearDeviations.toLocaleString()}</td>

                      <td>

                        <span className="dv-badge dv-badge-auto">

                          <CheckCircle2 size={14} />

                          {period.autoCorrected ?? 0}

                        </span>

                      </td>

                      <td>

                        <span className={

                          period.reviewRequired

                            ? "dv-badge dv-badge-warning"

                            : "dv-badge dv-badge-ok"

                        }>

                          {period.reviewRequired

                            ? <AlertTriangle size={14} />

                            : <CheckCircle2 size={14} />}

                          {period.reviewRequired ?? 0}

                        </span>

                      </td>

                      <td>{period.deviations.toLocaleString()}</td>

                      <td className="dv-action-cell">

                        <button

                          className="dv-link-button"

                          onClick={() => void openPeriod(period)}

                        >

                          Review

                          <ChevronRight size={16} />

                        </button>

                      </td>

                    </tr>

                  ))}

                  {periods.length === 0 && (

                    <tr>

                      <td colSpan={10} className="dv-empty-row">

                        No months in this fiscal year currently have DIVA activity.

                      </td>

                    </tr>

                  )}

                </tbody>

              </table>

            </div>

          )}

        </div>

      </section>

    );

  }

  const liveCalculation = editing

    ? calculateRuleAdjustment(editing, draft.correctionRule)

    : null;

  return (

    <section className="dv-workspace">

      <button className="dv-back-button" onClick={() => setSelectedPeriod(null)}>

        <ArrowLeft size={17} />

        Back to Billing Periods

      </button>

      <div className="dv-period-banner">

        <div>

          <span>DIVA Validation Report</span>

          <strong>

            {selectedPeriod.month} FY {selectedPeriod.fy}

          </strong>

        </div>

        <div>

          <span>Billing Period</span>

          <strong>{selectedPeriod.billingPeriodId}</strong>

        </div>

        <div>

          <span>Rule</span>

          <strong>±{threshold}%</strong>

        </div>

        <div>

          <span>DIVA Activity</span>

          <strong>{rows.length}</strong>

        </div>

      </div>

      <div className="dv-card">

        <div className="dv-toolbar">

          <div className="dv-search">

            <Search size={17} />

            <input

              value={search}

              onChange={(event) => setSearch(event.target.value)}

              placeholder="Search meter, facility, utility..."

            />

          </div>

          <button

            className="dv-secondary-button"

            onClick={() => exportDivaCsv(selectedPeriod, filteredRows)}

            disabled={!filteredRows.length}

          >

            <Download size={16} />

            Export DIVA CSV

          </button>

          <select

            value={filter}

            onChange={(event) =>

              setFilter(event.target.value as "all" | "month" | "year" | "both")

            }

          >

            <option value="all">All DIVA activity</option>

            <option value="month">Previous month</option>

            <option value="year">Previous year</option>

            <option value="both">Month + year</option>

          </select>

        </div>



        <div className="dv-bulk-bar">

          <label className="dv-bulk-select-all">

            <input

              type="checkbox"

              checked={allVisibleReviewSelected}

              disabled={visibleReviewRows.length === 0}

              onChange={(event) =>

                setVisibleSelection(visibleReviewRows, event.target.checked)

              }

            />

            <span>

              {allVisibleReviewSelected

                ? "Clear visible"

                : "Select all visible review items"}

            </span>

          </label>



          <div className="dv-bulk-actions">

            <strong>{selectedRows.length.toLocaleString()} selected</strong>

            <select

              value={bulkRule}

              onChange={(event) => setBulkRule(event.target.value)}

              disabled={!selectedRows.length}

              aria-label="Bulk correction rule"

            >

              {correctionRules

                .filter((rule) => !isManualCorrectionRule(rule.correction_rule_cd))

                .map((rule) => (

                  <option

                    key={rule.correction_rule_cd}

                    value={rule.correction_rule_cd}

                  >

                    {rule.correction_rule_cd.toUpperCase()} - {rule.correction_rule_name}

                  </option>

                ))}

            </select>

            <button

              className="dv-primary-button"

              disabled={!selectedRows.length}

              onClick={() => setBulkPreviewOpen(true)}

            >

              <Layers3 size={16} />

              Preview Bulk Correction

            </button>

          </div>

        </div>



        {error && <div className="dv-error">{error}</div>}

        {detailLoading && <div className="dv-empty">Loading deviations...</div>}

        {!detailLoading && (

          <div className="dv-table-scroll">

            <table className="dv-table dv-detail-table">

              <thead>

                <tr>

                  <th>Status</th>

                  <th>Meter</th>

                  <th>Facility</th>

                  <th>Utility</th>

                  <th>Original Consumption</th>

                  <th>Prior Year Consumption</th>

                  <th>Δ Year</th>

                  <th>Prev Month Consumption</th>

                  <th>Δ Month</th>

                  <th>Rule</th>

                  <th>Final Adjusted Consumption</th>

                  <th>DIVA Action</th>

                  <th />

                </tr>

              </thead>

              <tbody>

                {filteredRows.map((row) => (

                  <tr key={`${row.meterid}-${row.period}`} className="dv-row-flagged">

                    <td>

                      {row.autoCorrected ? (

                        <span className="dv-badge dv-badge-auto">

                          <CheckCircle2 size={14} />

                          Auto Corrected

                        </span>

                      ) : (

                        <span className="dv-badge dv-badge-warning">

                          <AlertTriangle size={14} />

                          Review Required

                        </span>

                      )}

                    </td>

                    <td className="dv-id-cell">{row.meterid}</td>

                    <td>{row.facilityNbr || "—"}</td>

                    <td>{row.utilityType || "—"}</td>

                    <td>{formatNumber(row.consumption)}</td>

                    <td>{formatNumber(row.previousYearConsumption)}</td>

                    <td className={row.yearFlag ? "dv-deviation-value" : ""}>

                      {formatPercent(row.previousYearPercent, row.yearFlag)}

                    </td>

                    <td>{formatNumber(row.previousMonthConsumption)}</td>

                    <td className={row.monthFlag ? "dv-deviation-value" : ""}>

                      {formatPercent(row.previousMonthPercent, row.monthFlag)}

                    </td>

                    <td>{row.correctionRule ? row.correctionRule.toUpperCase() : "—"}</td>

                    <td>{formatNumber(row.adjustedConsumption)}</td>

                    <td>

                      {row.validationAction === "AMR_QUARANTINED"
                        ? "AMR quarantined — review required"
                        : row.validationAction === "AMR_INSUFFICIENT_HISTORY"
                          ? "AMR quarantined — insufficient history"
                          : row.validationAction ||
                            (row.autoCorrected ? "Rule E — Previous Year" : row.reason)}

                    </td>

                    <td>

                      {isReviewRow(row) && (

                        <button

                          className="dv-primary-button dv-small-button"

                          onClick={() => startCorrection(row)}

                        >

                          Review / Correct

                        </button>

                      )}

                    </td>

                  </tr>

                ))}

                {filteredRows.length === 0 && (

                  <tr>

                    <td colSpan={13} className="dv-empty-row">

                      No DIVA records match the selected filter.

                    </td>

                  </tr>

                )}

              </tbody>

            </table>

          </div>

        )}

      </div>

      {bulkPreviewOpen && (

        <div

          className="dv-modal-backdrop"

          onMouseDown={() => !bulkSaving && setBulkPreviewOpen(false)}

        >

          <div

            className="dv-modal dv-bulk-modal"

            onMouseDown={(event) => event.stopPropagation()}

          >

            <div className="dv-modal-header">

              <div>

                <p>Bulk DIVA Correction</p>

                <h2>

                  Rule {bulkRule.toUpperCase()} — {selectedRows.length.toLocaleString()} selected

                </h2>

              </div>

              <button

                className="dv-icon-button"

                onClick={() => setBulkPreviewOpen(false)}

                disabled={bulkSaving}

                aria-label="Close"

              >

                <X size={20} />

              </button>

            </div>



            <div className="dv-bulk-summary">

              <div><span>Selected</span><strong>{selectedRows.length}</strong></div>

              <div><span>Eligible</span><strong>{bulkEligibleRows.length}</strong></div>

              <div>

                <span>Cannot Calculate</span>

                <strong>{bulkPreviewRows.length - bulkEligibleRows.length}</strong>

              </div>

            </div>



            <div className="dv-bulk-preview-table">

              <table className="dv-table">

                <thead>

                  <tr>

                    <th>Meter</th>

                    <th>Result</th>

                    <th>Adjusted Consumption</th>

                    <th>Calculation / Reason</th>

                  </tr>

                </thead>

                <tbody>

                  {bulkPreviewRows.map((row) => (

                    <tr key={`${row.meterid}-${row.period}`}>

                      <td className="dv-id-cell">{row.meterid}</td>

                      <td>

                        <span className={row.eligible ? "dv-badge dv-badge-ok" : "dv-badge dv-badge-warning"}>

                          {row.eligible ? "Eligible" : "Excluded"}

                        </span>

                      </td>

                      <td>

                        {row.eligible ? formatNumber(Number(row.adjustedConsumption)) : "—"}

                      </td>

                      <td>{row.eligible ? row.formula : row.reason}</td>

                    </tr>

                  ))}

                </tbody>

              </table>

            </div>



            <div className="dv-modal-note">

              The same correction rule is applied to every eligible meter, but each

              adjusted-consumption value is calculated from that meter&apos;s own history.

              Excluded rows are not changed.

            </div>



            <div className="dv-modal-actions">

              <button

                className="dv-secondary-button"

                onClick={() => setBulkPreviewOpen(false)}

                disabled={bulkSaving}

              >

                Cancel

              </button>

              <button

                className="dv-primary-button"

                onClick={() => void applyBulkCorrection()}

                disabled={bulkSaving || bulkEligibleRows.length === 0}

              >

                {bulkSaving

                  ? "Applying..."

                  : `Apply Rule ${bulkRule.toUpperCase()} to ${bulkEligibleRows.length} Meter${

                      bulkEligibleRows.length === 1 ? "" : "s"

                    }`}

              </button>

            </div>

          </div>

        </div>

      )}



      {editing && (

        <div className="dv-modal-backdrop" onMouseDown={() => !saving && setEditing(null)}>

          <div className="dv-modal" onMouseDown={(event) => event.stopPropagation()}>

            <div className="dv-modal-header">

              <div>

                <p>Meter Reading Correction</p>

                <h2>{editing.meterid}</h2>

              </div>

              <button

                className="dv-icon-button"

                onClick={() => setEditing(null)}

                disabled={saving}

                aria-label="Close"

              >

                <X size={20} />

              </button>

            </div>

            <div className="dv-validation-sequence">

              <div className="dv-validation-sequence-title">

                Validation Review

              </div>

              <div className="dv-validation-rule-row">

                <div>

                  <strong>Rule 1 — Previous Year</strong>

                  <span>

                    PASS only when the deviation is greater than -50% and less than +50%. ±50% or beyond is a FAIL.

                  </span>

                </div>

                <div className={editing.yearFlag ? "dv-rule-fail" : "dv-rule-pass"}>

                  {editing.yearFlag ? "FAILED" : "PASSED"}

                  <span>{formatPercent(editing.previousYearPercent, editing.yearFlag)}</span>

                </div>

              </div>

              <div className="dv-validation-rule-row">

                <div>

                  <strong>Rule 2 — Previous Month</strong>

                  <span>

                    Evaluated after Rule 1 fails. PASS only when the deviation is greater than -50% and less than +50%. ±50% or beyond is a FAIL.

                  </span>

                </div>

                <div className={editing.monthFlag ? "dv-rule-fail" : "dv-rule-pass"}>

                  {editing.monthFlag ? "FAILED" : "PASSED"}

                  <span>{formatPercent(editing.previousMonthPercent, editing.monthFlag)}</span>

                </div>

              </div>

              <div className="dv-recommended-correction">
                <span>
                  {editing.recommendedCorrectionRule
                    ? "Recommended Correction"
                    : "Validation Disposition"}
                </span>
                {editing.recommendedCorrectionRule ? (
                  <>
                    <strong>
                      {editing.recommendedCorrectionRule.toUpperCase()} - {
                        correctionRules.find(
                          (rule) =>
                            normalizeRule(rule.correction_rule_cd) ===
                            normalizeRule(editing.recommendedCorrectionRule),
                        )?.correction_rule_name || "Correction Rule"
                      }
                      {normalizeRule(editing.recommendedCorrectionRule) === "e" &&
                      editing.previousYearConsumption !== null
                        ? ` (${formatNumber(editing.previousYearConsumption)})`
                        : ""}
                    </strong>
                    <small>
                      Review the historical values below before saving the correction.
                    </small>
                  </>
                ) : (
                  <>
                    <strong>Manual review required — no automatic correction applied</strong>
                    <small>
                      The source value has been preserved. Choose a correction rule or
                      adjusted consumption only after reviewing the meter history.
                    </small>
                  </>
                )}
              </div>

            </div>

            <div className="dv-reference-grid">

              <div>

                <span>Calculated Consumption</span>

                <strong>{formatNumber(editing.consumption)}</strong>

              </div>

              <div>

                <span>Previous Month</span>

                <strong>{formatNumber(editing.previousMonthConsumption)}</strong>

              </div>

              <div>

                <span>2 Months Prior</span>

                <strong>{formatNumber(editing.previous2MonthConsumption)}</strong>

              </div>

              <div>

                <span>3 Months Prior</span>

                <strong>{formatNumber(editing.previous3MonthConsumption)}</strong>

              </div>

              <div>

                <span>Next Month</span>

                <strong>{formatNumber(editing.nextMonthConsumption)}</strong>

              </div>

              <div>

                <span>Same Month Prior FY</span>

                <strong>{formatNumber(editing.previousYearConsumption)}</strong>

              </div>

              <div>

                <span>Month Deviation</span>

                <strong>{formatPercent(editing.previousMonthPercent, editing.monthFlag)}</strong>

              </div>

              <div>

                <span>Year Deviation</span>

                <strong>{formatPercent(editing.previousYearPercent, editing.yearFlag)}</strong>

              </div>

            </div>

            <div className="dv-form-grid">

              <label>

                <span>Current Reading</span>

                <input

                  value={draft.reading}

                  onChange={(event) =>

                    setDraft((current) => ({ ...current, reading: event.target.value }))

                  }

                  inputMode="decimal"

                />

              </label>

              <label>

                <span>Correction Rule</span>

                <select

                  value={draft.correctionRule}

                  onChange={(event) => {

                    const rule = event.target.value;

                    const calculation = calculateRuleAdjustment(editing, rule);

                    setDraft((current) => ({

                      ...current,

                      correctionRule: rule,

                      adjustedConsumption: calculation.automatic

                        ? calculation.value

                        : current.adjustedConsumption,

                    }));

                  }}

                >

                  <option value="">No correction</option>

                  {correctionRules.map((rule) => (

                    <option

                      key={rule.correction_rule_cd}

                      value={rule.correction_rule_cd}

                    >

                      {rule.correction_rule_cd} - {rule.correction_rule_name}

                    </option>

                  ))}

                </select>

              </label>

              <label>

                <span>Adjusted Consumption</span>

                <input

                  value={draft.adjustedConsumption}

                  readOnly={Boolean(liveCalculation?.automatic)}

                  onChange={(event) =>

                    setDraft((current) => ({

                      ...current,

                      adjustedConsumption: event.target.value,

                    }))

                  }

                  placeholder={

                    liveCalculation?.automatic

                      ? "Calculated automatically"

                      : "Enter adjusted consumption"

                  }

                  inputMode="decimal"

                />

              </label>

              <label>

                <span>Used in Calculation</span>

                <select

                  value={draft.usedInCalculation}

                  onChange={(event) =>

                    setDraft((current) => ({

                      ...current,

                      usedInCalculation: event.target.value,

                    }))

                  }

                >

                  <option value="1">Yes</option>

                  <option value="0">No</option>

                </select>

              </label>

            </div>

            <div className="dv-calculation-panel">

              <div className="dv-calculation-heading">

                <span>Adjusted Consumption Preview</span>

                <strong>

                  {draft.adjustedConsumption.trim() &&

                  Number.isFinite(Number(draft.adjustedConsumption))

                    ? formatNumber(Number(draft.adjustedConsumption))

                    : "—"}

                </strong>

              </div>

              <div className="dv-calculation-formula">

                {liveCalculation?.formula ??

                  "Select a correction rule to see the calculation."}

              </div>

              {draft.correctionRule && (

                <div className="dv-calculation-rule">

                  {correctionRules.find(

                    (rule) =>

                      normalizeRule(rule.correction_rule_cd) ===

                      normalizeRule(draft.correctionRule),

                  )?.correction_rule_description || ""}

                </div>

              )}

            </div>

            <div className="dv-modal-note">

              Saving a changed current reading recalculates consumption, reruns the

              stored validation rules, and updates validation_required,

              validation_status, rule IDs, deviation percentages, and validation timestamp.

            </div>
              <div className="dv-modal-note">
                Resolve validation errors in billing-period order. A month cannot be cleared
                while the same meter still has an unresolved previous month. When an exception
                is resolved, Used in Calculation inherits the previous month's setting.
              </div>

            <div className="dv-modal-actions">

              <button

                className="dv-secondary-button"

                onClick={() => setEditing(null)}

                disabled={saving}

              >

                Cancel

              </button>

              <button

                className="dv-primary-button"

                onClick={() => void saveCorrection()}

                disabled={saving}

              >

                {saving ? "Saving..." : "Save Correction"}

              </button>

            </div>

          </div>

        </div>

      )}

    </section>

  );

}
