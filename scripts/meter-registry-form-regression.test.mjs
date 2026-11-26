import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const client = readFileSync(
  path.join(root, "app/backgrounddata/meter-registry-client.tsx"),
  "utf8",
);
const styles = readFileSync(
  path.join(root, "app/backgrounddata/backgrouddata.css"),
  "utf8",
);

test("Sub Installation uses the standard Meter Registry field presentation", () => {
  assert.match(client, /label="Sub Installation"/);
  assert.doesNotMatch(client, /bd-meter-group-field|bd-form-field-hint|WWYK \/ SHCZ = Group 1/);
  assert.doesNotMatch(styles, /\.bd-meter-group-field|\.bd-form-field-hint/);
});
