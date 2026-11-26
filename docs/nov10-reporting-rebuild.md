# November 10 reporting rebuild — implementation and boundaries

## Baselines
- Production is based exclusively on the user's clean GitHub archive `CUBE_Clean_Production.zip`.
- Development is based on `P72_Dev(4).zip`, preserving its standalone local-auth mode, existing DynamoDB Local connection, isolation tests and period-query optimizations. Neither source was replaced with the other.
- New reporting has **no feature flag**. It is available in Customer Billing > RCBL, EEIC Short, and EEIC Detail; the previously working RCBL Short billing preview / official export remains present and unchanged in financial methodology.

## Source of truth and mathematical boundaries
1. RCBL's existing authoritative source chooses the matching utility-group/utility-type `FINAL` Form 3556 at the original effective date and calculates its **existing** charge. Reporting uses that same selected 3556 record (no independent rate/date lookups, static annual costs, or rate changes).
2. The report calculates an **illustrative cost allocation of an existing customer-reimbursable charge**, not a new customer charge. For each component: `(source annual cost / class-specific source annual-cost basis) × original charge`, rounded to cents. Purchased utility is the exact residual, so each line's reported components reconcile to its original charge. CE-absorbed amounts remain excluded from customer-due reporting.
3. The required components are: Class B electricity: REM, CUBE/UMM, SRM Labor, and SRM Materials; Class B NG/PW/SS: SRM Materials; Class C/D electricity: REM, CUBE/UMM, SRM Labor; Class A and E: no separation. Class mapping comes from the existing 3556 rate key rather than guessing from customer labels.
4. Source rows are read from the selected `worksheet.purchased`, `purchasedServices`, `produced`, and `distribution` arrays. Exact known labels can identify REM, CUBE, Labor and explicitly labeled FSRM. **An unlabeled Distribution O&M row is NOT automatically treated as SRM Materials.** Unidentified rows require an explicit reviewed classification matching `section:rowID`.
5. Reviewed classification assignments are stored separately from finalized source 3556 worksheets in the existing 3556 DynamoDB table, identified by `3556_REPORTING_MAP#<worksheetId>` and a source SHA-256 fingerprint. Every save records who made the mapping, when and why, and writes an immutable audit record. The form's underlying source costs/rates are never edited.
6. Missing/ambiguous source costs, stale mappings, invalid denominators, and nonmatching preserved report lines yield **REVIEW**, not fabricated dollar allocations.
7. A newly saved RCBL version snapshots the reporting splits and the currently supplied *candidate* accounting-code values. A historical saved bill is not recomputed against today's 3556. Legacy saved bills without snapshots return REVIEW.

## Accounting and sample limitations — NOT certified
- The included candidate EEIC / Object Class crosswalk was assembled from the provided examples and is deliberately tagged `PENDING` or `DISPUTED`; Sewage EEIC is deliberately `UNRESOLVED`. **No export from this rebuild claims Finance authorization.** PDFs/Excel/CSV are labeled REVIEW and are for verification until the authorized crosswalk is supplied.
- The July DECA example includes a conflict between its displayed 3556 date and rounded rate, which meeting remarks also dispute. It has *not* been coerced into an acceptance fixture by inventing a denominator.
- The report-only *basis selection* and any conversion of total bill to displayed consumption are not independently certified. The existing reconciliation meter consumption is not modified. No hidden change to billing, rate, allocation or reimbursement methodology has been made.
- `npm run lint` invokes both formatting and import organization on the existing code. Legacy files may not pass formatting even though the source regression suite passes. The earlier Windows ARM64 Biome 2.5.5 crash may recur after a clean GitHub restore; upgrade that **dev tool only** to 2.5.9 as previously discussed if required, without running --write.
- Actual production and local DynamoDB databases have **not** been touched. End-to-end application builds, TypeScript typecheck and browser/live DynamoDB verification must still run on the user's computer before deployment.

## Recommended verification before deployment
**Production in `C:\Projects\p72`:** `npm run typecheck` then `cmd /c "set AUTH_MODE=cac&&npm run build"`; run the regression suite and manually preview new reports using data consistent with actual completed billing periods. Leave Git/deploy to operator. **No AWS access requested for this test.**

**Development in `C:\Projects\Test-Projects\CUBE\app`:** maintain the local-only `.env.local` and `lib/dynamo.ts` untouched; execute `node scripts/verify-local-isolation.mjs`, `npm run typecheck`, and the local build/regression tests; compare known 3556 costs and approved customer charges against the new source classifications.

When overlaying this complete Dev archive onto an existing directory, the previous reporting-only files are not removed by Windows Explorer's Copy/Overwrite. Run the dedicated script `scripts/remove-previous-nov10-reporting.ps1` (read it before running); it removes only the explicitly named obsolete reporting files and does not touch `.env.local`, `.git`, `node_modules` or unrelated Dev work.
