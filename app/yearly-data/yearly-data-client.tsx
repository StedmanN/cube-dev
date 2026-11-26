"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useAppSection } from "@/components/app-section-navigation";
import {
  ArrowDownAZ,
  ArrowUpAZ,
  BarChart3,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  X,
} from "lucide-react";

export type CategoryCodeRecord = {
  category_cd: string;
  category_nm: string;
  category_desc: string;
  area_um: string;
  space_type_id: string;
  space_type: string;
};

export type SpaceTypeRecord = {
  space_type_id: string;
  description: string;
};

export type IntensityValueRecord = {
  intensityid: string;
  fy: number;
  index: number;
  space_type: string;
  space_type_id: number;
  utility_type_cd: string;
};

type IntensitySuggestion = {
  intensityid: string; fy: number; utility_type_cd: string;
  space_type_id: number; space_type: string; previous_index: number;
  suggested_index: number; change_pct: number;
  method: "CALIBRATED" | "CARRY_FORWARD";
  confidence: "HIGH" | "MEDIUM" | "LOW"; periods_with_area: number;
  unconstrained_index?: number;
  unconstrained_change_pct?: number;
};

type UtilityDiagnostic = {
  utilityType: string;
  periods: number;
  invoiceTotal: number;
  currentEstimateTotal: number;
  suggestedEstimateTotal: number;
  currentTotalVariance: number;
  suggestedTotalVariance: number;
  currentTotalErrorPct: number | null;
  suggestedTotalErrorPct: number | null;
  currentMape: number | null;
  suggestedMape: number | null;
  improvementPercentagePoints: number | null;
  currentBias: "OVER" | "UNDER" | "BALANCED";
  suggestedBias: "OVER" | "UNDER" | "BALANCED";
};

type PeriodDiagnostic = {
  fy: number;
  billingPeriodId: number;
  utilityType: string;
  actual: number;
  currentEstimate: number;
  suggestedEstimate: number;
  currentErrorPct: number | null;
  suggestedErrorPct: number | null;
  currentVariance: number;
  suggestedVariance: number;
};

type BoundaryDiagnostic = {
  intensityid: string;
  utility_type_cd: string;
  space_type_id: number;
  space_type: string;
  previous_index: number;
  suggested_index: number;
  change_pct: number;
  boundary: "LOWER" | "UPPER";
};

type PwUnconstrainedDiagnostic = {
  space_type_id: number;
  space_type: string;
  previous_index: number;
  constrained_index: number;
  unconstrained_index: number;
  constrained_change_pct: number;
  unconstrained_change_pct: number;
  periods_with_area: number;
};

type PwModelDiagnostic = {
  periods: number;
  invoiceTotal: number;
  currentEstimateTotal: number;
  constrainedEstimateTotal: number;
  unconstrainedEstimateTotal: number;
  currentMape: number | null;
  constrainedMape: number | null;
  unconstrainedMape: number | null;
  currentTotalErrorPct: number | null;
  constrainedTotalErrorPct: number | null;
  unconstrainedTotalErrorPct: number | null;
  currentBias: "OVER" | "UNDER" | "BALANCED";
  constrainedBias: "OVER" | "UNDER" | "BALANCED";
  unconstrainedBias: "OVER" | "UNDER" | "BALANCED";
};

type InvoiceUnitDiagnostic = {
  utilityType: string;
  consumptionUnit: string;
  rows: number;
  rawConsumptionTotal: number;
  normalizedConsumptionTotal: number | null;
  status: "INCLUDED" | "CONVERTED" | "EXCLUDED";
};

type IntensitySuggestionResponse = {
  ok: boolean;
  targetFy: number;
  baselineFy: number;
  trainingYears: number[];
  settings: {
    maximumAdjustmentPct: number;
    minimumPeriodsForCalibration: number;
  };
  summary: {
    billingPeriodsAnalyzed: number;
    invoicePeriodUtilityPairs: number;
    ignoredInvoiceRowsUnknownUnit: number;
    currentModelMape: number | null;
    suggestedModelMape: number | null;
    improvementPercentagePoints: number | null;
    totalSuggestions: number;
    calibratedSuggestions: number;
    carryForwardSuggestions: number;
  };
  diagnostics?: {
    utilities: UtilityDiagnostic[];
    periods: PeriodDiagnostic[];
    worstPeriods: PeriodDiagnostic[];
    boundaryHits: BoundaryDiagnostic[];
    boundaryHitCount: number;
    ignoredInvoiceRowsUnknownUnit: number;
    invoiceUnits: InvoiceUnitDiagnostic[];
    pwUnconstrainedTest: {
      model: PwModelDiagnostic;
      intensities: PwUnconstrainedDiagnostic[];
    };
    zeroBaselineCarryForwardCount: number;
  };
  suggestions: IntensitySuggestion[];
  error?: string;
};

type SortDirection = "asc" | "desc";

const EMPTY_FORM: CategoryCodeRecord = {
  category_cd: "",
  category_nm: "",
  category_desc: "",
  area_um: "",
  space_type_id: "0",
  space_type: "NA",
};

const SPACE_TYPES: Record<string, string> = {
  "0": "NA",
  "1": "Office",
  "2": "Warehouse",
  "3": "Hangar",
  "4": "Industrial",
  "5": "Residential",
  "6": "Retail",
  "7": "Data Center",
};

