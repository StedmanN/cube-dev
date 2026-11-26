export type ReconciliationInvoiceRowClassification =
  | {
      kind: "CONSUMPTION";
      normalizedConsumption: number;
      normalizedUnit: string;
    }
  | {
      kind: "CHARGE_ONLY";
      charge: number;
    }
  | {
      kind: "INVALID";
      reason: "MISSING_CONSUMPTION_AND_CHARGE" | "INVALID_CONSUMPTION" | "UNSUPPORTED_UNIT";
    };

export type ReconciliationBillingStatusInput = {
  accountingDifference: number;
  allocationDifference: number;
  unallocatedMetered: number;
  unallocatedNonMetered: number;
  invalidInvoiceRows: number;
  issueCount: number;
};

const ACCOUNTING_TOLERANCE = 0.01;

function text(value: unknown): string {
  return value === undefined || value === null ? "" : String(value).trim();
}

function finiteNumber(value: unknown): number | null {
  const normalized = text(value).replace(/[$,]/g, "");
  if (!normalized) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeConsumption(
  utilityTypeValue: unknown,
  consumption: number,
  unitValue: unknown,
): { value: number; unit: string } | null {
  const utilityType = text(utilityTypeValue).toUpperCase();
  const unit = text(unitValue).toUpperCase().replace(/\s+/g, "");

  if (utilityType === "EL") {
    if (!unit || unit === "KWH") return { value: consumption, unit: "KWH" };
    if (unit === "MWH") return { value: consumption * 1000, unit: "KWH" };
    return null;
  }
  if (utilityType === "NG") {
    // Historical MBTU invoice values follow the CUBE MMBTU business convention.
    if (!unit || unit === "MMBTU" || unit === "MBTU") {
      return { value: consumption, unit: "MMBTU" };
    }
    if (unit === "THERM" || unit === "THERMS") {
      return { value: consumption * 0.1, unit: "MMBTU" };
    }
    return null;
  }
  if (utilityType === "PW" || utilityType === "SS") {
    if (!unit || unit === "KGAL" || unit === "KGL") {
      return { value: consumption, unit: "KGAL" };
    }
    if (unit === "GAL" || unit === "GALLON" || unit === "GALLONS") {
      return { value: consumption / 1000, unit: "KGAL" };
    }
  }
  return null;
}

/**
 * Classify invoice rows without discarding their financial meaning.
 *
 * A row with no consumption value and a finite charge is a legitimate
 * charge-only row. Its unit label is not used because there is no consumption
 * to convert. A supplied malformed consumption or unsupported consumption unit
 * remains invalid and blocks billing readiness.
 */
export function classifyReconciliationInvoiceRow(input: {
  utilityType: unknown;
  consumption: unknown;
  consumptionUnit: unknown;
  charge: unknown;
}): ReconciliationInvoiceRowClassification {
  const consumptionText = text(input.consumption);
  if (!consumptionText) {
    const charge = finiteNumber(input.charge);
    return charge === null
      ? { kind: "INVALID", reason: "MISSING_CONSUMPTION_AND_CHARGE" }
      : { kind: "CHARGE_ONLY", charge };
  }

  const consumption = finiteNumber(input.consumption);
  if (consumption === null) {
    return { kind: "INVALID", reason: "INVALID_CONSUMPTION" };
  }

  const normalized = normalizeConsumption(
    input.utilityType,
    consumption,
    input.consumptionUnit,
  );
  return normalized
    ? {
        kind: "CONSUMPTION",
        normalizedConsumption: normalized.value,
        normalizedUnit: normalized.unit,
      }
    : { kind: "INVALID", reason: "UNSUPPORTED_UNIT" };
}

export function evaluateReconciliationBillingStatus(
  input: ReconciliationBillingStatusInput,
): {
  accountingStatus: "RECONCILED" | "EXCEPTION";
  billingReady: boolean;
  reconciliationStatus: "BILLING_READY" | "EXCEPTION";
} {
  const accountingStatus =
    Math.abs(input.accountingDifference) <= ACCOUNTING_TOLERANCE &&
    input.invalidInvoiceRows === 0
      ? "RECONCILED"
      : "EXCEPTION";
  const billingReady =
    accountingStatus === "RECONCILED" &&
    Math.abs(input.allocationDifference) <= ACCOUNTING_TOLERANCE &&
    Math.abs(input.unallocatedMetered) <= ACCOUNTING_TOLERANCE &&
    Math.abs(input.unallocatedNonMetered) <= ACCOUNTING_TOLERANCE &&
    input.issueCount === 0;

  return {
    accountingStatus,
    billingReady,
    reconciliationStatus: billingReady ? "BILLING_READY" : "EXCEPTION",
  };
}
