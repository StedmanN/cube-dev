# CUBE — RCBL and EEIC Crosswalk (QC Preview)

## Purpose

This update adds the existing read-only 3556 reporting split to the customer-facing **RCBL Short PDF**, and allows reviewed, versioned EEIC/Object Class values to be changed through the Billing financial-report panel. It does **not** change customer charges, 3556 rates, reimbursement, allocations, or prior saved bill snapshots.

## Actual RCBL Short customer PDF

- Valid 3556 reporting splits show a commodity utility line and a combined `Other Utilities (PROVISIONAL)` line with `-` consumption, unit, and rate; the total due is unchanged.
- `Unit Cost` is the *display-only amount-per-consumption equivalent* for the commodity portion; it is not a replacement for the approved 3556 sales rate. The bill PDF explicitly says the breakdown is display-only.
- Missing, invalid, or non-reconciling reporting splits show their **original billed amounts** under `REVIEW`, plus an explicit `Unclassified - Review Required` notice. The application does not guess an amount for Other Utilities.
- CE-absorbed lines remain excluded from customer billing.
- Both the individual customer PDF and the all-customer PDF export use the new presentation function.

## Configurable accounting crosswalk

Within Billing financial reporting, generate a **Current reconciliation preview**, select **EEIC / Object Class crosswalk**, and press **Load crosswalk**. Signed-in users may update EEIC, Object Class, and PENDING/DISPUTED/PROVISIONAL status, with an 8+ character justification. No additional email/group allowlist or role configuration is required. The former crosswalk editor allowlist settings are no longer used. The default values are *working candidates*, not approved codes.

When a signed-in user explicitly saves changes, the server makes a DynamoDB transaction in the **existing** `p72-CUBE-3556` table (or existing `CUBE_3556_TABLE_NAME` override):

- `PK=3556_ACCOUNTING_CROSSWALK`, `SK=CURRENT` (active pointer).
- `PK=3556_ACCOUNTING_CROSSWALK`, `SK=AUDIT#<timestamp>#<uuid>` (immutable audit snapshot).

This does **not** update any `3556#...` rate/worksheet row. Saves require a signed-in session, a documented reason, strict code validation, and revision conflict checking. Historical RCBL bill versions preserve their previously snapshotted accounting codes. Saved-source reports remain read-only. No crosswalk data was written by the patch author.

## Remaining Government decisions

- Provisional electricity O&M accounts 811144, 811149, 812223, 812225, 812226 need confirmation as SRM Materials.
- The five February WWYK produced-water charges totaling $389.50 remain unclassified because the source FINAL 3556 annual cost is blank.
- Sewage EEIC 48030 vs 48040 is not resolved; it remains null by default.
- Mark's illustrative $345.93 Other Utilities example does **not** match the current provisional percentage split ($383.79 for the documented illustrative inputs). The implementation does not change the billing methodology to force a match.
- Both the 3556 *row classification* and *EEIC crosswalk* endpoints use the app's existing signed-in access.

## Verification before deployment

1. In `C:\Projects\p72`, run `npm run typecheck`.
2. Run the **CAC production build** with `cmd /c "set AUTH_MODE=cac&&npm run build"`.
3. Test the live read-only February preview and customer PDF exports (single and all), including a customer with unclassified water, classes A/E and Class B, and both TAC/WWYK groups.
4. Validate that customer billed totals match Production's *own* authoritative data. Do not substitute Development's $1,876,412.96 as a mandatory Production result if the source data has changed.
5. Leave Government QC reports visibly PROVISIONAL; do not treat them as approved accounting forms.

The patch is source-only. No AWS access, DynamoDB writes, Git operations, or EC2 deployment were performed by its author.