function normalizeRecord(
  value: Partial<CategoryCodeRecord>,
): CategoryCodeRecord {
  return {
    category_cd: String(value.category_cd ?? "").trim(),
    category_nm: String(value.category_nm ?? "").trim(),
    category_desc: String(value.category_desc ?? "").trim(),
    area_um: String(value.area_um ?? "").trim(),
    space_type_id: String(value.space_type_id ?? "0").trim() || "0",
    space_type: String(value.space_type ?? "").trim(),
  };
}
function formatDiagnosticNumber(value: number): string {
  if (!Number.isFinite(value)) return "—";
  const absolute = Math.abs(value);
  if (absolute >= 1_000_000) {
    return value.toLocaleString(undefined, { maximumFractionDigits: 0 });
  }
  if (absolute >= 1_000) {
    return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
  }
  return value.toLocaleString(undefined, { maximumFractionDigits: 4 });
}
function formatDiagnosticPct(value: number | null): string {
  return value === null || !Number.isFinite(value)
    ? "—"
    : `${value.toFixed(2)}%`;
}
function diagnosticBiasLabel(
  value: "OVER" | "UNDER" | "BALANCED",
): string {
  if (value === "OVER") return "Over estimate";
  if (value === "UNDER") return "Under estimate";
  return "Balanced";
}

