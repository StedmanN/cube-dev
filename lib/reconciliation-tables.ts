export type ReconciliationTableEnvironment = {
  NODE_ENV?: string;
  CUBE_LOCAL_INTEGRATION_TEST_MODE?: string;
  CUBE_RP_INTEGRATION_TEST_NAMESPACE?: string;
  CUBE_RECONCILIATION_INTEGRATION_TEST_NAMESPACE?: string;
};

const productionTables = {
  reconciliation: "p72-CUBE-MONTHLY-RECONCILIATION",
  readings: "p72-CUBE-METER-READINGS",
  meters: "p72-CUBE-METERS",
  customers: "p72-CUBE-CUSTOMERS",
  invoices: "p72-CUBE-INVOICES",
  propQ: "p72-CUBE-RP-PROPQ",
  plantUnit: "p72-CUBE-PLANT-UNIT",
  realPropertyLegacy: "p72-CUBE-RP-LEGACY",
  realPropertyMonthly: "p72-CUBE-RP-MONTHLY",
} as const;

const namespacePattern = /^CUBE-RP-IT-RECON-[A-Z0-9-]{8,80}$/i;

export function resolveReconciliationTables(
  environment: ReconciliationTableEnvironment,
) {
  const namespace =
    environment.CUBE_RECONCILIATION_INTEGRATION_TEST_NAMESPACE?.trim() ?? "";
  if (!namespace) return productionTables;

  if (environment.NODE_ENV === "production") {
    throw new Error(
      "Reconciliation integration-test table overrides are forbidden in production mode.",
    );
  }
  if (environment.CUBE_LOCAL_INTEGRATION_TEST_MODE !== "1") {
    throw new Error(
      "Reconciliation integration-test tables require CUBE_LOCAL_INTEGRATION_TEST_MODE=1.",
    );
  }
  if (!namespacePattern.test(namespace)) {
    throw new Error(
      "CUBE_RECONCILIATION_INTEGRATION_TEST_NAMESPACE must use the disposable CUBE-RP-IT-RECON- namespace.",
    );
  }
  if (environment.CUBE_RP_INTEGRATION_TEST_NAMESPACE?.trim() !== namespace) {
    throw new Error(
      "The reconciliation and Real Property integration-test namespaces must match exactly.",
    );
  }

  const table = (suffix: string) => `${namespace}-${suffix}`;
  return {
    reconciliation: table("MONTHLY-RECONCILIATION"),
    readings: table("METER-READINGS"),
    meters: table("METERS"),
    customers: table("CUSTOMERS"),
    invoices: table("INVOICES"),
    propQ: table("RP-PROPQ"),
    plantUnit: table("PLANT-UNIT"),
    realPropertyLegacy: table("RP-LEGACY"),
    realPropertyMonthly: table("RP-MONTHLY"),
  } as const;
}

export const RECONCILIATION_TABLES = Object.freeze(
  resolveReconciliationTables(process.env),
);

export const RECONCILIATION_INTEGRATION_TEST_NAMESPACE =
  process.env.CUBE_RECONCILIATION_INTEGRATION_TEST_NAMESPACE?.trim() || null;
