// ============================================================
// REAL PROPERTY MONTHLY CSV IMPORT
//
// Imports NextGen real property rows, resolves customer/facility
// mappings, and calculates utility estimates using the current
// or newest eligible prior fiscal-year intensity value.
//
// Authentication is intentionally COMMENTED OUT for development.
// Enable and verify authorization before production deployment.
// ============================================================

import { getAppSession } from "@/lib/app-session";

import {
  QueryCommand,
  ScanCommand,
  type QueryCommandInput,
  type ScanCommandInput,
} from "@aws-sdk/lib-dynamodb";
import { ddb } from "@/lib/dynamo";
import {
  normalizeImportCustomerName,
  resolveRealPropertyImportCustomer,
} from "@/lib/real-property-import-customer";
import { normalizeLegacyRealPropertyRecord, usesPeriodSnapshot } from "@/lib/real-property-effective-core";
import { validateRealPropertyCategoryCode } from "@/lib/real-property-category-code";
import {
  activateRealPropertySnapshot,
  buildPropQRecords,
  filterActiveRealPropertyRecords,
  getRealPropertyPeriodState,
  realPropertySourceVersion,
} from "@/lib/real-property-snapshot";
import {
  REAL_PROPERTY_TABLES,
} from "@/lib/real-property-tables";
import {
  normalizeUtilityReimbursementOverrides,
  parseUtilityReimbursementCsvValue,
  UTILITY_CODES,
  type UtilityReimbursementOverrides,
} from "@/lib/utility-reimbursement";
export const dynamic = "force-dynamic";
export const revalidate = 0;
// ============================================================
// TABLES
// ============================================================
const RP_TABLE = REAL_PROPERTY_TABLES.monthly;
const ESTIMATES_TABLE = REAL_PROPERTY_TABLES.estimates;
const CUSTOMERS_TABLE = REAL_PROPERTY_TABLES.customers;
const FACILITIES_TABLE = REAL_PROPERTY_TABLES.facilities;
const CATEGORY_TABLE = REAL_PROPERTY_TABLES.categories;
const INTENSITY_TABLE = REAL_PROPERTY_TABLES.intensities;
const LEGACY_RP_TABLE = REAL_PROPERTY_TABLES.legacy;
const BILLING_PERIOD_INDEX =
  "billing-period-index";
// ============================================================
// TYPES
// ============================================================
type Item =
  Record<string, unknown>;
type IntensityMatch = {
  item: Item;
  intensityFY: number;
};
// ============================================================
// BASIC HELPERS
// ============================================================
function text(
  value: unknown,
): string {
  return value === undefined ||
    value === null
    ? ""
    : String(value).trim();
}
function numberOrNull(
  value: unknown,
): number | null {
  const normalized =
    text(value).replace(
      /[$,]/g,
      "",
    );
  if (!normalized) {
    return null;
  }
  const parsed =
    Number(normalized);
  return Number.isFinite(parsed)
    ? parsed
    : null;
}
function flag(
  value: unknown,
): number {
  const normalized =
    text(value).toUpperCase();
  return [
    "1",
    "Y",
    "YES",
    "TRUE",
    "X",
  ].includes(normalized)
    ? 1
    : 0;
}
function monthCode(
  month: string,
): string {
  return month
    .slice(0, 3)
    .toUpperCase();
}

const REIMBURSEMENT_COLUMNS = Object.freeze({
  EL: "EL Reimbursement",
  NG: "NG Reimbursement",
  PW: "PW Reimbursement",
  SS: "SS Reimbursement",
} as const);

