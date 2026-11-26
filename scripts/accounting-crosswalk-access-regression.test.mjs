// Execute the real route with session and DynamoDB doubles; no AWS calls/writes.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const routeFile = path.join(root, "app/api/billing/3556/accounting-crosswalk/route.ts");
function compile(file, dependencies) {
  const output = { exports: {} };
  const js = ts.transpileModule(readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function("require", "module", "exports", js)(dependencies, output, output.exports);
  return output.exports;
}
const crosswalk = compile(path.join(root, "lib/reporting-crosswalk.ts"), require);
function fixture(user = { name: "Ordinary signed-in user", id: "user-1" }, current = undefined) {
  const calls = [];
  class GetCommand { constructor(input) { this.input = input; } }
  class TransactWriteCommand { constructor(input) { this.input = input; } }
  const route = compile(routeFile, dependency => {
    if (dependency === "next/server") return { NextResponse: Response };
    if (dependency === "@aws-sdk/lib-dynamodb") return { GetCommand, TransactWriteCommand };
    if (dependency === "@/lib/app-session") return { getAppSession: async () => user ? { user } : null };
    if (dependency === "@/lib/reporting-crosswalk") return crosswalk;
    if (dependency === "@/lib/dynamo") return { ddb: { send: async command => {
      calls.push(command);
      return command instanceof GetCommand ? { Item: current } : {};
    } } };
    return require(dependency);
  });
  return { route, calls, TransactWriteCommand };
}
const request = body => new Request("http://localhost/api/billing/3556/accounting-crosswalk", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});
const body = () => ({ codes: structuredClone(crosswalk.CANDIDATE_CROSSWALK), reason: "Accounting reference reviewed", expectedUpdatedAt: null });

test("anonymous users cannot read or save the crosswalk", async () => {
  const { route, calls } = fixture(null);
  assert.equal((await route.GET()).status, 401);
  assert.equal((await route.POST(request(body()))).status, 401);
  assert.equal(calls.length, 0);
});
test("an authenticated user without explicit editor authorization is read-only", async () => {
  const { route, calls, TransactWriteCommand } = fixture();
  const loaded = await route.GET();
  assert.equal(loaded.status, 200);
  assert.deepEqual((await loaded.json()).codes, crosswalk.CANDIDATE_CROSSWALK);
  assert.equal((await route.POST(request(body()))).status, 403);
  assert.equal(calls.filter(command => command instanceof TransactWriteCommand).length, 0);
});
test("an explicitly authorized editor can save an audited crosswalk", async () => {
  const previousGroups = process.env.CUBE_REPORTING_CROSSWALK_EDITOR_GROUPS;
  const previousEmails = process.env.CUBE_REPORTING_CROSSWALK_EDITOR_EMAILS;
  process.env.CUBE_REPORTING_CROSSWALK_EDITOR_GROUPS = "accounting-test-editors";
  delete process.env.CUBE_REPORTING_CROSSWALK_EDITOR_EMAILS;
  const user = { name: "Authorized editor", id: "editor-1", groups: ["Accounting-Test-Editors"] };
  try {
  const { route, calls, TransactWriteCommand } = fixture(user);
  const loaded = await route.GET();
  assert.equal(loaded.status, 200);
  assert.equal((await loaded.json()).canEdit, true);
  const saved = await route.POST(request(body()));
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).accountingApproved, false);
  const writes = calls.filter(command => command instanceof TransactWriteCommand);
  assert.equal(writes.length, 1);
  const [pointer, audit] = writes[0].input.TransactItems.map(item => item.Put);
  assert.equal(pointer.Item.SK, "CURRENT");
  assert.match(audit.Item.SK, /^AUDIT#/);
  assert.equal(audit.Item.UpdatedBy, "Authorized editor");
  assert.equal(audit.Item.Reason, body().reason);
  assert.deepEqual(audit.Item.Codes, body().codes);
  assert.ok(pointer.ConditionExpression);
  assert.ok(audit.ConditionExpression);
  } finally {
    if (previousGroups === undefined) delete process.env.CUBE_REPORTING_CROSSWALK_EDITOR_GROUPS;
    else process.env.CUBE_REPORTING_CROSSWALK_EDITOR_GROUPS = previousGroups;
    if (previousEmails === undefined) delete process.env.CUBE_REPORTING_CROSSWALK_EDITOR_EMAILS;
    else process.env.CUBE_REPORTING_CROSSWALK_EDITOR_EMAILS = previousEmails;
  }
});
test("authorized editors cannot save invalid codes or missing reasons", async () => {
  const previousGroups = process.env.CUBE_REPORTING_CROSSWALK_EDITOR_GROUPS;
  process.env.CUBE_REPORTING_CROSSWALK_EDITOR_GROUPS = "accounting-test-editors";
  try {
  const { route, calls, TransactWriteCommand } = fixture({ name: "Authorized editor", groups: ["accounting-test-editors"] });
  assert.equal((await route.POST(request({ ...body(), reason: "" }))).status, 400);
  const invalid = body(); invalid.codes.EL.objectClass = "invalid";
  assert.equal((await route.POST(request(invalid))).status, 400);
  assert.equal(calls.filter(command => command instanceof TransactWriteCommand).length, 0);
  } finally {
    if (previousGroups === undefined) delete process.env.CUBE_REPORTING_CROSSWALK_EDITOR_GROUPS;
    else process.env.CUBE_REPORTING_CROSSWALK_EDITOR_GROUPS = previousGroups;
  }
});
test("an authorized editor cannot overwrite a stale crosswalk revision", async () => {
  const previousGroups = process.env.CUBE_REPORTING_CROSSWALK_EDITOR_GROUPS;
  process.env.CUBE_REPORTING_CROSSWALK_EDITOR_GROUPS = "accounting-test-editors";
  try {
  const { route, calls, TransactWriteCommand } = fixture({ name: "Authorized editor", groups: ["accounting-test-editors"] }, { UpdatedAt: "newer-revision" });
  assert.equal((await route.POST(request(body()))).status, 409);
  assert.equal(calls.filter(command => command instanceof TransactWriteCommand).length, 0);
  } finally {
    if (previousGroups === undefined) delete process.env.CUBE_REPORTING_CROSSWALK_EDITOR_GROUPS;
    else process.env.CUBE_REPORTING_CROSSWALK_EDITOR_GROUPS = previousGroups;
  }
});
