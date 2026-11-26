# Removes ONLY obsolete reporting files left by the prior November 10 Dev implementation.
# Does NOT touch environment, local authentication, DynamoDB Local, existing tests, or Git.
$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$old = @(
  "docs/3556-other-utilities-reporting.md",
  "lib/3556-reporting-breakdown.ts",
  "lib/development-preview-pdf.ts",
  "lib/development-preview-xlsx.ts",
  "lib/eeic-cross-reference.ts",
  "lib/eeic-reporting.ts",
  "scripts/3556-reporting-breakdown-regression.test.mjs",
  "scripts/eeic-reporting-regression.test.mjs",
  "scripts/phase4-browser-validation.mjs",
  "scripts/phase4-live-report-validation.mjs",
  "scripts/phase5a-formatting-regression.test.mjs",
  "scripts/phase5a-local-audit.mjs"
)
foreach ($relative in $old) {
  $full = Join-Path $root $relative
  if (Test-Path -LiteralPath $full -PathType Leaf) {
    Remove-Item -LiteralPath $full -Force
    Write-Host "Removed obsolete reporting file: $relative"
  }
}
Write-Host "Old November 10 reporting files cleanup complete."
