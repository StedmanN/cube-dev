/**
 * Reporting-only subdivision of an EXISTING 3556 charge.
 *
 * NEVER changes the 3556 rate, consumption, billing amount, disposition or
 * allocation. Annual costs are read from the effective FINAL 3556 selected by
 * the existing billing API. Unknown source classifications fail closed.
 */
export type UtilityCode = "EL" | "NG" | "PW" | "SS";
export type ComponentCode = "REM" | "CUBE" | "SRM_LABOR" | "SRM_MATERIALS";
export type ReportingClass = "A" | "B" | "C" | "D" | "E" | "UNKNOWN";
export type ReportingStatus = "READY" | "PROVISIONAL" | "REVIEW" | "NOT_APPLICABLE";
export type WorksheetSection = "purchased" | "purchasedServices" | "produced" | "distribution";
export type ReportingAssignment = ComponentCode | "UNCLASSIFIED";
export type ClassificationStatus = "IDENTIFIED" | "PROVISIONAL" | "UNCLASSIFIED";
export type CostRow = {
  key: string;
  section: WorksheetSection;
  account: string;
  description: string;
  amount: number;
  component: ComponentCode | null;
  classificationStatus: ClassificationStatus;
  provisionalCandidate: boolean;
  classifiedExplicitly: boolean;
};
export type ReportingAmounts = Record<"PURCHASED_UTILITY" | ComponentCode, number>;
export type ReportingSplit = {
  status: ReportingStatus;
  rateClass: ReportingClass;
  utility: UtilityCode | null;
  rateId: string;
  effectiveDate: string;
  originalCharge: number | null;
  sourceBasis: number | null;
  purchasedUtilityAmount: number | null;
  components: Partial<Record<ComponentCode, number>>;
  sourceRows: CostRow[];
  warnings: string[];
  issues: string[];
};

type AnyRow = Record<string, unknown>;
export type Final3556 = {
  id?: unknown;
  effectiveDate?: unknown;
  status?: unknown;
  utilitySystem?: unknown;
  worksheet?: Record<string, unknown> | null;
};

const COMPONENTS: ComponentCode[] = ["REM", "CUBE", "SRM_LABOR", "SRM_MATERIALS"];
const SECTION_KEYS: WorksheetSection[] = ["purchased", "purchasedServices", "produced", "distribution"];

/** Provisional account mapping; component costs always come from the selected FINAL 3556. */
export const PROVISIONAL_ACCOUNT_COMPONENTS: Partial<Record<UtilityCode, Record<string, ComponentCode>>> = {
  EL: {
    "811144": "SRM_MATERIALS",
    "811149": "SRM_MATERIALS",
    "812223": "SRM_MATERIALS",
    "812225": "SRM_MATERIALS",
    "812226": "SRM_MATERIALS",
  },
};

function label(value: unknown): string {
  return String(value ?? "").trim().toUpperCase().replace(/&/g, "AND").replace(/[^A-Z0-9]/g, "");
}
function value(value: unknown): string { return String(value ?? "").trim(); }
function finiteAmount(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || !value.trim()) return null;
  const text = value.replace(/[$,\s]/g, "").replace(/^\((.*)\)$/, "-$1");
  if (!/^-?\d+(?:\.\d+)?$/.test(text)) return null;
  const num = Number(text);
  return Number.isFinite(num) ? num : null;
}
function cents(amount: number): number { return Math.round((amount + Math.sign(amount) * Number.EPSILON) * 100); }
function money(amount: number): number { return Number((amount / 100).toFixed(2)); }

export function classForRateKey(key: unknown): ReportingClass {
  switch (value(key)) {
    case "mfh": return "A";
    case "nonFederal": return "B";
    case "nonDodFederal": return "C";
    case "dod": return "D";
    case "categoryCMwr": return "E";
    default: return "UNKNOWN";
  }
}
export function normalizeReportingUtility(raw: unknown): UtilityCode | null {
  switch (label(raw)) {
    case "EL": case "ELECTRIC": case "ELECTRICITY": return "EL";
    case "NG": case "GAS": case "NATURALGAS": return "NG";
    case "PW": case "WATER": case "POTABLEWATER": return "PW";
    case "SS": case "SEWER": case "SEWAGE": case "SANITARYSEWER": return "SS";
    default: return null;
  }
}

