import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { extname, relative } from "node:path";

const root = new URL("../", import.meta.url);
const sourceExtensions = new Set([".ts", ".tsx", ".js", ".mjs", ".sh"]);
const ignoredDirectories = new Set([".git", ".next", "node_modules"]);

function read(path) {
  return readFileSync(new URL(path, root), "utf8");
}

function sourceFiles(directory = new URL("./", root)) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const entryUrl = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, directory);
    if (entry.isDirectory()) files.push(...sourceFiles(entryUrl));
    else if (sourceExtensions.has(extname(entry.name))) files.push(entryUrl);
  }
  return files;
}

const dynamo = read("lib/dynamo.ts");
assert.match(dynamo, /endpoint:\s*DYNAMODB_LOCAL_ENDPOINT/);
assert.match(dynamo, /DYNAMODB_LOCAL_ENDPOINT\s*=\s*"http:\/\/127\.0\.0\.1:8000"/);
assert.match(dynamo, /accessKeyId:\s*"DUMMYLOCALACCESSKEY"/);
assert.match(dynamo, /secretAccessKey:\s*"DUMMYLOCALSECRETKEY"/);
assert.match(dynamo, /maxAttempts:\s*1/);
assert.doesNotMatch(dynamo, /process\.env/);
assert.match(dynamo, /DynamoDBLocalUnavailableError/);
assert.match(dynamo, /will not fall back to AWS/);
assert.match(dynamo, /step:\s*"finalizeRequest"/);

const dynamoError = read("lib/dynamo-error.ts");
assert.match(dynamoError, /DYNAMODB_LOCAL_UNAVAILABLE/);

const authMode = read("lib/auth-mode.ts");
assert.match(authMode, /AUTH_MODE:\s*AuthMode\s*=\s*"local"/);
assert.match(authMode, /isLocalAuth\s*=\s*true/);
assert.doesNotMatch(authMode, /process\.env/);

const auth = read("lib/auth.ts");
assert.doesNotMatch(auth, /process\.env\.COGNITO/);
assert.doesNotMatch(auth, /amazonaws\.com|us-gov-/i);

const loader = read("scripts/load-env.sh");
assert.doesNotMatch(loader, /^\s*aws\s+/m);
assert.match(loader, /exit 1/);

// The standalone export utility is the sole intentional AWS-capable file. It
// is not imported by the application and is restricted to DescribeTable/Scan.
const govCloudExport = read("scripts/export-govcloud-dynamodb.mjs");
assert.match(
  govCloudExport,
  /GOVCLOUD_ENDPOINT\s*=\s*"https:\/\/dynamodb\.us-gov-west-1\.amazonaws\.com"/,
);
assert.match(govCloudExport, /credentials:\s*fromIni\(\{ profile \}\)/);
assert.match(govCloudExport, /DescribeTableCommand/);
assert.match(govCloudExport, /ScanCommand/);
assert.match(govCloudExport, /PREFLIGHT_PROFILE\s*=\s*"govcloud"/);
assert.match(govCloudExport, /govCloudDescribeTableOnlyGuard/);
assert.match(govCloudExport, /context\.commandName\s*!==\s*"DescribeTableCommand"/);
assert.match(govCloudExport, /LOCAL_ENDPOINT\s*=\s*"http:\/\/127\.0\.0\.1:8000"/);
assert.match(govCloudExport, /accessKeyId:\s*"DUMMYLOCALACCESSKEY"/);
assert.match(govCloudExport, /secretAccessKey:\s*"DUMMYLOCALSECRETKEY"/);
assert.match(govCloudExport, /localDescribeTableOnlyGuard/);
assert.match(govCloudExport, /localPreflightLoopbackGuard/);
assert.doesNotMatch(
  govCloudExport,
  /PutItemCommand|UpdateItemCommand|DeleteItemCommand|BatchWriteItemCommand|TransactWriteItemsCommand|CreateTableCommand|UpdateTableCommand|DeleteTableCommand/,
);
assert.match(govCloudExport, /govCloudReadOnlyExportGuard/);

// The importer mentions the GovCloud endpoint only to authenticate the
// manifest's provenance. Its sole client remains hard-locked to loopback.
const localImport = read("scripts/import-local-dynamodb.mjs");
assert.match(
  localImport,
  /LOCAL_ENDPOINT\s*=\s*"http:\/\/127\.0\.0\.1:8000"/,
);
assert.match(localImport, /accessKeyId:\s*"DUMMYLOCALACCESSKEY"/);
assert.match(localImport, /secretAccessKey:\s*"DUMMYLOCALSECRETKEY"/);
assert.match(localImport, /maxAttempts:\s*1/);
assert.match(localImport, /localImportHttpGuard/);
assert.doesNotMatch(localImport, /fromIni|AWS_PROFILE|process\.env\.AWS/);

const meterMappingsRepair = read("scripts/recreate-local-meter-mappings-table.mjs");
assert.match(
  meterMappingsRepair,
  /LOCAL_ENDPOINT\s*=\s*"http:\/\/127\.0\.0\.1:8000"/,
);
assert.match(
  meterMappingsRepair,
  /TARGET_TABLE\s*=\s*"p72-CUBE-METER-MAPPINGS"/,
);
assert.match(meterMappingsRepair, /accessKeyId:\s*"DUMMYLOCALACCESSKEY"/);
assert.match(meterMappingsRepair, /secretAccessKey:\s*"DUMMYLOCALSECRETKEY"/);
assert.match(meterMappingsRepair, /maxAttempts:\s*1/);
assert.match(meterMappingsRepair, /meterMappingsSingleTableGuard/);
assert.match(meterMappingsRepair, /meterMappingsLoopbackGuard/);
assert.match(meterMappingsRepair, /ConsistentRead:\s*true/);
assert.match(meterMappingsRepair, /Select:\s*"COUNT"/);
assert.doesNotMatch(
  meterMappingsRepair,
  /fromIni|AWS_PROFILE|process\.env\.AWS|amazonaws\.com|us-gov-/i,
);

const unsafe = [];
for (const fileUrl of sourceFiles()) {
  const path = relative(new URL("./", root).pathname, fileUrl.pathname).replaceAll("\\", "/");
  if (path === "scripts/verify-local-isolation.mjs") continue;
  const contents = readFileSync(fileUrl, "utf8");

  if (
    path === "scripts/export-govcloud-dynamodb.mjs" ||
    path === "scripts/import-local-dynamodb.mjs"
  ) continue;

  if (/@aws-sdk\/client-(?!dynamodb\b)/.test(contents)) {
    unsafe.push(`${path}: imports a non-DynamoDB AWS service client`);
  }
  if (/amazonaws\.com|us-gov-/i.test(contents)) {
    unsafe.push(`${path}: contains a production AWS/GovCloud endpoint`);
  }
  if (/^\s*aws\s+/m.test(contents)) {
    unsafe.push(`${path}: invokes the AWS CLI`);
  }
  if (/new\s+DynamoDBClient\s*\(/.test(contents)) {
    if (!/http:\/\/127\.0\.0\.1:8000/.test(contents)) {
      unsafe.push(`${path}: constructs a DynamoDB client without the local endpoint`);
    }
    if (!/DUMMYLOCALACCESSKEY/.test(contents)) {
      unsafe.push(`${path}: constructs a DynamoDB client without dummy credentials`);
    }
  }
}

assert.deepEqual(unsafe, [], unsafe.join("\n"));
console.log("Isolation verification passed: AWS/GovCloud access paths are disabled.");
