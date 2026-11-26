import assert from "node:assert/strict";
import test from "node:test";

import { resolveReconciliationTables } from "../lib/reconciliation-tables.ts";

const namespace = "CUBE-RP-IT-RECON-BP175-SAFETY";

test("normal application execution cannot redirect reconciliation tables", () => {
  const tables = resolveReconciliationTables({ NODE_ENV: "production" });
  assert.equal(tables.reconciliation, "p72-CUBE-MONTHLY-RECONCILIATION");
  assert.equal(tables.realPropertyLegacy, "p72-CUBE-RP-LEGACY");
});

test("production mode rejects a reconciliation table override", () => {
  assert.throws(
    () =>
      resolveReconciliationTables({
        NODE_ENV: "production",
        CUBE_LOCAL_INTEGRATION_TEST_MODE: "1",
        CUBE_RP_INTEGRATION_TEST_NAMESPACE: namespace,
        CUBE_RECONCILIATION_INTEGRATION_TEST_NAMESPACE: namespace,
      }),
    /forbidden in production mode/,
  );
});

test("test overrides require explicit opt-in and matching safe namespaces", () => {
  assert.throws(
    () =>
      resolveReconciliationTables({
        NODE_ENV: "development",
        CUBE_RP_INTEGRATION_TEST_NAMESPACE: namespace,
        CUBE_RECONCILIATION_INTEGRATION_TEST_NAMESPACE: namespace,
      }),
    /CUBE_LOCAL_INTEGRATION_TEST_MODE=1/,
  );
  assert.throws(
    () =>
      resolveReconciliationTables({
        NODE_ENV: "development",
        CUBE_LOCAL_INTEGRATION_TEST_MODE: "1",
        CUBE_RP_INTEGRATION_TEST_NAMESPACE: namespace,
        CUBE_RECONCILIATION_INTEGRATION_TEST_NAMESPACE: "p72-CUBE-MONTHLY-RECONCILIATION",
      }),
    /disposable CUBE-RP-IT-RECON-/,
  );
  assert.throws(
    () =>
      resolveReconciliationTables({
        NODE_ENV: "development",
        CUBE_LOCAL_INTEGRATION_TEST_MODE: "1",
        CUBE_RP_INTEGRATION_TEST_NAMESPACE: `${namespace}-OTHER`,
        CUBE_RECONCILIATION_INTEGRATION_TEST_NAMESPACE: namespace,
      }),
    /must match exactly/,
  );
});

test("valid local integration mode maps the complete reconciliation graph", () => {
  const tables = resolveReconciliationTables({
    NODE_ENV: "development",
    CUBE_LOCAL_INTEGRATION_TEST_MODE: "1",
    CUBE_RP_INTEGRATION_TEST_NAMESPACE: namespace,
    CUBE_RECONCILIATION_INTEGRATION_TEST_NAMESPACE: namespace,
  });
  for (const tableName of Object.values(tables)) {
    assert.ok(tableName.startsWith(`${namespace}-`));
  }
  assert.equal(
    tables.reconciliation,
    `${namespace}-MONTHLY-RECONCILIATION`,
  );
});

