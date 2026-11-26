const TEST_NAMESPACE_ENV = "CUBE_RP_INTEGRATION_TEST_NAMESPACE";

const productionTables = {
  customers: "p72-CUBE-CUSTOMERS",
  facilities: "p72-CUBE-FACILITIES",
  categories: "p72-CUBE-CATEGORY-CODES",
  intensities: "p72-CUBE-INTENSITY-VALUES",
  legacy: "p72-CUBE-RP-LEGACY",
  monthly: "p72-CUBE-RP-MONTHLY",
  estimates: "p72-CUBE-ESTIMATES",
  propQ: "p72-CUBE-RP-PROPQ",
  control: "p72-CUBE-3556",
} as const;

const testNamespace = process.env[TEST_NAMESPACE_ENV]?.trim() ?? "";

if (
  testNamespace &&
  !/^CUBE-RP-IT-[A-Z0-9-]{8,80}$/i.test(testNamespace)
) {
  throw new Error(
    `${TEST_NAMESPACE_ENV} must use the disposable CUBE-RP-IT- namespace.`,
  );
}

function testTable(suffix: string) {
  return `${testNamespace}-${suffix}`;
}

/**
 * Production names remain the default. The explicit integration-test namespace
 * redirects the complete Real Property write graph to disposable local tables.
 */
export const REAL_PROPERTY_TABLES = Object.freeze(
  testNamespace
    ? {
        customers: testTable("CUSTOMERS"),
        facilities: testTable("FACILITIES"),
        categories: testTable("CATEGORY-CODES"),
        intensities: testTable("INTENSITY-VALUES"),
        legacy: testTable("RP-LEGACY"),
        monthly: testTable("RP-MONTHLY"),
        estimates: testTable("ESTIMATES"),
        propQ: testTable("RP-PROPQ"),
        control: testTable("CONTROL"),
      }
    : productionTables,
);

export const REAL_PROPERTY_INTEGRATION_TEST_NAMESPACE = testNamespace || null;

