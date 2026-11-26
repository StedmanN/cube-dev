export const PW_HEAD_FT = 600;
export const PW_ENERGY_CONSTANT = 0.00315;
export const PW_COMBINED_EFFICIENCY = 0.624;
export const PW_KWH_PER_KGAL =
  (PW_HEAD_FT * PW_ENERGY_CONSTANT) / PW_COMBINED_EFFICIENCY;
export const SS_KWH_PER_KGAL = 2.18;
export const RECONCILIATION_EPSILON = 0.000001;

function round(value: number, decimals = 8): number {
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

export type PumpingEnergy = {
  pwPumpingKwh: number;
  ssPumpingKwh: number;
};

export function isProducedWaterPumpingGroup(utilityGroup: string): boolean {
  return utilityGroup === "1";
}

export function pumpingEnergyForPwAllocation(
  pwConsumption: number,
  ssPwFactor: number,
): PumpingEnergy {
  const ssConsumption = pwConsumption * ssPwFactor;
  return {
    pwPumpingKwh: round(pwConsumption * PW_KWH_PER_KGAL),
    ssPumpingKwh: round(ssConsumption * SS_KWH_PER_KGAL),
  };
}

export function pumpingReserveForPwAllocations(
  pwAllocations: number[],
  ssPwFactor: number,
): number {
  return pwAllocations.reduce((total, pwConsumption) => {
    const energy = pumpingEnergyForPwAllocation(pwConsumption, ssPwFactor);
    return total + energy.pwPumpingKwh + energy.ssPumpingKwh;
  }, 0);
}

export type SewerEligiblePwAllocation = {
  pwConsumption: number;
  sewerEligible: boolean;
};

/**
 * PW pumping is reserved for every PW allocation. SS pumping is reserved only
 * when that allocation's active RP source is sewer-eligible. The engineering
 * equations and row-level rounding remain the same as the generated rows.
 */
export function pumpingReserveForSewerEligibility(
  pwAllocations: readonly SewerEligiblePwAllocation[],
  ssPwFactor: number,
): number {
  return pwAllocations.reduce((total, allocation) => {
    const energy = pumpingEnergyForPwAllocation(
      allocation.pwConsumption,
      ssPwFactor,
    );
    return (
      total +
      energy.pwPumpingKwh +
      (allocation.sewerEligible ? energy.ssPumpingKwh : 0)
    );
  }, 0);
}

export type ElectricityPool = {
  originalNonMeteredPool: number;
  pumpingReserved: number;
  distributableNonMeteredPool: number;
  insufficientPool: boolean;
};

export function reserveElectricityPool(
  invoiceConsumption: number,
  meteredConsumption: number,
  pumpingReserved: number,
): ElectricityPool {
  const originalNonMeteredPool = invoiceConsumption - meteredConsumption;
  return {
    originalNonMeteredPool,
    pumpingReserved,
    distributableNonMeteredPool: originalNonMeteredPool - pumpingReserved,
    insufficientPool:
      pumpingReserved > originalNonMeteredPool + RECONCILIATION_EPSILON,
  };
}