/** Exact supported business labels, NOT a fallback to all Distribution O&M. */
function fromIdentity(row: AnyRow): ComponentCode | null {
  const direct = value(row.reportingComponent ?? row.reportingCategory).toUpperCase();
  if (COMPONENTS.includes(direct as ComponentCode)) return direct as ComponentCode;
  const candidates = [label(row.accountProjectNumber), label(row.description)];
  const has = (...allowed: string[]) => candidates.some((x) => allowed.includes(x));
  if (has("RESOURCEEFFMGR", "RESOURCEEFFICIENCYMGR", "RESOURCEEFFICIENCYMANAGER")) return "REM";
  if (has("UTILITYMGTASSETM", "UTILITYMGTMODULE", "UTILITYMGTASSETMGT", "UTILITYMANAGEMENTMODULE", "CUBE", "UMM")) return "CUBE";
  if (has("BMCPWRPRO", "BMCPOWERPRO", "SRMLABOR")) return "SRM_LABOR";
  if (has("FSRMCLIN0001", "SRMMATERIALS")) return "SRM_MATERIALS";
  return null;
}

export function read3556Rows(
  rate: Final3556,
  classifications: Record<string, ReportingAssignment> = {},
  provisionalAccountComponents = PROVISIONAL_ACCOUNT_COMPONENTS,
): { rows: CostRow[]; errors: string[] } {
  const worksheet = rate.worksheet;
  if (!worksheet || typeof worksheet !== "object") return {rows: [], errors: ["FINAL 3556 has no worksheet cost rows."]};
  const rows: CostRow[] = [];
  const errors: string[] = [];
  const classifiedKeys = new Set<string>();
  for (const section of SECTION_KEYS) {
    const sectionRows = worksheet[section];
    if (!Array.isArray(sectionRows)) { errors.push(`3556 section ${section} is missing.`); continue; }
    const seen = new Set<string>();
    for (let i = 0; i < sectionRows.length; i++) {
      const row = sectionRows[i];
      if (!row || typeof row !== "object") { errors.push(`${section}[${i}] is not a row.`); continue; }
      const input = row as AnyRow;
      const key = value(input.id);
      if (!key || seen.has(key)) { errors.push(`${section}[${i}] has a missing or duplicated source row ID.`); continue; }
      seen.add(key);
      const amount = finiteAmount(section === "distribution" ? input.cost : input.totalAnnualCost);
      if (amount === null && !value(input.accountProjectNumber) && !value(input.description) && !value(input.notes)) continue;
      if (amount === null || amount < 0) { errors.push(`${section}[${i}] has a missing, negative or invalid annual cost.`); continue; }
      const tag = value(input.reportingComponent ?? input.reportingCategory).toUpperCase();
      if (tag && !COMPONENTS.includes(tag as ComponentCode)) {errors.push(`${section}[${i}] has an unrecognized reporting component: ${tag}.`);continue;}
      if (tag && (section === "purchased" || section === "produced")) { errors.push(`${section}[${i}] cannot be classified as an Other Utilities service charge.`); continue; }
      const sourceKey = `${section}:${key}`;
      const explicit = classifications[sourceKey];
      const utility = normalizeReportingUtility(rate.utilitySystem);
      const provisional = section === "distribution" && utility
        ? provisionalAccountComponents[utility]?.[value(input.accountProjectNumber)]
        : undefined;
      if (explicit === "UNCLASSIFIED") {
        if (section !== "distribution") {
          errors.push(`${sourceKey} can only be explicitly left unclassified in Distribution O&M.`);
          continue;
        }
        classifiedKeys.add(sourceKey);
        rows.push({key, section, account: value(input.accountProjectNumber), description: value(input.description), amount, component: null, classificationStatus: "UNCLASSIFIED", provisionalCandidate: Boolean(provisional), classifiedExplicitly: true});
        continue;
      }
      if (explicit && !COMPONENTS.includes(explicit)) { errors.push(`${sourceKey} has an invalid configured reporting component.`); continue; }
      const inferred = fromIdentity(input);
      if (explicit && inferred && inferred !== explicit) { errors.push(`${sourceKey} conflicts with its 3556 label.`); continue; }
      if (explicit && (section === "purchased" || section === "produced")) {errors.push(`${sourceKey} cannot be classified as a service charge.`);continue;}
      if (explicit) classifiedKeys.add(sourceKey);
      const component = explicit ?? inferred ?? provisional ?? null;
      rows.push({
        key, section, account: value(input.accountProjectNumber), description: value(input.description), amount,
        component,
        classificationStatus: provisional ? "PROVISIONAL" : component ? "IDENTIFIED" : "UNCLASSIFIED",
        provisionalCandidate: Boolean(provisional),
        classifiedExplicitly: Boolean(explicit || tag),
      });
    }
  }
  for (const key of Object.keys(classifications)) {
    if (!classifiedKeys.has(key)) errors.push(`Reporting classification references a missing or invalid 3556 row: ${key}.`);
  }
  return {rows, errors};
}