function reimbursementOverridesFromUploadRow(
  row: Item,
  sourceRow: number,
): { overrides: UtilityReimbursementOverrides; errors: string[] } {
  const overrides: UtilityReimbursementOverrides = {};
  const errors: string[] = [];
  for (const utility of UTILITY_CODES) {
    const column = REIMBURSEMENT_COLUMNS[utility];
    if (!Object.prototype.hasOwnProperty.call(row, column)) continue;
    const parsed = parseUtilityReimbursementCsvValue(row[column]);
    if (parsed.error) {
      errors.push(`Row ${sourceRow}: ${column} ${parsed.error}`);
    } else if (parsed.value !== null) {
      overrides[utility] = parsed.value;
    }
  }
  return { overrides, errors };
}
// ============================================================
// SCAN ENTIRE TABLE
// ============================================================
async function scanAll(
  tableName: string,
): Promise<Item[]> {
  const items: Item[] =
    [];
  let exclusiveStartKey:
    | ScanCommandInput["ExclusiveStartKey"]
    | undefined;
  do {
    const result =
      await ddb.send(
        new ScanCommand({
          TableName:
            tableName,
          ExclusiveStartKey:
            exclusiveStartKey,
        }),
      );
    items.push(
      ...((result.Items ??
        []) as Item[]),
    );
    exclusiveStartKey =
      result.LastEvaluatedKey;
  } while (
    exclusiveStartKey
  );
  return items;
}
// ============================================================
// QUERY EXISTING RP FOR BILLING PERIOD
// ============================================================
async function queryPeriod(
  tableName: string,
  billingPeriodId: number,
): Promise<Item[]> {
  const items: Item[] =
    [];
  let exclusiveStartKey:
    | QueryCommandInput["ExclusiveStartKey"]
    | undefined;
  do {
    const result =
      await ddb.send(
        new QueryCommand({
          TableName:
            tableName,
          IndexName:
            BILLING_PERIOD_INDEX,
          KeyConditionExpression:
            "#bp = :bp",
          ExpressionAttributeNames: {
            "#bp":
              "billing_period_id",
          },
          ExpressionAttributeValues: {
            ":bp":
              billingPeriodId,
          },
          ExclusiveStartKey:
            exclusiveStartKey,
        }),
      );
    items.push(
      ...((result.Items ??
        []) as Item[]),
    );
    exclusiveStartKey =
      result.LastEvaluatedKey;
  } while (
    exclusiveStartKey
  );
  return filterActiveRealPropertyRecords(tableName, billingPeriodId, items);
}

