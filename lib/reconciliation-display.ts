export type ReconciliationDisplaySummary = {
  UtilityType?: unknown;
  AccountedConsumption?: unknown;
  AllocatedMeteredConsumption?: unknown;
  UnallocatedMeteredConsumption?: unknown;
  AllocatedNonMeteredConsumption?: unknown;
  AllocatedDerivedConsumption?: unknown;
  UnallocatedNonMeteredConsumption?: unknown;
  NonMeteredConsumption?: unknown;
  PumpingReservedConsumption?: unknown;
  DistributableNonMeteredConsumption?: unknown;
};

function numberOrNull(value: unknown): number | null {
  if (value === undefined || value === null || String(value).trim() === "") {
    return null;
  }
  const parsed = Number(String(value).replace(/[$,]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function numberValue(value: unknown): number {
  return numberOrNull(value) ?? 0;
}

/**
 * Use the persisted reconciliation accounting total when available. The
 * fallback keeps older snapshots readable while including derived rows and
 * explicitly unallocated consumption in the displayed accounting total.
 */
export function displayAccountedConsumption(
  summary: ReconciliationDisplaySummary,
): number {
  const persisted = numberOrNull(summary.AccountedConsumption);
  if (persisted !== null) return persisted;

  return (
    numberValue(summary.AllocatedMeteredConsumption) +
    numberValue(summary.UnallocatedMeteredConsumption) +
    numberValue(summary.AllocatedNonMeteredConsumption) +
    numberValue(summary.AllocatedDerivedConsumption) +
    numberValue(summary.UnallocatedNonMeteredConsumption)
  );
}

/**
 * Read the saved pumping reserve, with a compatibility fallback for older
 * summaries that did not persist PumpingReservedConsumption.
 */
export function displayPumpingReservedConsumption(
  summary: ReconciliationDisplaySummary,
): number {
  const persisted = numberOrNull(summary.PumpingReservedConsumption);
  if (persisted !== null) return persisted;

  return String(summary.UtilityType ?? "").trim().toUpperCase() === "EL"
    ? numberValue(summary.AllocatedDerivedConsumption)
    : 0;
}

/**
 * Read the saved distributable pool, with a compatibility fallback for older
 * summaries that only stored the original nonmetered pool.
 */
export function displayDistributableNonMeteredConsumption(
  summary: ReconciliationDisplaySummary,
): number {
  const persisted = numberOrNull(summary.DistributableNonMeteredConsumption);
  if (persisted !== null) return persisted;

  return (
    numberValue(summary.NonMeteredConsumption) -
    displayPumpingReservedConsumption(summary)
  );
}
