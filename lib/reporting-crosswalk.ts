/**
 * Accounting-code metadata for reporting only. These are working candidates,
 * NOT an approved FMDD or Government accounting cross-reference.
 * A reviewed, auditable DynamoDB override may replace them without changing
 * any 3556 rate, customer charge, or immutable saved-bill snapshot.
 */
export type AccountingStatus = "PENDING" | "DISPUTED" | "PROVISIONAL";
export type AccountingCode = {eeic: string | null; objectClass: string; status: AccountingStatus};
export const COMPONENT_KEYS = ["EL", "NG", "PW", "SS", "REM", "CUBE", "SRM_LABOR", "SRM_MATERIALS"] as const;
export type AccountingComponent = typeof COMPONENT_KEYS[number];
export type AccountingCrosswalk = Record<AccountingComponent, AccountingCode>;
export const CANDIDATE_CROSSWALK: AccountingCrosswalk = {
  EL: {eeic: "48020", objectClass: "233.2110", status: "PENDING"},
  NG: {eeic: "48030", objectClass: "233.2210", status: "PENDING"},
  PW: {eeic: "48010", objectClass: "233.2010", status: "PENDING"},
  SS: {eeic: "48040", objectClass: "233.2310", status: "PROVISIONAL"},
  REM: {eeic: "480RE", objectClass: "233.5541", status: "PROVISIONAL"},
  CUBE: {eeic: "53317", objectClass: "254.2209", status: "PROVISIONAL"},
  SRM_LABOR: {eeic: "5703A", objectClass: "254.3101", status: "PROVISIONAL"},
  SRM_MATERIALS: {eeic: "61900", objectClass: "254.3101", status: "PROVISIONAL"},
};
export const ACCOUNTING_CROSSWALK_PK = "3556_ACCOUNTING_CROSSWALK";
export const ACCOUNTING_CROSSWALK_RECORD_TYPE = "REPORTING_ACCOUNTING_CROSSWALK";

/** Refuse partial, unknown, or malformed assignments; no inferred accounting codes. */
export function validateAccountingCrosswalk(raw: unknown): AccountingCrosswalk {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("An eight-component accounting crosswalk is required.");
  const incoming = raw as Record<string, unknown>;
  if (Object.keys(incoming).length !== COMPONENT_KEYS.length || Object.keys(incoming).some(key => !COMPONENT_KEYS.includes(key as AccountingComponent))) {
    throw new Error("Crosswalk must contain exactly the eight supported components.");
  }
  const result = {} as AccountingCrosswalk;
  for (const key of COMPONENT_KEYS) {
    const candidate = incoming[key];
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw new Error(`${key}: missing code entry.`);
    const code = candidate as Record<string, unknown>;
    if (Object.keys(code).some(field => !["eeic", "objectClass", "status"].includes(field))) throw new Error(`${key}: unsupported field.`);
    const eeic = code.eeic;
    const objectClass = code.objectClass;
    const status = code.status;
    if (eeic !== null && (typeof eeic !== "string" || !/^[A-Z0-9]{3,10}$/.test(eeic))) throw new Error(`${key}: EEIC must be an uppercase code or blank for unresolved.`);
    if (typeof objectClass !== "string" || !/^\d{3}\.\d{4}$/.test(objectClass)) throw new Error(`${key}: invalid Object Class format.`);
    if (status !== "PENDING" && status !== "DISPUTED" && status !== "PROVISIONAL") throw new Error(`${key}: classifications remain unapproved; status must be PENDING, DISPUTED, or PROVISIONAL.`);
    result[key] = {eeic, objectClass, status};
  }
  return result;
}

export type ActiveCrosswalk = {codes: AccountingCrosswalk; updatedAt: string | null; updatedBy: string | null; source: "DEFAULT_CANDIDATES" | "CONFIGURED"};
export function resolveAccountingCrosswalkRecord(item: Record<string, unknown> | null | undefined): ActiveCrosswalk {
  if (!item) return {codes: structuredClone(CANDIDATE_CROSSWALK), updatedAt: null, updatedBy: null, source: "DEFAULT_CANDIDATES"};
  if (item.RecordType !== ACCOUNTING_CROSSWALK_RECORD_TYPE || item.PK !== ACCOUNTING_CROSSWALK_PK || item.SK !== "CURRENT") {
    throw new Error("Invalid stored accounting-crosswalk record; reporting is blocked until repaired.");
  }
  return {
    codes: validateAccountingCrosswalk(item.Codes),
    updatedAt: String(item.UpdatedAt ?? ""),
    updatedBy: String(item.UpdatedBy ?? ""),
    source: "CONFIGURED",
  };
}

export function resolveAccountingCrosswalkFromScannedRecords(records: Array<Record<string, unknown>>): ActiveCrosswalk {
  const current = records.filter(item => item.PK === ACCOUNTING_CROSSWALK_PK && item.SK === "CURRENT");
  if (current.length > 1) throw new Error("Duplicated current accounting crosswalk; reporting is blocked.");
  return resolveAccountingCrosswalkRecord(current[0]);
}