const REQUIRED: Record<ReportingClass, Record<UtilityCode, ComponentCode[]>> = {
  A: {EL: [], NG: [], PW: [], SS: []},
  B: {EL: ["REM", "CUBE", "SRM_LABOR", "SRM_MATERIALS"], NG: ["SRM_MATERIALS"], PW: ["SRM_MATERIALS"], SS: ["SRM_MATERIALS"]},
  C: {EL: ["REM", "CUBE", "SRM_LABOR"], NG: [], PW: [], SS: []},
  D: {EL: ["REM", "CUBE", "SRM_LABOR"], NG: [], PW: [], SS: []},
  E: {EL: [], NG: [], PW: [], SS: []},
  UNKNOWN: {EL: [], NG: [], PW: [], SS: []},
};

export function compute3556ReportingSplit(input: {
  rate: Final3556 | null;
  rateKey: string;
  utility: unknown;
  originalCharge: unknown;
  classifications?: Record<string, ReportingAssignment>;
  provisionalAccountComponents?: Partial<Record<UtilityCode, Record<string, ComponentCode>>>;
}): ReportingSplit {
  const rateClass = classForRateKey(input.rateKey);
  const utility = normalizeReportingUtility(input.utility);
  const gross = finiteAmount(input.originalCharge);
  const issues: string[] = [];
  const base: ReportingSplit = {
    status: "REVIEW", rateClass, utility, rateId: value(input.rate?.id),
    effectiveDate: value(input.rate?.effectiveDate), originalCharge: gross,
    sourceBasis: null, purchasedUtilityAmount: null, components: {}, sourceRows: [], warnings: [], issues,
  };
  if (rateClass === "UNKNOWN") issues.push("Rate Class cannot be mapped to A/B/C/D/E; no reporting allocation was made.");
  if (!utility) issues.push("Utility type is not recognized for reporting.");
  if (gross === null) issues.push("Original billed charge is missing or invalid.");
  if (issues.length) return base;
  if (gross === null || utility === null) return base; // narrowed for TypeScript
  const required = REQUIRED[rateClass][utility];
  if (required.length === 0) return {...base, status: "NOT_APPLICABLE", purchasedUtilityAmount: money(cents(gross))};
  if (!input.rate || label(input.rate.status) !== "FINAL") {
    issues.push("The selected cost worksheet is not a FINAL 3556.");
    return base;
  }
  if (!base.rateId || !/^\d{4}-\d{2}-\d{2}$/.test(base.effectiveDate)) {
    issues.push("The FINAL 3556 lacks an ID or valid effective date."); return base;
  }
  const parsed = read3556Rows(input.rate, input.classifications, input.provisionalAccountComponents ?? PROVISIONAL_ACCOUNT_COMPONENTS);
  issues.push(...parsed.errors);
  const rows = parsed.rows;
  if (rateClass === "B" && utility === "EL" && rows.some(row => row.provisionalCandidate && row.classificationStatus === "UNCLASSIFIED")) {
    issues.push("A provisional Electricity account candidate is explicitly left unclassified; the affected charge remains in review.");
  }
  const chosen = new Map<ComponentCode, CostRow[]>();
  for (const component of required) {
    const hits = rows.filter((row) => row.component === component && row.amount > 0);
    chosen.set(component, hits);
    if (hits.length === 0) issues.push(`${component}: no explicitly identifiable annual-cost row on the selected FINAL 3556.`);
    if (hits.length > 1 && component !== "SRM_MATERIALS") issues.push(`${component}: multiple component rows require an explicit, reviewed allocation rule.`);
    if (hits.length > 1 && component === "SRM_MATERIALS" && hits.some(row =>
      !row.classifiedExplicitly && row.classificationStatus !== "PROVISIONAL" &&
      !["FSRMCLIN0001", "SRMMATERIALS"].some(name => [label(row.account), label(row.description)].includes(name))
    )) issues.push("SRM Materials has multiple rows that are not explicitly identified as FSRM.");
  }
  // Only the required, identifiable component rows count toward the C/D base.
  // Class B's base uses all relevant annual utility/operating costs.
  const baseRows = rows.filter(row =>
    rateClass === "B" ||
    row.section !== "distribution" ||
    (row.component !== null && required.includes(row.component))
  );
  const denom = baseRows.reduce((sum, row) => sum + row.amount, 0);
  if (!(denom > 0) || !Number.isFinite(denom)) issues.push("Applicable 3556 annual-cost denominator must be positive.");
  const selectedRows = required.flatMap(c => chosen.get(c) ?? []);
  const provisionalRows = selectedRows.filter(row => row.classificationStatus === "PROVISIONAL");
  if (provisionalRows.length) {
    const accounts = [...new Set(provisionalRows.map(row => row.account))].join(", ");
    base.warnings.push(`SRM Materials uses provisional Electricity account mapping${accounts ? ` for ${accounts}` : ""}.`);
  }
  const used = new Set<string>();
  for (const row of selectedRows) {
    const rowId = `${row.section}:${row.key}`;
    if (used.has(rowId)) issues.push(`${rowId} is assigned to multiple components.`);
    used.add(rowId);
  }
  const classifiedTotal = selectedRows.reduce((sum, row) => sum + row.amount, 0);
  if (denom > 0 && classifiedTotal > denom + 0.000001) issues.push("Classified component costs exceed the 3556 annual-cost denominator.");
  if (issues.length) return {...base, sourceBasis: denom > 0 ? denom : null, sourceRows: selectedRows};
  const grossCents = cents(gross);
  const components: Partial<Record<ComponentCode, number>> = {};
  let allocatedCents = 0;
  for (const code of required) {
    const componentCost = (chosen.get(code) ?? []).reduce((n, row) => n + row.amount, 0);
    const part = Math.round(grossCents * componentCost / denom);
    allocatedCents += part;
    components[code] = money(part);
  }
  const remainder = grossCents - allocatedCents;
  // Residual must have the same sign as gross; fail closed on bad basis.
  if ((grossCents >= 0 && remainder < 0) || (grossCents < 0 && remainder > 0)) {
    issues.push("Component allocation exceeds original billed amount.");
    return {...base, sourceBasis: denom, sourceRows: selectedRows};
  }
  return {...base, status: provisionalRows.length ? "PROVISIONAL" : "READY", sourceBasis: denom, purchasedUtilityAmount: money(remainder), components, sourceRows: selectedRows};
}
