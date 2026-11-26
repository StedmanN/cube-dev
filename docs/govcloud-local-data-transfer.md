# GovCloud-to-DynamoDB-Local data transfer

This process keeps the CUBE application permanently connected to DynamoDB
Local. A standalone export utility performs the authorized, read-only GovCloud
work; a separate importer can connect only to `http://127.0.0.1:8000`.

No command in this document has been run as part of preparing these scripts.

## Scope and February FY2026 policy

The export covers all 20 CUBE tables. It exports complete source/reference data
and complete meter-reading history, which preserves every historical dependency
and relationship rather than trying to reconstruct a partial graph.

February FY2026 is billing period 175. The export asserts that meter readings
exist for these calculation dependencies:

- 175: February FY2026 current readings
- 174, 173, 172: prior-month correction/validation dependencies
- 163: February FY2025 prior-year dependency

The following records are filtered out during the AWS scan:

- billing period 175 from `p72-CUBE-MONTHLY-RECONCILIATION`
- billing period 175 from `p72-CUBE-RCBL-SHORT`
- billing period 175 from `p72-CUBE-RCBL-SHORT-HISTORY`

Invoices, rates, estimates, PropQ, plant production, real property, customers,
facilities, meters, mappings, and other source/reference data remain included.

## AWS permissions

Use a dedicated GovCloud profile whose IAM policy allows only:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "dynamodb:DescribeTable",
        "dynamodb:Scan"
      ],
      "Resource": "arn:aws-us-gov:dynamodb:us-gov-west-1:ACCOUNT_ID:table/p72-CUBE-*"
    }
  ]
}
```

Replace `ACCOUNT_ID` in the IAM policy, not in any export file. The exporter
requires `--profile`, uses `fromIni` for that profile only, and refuses AWS
access-key, secret-key, session-token, web-identity, or role variables in its
environment. It imports no DynamoDB write commands.

## Schema preflight before export

From the project root on the authorized machine, run:

```powershell
node .\scripts\export-govcloud-dynamodb.mjs --preflight --profile govcloud
```

Preflight is hard-limited to the existing `govcloud` profile, the GovCloud West
region, and the fixed DynamoDB GovCloud endpoint. It also connects to
`http://127.0.0.1:8000` using fixed dummy credentials and no credential chain.
Command middleware on both clients rejects every operation except
`DescribeTable`; endpoint middleware prevents either client from reaching a
different destination. It does not scan records, create an export directory,
or write to either DynamoDB service. DynamoDB Local must be running first.

The check first confirms Node.js 20+ and both required AWS SDK packages are
installed. It then compares each production table to the live DynamoDB Local
table and checks the local table against the shared definition used by
`create-local-dynamodb-tables.mjs`. Comparisons include the primary key,
key/index attribute types, exact GSI names and keys, GSI projections, and LSIs.
Per-table and total production `ItemCount` and `TableSizeBytes` values are
displayed as estimates; DynamoDB updates these values periodically, so they are
suitable for transfer planning rather than exact record accounting.

Exit code `0` means all 20 schemas match, `2` means at least one schema differs,
and `1` means the check could not complete. Review every mismatch before
enabling export or import.

### Correct the local meter-mappings key after review

Production defines `p72-CUBE-METER-MAPPINGS` with `source_meterid` (`S`) as its
hash key and `source_facility_nbr` (`S`) as its range key. To repair only the
empty local copy after review, run:

```powershell
node .\scripts\recreate-local-meter-mappings-table.mjs --apply --confirm-no-writers
```

Stop the test application and every other local DynamoDB writer before running
the command; the confirmation flag is required to acknowledge that condition.
The repair utility is hard-locked to `http://127.0.0.1:8000`, uses dummy
credentials, and permits operations only on `p72-CUBE-METER-MAPPINGS`. Before
deletion, it performs a consistent `Select: COUNT` scan and refuses to proceed
if any item exists. It then deletes and recreates only that table from the
shared definition. Running it without `--apply` is an offline plan and makes no
connection.

## Export after approval

First review the plan without connecting to AWS:

```powershell
node scripts/export-govcloud-dynamodb.mjs
```

After approval, use the dedicated read-only profile:

```powershell
node scripts/export-govcloud-dynamodb.mjs --export `
  --profile cube-export-readonly `
  --output .cube-data/cube-fy2026-feb-source
```

The endpoint is fixed to
`https://dynamodb.us-gov-west-1.amazonaws.com`. Final-request middleware blocks
every other host. Output is allowed only below `.cube-data`, which is ignored by
Git.

Each table receives:

- `schema.json`: primary key, attribute definitions, and GSIs
- `items.ndjson`: one raw DynamoDB `AttributeValue` map per line

The root `manifest.json` contains exact exported item counts, NDJSON byte sizes,
SHA-256 hashes, page/scanned counts, approximate AWS `ItemCount` and
`TableSizeBytes`, the exclusion policy, and dependency-period counts. It does
not contain credentials, profile contents, tokens, ARNs, or secrets.

## Transfer and offline verification

Transfer the entire export directory. If an archive is needed:

```powershell
Compress-Archive `
  -Path .cube-data/cube-fy2026-feb-source `
  -DestinationPath .cube-data/cube-fy2026-feb-source.zip
Get-FileHash .cube-data/cube-fy2026-feb-source.zip -Algorithm SHA256
```

After copying/extracting it beneath `.cube-data`, verify it without connecting
to either DynamoDB service:

```powershell
node scripts/import-local-dynamodb.mjs --verify `
  --source .cube-data/cube-fy2026-feb-source
```

This checks every table file's SHA-256, byte count, item count, JSON structure,
and February exclusion.

## Local import after separate approval

The importer uses raw low-level DynamoDB items, so `S`, `N`, `BOOL`, `NULL`,
`B`, lists, maps, and string/number/binary sets are not converted. It validates
all 20 local schemas and confirms every local table is empty before issuing the
first write.

After review:

```powershell
node scripts/import-local-dynamodb.mjs --import `
  --source .cube-data/cube-fy2026-feb-source
```

The importer has a literal `127.0.0.1:8000` endpoint, alphanumeric dummy
credentials, one SDK attempt, and a final-request loopback guard. It cannot use
an AWS profile or credential chain. It batch-writes at most 25 raw items and
verifies each local table's final count.

The import is not globally transactional across tables. If the local process is
interrupted after writes begin, recreate/empty the affected local tables before
retrying; the importer deliberately refuses non-empty destinations.

## Expected size and compatibility

Exact production sizes cannot be known without the authorized read-only AWS
operation. The export manifest records both AWS's approximate table size/count
and the exact exported NDJSON size/count. Expect:

- meter readings to be the largest source-history table;
- invoices, monthly RP, estimates, and PropQ to scale with months and source
  rows;
- reconciliation and RCBL billing history to scale with allocation/billing
  lines, although February 175 is excluded;
- registry, reference, rate, mapping, and plant tables to be comparatively
  small.

Raw `AttributeValue` JSON is normally larger than DynamoDB's reported logical
table bytes because every value includes a type wrapper. Reserve at least three
times the combined AWS `TableSizeBytes` for the uncompressed export, manifest,
and a compressed transfer copy until the actual manifest is available.

Compatibility checks intentionally fail before import if production and local
primary keys, key types, or GSIs differ. This is especially important for
scan-only reference tables whose local keys were inferred from their canonical
identity fields. Attribute-name casing is preserved exactly. The scripts do not
transform legacy fields, recalculate formulas, create tables, or manufacture
relationships.