async function queryLegacyBaseline(
  billingPeriodId: number,
  fy: number,
  billingMonth: string,
): Promise<Item[]> {
  const items: Item[] = [];
  let exclusiveStartKey: ScanCommandInput["ExclusiveStartKey"] | undefined;
  do {
    const result = await ddb.send(
      new ScanCommand({
        TableName: LEGACY_RP_TABLE,
        FilterExpression: "#fy = :fy",
        ExpressionAttributeNames: { "#fy": "FY" },
        ExpressionAttributeValues: { ":fy": fy },
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );
    items.push(...((result.Items ?? []) as Item[]));
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);
  return items.map((item) =>
    normalizeLegacyRealPropertyRecord(item, { billingPeriodId, billingMonth }),
  );
}
// ============================================================
// CSV PARSER
// Supports quoted commas, doubled quotation marks, and CRLF/LF rows.
// ============================================================
function parseCsv(
  csvText: string,
): Item[] {
  const records:
    string[][] = [];
  let record:
    string[] = [];
  let field = "";
  let inQuotes = false;
  for (
    let i = 0;
    i < csvText.length;
    i += 1
  ) {
    const char =
      csvText[i];
    if (inQuotes) {
      if (
        char === '"'
      ) {
        if (
          csvText[
            i + 1
          ] === '"'
        ) {
          field += '"';
          i += 1;
        } else {
          inQuotes =
            false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (
      char === '"'
    ) {
      inQuotes = true;
    } else if (
      char === ","
    ) {
      record.push(
        field,
      );
      field = "";
    } else if (
      char === "\n"
    ) {
      record.push(
        field,
      );
      records.push(
        record,
      );
      record = [];
      field = "";
    } else if (
      char !== "\r"
    ) {
      field += char;
    }
  }
  if (
    field.length >
      0 ||
    record.length >
      0
  ) {
    record.push(
      field,
    );
    records.push(
      record,
    );
  }
  if (
    records.length ===
    0
  ) {
    return [];
  }
  const headers =
    records[0].map(
      (
        header,
        index,
      ) =>
        index === 0
          ? header
              .replace(
                /^\uFEFF/,
                "",
              )
              .trim()
          : header.trim(),
    );
  return records
    .slice(1)
    .filter(
      (
        values,
      ) =>
        values.some(
          (
            value,
          ) =>
            value.trim() !==
            "",
        ),
    )
    .map(
      (
        values,
      ) => {
        const row:
          Item = {};
        headers.forEach(
          (
            header,
            index,
          ) => {
            if (
              header
            ) {
              row[
                header
              ] =
                values[
                  index
                ] ??
                "";
            }
          },
        );
        return row;
      },
    );
}
// ============================================================
// INTENSITY LOOKUP
// Estimate = area in SF multiplied by the matching intensity index.
//
// Business rule:
//
// 1. Use the uploaded RP fiscal year when that FY has an
//    intensity value for the Utility + Space Type.
//
// 2. If that exact FY does not exist, use the newest available
//    PRIOR fiscal year.
//
// 3. NEVER use an intensity value from a future fiscal year.
//
// Example:
//
// Upload FY27
//
// FY27 exists -> use FY27
// FY27 missing, FY26 exists -> use FY26
// FY27 missing, FY26/FY25 exist -> use FY26
// FY28 exists but FY27 missing -> DO NOT use FY28
// ============================================================
function buildIntensityLookup(
  intensities: Item[],
): Map<string, Item[]> {
  const lookup =
    new Map<
      string,
      Item[]
    >();
  for (
    const intensity
    of intensities
  ) {
    const intensityFY =
      numberOrNull(
        intensity.fy,
      );
    const utility =
      text(
        intensity
          .utility_type_cd,
      ).toUpperCase();
    const spaceTypeId =
      text(
        intensity
          .space_type_id,
      );
    if (
      intensityFY ===
        null ||
      !utility ||
      !spaceTypeId
    ) {
      continue;
    }
    const key =
      `${utility}|${spaceTypeId}`;
    const existing =
      lookup.get(
        key,
      ) ?? [];
    existing.push(
      intensity,
    );
    lookup.set(
      key,
      existing,
    );
  }
  // Sort newest FY first.
  //
  // This makes fallback deterministic:
  // the first candidate <= target FY wins.
  for (
    const values
    of lookup.values()
  ) {
    values.sort(
      (
        a,
        b,
      ) =>
        (numberOrNull(
          b.fy,
        ) ?? 0) -
        (numberOrNull(
          a.fy,
        ) ?? 0),
    );
  }
  return lookup;
}
function findIntensity(
  lookup:
    Map<string, Item[]>,
  targetFY: number,
  utility: string,
  spaceTypeId: string,
): IntensityMatch | null {
  const key =
    `${utility.toUpperCase()}|${spaceTypeId}`;
  const candidates =
    lookup.get(
      key,
    ) ?? [];
  // Candidates are already sorted
  // newest -> oldest.
  //
  // Therefore the first FY <= targetFY
  // is the correct value.
  const item =
    candidates.find(
      (
        candidate,
      ) => {
        const candidateFY =
          numberOrNull(
            candidate.fy,
          );
        return (
          candidateFY !==
            null &&
          candidateFY <=
            targetFY
        );
      },
    );
  if (!item) {
    return null;
  }
  const intensityFY =
    numberOrNull(
      item.fy,
    );
  if (
    intensityFY ===
    null
  ) {
    return null;
  }
  return {
    item,
    intensityFY,
  };
}
// ============================================================
// POST
// ============================================================
export async function POST(
  request: Request,
) {
  // ========================================================
  // PRODUCTION AUTHENTICATION (CURRENTLY DISABLED)
  //
  // Authenticate before accepting uploads or writing to
  // RP and estimates tables. Add role-based authorization.
  // ========================================================
  const session = await getAppSession();
  if (!session?.user) {
    return Response.json(
      { ok: false, error: "Unauthorized" },
      { status: 401 },
    );
  }
  // ========================================================
  // AUTHENTICATED REQUEST
  // ========================================================

  try {
    const formData =
      await request.formData();
    const file =
      formData.get(
        "file",
      );
    const fy =
      Number(
        formData.get(
          "fy",
        ),
      );
    const billingMonth =
      text(
        formData.get(
          "billing_month_nm",
        ),
      );
    const billingPeriodId =
      Number(
        formData.get(
          "billing_period_id",
        ),
      );
    const mode = text(formData.get("mode")).toLowerCase() || "import";
    if (!["import", "validate", "replace"].includes(mode)) {
      return Response.json(
        { ok: false, error: "Upload mode must be import, validate, or replace." },
        { status: 400 },
      );
    }
    if (
      mode !== "validate" &&
      text(formData.get("confirmed")).toLowerCase() !== "true"
    ) {
      return Response.json(
        {
          ok: false,
          error:
            "Final confirmation is required before importing or replacing Real Property data.",
        },
        { status: 400 },
      );
    }
    // ========================================================
    // VALIDATE REQUEST
    // ========================================================
    if (
      !(
        file instanceof
        File
      )
    ) {
      return Response.json(
        {
          ok: false,
          error:
            "A NextGen CSV file is required.",
        },
        {
          status: 400,
        },
      );
    }
    if (
      !file.name
        .toLowerCase()
        .endsWith(
          ".csv",
        )
    ) {
      return Response.json(
        {
          ok: false,
          error:
            "Real Property upload must be a .csv file.",
        },
        {
          status: 400,
        },
      );
    }
    if (
      !Number.isInteger(
        fy,
      ) ||
      !billingMonth ||
      !Number.isInteger(
        billingPeriodId,
      )
    ) {
      return Response.json(
        {
          ok: false,
          error:
            "FY, billing month, and billing_period_id are required.",
        },
        {
          status: 400,
        },
      );
    }
    // ========================================================
    // PREVENT DUPLICATE MONTHLY RP IMPORT
    // ========================================================
    const initialState = await getRealPropertyPeriodState(billingPeriodId);
    const existing = usesPeriodSnapshot(billingPeriodId, initialState !== null)
      ? await queryPeriod(RP_TABLE, billingPeriodId)
      : await queryLegacyBaseline(billingPeriodId, fy, billingMonth);
    const observedSourceVersion = realPropertySourceVersion(
      existing,
      initialState,
    );
    const submittedSourceVersion = text(formData.get("source_data_version"));
    if (
      mode !== "validate" &&
      submittedSourceVersion !== observedSourceVersion
    ) {
      return Response.json(
        {
          ok: false,
          error:
            "Real Property changed after validation. Reload the month, validate the file again, and then confirm the replacement.",
        },
        { status: 409 },
      );
    }
    if (existing.length > 0 && mode === "import") {
      return Response.json(
        {
          ok: false,
          error:
            `Real Property has already been imported for ${billingMonth} FY ${fy}. ` +
            "Estimates are stored once and will not be recalculated automatically.",
        },
        {
          status: 409,
        },
      );
    }
    // ========================================================
    // PARSE CSV
    // ========================================================
    const rows =
      parseCsv(
        await file.text(),
      );
    if (
      rows.length ===
      0
    ) {
      return Response.json(
        {
          ok: false,
          error:
            "The CSV file contains no data rows.",
        },
        {
          status: 400,
        },
      );
    }
    const uploadRows =
      rows.filter(
        (
          row,
        ) =>
          flag(
            row[
              "Upload?"
            ],
          ) === 1,
      );
    if (
      uploadRows.length ===
      0
    ) {
      return Response.json(
        {
          ok: false,
          error:
            "No rows marked Upload? = Y were found in the CSV file.",
        },
        {
          status: 400,
        },
      );
    }
    const reimbursementColumnsPresent = new Set(
      UTILITY_CODES.filter((utility) =>
        Object.prototype.hasOwnProperty.call(
          rows[0],
          REIMBURSEMENT_COLUMNS[utility],
        ),
      ),
    );
    const existingHasReimbursementOverrides = existing.some(
      (item) =>
        Object.keys(
          normalizeUtilityReimbursementOverrides(
            item.UtilityReimbursementOverrides,
          ),
        ).length > 0,
    );
    if (
      mode !== "import" &&
      existingHasReimbursementOverrides &&
      reimbursementColumnsPresent.size !== UTILITY_CODES.length
    ) {
      return Response.json(
        {
          ok: false,
          error:
            "This month contains explicit utility reimbursement overrides. " +
            "The replacement file must include EL Reimbursement, NG Reimbursement, " +
            "PW Reimbursement, and SS Reimbursement columns so those settings are " +
            "not silently erased. Leave an individual value blank to reset it to " +
            "the Customer Registry default.",
        },
        { status: 400 },
      );
    }
    // ========================================================
    // LOAD REFERENCE DATA
    // ========================================================
    const [
      customers,
      facilities,
      categories,
      intensities,
    ] =
      await Promise.all([
        scanAll(
          CUSTOMERS_TABLE,
        ),
        scanAll(
          FACILITIES_TABLE,
        ),
        scanAll(
          CATEGORY_TABLE,
        ),
        scanAll(
          INTENSITY_TABLE,
        ),
      ]);
    // ========================================================
    // CUSTOMER LOOKUP
    // ========================================================
    const customerByAlias =
      new Map<
        string,
        Item
      >();
    for (
      const customer
      of customers
    ) {
      const aliases =
        new Set<string>();
      aliases.add(
        normalizeImportCustomerName(
          customer
            .CustomerName,
        ),
      );
      aliases.add(
        normalizeImportCustomerName(
          customer.UMMName,
        ),
      );
      const nextGenNames =
        Array.isArray(
          customer
            .NextGenNames,
        )
          ? customer
              .NextGenNames
          : customer
                .NextGenNames instanceof
              Set
            ? Array.from(
                customer
                  .NextGenNames,
              )
            : [];
      for (
        const alias
        of nextGenNames
      ) {
        aliases.add(
          normalizeImportCustomerName(
            alias,
          ),
        );
      }
      for (
        const alias
        of aliases
      ) {
        if (
          alias
        ) {
          customerByAlias.set(
            alias,
            customer,
          );
        }
      }
    }
    // ========================================================
    // FACILITY LOOKUP
    // ========================================================
    const facilityByRpuid =
      new Map<
        string,
        Item
      >();
    const facilityByNumberSite =
      new Map<
        string,
        Item
      >();
    for (
      const facility
      of facilities
    ) {
      const rpuid =
        text(
          facility.RPUID,
        );
      if (
        rpuid
      ) {
        facilityByRpuid.set(
          rpuid,
          facility,
        );
      }
      const facilityNumber =
        text(
          facility
            .FacilityNumber,
        );
      const siteCode =
        text(
          facility.SITE_CD,
        );
      if (
        facilityNumber
      ) {
        facilityByNumberSite.set(
          `${siteCode}|${facilityNumber}`,
          facility,
        );
      }
    }
    // ========================================================
    // CATEGORY CODE LOOKUP
    // ========================================================
    const categoryByCode =
      new Map<
        string,
        Item
      >();
    for (
      const category
      of categories
    ) {
      const code =
        text(
          category
            .category_cd,
        );
      if (
        code
      ) {
        categoryByCode.set(
          code,
          category,
        );
      }
    }
    // ========================================================
    // INTENSITY LOOKUP
// Estimate = area in SF multiplied by the matching intensity index.
    // ========================================================
    const intensityLookup =
      buildIntensityLookup(
        intensities,
      );
    // ========================================================
    // OUTPUT COLLECTIONS
    // ========================================================
    const rpItems:
      Item[] = [];
    const estimateItems:
      Item[] = [];
    const errors:
      string[] = [];
    const intensityFallbacks:
      {
        sourceRow: number;
        utility: string;
        spaceTypeId: string;
        requestedFY: number;
        intensityFY: number;
      }[] = [];
    const batchId =
      `RP-FY${String(
        fy,
      ).slice(
        -2,
      )}-${monthCode(
        billingMonth,
      )}-${billingPeriodId}`;
    // ========================================================
    // PROCESS UPLOAD ROWS
    // ========================================================
    for (
      let index = 0;
      index <
      uploadRows.length;
      index += 1
    ) {
      const row =
        uploadRows[
          index
        ];
      const sourceRow =
        index + 2;
      const reimbursementResult = reimbursementOverridesFromUploadRow(
        row,
        sourceRow,
      );
      errors.push(...reimbursementResult.errors);
      // ======================================================
      // SOURCE VALUES
      // ======================================================
      const rpuid =
        text(
          row.RPUID,
        );
      const siteCode =
        text(
          row[
            "Site Code"
          ],
        );
      const facilityNumber =
        text(
          row[
            "Facility Number"
          ],
        );
      const nextGenCustomerName =
        text(
          row[
            "Customer Name"
          ],
        );
      const cubeCustomerName =
        text(
          row[
            "CUBE Customer Name"
          ],
        );
      const categoryCode =
        text(
          row[
            "Asset Allocation Current Use CAT Code"
          ],
        );
      const allocationQty =
        numberOrNull(
          row[
            "Asset Allocation Size Qty"
          ],
        );
      const allocationUM =
        text(
          row[
            "Asset Allocation Size UoM"
          ],
        ).toUpperCase();
      // ======================================================
      // RESOLVE CUSTOMER
      // ======================================================
      const customerResolution = resolveRealPropertyImportCustomer({
        cubeCustomerName,
        nextGenCustomerName,
        customerByAlias,
      });
      const customer = customerResolution.customer;
      // ======================================================
      // RESOLVE FACILITY
      // ======================================================
      const facility =
        (rpuid
          ? facilityByRpuid.get(
              rpuid,
            )
          : undefined) ??
        facilityByNumberSite.get(
          `${siteCode}|${facilityNumber}`,
        );
      // ======================================================
      // RESOLVE CATEGORY
      // ======================================================
      const category =
        categoryCode
          ? categoryByCode.get(
              categoryCode,
            )
          : undefined;
      // ======================================================
      // REQUIRED VALIDATION
      // ======================================================
      if (customerResolution.error) {
        errors.push(`Row ${sourceRow}: ${customerResolution.error}`);
      } else if (!customer) {
        errors.push(
          `Row ${sourceRow}: customer mapping not found for "${nextGenCustomerName || cubeCustomerName}".`,
        );
      }
      if (
        !facility
      ) {
        errors.push(
          `Row ${sourceRow}: facility mapping not found for RPUID ${rpuid || "blank"} / Facility ${facilityNumber}.`,
        );
      }
      const categoryCodeError = validateRealPropertyCategoryCode(
        categoryCode,
        categories,
      );
      if (categoryCodeError) {
        errors.push(`Row ${sourceRow}: ${categoryCodeError}`);
      }
      if (
        allocationQty ===
        null
      ) {
        errors.push(
          `Row ${sourceRow}: Asset Allocation Size Qty is missing or invalid.`,
        );
      }
      if (
        !customer ||
        !facility ||
        allocationQty ===
          null
      ) {
        continue;
      }
      // ======================================================
      // RP IDENTIFIERS
      // ======================================================
      const monthlyRpId =
        `MRP-FY${String(
          fy,
        ).slice(
          -2,
        )}-${monthCode(
          billingMonth,
        )}-${String(
          index + 1,
        ).padStart(
          6,
          "0",
        )}`;
      const customerId =
        text(
          customer
            .CustomerID,
        );
      const facilityId =
        text(
          facility
            .FacilityID,
        );
      const utilityGroup =
        numberOrNull(
          row[
            "Utility Group"
          ],
        ) ?? 0;
      // ======================================================
      // CREATE MONTHLY RP ITEM
      // ======================================================
      const rpItem:
        Item = {
          MonthlyRPID:
            monthlyRpId,
          FY:
            fy,
          BillingMonth:
            billingMonth,
          BillingMonthCode:
            monthCode(
              billingMonth,
            ),
          FacilityID:
            facilityId,
          CustomerID:
            customerId,
          SiteCode:
            siteCode,
          FacilityNumber:
            facilityNumber,
          CUBECustomerName:
            cubeCustomerName,
          AllocationQty:
            allocationQty,
          AllocationUM:
            allocationUM,
          UtilityGroup:
            utilityGroup,
          EL:
            flag(
              row.EL,
            ),
          NG:
            flag(
              row.NG,
            ),
          PW:
            flag(
              row.PW,
            ),
          SS:
            flag(
              row.SS,
            ),
          Source:
            "NEXTGEN_RP",
          SnapshotType:
            "MONTHLY",
          ImportBatchID:
            batchId,
          billing_period_id:
            billingPeriodId,
          UtilityReimbursementOverrides:
            reimbursementResult.overrides,
        };
      if (
        rpuid
      ) {
        rpItem.RPUID =
          rpuid;
      }
      if (
        nextGenCustomerName
      ) {
        rpItem.NextGenCustomerName =
          nextGenCustomerName;
      }
      if (
        categoryCode
      ) {
        rpItem.CategoryCode =
          categoryCode;
      }
      const categoryDescription =
        text(
          row[
            "RPCS CATCODE Description"
          ],
        );
      if (
        categoryDescription
      ) {
        rpItem.CategoryDescription =
          categoryDescription;
      }
      rpItems.push(
        rpItem,
      );
      // ======================================================
      // ESTIMATE ELIGIBILITY
      //
      // Estimates require:
      //
      // - SF allocation
      // - valid Category Code
      // - Category Code -> Space Type
      //
      // Category mappings are intentionally checked here.
      // ======================================================
      if (
        allocationUM !==
          "SF" ||
        !category
      ) {
        continue;
      }
      const spaceTypeId =
        text(
          category
            .space_type_id,
        );
      const spaceType =
        text(
          category
            .space_type,
        );
      if (
        !spaceTypeId
      ) {
        continue;
      }
      // ======================================================
      // CREATE ESTIMATE FOR EACH ENABLED UTILITY
      // ======================================================
      for (
        const utility
        of [
          "EL",
          "NG",
          "PW",
          "SS",
        ] as const
      ) {
        if (
          flag(
            row[
              utility
            ],
          ) !== 1
        ) {
          continue;
        }
        // ====================================================
        // FIND INTENSITY
        //
        // Exact FY first.
        // Otherwise newest prior FY.
        // Future FY values are never eligible.
        // ====================================================
        const intensityMatch =
          findIntensity(
            intensityLookup,
            fy,
            utility,
            spaceTypeId,
          );
        if (
          !intensityMatch
        ) {
          errors.push(
            `Row ${sourceRow}: no ${utility} intensity exists for Space Type ${spaceTypeId} for FY ${fy} or any prior FY.`,
          );
          continue;
        }
        const intensityValue =
          numberOrNull(
            intensityMatch
              .item.index,
          );
        if (
          intensityValue ===
          null
        ) {
          errors.push(
            `Row ${sourceRow}: intensity value is invalid for FY ${intensityMatch.intensityFY} ${utility} Space Type ${spaceTypeId}.`,
          );
          continue;
        }
        const intensityFY =
          intensityMatch
            .intensityFY;
        // ====================================================
        // TRACK FALLBACK FOR RESPONSE / AUDIT
        // ====================================================
        if (
          intensityFY !==
          fy
        ) {
          intensityFallbacks.push(
            {
              sourceRow,
              utility,
              spaceTypeId,
              requestedFY:
                fy,
              intensityFY,
            },
          );
        }
        // ====================================================
        // ESTIMATE
        // ====================================================
        estimateItems.push(
          {
            EstimateID:
              `EST#${billingPeriodId}#${monthlyRpId}#${utility}`,
            billing_period_id:
              billingPeriodId,
            // Billing / RP FY
            FY:
              fy,
            BillingMonth:
              billingMonth,
            MonthlyRPID:
              monthlyRpId,
            FacilityID:
              facilityId,
            CustomerID:
              customerId,
            CategoryCode:
              categoryCode,
            SpaceTypeID:
              Number(
                spaceTypeId,
              ),
            SpaceType:
              spaceType,
            AreaSF:
              allocationQty,
            UtilityType:
              utility,
            // =================================================
            // IMPORTANT:
            // Store the FY actually used for the calculation.
            // =================================================
            IntensityFY:
              intensityFY,
            IntensityValue:
              intensityValue,
            EstimatedUsage:
              allocationQty *
              intensityValue,
            CalculationMethod:
              intensityFY ===
              fy
                ? "AREA_INTENSITY"
                : "AREA_INTENSITY_PRIOR_FY",
            IntensityID:
              `${intensityFY}#${utility}#${spaceTypeId}`,
            Source:
              "RP_MONTHLY",
            SourceMonthlyRPID:
              monthlyRpId,
          },
        );
      }
    }
    // ========================================================
    // VALIDATION FAILURE
    //
    // Nothing is written unless ALL required validation passes.
    // ========================================================
    if (
      errors.length >
      0
    ) {
      return Response.json(
        {
          ok: false,
          error:
            `Import validation failed with ${errors.length} issue(s). ` +
            "Nothing was written to DynamoDB.",
          errors:
            errors.slice(
              0,
              100,
            ),
        },
        {
          status: 400,
        },
      );
    }
    if (
      rpItems.length ===
      0
    ) {
      return Response.json(
        {
          ok: false,
          error:
            "No valid RP records were produced.",
        },
        {
          status: 400,
        },
      );
    }
    const propQItems = buildPropQRecords(estimateItems, {
      billingPeriodId,
      fy,
      billingMonth,
    });
    // Validation is a read-only preview. Replacement runs this complete
    // validation again before staging any rows or switching the active month.
    if (mode === "validate") {
      return Response.json({
        ok: true,
        validated: true,
        billingPeriodId,
        fy,
        billingMonth,
        existingRecordCount: existing.length,
        realPropertyImported: rpItems.length,
        estimatesCreated: estimateItems.length,
        propQCreated: propQItems.length,
        sourceDataVersion: observedSourceVersion,
        message: "Replacement file validation passed. No data was changed.",
      });
    }
    const actor =
      text(session.user.email ?? session.user.name) || "authenticated-user";
    await activateRealPropertySnapshot({
      billingPeriodId,
      fy,
      billingMonth,
      realProperty: rpItems,
      estimates: estimateItems,
      propQ: propQItems,
      operation: mode === "replace" ? "REPLACE" : "IMPORT",
      actor,
      details: {
        importBatchId: batchId,
        replacedRecordCount: existing.length,
        replacementValidatedBeforeActivation: true,
      },
      expectedDataVersion: initialState?.ActiveDataVersion ?? null,
    });
// ========================================================
    // RESPONSE
    // ========================================================
    const fallbackFYs =
      Array.from(
        new Set(
          intensityFallbacks.map(
            (
              fallback,
            ) =>
              fallback
                .intensityFY,
          ),
        ),
      ).sort(
        (
          a,
          b,
        ) =>
          b - a,
      );
    return Response.json(
      {
        ok: true,
        billingPeriodId,
        fy,
        billingMonth,
        realPropertyImported:
          rpItems.length,
        estimatesCreated:
          estimateItems.length,
        propQGenerated:
          true,
        propQMessage:
          "PropQ was calculated and activated with the Real Property snapshot.",
        propQCreated:
          propQItems.length,
        replacedExistingRecords:
          mode === "replace" ? existing.length : 0,
        replacement:
          mode === "replace",
        importBatchId:
          batchId,
        intensityFallbackCount:
          intensityFallbacks.length,
        intensityFallbackFYs:
          fallbackFYs,
        intensityFallbacks:
          intensityFallbacks.slice(
            0,
            100,
          ),
      },
    );
  } catch (
    error
  ) {
    console.error(
      "Real Property upload failed:",
      error,
    );
    return Response.json(
      {
        ok: false,
        error:
          error instanceof
            Error
            ? error.message
            : "Unable to import Real Property data.",
      },
      {
        status: 500,
      },
    );
  }
}
