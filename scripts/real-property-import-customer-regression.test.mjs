import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeImportCustomerName,
  resolveRealPropertyImportCustomer,
} from "../lib/real-property-import-customer.ts";

const dlaDlr = {
  CustomerID: "CUST-000027",
  CustomerName: "DLA-DLR",
  UMMName: "SMAG Extra",
};
const dlaWeapons = {
  CustomerID: "CUST-000028",
  CustomerName: "DLA-WPNSPT",
  UMMName: "DSCR",
};

function aliases(entries) {
  return new Map(
    entries.map(([name, customer]) => [
      normalizeImportCustomerName(name),
      customer,
    ]),
  );
}

test("conflicting CUBE and NextGen names block the DLA-DLR row", () => {
  const result = resolveRealPropertyImportCustomer({
    cubeCustomerName: "DLA-DLR",
    nextGenCustomerName: "TINKER AFB - DLA WEAPONS SUPPORT",
    customerByAlias: aliases([
      ["DLA-DLR", dlaDlr],
      ["TINKER AFB - DLA WEAPONS SUPPORT", dlaWeapons],
    ]),
  });

  assert.equal(result.customer, null);
  assert.match(result.error, /DLA-DLR/);
  assert.match(result.error, /CUST-000027/);
  assert.match(result.error, /TINKER AFB - DLA WEAPONS SUPPORT/);
  assert.match(result.error, /CUST-000028/);
  assert.match(result.error, /Correct the source names before importing/);
});

test("two names resolving to the same customer remain valid", () => {
  const result = resolveRealPropertyImportCustomer({
    cubeCustomerName: "DLA-DLR",
    nextGenCustomerName: "SMAG Extra",
    customerByAlias: aliases([
      ["DLA-DLR", dlaDlr],
      ["SMAG Extra", dlaDlr],
    ]),
  });

  assert.equal(result.error, null);
  assert.equal(result.customer?.CustomerID, "CUST-000027");
});

test("one successfully resolved name remains valid", () => {
  const map = aliases([["DLA-DLR", dlaDlr]]);
  const cubeOnly = resolveRealPropertyImportCustomer({
    cubeCustomerName: " DLA-DLR ",
    nextGenCustomerName: "Unmapped source name",
    customerByAlias: map,
  });
  const nextGenOnly = resolveRealPropertyImportCustomer({
    cubeCustomerName: "",
    nextGenCustomerName: "DLA-DLR",
    customerByAlias: map,
  });

  assert.equal(cubeOnly.error, null);
  assert.equal(cubeOnly.customer?.CustomerID, "CUST-000027");
  assert.equal(nextGenOnly.error, null);
  assert.equal(nextGenOnly.customer?.CustomerID, "CUST-000027");
});

test("unresolved names preserve the existing missing-mapping validation path", () => {
  const result = resolveRealPropertyImportCustomer({
    cubeCustomerName: "Unknown CUBE customer",
    nextGenCustomerName: "Unknown NextGen customer",
    customerByAlias: new Map(),
  });

  assert.equal(result.customer, null);
  assert.equal(result.error, null);
});