export function YearlyDataClient() {
  const { activeSection: activeTab } = useAppSection();

  const [records, setRecords] = useState<CategoryCodeRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const [search, setSearch] = useState("");
  const [sortDirection, setSortDirection] =
    useState<SortDirection>("asc");

  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [form, setForm] =
    useState<CategoryCodeRecord>(EMPTY_FORM);

  const [spaceTypes, setSpaceTypes] = useState<SpaceTypeRecord[]>([]);
  const [spaceTypesLoading, setSpaceTypesLoading] = useState(false);
  const [spaceTypeSearch, setSpaceTypeSearch] = useState("");
  const [spaceTypeModalOpen, setSpaceTypeModalOpen] = useState(false);
  const [spaceTypeEditing, setSpaceTypeEditing] = useState(false);
  const [spaceTypeSaving, setSpaceTypeSaving] = useState(false);
  const [spaceTypeForm, setSpaceTypeForm] = useState<SpaceTypeRecord>({
    space_type_id: "",
    description: "",
  });

  const [intensityValues, setIntensityValues] =
    useState<IntensityValueRecord[]>([]);
  const [intensityLoading, setIntensityLoading] = useState(false);
  const [intensitySearch, setIntensitySearch] = useState("");
  const [intensityModalOpen, setIntensityModalOpen] = useState(false);
  const [intensityEditing, setIntensityEditing] = useState(false);
  const [intensitySaving, setIntensitySaving] = useState(false);
  const [intensityForm, setIntensityForm] =
    useState<IntensityValueRecord>({
      intensityid: "",
      fy: new Date().getFullYear(),
      index: 0,
      space_type: "NA",
      space_type_id: 0,
      utility_type_cd: "",
    });
  const latestIntensityFy = useMemo(() => intensityValues.length ? Math.max(...intensityValues.map((item) => item.fy)) : new Date().getFullYear(), [intensityValues]);
  const [suggestionTargetFy, setSuggestionTargetFy] = useState(new Date().getFullYear() + 1);
  const [suggestionLoading, setSuggestionLoading] = useState(false);
  const [suggestionSaving, setSuggestionSaving] = useState(false);
  const [suggestionResult, setSuggestionResult] = useState<IntensitySuggestionResponse | null>(null);
  const boundaryHitsByUtility = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const item of suggestionResult?.diagnostics?.boundaryHits ?? []) {
      counts[item.utility_type_cd] = (counts[item.utility_type_cd] ?? 0) + 1;
    }
    return counts;
  }, [suggestionResult]);
  const invoiceUnitDiagnostics =
    suggestionResult?.diagnostics?.invoiceUnits ?? [];

  const invoiceUnitSummary = useMemo(() => {
    let includedRows = 0;
    let convertedRows = 0;
    let excludedRows = 0;

    for (const item of invoiceUnitDiagnostics) {
      if (item.status === "INCLUDED") includedRows += item.rows;
      else if (item.status === "CONVERTED") convertedRows += item.rows;
      else excludedRows += item.rows;
    }

    return {
      includedRows,
      convertedRows,
      excludedRows,
      totalRows: includedRows + convertedRows + excludedRows,
    };
  }, [invoiceUnitDiagnostics]);

  const loadCategoryCodes = useCallback(async () => {
    setLoading(true);
    setError("");

    try {
      const response = await fetch("/api/yearly-data/category-codes", {
        method: "GET",
        cache: "no-store",
      });

      const payload = await response.json();

      if (!response.ok || !payload.ok) {
        throw new Error(
          payload.error || "Unable to load Category Codes.",
        );
      }
      
      setRecords(
        (payload.items ?? []).map(
          (item: Partial<CategoryCodeRecord>) =>
            normalizeRecord(item),
        ),
      );
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : "Unable to load Category Codes.",
      );
    } finally {
      setLoading(false);
    }
  }, []);
  const loadSpaceTypes = useCallback(async () => {
    setSpaceTypesLoading(true);
    setError("");
    try {
      const response = await fetch("/api/yearly-data/space-types", {
        method: "GET",
        cache: "no-store",
      });
      const payload = await response.json();
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || "Unable to load Space Types.");
      }
      setSpaceTypes(
        (payload.items ?? []).map((item: Partial<SpaceTypeRecord>) => ({
          space_type_id: String(item.space_type_id ?? "").trim(),
          description: String(item.description ?? "").trim(),
        })),
      );
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : "Unable to load Space Types.",
      );
    } finally {
      setSpaceTypesLoading(false);
    }
  }, []);
  useEffect(() => {
    void loadCategoryCodes();
  }, [loadCategoryCodes]);
  useEffect(() => {
    if (activeTab === "space-types" && spaceTypes.length === 0) {
      void loadSpaceTypes();
    }
  }, [activeTab, loadSpaceTypes, spaceTypes.length]);
  const loadIntensityValues = useCallback(async () => {
    setIntensityLoading(true);
    setError("");
    try {
      const response = await fetch("/api/yearly-data/intensity-values", {
        method: "GET",
        cache: "no-store",
      });
      const payload = await response.json();
      if (!response.ok || !payload.ok) {
        throw new Error(
          payload.error || "Unable to load Intensity Values.",
        );
      }
      setIntensityValues(payload.items ?? []);
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : "Unable to load Intensity Values.",
      );
    } finally {
      setIntensityLoading(false);
    }
  }, []);
  useEffect(() => {
    if (
      activeTab === "intensity-values" &&
      intensityValues.length === 0
    ) {
      void loadIntensityValues();
    }
  }, [activeTab, loadIntensityValues, intensityValues.length]);
  const filteredRecords = useMemo(() => {
    const query = search.trim().toLowerCase();
    const filtered = !query
      ? [...records]
      : records.filter((record) =>
          [
            record.category_cd,
            record.category_nm,
            record.category_desc,
            record.area_um,
            record.space_type_id,
            record.space_type,
          ].some((field) =>
            field.toLowerCase().includes(query),
          ),
        );
    filtered.sort((a, b) => {
      const result = a.category_cd.localeCompare(
        b.category_cd,
        undefined,
        {
          numeric: true,
          sensitivity: "base",
        },
      );
      return sortDirection === "asc" ? result : -result;
    });
    return filtered;
  }, [records, search, sortDirection]);
  const filteredSpaceTypes = useMemo(() => {
    const query = spaceTypeSearch.trim().toLowerCase();
    return [...spaceTypes]
      .filter((item) =>
        !query ||
        item.space_type_id.toLowerCase().includes(query) ||
        item.description.toLowerCase().includes(query),
      )
      .sort((a, b) =>
        a.space_type_id.localeCompare(b.space_type_id, undefined, {
          numeric: true,
          sensitivity: "base",
        }),
      );
  }, [spaceTypes, spaceTypeSearch]);
  function openSpaceTypeCreate() {
    setSpaceTypeEditing(false);
    setSpaceTypeForm({ space_type_id: "", description: "" });
    setError("");
    setMessage("");
    setSpaceTypeModalOpen(true);
  }
  function openSpaceTypeEdit(record: SpaceTypeRecord) {
    setSpaceTypeEditing(true);
    setSpaceTypeForm(record);
    setError("");
    setMessage("");
    setSpaceTypeModalOpen(true);
  }
  async function saveSpaceType() {
    const item = {
      space_type_id: spaceTypeForm.space_type_id.trim(),
      description: spaceTypeForm.description.trim(),
    };
    if (!item.space_type_id) {
      setError("Space Type ID is required.");
      return;
    }
    if (!item.description) {
      setError("Description is required.");
      return;
    }
    setSpaceTypeSaving(true);
    setError("");
    setMessage("");
    try {
      const response = await fetch("/api/yearly-data/space-types", {
        method: spaceTypeEditing ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(item),
      });
      const payload = await response.json();
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || "Unable to save Space Type.");
      }
      const saved: SpaceTypeRecord = {
        space_type_id: String(payload.item.space_type_id ?? "").trim(),
        description: String(payload.item.description ?? "").trim(),
      };
      setSpaceTypes((current) => [
        ...current.filter(
          (record) => record.space_type_id !== saved.space_type_id,
        ),
        saved,
      ]);
      setSpaceTypeModalOpen(false);
      setMessage(
        spaceTypeEditing
          ? `Space Type ${saved.space_type_id} updated.`
          : `Space Type ${saved.space_type_id} created.`,
      );
    } catch (saveError) {
      setError(
        saveError instanceof Error
          ? saveError.message
          : "Unable to save Space Type.",
      );
    } finally {
      setSpaceTypeSaving(false);
    }
  }
  async function deleteSpaceType(record: SpaceTypeRecord) {
    if (
      !window.confirm(
        `Delete Space Type ${record.space_type_id} - ${record.description}?`,
      )
    ) {
      return;
    }
    setError("");
    setMessage("");
    try {
      const response = await fetch(
        `/api/yearly-data/space-types?space_type_id=${encodeURIComponent(
          record.space_type_id,
        )}`,
        { method: "DELETE" },
      );
      const payload = await response.json();
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || "Unable to delete Space Type.");
      }
      setSpaceTypes((current) =>
        current.filter(
          (item) => item.space_type_id !== record.space_type_id,
        ),
      );
      setMessage(`Space Type ${record.space_type_id} deleted.`);
    } catch (deleteError) {
      setError(
        deleteError instanceof Error
          ? deleteError.message
          : "Unable to delete Space Type.",
      );
    }
  }
  useEffect(() => {
    if (!intensityValues.length) return;
    const nextFy = latestIntensityFy + 1;
    setSuggestionTargetFy((current) => current <= latestIntensityFy ? nextFy : current);
  }, [intensityValues, latestIntensityFy]);
  const targetFyAlreadyExists = useMemo(() => intensityValues.some((item) => item.fy === suggestionTargetFy), [intensityValues, suggestionTargetFy]);
  async function generateIntensitySuggestions() {
    setSuggestionLoading(true); setSuggestionResult(null); setError(""); setMessage("");
    try {
      if (!Number.isInteger(suggestionTargetFy) || suggestionTargetFy <= 0) throw new Error("Enter a valid target fiscal year.");
      if (targetFyAlreadyExists) throw new Error(`FY${suggestionTargetFy} already has intensity values. Suggestions can only be generated for a new fiscal year.`);
      const response = await fetch("/api/yearly-data/intensity-suggestions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ targetFy: suggestionTargetFy }) });
      const payload = await response.json() as IntensitySuggestionResponse;
      if (!response.ok || !payload.ok) throw new Error(payload.error || "Unable to generate suggested intensity values.");
      setSuggestionResult(payload);
      setMessage(`Generated ${payload.suggestions.length} suggested intensity values for FY${payload.targetFy}. Review them before creating the new fiscal year.`);
    } catch (e) { setError(e instanceof Error ? e.message : "Unable to generate suggested intensity values."); }
    finally { setSuggestionLoading(false); }
  }
  function discardIntensitySuggestions() { setSuggestionResult(null); setError(""); setMessage(""); }
  async function createSuggestedIntensityValues() {
    if (!suggestionResult) return;
    if (!window.confirm(`Create ${suggestionResult.suggestions.length} intensity values for FY${suggestionResult.targetFy}?`)) return;
    setSuggestionSaving(true); setError(""); setMessage("");
    let created = 0;
    try {
      if (intensityValues.some((item) => item.fy === suggestionResult.targetFy)) throw new Error(`FY${suggestionResult.targetFy} already has intensity values.`);
      for (const suggestion of suggestionResult.suggestions) {
        const item: IntensityValueRecord = { intensityid: buildIntensityId(suggestionResult.targetFy, suggestion.utility_type_cd, suggestion.space_type_id), fy: suggestionResult.targetFy, index: suggestion.suggested_index, space_type: suggestion.space_type, space_type_id: suggestion.space_type_id, utility_type_cd: suggestion.utility_type_cd.toUpperCase() };
        const response = await fetch("/api/yearly-data/intensity-values", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(item) });
        const payload = await response.json();
        if (!response.ok || !payload.ok) throw new Error(payload.error || `Unable to create ${item.intensityid}. ${created} records were created before the error.`);
        created += 1;
      }
      await loadIntensityValues(); setSuggestionResult(null); setMessage(`FY${suggestionResult.targetFy} intensity values created successfully (${created} records).`);
    } catch (e) { await loadIntensityValues(); setError(e instanceof Error ? e.message : "Unable to create suggested intensity values."); }
    finally { setSuggestionSaving(false); }
  }
  const filteredIntensityValues = useMemo(() => {
    const query = intensitySearch.trim().toLowerCase();
    return [...intensityValues]
      .filter((item) => {
        if (!query) return true;
        return [
          item.intensityid,
          String(item.fy),
          String(item.index),
          item.space_type,
          String(item.space_type_id),
          item.utility_type_cd,
        ].some((field) =>
          field.toLowerCase().includes(query),
        );
      })
      .sort((a, b) =>
        a.fy !== b.fy
          ? b.fy - a.fy
          : a.intensityid.localeCompare(
              b.intensityid,
              undefined,
              { numeric: true, sensitivity: "base" },
            ),
      );
  }, [intensityValues, intensitySearch]);
  function buildIntensityId(
    fy: number,
    utilityType: string,
    spaceTypeId: number,
  ) {
    return `${fy}#${utilityType.trim().toUpperCase()}#${spaceTypeId}`;
  }
  function openIntensityCreate() {
    const fy = new Date().getFullYear();
    setIntensityEditing(false);
    setIntensityForm({
      intensityid: "",
      fy,
      index: 0,
      space_type: "NA",
      space_type_id: 0,
      utility_type_cd: "",
    });
    setError("");
    setMessage("");
    setIntensityModalOpen(true);
  }
  function openIntensityEdit(record: IntensityValueRecord) {
    setIntensityEditing(true);
    setIntensityForm(record);
    setError("");
    setMessage("");
    setIntensityModalOpen(true);
  }
  function updateIntensityForm(
    field: keyof IntensityValueRecord,
    value: string,
  ) {
    setIntensityForm((current) => {
      if (field === "fy") {
        const fy = Number(value);
        return {
          ...current,
          fy,
          intensityid: intensityEditing
            ? current.intensityid
            : buildIntensityId(
                fy,
                current.utility_type_cd,
                current.space_type_id,
              ),
        };
      }
      if (field === "index") {
        return { ...current, index: Number(value) };
      }
      if (field === "space_type_id") {
        const id = Number(value);
        return {
          ...current,
          space_type_id: id,
          space_type: SPACE_TYPES[String(id)] ?? "",
          intensityid: intensityEditing
            ? current.intensityid
            : buildIntensityId(
                current.fy,
                current.utility_type_cd,
                id,
              ),
        };
      }
      if (field === "utility_type_cd") {
        const utilityType = value.toUpperCase();
        return {
          ...current,
          utility_type_cd: utilityType,
          intensityid: intensityEditing
            ? current.intensityid
            : buildIntensityId(
                current.fy,
                utilityType,
                current.space_type_id,
              ),
        };
      }
      return { ...current, [field]: value };
    });
  }
  async function saveIntensityValue() {
    const item = {
      ...intensityForm,
      intensityid: intensityEditing
        ? intensityForm.intensityid
        : buildIntensityId(
            intensityForm.fy,
            intensityForm.utility_type_cd,
            intensityForm.space_type_id,
          ),
      utility_type_cd:
        intensityForm.utility_type_cd.trim().toUpperCase(),
      space_type:
        SPACE_TYPES[String(intensityForm.space_type_id)] ?? "",
    };
    if (!Number.isInteger(item.fy) || item.fy <= 0) {
      setError("Fiscal Year is required.");
      return;
    }
    if (!item.utility_type_cd) {
      setError("Utility Type Code is required.");
      return;
    }
    if (!Number.isFinite(item.index)) {
      setError("Index must be a valid number.");
      return;
    }
    setIntensitySaving(true);
    setError("");
    setMessage("");
    try {
      const response = await fetch(
        "/api/yearly-data/intensity-values",
        {
          method: intensityEditing ? "PUT" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(item),
        },
      );
      const payload = await response.json();
      if (!response.ok || !payload.ok) {
        throw new Error(
          payload.error || "Unable to save Intensity Value.",
        );
      }
      const saved = payload.item as IntensityValueRecord;
      setIntensityValues((current) => [
        ...current.filter(
          (record) => record.intensityid !== saved.intensityid,
        ),
        saved,
      ]);
      setIntensityModalOpen(false);
      setMessage(
        intensityEditing
          ? `Intensity Value ${saved.intensityid} updated.`
          : `Intensity Value ${saved.intensityid} created.`,
      );
    } catch (saveError) {
      setError(
        saveError instanceof Error
          ? saveError.message
          : "Unable to save Intensity Value.",
      );
    } finally {
      setIntensitySaving(false);
    }
  }
  async function deleteIntensityValue(
    record: IntensityValueRecord,
  ) {
    if (
      !window.confirm(
        `Delete Intensity Value ${record.intensityid}?`,
      )
    ) {
      return;
    }
    setError("");
    setMessage("");
    try {
      const response = await fetch(
        `/api/yearly-data/intensity-values?intensityid=${encodeURIComponent(
          record.intensityid,
        )}`,
        { method: "DELETE" },
      );
      const payload = await response.json();
      if (!response.ok || !payload.ok) {
        throw new Error(
          payload.error || "Unable to delete Intensity Value.",
        );
      }
      setIntensityValues((current) =>
        current.filter(
          (item) => item.intensityid !== record.intensityid,
        ),
      );
      setMessage(`Intensity Value ${record.intensityid} deleted.`);
    } catch (deleteError) {
      setError(
        deleteError instanceof Error
          ? deleteError.message
          : "Unable to delete Intensity Value.",
      );
    }
  }
  function openCreate() {
    setEditing(false);
    setForm(EMPTY_FORM);
    setError("");
    setMessage("");
    setModalOpen(true);
  }
  function openEdit(record: CategoryCodeRecord) {
    setEditing(true);
    setForm(record);
    setError("");
    setMessage("");
    setModalOpen(true);
  }
  function closeModal() {
    if (saving) return;
    setModalOpen(false);
    setForm(EMPTY_FORM);
  }
  function updateForm(
    field: keyof CategoryCodeRecord,
    value: string,
  ) {
    if (field === "space_type_id") {
      setForm((current) => ({
        ...current,
        space_type_id: value,
        space_type: SPACE_TYPES[value] ?? "",
      }));
      return;
    }
    setForm((current) => ({
      ...current,
      [field]: value,
    }));
  }
  async function saveCategoryCode() {
    setError("");
    setMessage("");
    const normalized = normalizeRecord(form);
    if (!normalized.category_cd) {
      setError("Category Code is required.");
      return;
    }
    setSaving(true);
    try {
      const response = await fetch(
        "/api/yearly-data/category-codes",
        {
          method: editing ? "PUT" : "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(normalized),
        },
      );
      const payload = await response.json();
      if (!response.ok || !payload.ok) {
        throw new Error(
          payload.error || "Unable to save Category Code.",
        );
      }
      const saved = normalizeRecord(payload.item);
      setRecords((current) => {
        const withoutSaved = current.filter(
          (item) => item.category_cd !== saved.category_cd,
        );
        return [...withoutSaved, saved];
      });
      setModalOpen(false);
      setForm(EMPTY_FORM);
      setMessage(
        editing
          ? `Category Code ${saved.category_cd} updated.`
          : `Category Code ${saved.category_cd} created.`,
      );
    } catch (saveError) {
      setError(
        saveError instanceof Error
          ? saveError.message
          : "Unable to save Category Code.",
      );
    } finally {
      setSaving(false);
    }
  }
  async function deleteCategoryCode(
    record: CategoryCodeRecord,
  ) {
    const confirmed = window.confirm(
      `Delete Category Code ${record.category_cd} - ${record.category_nm}?`,
    );
    if (!confirmed) return;
    setError("");
    setMessage("");
    try {
      const response = await fetch(
        `/api/yearly-data/category-codes?category_cd=${encodeURIComponent(
          record.category_cd,
        )}`,
        {
          method: "DELETE",
        },
      );
      const payload = await response.json();
      if (!response.ok || !payload.ok) {
        throw new Error(
          payload.error || "Unable to delete Category Code.",
        );
      }
      setRecords((current) =>
        current.filter(
          (item) =>
            item.category_cd !== record.category_cd,
        ),
      );
      setMessage(
        `Category Code ${record.category_cd} deleted.`,
      );
    } catch (deleteError) {
      setError(
        deleteError instanceof Error
          ? deleteError.message
          : "Unable to delete Category Code.",
      );
    }
  }
  return (
    <section className="bd-workspace yd-workspace">
      {activeTab === "category-codes" && (
        <div className="yd-content">
          <div className="yd-section-heading yd-category-heading">
            <div>
              <p className="yd-section-eyebrow">
                Yearly reference data
              </p>
              <h2>Category Codes</h2>
              <p>
                View and maintain Category Code reference
                records.
              </p>
            </div>
            <div className="yd-heading-actions">
              <button
                type="button"
                className="yd-secondary-button"
                onClick={() => void loadCategoryCodes()}
                disabled={loading}
              >
                <RefreshCw
                  size={15}
                  className={loading ? "yd-spin" : ""}
                />
                Refresh
              </button>
              <button
                type="button"
                className="yd-primary-button"
                onClick={openCreate}
              >
                <Plus size={16} />
                Add Category Code
              </button>
            </div>
          </div>
          {error && (
            <div className="yd-alert yd-alert-error">
              {error}
            </div>
          )}
          {message && (
            <div className="yd-alert yd-alert-success">
              {message}
            </div>
          )}
          <div className="yd-table-controls">
            <div className="yd-search">
              <Search size={16} />
              <input
                value={search}
                onChange={(event) =>
                  setSearch(event.target.value)
                }
                placeholder="Search category code, name, description, area, or space type..."
              />
            </div>
            <div className="yd-table-control-right">
              <span className="yd-record-count">
                {filteredRecords.length.toLocaleString()} of{" "}
                {records.length.toLocaleString()} records
              </span>
              <button
                type="button"
                className="yd-sort-button"
                onClick={() =>
                  setSortDirection((current) =>
                    current === "asc" ? "desc" : "asc",
                  )
                }
              >
                {sortDirection === "asc" ? (
                  <ArrowDownAZ size={16} />
                ) : (
                  <ArrowUpAZ size={16} />
                )}
                Cat Code
              </button>
            </div>
          </div>
          <div className="yd-table-shell">
            <table className="yd-table">
              <thead>
                <tr>
                  <th>Category Code</th>
                  <th>Category Name</th>
                  <th>Description</th>
                  <th>Area UM</th>
                  <th>Space Type ID</th>
                  <th>Space Type</th>
                  <th className="yd-actions-column">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr>
                    <td
                      colSpan={7}
                      className="yd-table-message"
                    >
                      Loading Category Codes...
                    </td>
                  </tr>
                ) : filteredRecords.length === 0 ? (
                  <tr>
                    <td
                      colSpan={7}
                      className="yd-table-message"
                    >
                      No Category Codes found.
                    </td>
                  </tr>
                ) : (
                  filteredRecords.map((record) => (
                    <tr key={record.category_cd}>
                      <td className="yd-code-cell">
                        {record.category_cd}
                      </td>
                      <td>{record.category_nm || "—"}</td>
                      <td className="yd-description-cell">
                        {record.category_desc || "—"}
                      </td>
                      <td>{record.area_um || "—"}</td>
                      <td>{record.space_type_id || "—"}</td>
                      <td>{record.space_type || "—"}</td>
                      <td>
                        <div className="yd-row-actions">
                          <button
                            type="button"
                            className="yd-icon-button"
                            title={`Edit ${record.category_cd}`}
                            onClick={() => openEdit(record)}
                          >
                            <Pencil size={15} />
                          </button>
                          <button
                            type="button"
                            className="yd-icon-button yd-delete-button"
                            title={`Delete ${record.category_cd}`}
                            onClick={() =>
                              void deleteCategoryCode(record)
                            }
                          >
                            <Trash2 size={15} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {activeTab === "space-types" && (
        <div className="yd-content">
          <div className="yd-section-heading yd-category-heading">
            <div>
              <p className="yd-section-eyebrow">Yearly reference data</p>
              <h2>Space Types</h2>
              <p>View and maintain Space Type reference records.</p>
            </div>
            <div className="yd-heading-actions">
              <button
                type="button"
                className="yd-secondary-button"
                onClick={() => void loadSpaceTypes()}
                disabled={spaceTypesLoading}
              >
                <RefreshCw
                  size={15}
                  className={spaceTypesLoading ? "yd-spin" : ""}
                />
                Refresh
              </button>
              <button
                type="button"
                className="yd-primary-button"
                onClick={openSpaceTypeCreate}
              >
                <Plus size={16} />
                Add Space Type
              </button>
            </div>
          </div>
          {error && <div className="yd-alert yd-alert-error">{error}</div>}
          {message && (
            <div className="yd-alert yd-alert-success">{message}</div>
          )}
          <div className="yd-table-controls">
            <div className="yd-search">
              <Search size={16} />
              <input
                value={spaceTypeSearch}
                onChange={(event) => setSpaceTypeSearch(event.target.value)}
                placeholder="Search Space Type ID or description..."
              />
            </div>
            <span className="yd-record-count">
              {filteredSpaceTypes.length} of {spaceTypes.length} records
            </span>
          </div>
          <div className="yd-table-shell">
            <table className="yd-table yd-space-type-table">
              <thead>
                <tr>
                  <th>Space Type ID</th>
                  <th>Description</th>
                  <th className="yd-actions-column">Actions</th>
                </tr>
              </thead>
              <tbody>
                {spaceTypesLoading ? (
                  <tr>
                    <td colSpan={3} className="yd-table-message">
                      Loading Space Types...
                    </td>
                  </tr>
                ) : filteredSpaceTypes.length === 0 ? (
                  <tr>
                    <td colSpan={3} className="yd-table-message">
                      No Space Types found.
                    </td>
                  </tr>
                ) : (
                  filteredSpaceTypes.map((record) => (
                    <tr key={record.space_type_id}>
                      <td className="yd-code-cell">
                        {record.space_type_id}
                      </td>
                      <td>{record.description}</td>
                      <td>
                        <div className="yd-row-actions">
                          <button
                            type="button"
                            className="yd-icon-button"
                            title={`Edit ${record.space_type_id}`}
                            onClick={() => openSpaceTypeEdit(record)}
                          >
                            <Pencil size={15} />
                          </button>
                          <button
                            type="button"
                            className="yd-icon-button yd-delete-button"
                            title={`Delete ${record.space_type_id}`}
                            onClick={() => void deleteSpaceType(record)}
                          >
                            <Trash2 size={15} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {activeTab === "intensity-values" && (
        <div className="yd-content">
          <div className="yd-section-heading yd-category-heading"><div><p className="yd-section-eyebrow">Yearly reference data</p><h2>Intensity Values</h2><p>View and maintain yearly utility intensity values by fiscal year, utility type, and space type.</p></div><div className="yd-heading-actions"><button type="button" className="yd-secondary-button" onClick={() => void loadIntensityValues()} disabled={intensityLoading || suggestionLoading || suggestionSaving}><RefreshCw size={15} className={intensityLoading ? "yd-spin" : ""}/>Refresh</button><button type="button" className="yd-primary-button" onClick={openIntensityCreate} disabled={suggestionLoading || suggestionSaving}><Plus size={16}/>Add Intensity Value</button></div></div>
          {error && <div className="yd-alert yd-alert-error">{error}</div>}
          {message && <div className="yd-alert yd-alert-success">{message}</div>}
          <div className="yd-table-controls"><div className="yd-search"><Search size={16}/><input value={intensitySearch} onChange={(e) => setIntensitySearch(e.target.value)} placeholder="Search FY, utility type, space type, or intensity ID..."/></div><span className="yd-record-count">{filteredIntensityValues.length} of {intensityValues.length} records</span></div>
          <div className="yd-table-shell"><table className="yd-table yd-intensity-table"><thead><tr><th>Intensity ID</th><th>FY</th><th>Utility Type</th><th>Space Type ID</th><th>Space Type</th><th>Value</th><th className="yd-actions-column">Actions</th></tr></thead><tbody>{intensityLoading ? <tr><td colSpan={7} className="yd-table-message">Loading Intensity Values...</td></tr> : filteredIntensityValues.length === 0 ? <tr><td colSpan={7} className="yd-table-message">No Intensity Values found.</td></tr> : filteredIntensityValues.map((record) => <tr key={record.intensityid}><td className="yd-code-cell">{record.intensityid}</td><td>{record.fy}</td><td>{record.utility_type_cd}</td><td>{record.space_type_id}</td><td>{record.space_type}</td><td className="yd-index-cell">{record.index}</td><td><div className="yd-row-actions"><button type="button" className="yd-icon-button" title={`Edit ${record.intensityid}`} onClick={() => openIntensityEdit(record)}><Pencil size={15}/></button><button type="button" className="yd-icon-button yd-delete-button" title={`Delete ${record.intensityid}`} onClick={() => void deleteIntensityValue(record)}><Trash2 size={15}/></button></div></td></tr>)}</tbody></table></div>
        </div>
      )}
      {intensityModalOpen && (
        <div
          className="yd-modal-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (
              event.target === event.currentTarget &&
              !intensitySaving
            ) {
              setIntensityModalOpen(false);
            }
          }}
        >
          <div
            className="yd-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="intensity-dialog-title"
          >
            <div className="yd-modal-header">
              <div>
                <p className="yd-section-eyebrow">Intensity Values</p>
                <h2 id="intensity-dialog-title">
                  {intensityEditing
                    ? `Edit ${intensityForm.intensityid}`
                    : "Add Intensity Value"}
                </h2>
              </div>
              <button
                type="button"
                className="yd-modal-close"
                onClick={() => setIntensityModalOpen(false)}
                disabled={intensitySaving}
                aria-label="Close"
              >
                <X size={19} />
              </button>
            </div>
            <div className="yd-form-grid">
              <label className="yd-field yd-field-wide">
                <span>Intensity ID</span>
                <input
                  value={
                    intensityEditing
                      ? intensityForm.intensityid
                      : buildIntensityId(
                          intensityForm.fy,
                          intensityForm.utility_type_cd,
                          intensityForm.space_type_id,
                        )
                  }
                  disabled
                  className="yd-readonly"
                />
                <small>
                  Generated as FY#UTILITY_TYPE#SPACE_TYPE_ID and cannot
                  be modified after creation.
                </small>
              </label>
              <label className="yd-field">
                <span>Fiscal Year</span>
                <input
                  type="number"
                  value={intensityForm.fy}
                  onChange={(event) =>
                    updateIntensityForm("fy", event.target.value)
                  }
                  disabled={intensityEditing}
                  className={intensityEditing ? "yd-readonly" : ""}
                />
              </label>
              <label className="yd-field">
                <span>Utility Type Code</span>
                <input
                  value={intensityForm.utility_type_cd}
                  onChange={(event) =>
                    updateIntensityForm(
                      "utility_type_cd",
                      event.target.value,
                    )
                  }
                  disabled={intensityEditing}
                  className={intensityEditing ? "yd-readonly" : ""}
                  placeholder="Example: SS"
                />
              </label>
              <label className="yd-field">
                <span>Space Type</span>
                <select
                  value={String(intensityForm.space_type_id)}
                  onChange={(event) =>
                    updateIntensityForm(
                      "space_type_id",
                      event.target.value,
                    )
                  }
                  disabled={intensityEditing}
                  className={intensityEditing ? "yd-readonly" : ""}
                >
                  {Object.entries(SPACE_TYPES).map(([id, name]) => (
                    <option key={id} value={id}>
                      {id} - {name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="yd-field">
                <span>Value</span>
                <input
                  type="number"
                  step="any"
                  value={intensityForm.index}
                  onChange={(event) =>
                    updateIntensityForm("index", event.target.value)
                  }
                />
              </label>
            </div>
            <div className="yd-modal-footer">
              <button
                type="button"
                className="yd-secondary-button"
                onClick={() => setIntensityModalOpen(false)}
                disabled={intensitySaving}
              >
                Cancel
              </button>
              <button
                type="button"
                className="yd-primary-button"
                onClick={() => void saveIntensityValue()}
                disabled={intensitySaving}
              >
                {intensitySaving
                  ? "Saving..."
                  : intensityEditing
                    ? "Save Changes"
                    : "Create Intensity Value"}
              </button>
            </div>
          </div>
        </div>
      )}
      {spaceTypeModalOpen && (
        <div
          className="yd-modal-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !spaceTypeSaving) {
              setSpaceTypeModalOpen(false);
            }
          }}
        >
          <div
            className="yd-modal yd-space-type-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="space-type-dialog-title"
          >
            <div className="yd-modal-header">
              <div>
                <p className="yd-section-eyebrow">Space Types</p>
                <h2 id="space-type-dialog-title">
                  {spaceTypeEditing
                    ? `Edit ${spaceTypeForm.space_type_id}`
                    : "Add Space Type"}
                </h2>
              </div>
              <button
                type="button"
                className="yd-modal-close"
                onClick={() => setSpaceTypeModalOpen(false)}
                disabled={spaceTypeSaving}
                aria-label="Close"
              >
                <X size={19} />
              </button>
            </div>
            <div className="yd-form-grid">
              <label className="yd-field">
                <span>Space Type ID</span>
                <input
                  value={spaceTypeForm.space_type_id}
                  onChange={(event) =>
                    setSpaceTypeForm((current) => ({
                      ...current,
                      space_type_id: event.target.value,
                    }))
                  }
                  disabled={spaceTypeEditing}
                  className={spaceTypeEditing ? "yd-readonly" : ""}
                  autoFocus={!spaceTypeEditing}
                />
                {spaceTypeEditing && (
                  <small>
                    Space Type ID is the record key and cannot be modified.
                  </small>
                )}
              </label>
              <label className="yd-field">
                <span>Description</span>
                <input
                  value={spaceTypeForm.description}
                  onChange={(event) =>
                    setSpaceTypeForm((current) => ({
                      ...current,
                      description: event.target.value,
                    }))
                  }
                  autoFocus={spaceTypeEditing}
                />
              </label>
            </div>
            <div className="yd-modal-footer">
              <button
                type="button"
                className="yd-secondary-button"
                onClick={() => setSpaceTypeModalOpen(false)}
                disabled={spaceTypeSaving}
              >
                Cancel
              </button>
              <button
                type="button"
                className="yd-primary-button"
                onClick={() => void saveSpaceType()}
                disabled={spaceTypeSaving}
              >
                {spaceTypeSaving
                  ? "Saving..."
                  : spaceTypeEditing
                    ? "Save Changes"
                    : "Create Space Type"}
              </button>
            </div>
          </div>
        </div>
      )}
      {modalOpen && (
        <div
          className="yd-modal-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              closeModal();
            }
          }}
        >
          <div
            className="yd-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="category-code-dialog-title"
          >
            <div className="yd-modal-header">
              <div>
                <p className="yd-section-eyebrow">
                  Category Codes
                </p>
                <h2 id="category-code-dialog-title">
                  {editing
                    ? `Edit ${form.category_cd}`
                    : "Add Category Code"}
                </h2>
              </div>
              <button
                type="button"
                className="yd-modal-close"
                onClick={closeModal}
                aria-label="Close"
              >
                <X size={19} />
              </button>
            </div>
            <div className="yd-form-grid">
              <label className="yd-field">
                <span>Category Code</span>
                <input
                  value={form.category_cd}
                  onChange={(event) =>
                    updateForm(
                      "category_cd",
                      event.target.value,
                    )
                  }
                  disabled={editing}
                  className={editing ? "yd-readonly" : ""}
                  autoFocus={!editing}
                />
                {editing && (
                  <small>
                    Category Code is the record key and cannot
                    be modified.
                  </small>
                )}
              </label>
              <label className="yd-field">
                <span>Area UM</span>
                <input
                  value={form.area_um}
                  onChange={(event) =>
                    updateForm(
                      "area_um",
                      event.target.value,
                    )
                  }
                />
              </label>
              <label className="yd-field yd-field-wide">
                <span>Category Name</span>
                <input
                  value={form.category_nm}
                  onChange={(event) =>
                    updateForm(
                      "category_nm",
                      event.target.value,
                    )
                  }
                />
              </label>
              <label className="yd-field">
                <span>Space Type</span>
                <select
                  value={form.space_type_id}
                  onChange={(event) =>
                    updateForm(
                      "space_type_id",
                      event.target.value,
                    )
                  }
                >
                  {Object.entries(SPACE_TYPES).map(
                    ([id, name]) => (
                      <option key={id} value={id}>
                        {id} - {name}
                      </option>
                    ),
                  )}
                </select>
              </label>
              <label className="yd-field yd-field-wide">
                <span>Description</span>
                <textarea
                  rows={6}
                  value={form.category_desc}
                  onChange={(event) =>
                    updateForm(
                      "category_desc",
                      event.target.value,
                    )
                  }
                />
              </label>
            </div>
            <div className="yd-modal-footer">
              <button
                type="button"
                className="yd-secondary-button"
                onClick={closeModal}
                disabled={saving}
              >
                Cancel
              </button>
              <button
                type="button"
                className="yd-primary-button"
                onClick={() => void saveCategoryCode()}
                disabled={saving}
              >
                {saving
                  ? "Saving..."
                  : editing
                    ? "Save Changes"
                    : "Create Category Code"}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
function PlaceholderTab({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="yd-content">
      <div className="yd-section-heading">
        <div>
          <p className="yd-section-eyebrow">
            Yearly reference data
          </p>
          <h2>{title}</h2>
          <p>{description}</p>
        </div>
      </div>
      <div className="yd-empty-panel">
        <h3>{title}</h3>
        <p>
          This tab remains layout only. Its data logic will be
          added separately.
        </p>
      </div>
    </div>
  );
}
