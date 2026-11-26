export const UTILITY_CODES = ["EL", "NG", "PW", "SS"] as const;

export type UtilityCode = (typeof UTILITY_CODES)[number];

export type UtilityReimbursementOverrides = Partial<
  Record<UtilityCode, boolean>
>;

export type UtilityReimbursementResolution = {
  utilityType: UtilityCode;
  customerDefaultReimbursable: boolean;
  explicitOverride: boolean | null;
  overrideApplied: boolean;
  effectiveReimbursable: boolean;
  source: "CUSTOMER_REGISTRY" | "RP_OVERRIDE";
  disposition: "CUSTOMER_REIMBURSABLE" | "CE_ABSORBED";
};

function text(value: unknown): string {
  return value === undefined || value === null ? "" : String(value).trim();
}

function normalized(value: unknown): string {
  return text(value).toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function isUtilityCode(value: unknown): value is UtilityCode {
  return UTILITY_CODES.includes(text(value).toUpperCase() as UtilityCode);
}

export function customerTypeIsReimbursable(value: unknown): boolean {
  return normalized(value) === "REIMBURSABLE";
}

export function normalizeUtilityReimbursementOverrides(
  value: unknown,
): UtilityReimbursementOverrides {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const source = value as Record<string, unknown>;
  const result: UtilityReimbursementOverrides = {};
  for (const utility of UTILITY_CODES) {
    if (typeof source[utility] === "boolean") {
      result[utility] = source[utility];
    }
  }
  return result;
}

export function utilityReimbursementOverrideErrors(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return ["Utility reimbursement overrides must be an object."];
  }
  const source = value as Record<string, unknown>;
  const errors: string[] = [];
  for (const key of Object.keys(source)) {
    if (!isUtilityCode(key)) {
      errors.push(`Unsupported utility reimbursement override ${key}.`);
      continue;
    }
    if (typeof source[key] !== "boolean") {
      errors.push(`${key} reimbursement override must be true or false.`);
    }
  }
  return errors;
}

export function parseUtilityReimbursementCsvValue(value: unknown): {
  value: boolean | null;
  error: string | null;
} {
  const raw = text(value);
  if (!raw) return { value: null, error: null };
  const token = normalized(raw);
  if (["1", "Y", "YES", "TRUE", "ON", "REIMBURSABLE"].includes(token)) {
    return { value: true, error: null };
  }
  if (
    [
      "0",
      "N",
      "NO",
      "FALSE",
      "OFF",
      "NONREIMBURSABLE",
      "CEABSORBED",
    ].includes(token)
  ) {
    return { value: false, error: null };
  }
  return {
    value: null,
    error:
      `"${raw}" is not a valid reimbursement value. Use Reimbursable, ` +
      "Non-Reimbursable, Yes/No, On/Off, 1/0, or leave it blank to inherit.",
  };
}

export function resolveUtilityReimbursement(input: {
  utilityType: UtilityCode;
  customerType: unknown;
  overrides: unknown;
  calculationEnabled?: boolean;
}): UtilityReimbursementResolution {
  const overrides = normalizeUtilityReimbursementOverrides(input.overrides);
  const explicitOverride =
    typeof overrides[input.utilityType] === "boolean"
      ? overrides[input.utilityType]!
      : null;
  const calculationEnabled = input.calculationEnabled !== false;
  const overrideApplied = calculationEnabled && explicitOverride !== null;
  const customerDefaultReimbursable = customerTypeIsReimbursable(
    input.customerType,
  );
  const effectiveReimbursable = overrideApplied
    ? explicitOverride
    : customerDefaultReimbursable;
  return {
    utilityType: input.utilityType,
    customerDefaultReimbursable,
    explicitOverride,
    overrideApplied,
    effectiveReimbursable,
    source: overrideApplied ? "RP_OVERRIDE" : "CUSTOMER_REGISTRY",
    disposition: effectiveReimbursable
      ? "CUSTOMER_REIMBURSABLE"
      : "CE_ABSORBED",
  };
}

export function reimbursementSnapshotFields(
  resolution: UtilityReimbursementResolution,
) {
  return {
    ReimbursementUtilityType: resolution.utilityType,
    CustomerRegistryReimbursementType:
      resolution.customerDefaultReimbursable
        ? "Reimbursable"
        : "Non-Reimbursable",
    ReimbursementOverride: resolution.explicitOverride,
    ReimbursementOverrideApplied: resolution.overrideApplied ? 1 : 0,
    EffectiveReimbursementType: resolution.effectiveReimbursable
      ? "Reimbursable"
      : "Non-Reimbursable",
    ReimbursementSource: resolution.source,
    ReimbursementDisposition: resolution.disposition,
  };
}

export function splitReimbursementCharge(
  calculatedAmount: number | null,
  disposition: "CUSTOMER_REIMBURSABLE" | "CE_ABSORBED",
) {
  if (calculatedAmount === null) {
    return {
      calculatedAmount: null,
      customerChargeAmount: null,
      ceAbsorbedAmount: null,
    };
  }
  return {
    calculatedAmount,
    customerChargeAmount:
      disposition === "CUSTOMER_REIMBURSABLE" ? calculatedAmount : 0,
    ceAbsorbedAmount:
      disposition === "CE_ABSORBED" ? calculatedAmount : 0,
  };
}

export function splitReimbursementConsumption(
  allocatedConsumption: number,
  disposition: "CUSTOMER_REIMBURSABLE" | "CE_ABSORBED",
) {
  return {
    allocatedReimbursableConsumption:
      disposition === "CUSTOMER_REIMBURSABLE" ? allocatedConsumption : 0,
    allocatedCEAbsorbedConsumption:
      disposition === "CE_ABSORBED" ? allocatedConsumption : 0,
  };
}

/**
 * Pumping electricity retains its EL rate and consumption methodology.
 * Only reimbursement responsibility follows the derived utility for SS
 * pumping; PW pumping continues to follow EL reimbursement as before.
 */
export function pumpingReimbursementUtility(source: "PW_PUMPING" | "SS_PUMPING"): UtilityCode {
  return source === "SS_PUMPING" ? "SS" : "EL";
}
