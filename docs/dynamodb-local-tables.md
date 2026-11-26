# CUBE DynamoDB Local table inventory

This inventory is derived from the TEST copy's DynamoDB commands and item
builders. It defines empty tables only; it does not contain or import data.

| Table | Primary key | Required GSIs | Billing role |
| --- | --- | --- | --- |
| `p72-CUBE-CUSTOMERS` | `CustomerID` (S) | None | Customer registry and billing classification |
| `p72-CUBE-FACILITIES` | `FacilityID` (S) | None | Facility registry used by meters and real property |
| `p72-CUBE-METERS` | `meterid` (S) | None | Meter master data, multiplier, utility, facility, and read method |
| `p72-CUBE-INV-READ-METHODS` | `inv_read_method_id` (N) | None | AMR/manual authority and rollover behavior |
| `p72-CUBE-METER-MAPPINGS` | `source_meterid` (S) + `source_facility_nbr` (S) | None | Maps imported AMR identifiers and facilities to CUBE meters |
| `p72-CUBE-METER-CORRECTION-RULES` | `correction_rule_cd` (S) | None | Reading validation and correction rule reference data |
| `p72-CUBE-CATEGORY-CODES` | `category_cd` (S) | None | Maps real-property categories to space types |
| `p72-CUBE-SPACE-TYPES` | `space_type_id` (S) | None | Space-type reference data |
| `p72-CUBE-INTENSITY-VALUES` | `intensityid` (S) | None | FY/utility/space-type intensity values used for estimates |
| `p72-CUBE-METER-READINGS` | `meterid` (S) + `billing_period_id` (N) | `billing-period-index`: `billing_period_id` (N); `fy-index`: `fy` (N) | Monthly readings, corrected consumption, and validation state |
| `p72-CUBE-INVOICES` | `invoiceid` (S) | `billing-period-index`: `billing_period_id` (N); `fy-index`: `fy` (N) | Monthly utility invoice consumption and cost |
| `p72-CUBE-RP-LEGACY` | `LegacyRPID` (S) | None | Annual legacy real-property allocations |
| `p72-CUBE-RP-MONTHLY` | `MonthlyRPID` (S) | `billing-period-index`: `billing_period_id` (N) | Monthly real-property/customer allocation inputs |
| `p72-CUBE-ESTIMATES` | `EstimateID` (S) | `billing-period-index`: `billing_period_id` (N) | Area × intensity projected usage |
| `p72-CUBE-RP-PROPQ` | `PropQID` (S) | `billing-period-index`: `billing_period_id` (N) | Facility/utility proportional allocation weights |
| `p72-CUBE-PLANT-UNIT` | `PlantUnitID` (S) | `billing-period-index`: `billing_period_id` (N) | Produced-utility quantities used during reconciliation |
| `p72-CUBE-MONTHLY-RECONCILIATION` | `billing_period_id` (N) + `ReconciliationID` (S) | None | Persisted summaries, allocations, and unresolved-meter records |
| `p72-CUBE-3556` | `PK` (S) + `SK` (S) | None | Draft/final/archive utility sales-rate worksheets |
| `p72-CUBE-RCBL-SHORT` | `RCBLShortID` (S) | None | Versioned current short-form reimbursable bills and active pointer |
| `p72-CUBE-RCBL-SHORT-HISTORY` | `billing_period_id` (N) + `HistoryKey` (S) | None | Immutable bill replacement audit/history metadata |

## Workflow relationship

1. Registry and reference tables establish customers, facilities, meters,
   reading behavior, category/space mappings, and intensity factors.
2. Monthly imports create meter readings, invoices, monthly real property, and
   projected estimates. PropQ converts estimates into allocation weights; plant
   unit records add produced-utility quantities.
3. Monthly reconciliation combines invoices, included meter consumption,
   PropQ, real property, and plant production into persisted allocation and
   summary records.
4. Final 3556 worksheets provide approved rates. RCBL Short combines those
   rates with reconciled allocations and invoice cost recovery to generate
   customer bills.
5. The RCBL Short table stores versioned bill rows plus the active-version
   pointer. The history table records replacement lineage and audit metadata.

### Real Property snapshot retention

After a successful snapshot activation, CUBE retains the active version and its
five most recent previously active versions per billing period. Ordering follows
the successful activation audit chain, including empty snapshots. Cleanup deletes
only older audited versions from RP-MONTHLY, ESTIMATES and RP-PROPQ. It does not
remove annual legacy data, unversioned records, abandoned staging versions, audit
records, reconciliation records or saved bills. Periods without an active pointer
are skipped. Missing/ambiguous audit history stops cleanup.

Every delete transaction checks the captured active pointer. If activation changes
while cleanup is running, cleanup stops and can be retried. A cleanup failure is
logged separately after activation and never reports a committed activation as a
failed update. Interrupted cleanup can leave an old inactive version partially
removed; rerunning completes it without touching retained versions. The existing
billing-period GSI is eventually consistent, so delayed obsolete entries may
require a later retry. No new indexes are required for this retention change.

For existing local data, preview with:

```sh
node scripts/real-property-retention.mjs --all
```

Apply with `--all --apply` (or replace `--all` with a billing-period ID). Apply
fingerprints protected records in the affected periods and the control table,
checks February as a legacy comparison, and verifies no obsolete audited rows
remain. Protected rows are captured while reading cleanup pages to avoid an
additional full-history scan. This
maintenance script is permanently restricted to DynamoDB Local at 127.0.0.1:8000.
Deletion is irreversible without a backup. Audit metadata remains available but
removed versions' full source records can no longer be reconstructed from it.

Validation:

```sh
node --test scripts/real-property-retention.test.mjs
node scripts/real-property-retention-local.test.mjs
```

The second test creates and removes uniquely named disposable local tables.
