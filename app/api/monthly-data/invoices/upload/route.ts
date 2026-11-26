import {

  BatchWriteCommand,

  DeleteCommand,

  QueryCommand,

  ScanCommand,

  type BatchWriteCommandInput,

  type QueryCommandInput,

} from "@aws-sdk/lib-dynamodb";

import {

  NextResponse,

} from "next/server";

import {

  createHash,

} from "crypto";

import { getAppSession } from "@/lib/app-session";

import {

  ddb,

} from "@/lib/dynamo";

// ============================================================

// AUTHENTICATION

//

// Auth.js authentication is configured in "@/lib/auth".

//

// Both API operations in this route include commented-out server-side authentication scaffolding:

//

//   DELETE

//     Deletes one or more invoice records.

//

//   POST

//     Previews, imports, or replaces invoice billing-period

//     data from an uploaded CSV.

//

// When enabled, each handler validates the current Auth.js session BEFORE

// reading request data or performing DynamoDB operations.

//

// A valid authenticated request must contain session.user.

// When authentication is enabled, requests without a user return HTTP 401.

//

// Authentication should be enforced at the API layer before production use.

// Page/UI authentication alone must never be relied upon to

// protect invoice data or DynamoDB operations.

// ============================================================

const TABLE =

  "p72-CUBE-INVOICES";

const BILLING_PERIOD_INDEX =

  "billing-period-index";

const FORM_3556_TABLE =

  process.env.CUBE_3556_TABLE_NAME ||

  "p72-CUBE-3556";

const RATE_VARIANCE_THRESHOLD_PERCENT = 5;

// ============================================================

// TYPE FOR ONE BATCH WRITE REQUEST

// ============================================================

type InvoiceWriteRequest =

  NonNullable<

    BatchWriteCommandInput["RequestItems"]

  >[string][number];

// ============================================================

// IMPORT SETTINGS

// ============================================================

const BATCH_SIZE =

  25;

const MAX_CONCURRENT_BATCHES =

  5;

const MAX_RETRIES =

  6;

// ============================================================

// SOURCE CSV COLUMN NAMES

//

// These are matched by column NAME only.

// Excel highlighting / fill color is irrelevant.

//

// Save the Excel workbook as CSV UTF-8, then upload it.

// Extra columns in the CSV are ignored.

// ============================================================

const REQUIRED_SOURCE_COLUMNS = [

  "BILLING MONTH",

  "FY",

  "BILLING PERIOD ID",

  "UTILITY TYPE",

  "UTI GRP ID",

  "ACCOUNT #",

  "PRIMARY ACCOUNT #",

  "COMPANY ID",

  "ACCOUNT COMMENTS",

  "FROM DATE",

  "TO DATE",

  "CONSUMPTION",

  "UOM",

  "CHARGE",

];

// ============================================================

// FISCAL BILLING PERIOD SEQUENCE

//

// Historical anchor:

// September FY2025 = Billing Period 170

// ============================================================

const FISCAL_MONTH_ORDER = [

  "October",

  "November",

  "December",

  "January",

  "February",

  "March",

  "April",

  "May",

  "June",

  "July",

  "August",

  "September",

];

// ============================================================

// BASIC HELPERS

// ============================================================

function text(

  value: unknown,

): string {

  if (

    value === undefined ||

    value === null

  ) {

    return "";

  }

  return String(

    value,

  ).trim();

}

function normalizeHeader(

  value: unknown,

): string {

  return text(value)

    .replace(/[\uFEFF\u0000]/g, "")

    .replace(/^["']|["']$/g, "")

    .replace(/\s+/g, " ")

    .trim()

    .toUpperCase();

}

function normalizeMonth(

  value: unknown,

): string {

  const raw =

    text(

      value,

    ).toLowerCase();

  const match =

    FISCAL_MONTH_ORDER.find(

      (month) =>

        month.toLowerCase() ===

        raw,

    );

  return (

    match ??

    ""

  );

}

function numericValue(

  value: unknown,

): number | null {

  const raw =

    text(

      value,

    );

  if (

    !raw

  ) {

    return null;

  }

  // Remove common Excel formatting.

  const cleaned =

    raw

      .replace(

        /[$,]/g,

        "",

      )

      .trim();

  const parsed =

    Number(

      cleaned,

    );

  return Number.isFinite(

    parsed,

  )

    ? parsed

    : null;

}

function integerValue(

  value: unknown,

): number | null {

  const parsed =

    numericValue(

      value,

    );

  if (

    parsed === null ||

    !Number.isInteger(

      parsed,

    )

  ) {

    return null;

  }

  return parsed;

}

function accountText(

  value: unknown,

): string {

  const raw =

    text(

      value,

    );

  if (

    !raw

  ) {

    return "";

  }

  // Prevent common CSV values such as 12345.0 from

  // becoming account numbers with a trailing ".0".

  if (

    /^-?\d+\.0+$/.test(

      raw,

    )

  ) {

    return raw.replace(

      /\.0+$/,

      "",

    );

  }

  return raw;

}

// ============================================================

// DATE NORMALIZER

//

// Supports:

//   YYYY-MM-DD

//   M/D/YYYY

//   MM/DD/YYYY

//

// If the date is in another text format, the original value

// is preserved instead of rejecting the row.

// ============================================================

function normalizeDate(

  value: unknown,

): string {

  const raw = text(value);

  if (!raw) return "";

  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {

    return raw;

  }

  const usDate = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);

  if (usDate) {

    const month = usDate[1].padStart(2, "0");

    const day = usDate[2].padStart(2, "0");

    const year = usDate[3];

    return `${year}-${month}-${day}`;

  }

  return raw;

}

// ============================================================

// BILLING PERIOD VALIDATION

// ============================================================

function expectedBillingPeriodId(

  fy: number,

  month: string,

): number | null {

  const anchorFY =

    2025;

  const anchorMonth =

    "September";

  const anchorBillingPeriodId =

    170;

  const targetMonthIndex =

    FISCAL_MONTH_ORDER.indexOf(

      month,

    );

  const anchorMonthIndex =

    FISCAL_MONTH_ORDER.indexOf(

      anchorMonth,

    );

  if (

    !Number.isInteger(

      fy,

    ) ||

    targetMonthIndex <

      0 ||

    anchorMonthIndex <

      0

  ) {

    return null;

  }

  const monthDifference =

    (

      fy -

      anchorFY

    ) *

      12 +

    (

      targetMonthIndex -

      anchorMonthIndex

    );

  return (

    anchorBillingPeriodId +

    monthDifference

  );

}

// ============================================================

// DELAY

// ============================================================

function sleep(

  milliseconds: number,

) {

  return new Promise<void>(

    (resolve) => {

      setTimeout(

        resolve,

        milliseconds,

      );

    },

  );

}

// ============================================================

// CSV PARSER

//

// Handles:

//   - quoted fields

//   - commas inside quotes

//   - escaped quotes

//   - CRLF / LF

//   - embedded newlines inside quoted fields

// ============================================================

function detectCsvDelimiter(csv: string): string {

  const firstLine = csv

    .replace(/^\uFEFF/, "")

    .split(/\r?\n/, 1)[0] ?? "";

  const candidates = [",", "\t", ";", "|"];

  let bestDelimiter = ",";

  let bestCount = -1;

  for (const delimiter of candidates) {

    let count = 0;

    let inQuotes = false;

    for (let i = 0; i < firstLine.length; i++) {

      const char = firstLine[i];

      const next = firstLine[i + 1];

      if (char === '"') {

        if (inQuotes && next === '"') {

          i++;

          continue;

        }

        inQuotes = !inQuotes;

        continue;

      }

      if (!inQuotes && char === delimiter) count++;

    }

    if (count > bestCount) {

      bestCount = count;

      bestDelimiter = delimiter;

    }

  }

  return bestDelimiter;

}

function parseCSV(csv: string): string[][] {

  const rows: string[][] = [];

  let row: string[] = [];

  let field = "";

  let inQuotes = false;

  const delimiter = detectCsvDelimiter(csv);

  for (let i = 0; i < csv.length; i++) {

    const char = csv[i];

    const next = csv[i + 1];

    if (char === '"') {

      if (inQuotes && next === '"') {

        field += '"';

        i++;

        continue;

      }

      inQuotes = !inQuotes;

      continue;

    }

    if (char === delimiter && !inQuotes) {

      row.push(field);

      field = "";

      continue;

    }

    if ((char === "\n" || char === "\r") && !inQuotes) {

      if (char === "\r" && next === "\n") i++;

      row.push(field);

      field = "";

      if (row.some((value) => value.trim() !== "")) {

        rows.push(row);

      }

      row = [];

      continue;

    }

    field += char;

  }

  row.push(field);

  if (row.some((value) => value.trim() !== "")) rows.push(row);

  return rows;

}

// ============================================================

// CSV TO OBJECTS

//

// Headers are normalized so these all match:

//

//   Company ID

//   COMPANY ID

//   Company ID

//

// Extra whitespace in headers is also ignored.

// ============================================================

function csvToObjects(

  csv: string,

): {

  headers: string[];

  rows: Record<

    string,

    string

  >[];

} {

  const cleanCSV =

    csv.replace(

      /^\uFEFF/,

      "",

    );

  const parsedRows =

    parseCSV(

      cleanCSV,

    );

  if (

    parsedRows.length <

    2

  ) {

    return {

      headers:

        [],

      rows:

        [],

    };

  }

  const headers =

    parsedRows[0].map(

      (header) =>

        normalizeHeader(

          header,

        ),

    );

  const rows =

    parsedRows

      .slice(

        1,

      )

      .filter(

        (row) =>

          row.some(

            (value) =>

              value.trim() !==

              "",

          ),

      )

      .map(

        (row) => {

          const item:

            Record<

              string,

              string

            > = {};

          headers.forEach(

            (

              header,

              index,

            ) => {

              item[

                header

              ] =

                text(

                  row[

                    index

                  ],

                );

            },

          );

          return item;

        },

      );

  return {

    headers,

    rows,

  };

}

// ============================================================

// SPLIT ARRAY INTO CHUNKS

// ============================================================

function chunkArray<T>(

  items: T[],

  size: number,

): T[][] {

  const chunks:

    T[][] = [];

  for (

    let i =

      0;

    i <

    items.length;

    i += size

  ) {

    chunks.push(

      items.slice(

        i,

        i +

          size,

      ),

    );

  }

  return chunks;

}

// ============================================================

// WRITE ONE DYNAMODB BATCH

// ============================================================

async function writeBatch(

  requests:

    InvoiceWriteRequest[],

) {

  let remaining:

    InvoiceWriteRequest[] =

    requests;

  let retry =

    0;

  while (

    remaining.length >

    0

  ) {

    const result =

      await ddb.send(

        new BatchWriteCommand({

          RequestItems: {

            [TABLE]:

              remaining,

          },

        }),

      );

    remaining =

      (

        result

          .UnprocessedItems?.[

            TABLE

          ] ??

        []

      ) as InvoiceWriteRequest[];

    if (

      remaining.length ===

      0

    ) {

      return;

    }

    retry++;

    if (

      retry >

      MAX_RETRIES

    ) {

      throw new Error(

        `DynamoDB could not process ${remaining.length} invoice writes after ${MAX_RETRIES} retries.`,

      );

    }

    const delay =

      Math.min(

        100 *

          2 **

            (

              retry -

              1

            ),

        3000,

      );

    await sleep(

      delay,

    );

  }

}

// ============================================================

// CONCURRENT BATCH WRITER

// ============================================================

async function writeBatches(

  batches:

    InvoiceWriteRequest[][],

) {

  let nextIndex =

    0;

  let imported =

    0;

  async function worker() {

    while (

      true

    ) {

      const index =

        nextIndex++;

      if (

        index >=

        batches.length

      ) {

        return;

      }

      const batch =

        batches[

          index

        ];

      await writeBatch(

        batch,

      );

      imported +=

        batch.length;

    }

  }

  const workerCount =

    Math.min(

      MAX_CONCURRENT_BATCHES,

      batches.length,

    );

  await Promise.all(

    Array.from(

      {

        length:

          workerCount,

      },

      () =>

        worker(),

    ),

  );

  return imported;

}

// ============================================================

// 3556 RATE MONITORING

// ============================================================

type RateMonitoringStatus =

  | "WITHIN_RANGE"

  | "REVIEW_REQUIRED"

  | "NO_BASELINE"

  | "NO_CONSUMPTION";

type InvoiceRateMonitoringResult = {

  utilityGroupId: number;

  utilityGroup: string;

  utilityType: string;

  utilitySystem: string;

  totalCost: number;

  totalConsumption: number;

  currentRate: number | null;

  baselineRate: number | null;

  variancePercent: number | null;

  thresholdPercent: number;

  status: RateMonitoringStatus;

  baselineEffectiveDate?: string;

  baselineApprovedAt?: string;

  baselinePK?: string;

  baselineSK?: string;

  checkedAt: string;

};

function invoiceUtilityGroupName(value: unknown): string {

  const id = Number(value);

  if (id === 1) return "WWYK";

  if (id === 2) return "TAC";

  return String(value ?? "").trim();

}

function invoiceUtilitySystem(value: unknown): string {

  const code = String(value ?? "").trim().toUpperCase();

  if (code === "EL") return "Electricity";

  if (code === "NG") return "Natural Gas";

  if (code === "PW") return "Produced Water";

  if (code === "SS") return "Sewer";

  return String(value ?? "").trim();

}

function finiteRateNumber(value: unknown): number | null {

  const number = Number(value);

  return Number.isFinite(number) ? number : null;

}

function approvedA3Rate(record: Record<string, unknown>): number | null {

  const monitoring =

    record.rateMonitoring && typeof record.rateMonitoring === "object"

      ? (record.rateMonitoring as Record<string, unknown>)

      : null;

  const monitoringRate =

    monitoring ? finiteRateNumber(monitoring.baselineRate) : null;

  if (monitoringRate !== null && monitoringRate > 0) {

    return monitoringRate;

  }

  const calculated =

    record.calculatedRates && typeof record.calculatedRates === "object"

      ? (record.calculatedRates as Record<string, unknown>)

      : null;

  const calculatedRate =

    calculated ? finiteRateNumber(calculated.a3BasicCost) : null;

  return calculatedRate !== null && calculatedRate > 0

    ? calculatedRate

    : null;

}

async function scanFinal3556Records(): Promise<Record<string, unknown>[]> {

  const records: Record<string, unknown>[] = [];

  let exclusiveStartKey: Record<string, unknown> | undefined;

  do {

    const result = await ddb.send(

      new ScanCommand({

        TableName: FORM_3556_TABLE,

        ExclusiveStartKey: exclusiveStartKey,

      }),

    );

    records.push(

      ...((result.Items ?? []) as Record<string, unknown>[]),

    );

    exclusiveStartKey =

      result.LastEvaluatedKey as Record<string, unknown> | undefined;

  } while (exclusiveStartKey);

  return records.filter(

    (record) =>

      String(record.status ?? "").trim().toUpperCase() === "FINAL",

  );

}

function latest3556ForPair(

  records: Record<string, unknown>[],

  utilityGroup: string,

  utilitySystem: string,

): Record<string, unknown> | null {

  const group = utilityGroup.trim().toUpperCase();

  const system = utilitySystem.trim().toUpperCase();

  return (

    records

      .filter(

        (record) =>

          String(record.utilityGroup ?? "").trim().toUpperCase() === group &&

          String(record.utilitySystem ?? "").trim().toUpperCase() === system,

      )

      .sort((a, b) => {

        const effectiveCompare =

          String(b.effectiveDate ?? "").localeCompare(

            String(a.effectiveDate ?? ""),

          );

        if (effectiveCompare !== 0) return effectiveCompare;

        return String(b.approvedAt ?? "").localeCompare(

          String(a.approvedAt ?? ""),

        );

      })[0] ?? null

  );

}

async function calculateInvoiceRateMonitoring(

  items: Record<string, unknown>[],

): Promise<InvoiceRateMonitoringResult[]> {

  const grouped = new Map<

    string,

    {

      utilityGroupId: number;

      utilityGroup: string;

      utilityType: string;

      utilitySystem: string;

      totalCost: number;

      totalConsumption: number;

    }

  >();

  for (const item of items) {

    const utilityGroupId = Number(item.utility_group_id);

    const utilityType =

      String(item.utility_type_cd ?? "").trim().toUpperCase();

    if (!Number.isFinite(utilityGroupId) || !utilityType) continue;

    const utilityGroup = invoiceUtilityGroupName(utilityGroupId);

    const utilitySystem = invoiceUtilitySystem(utilityType);

    const key =

      `${utilityGroup.toUpperCase()}#${utilitySystem.toUpperCase()}`;

    const current =

      grouped.get(key) ?? {

        utilityGroupId,

        utilityGroup,

        utilityType,

        utilitySystem,

        totalCost: 0,

        totalConsumption: 0,

      };

    const charge = finiteRateNumber(item.charge);

    const consumption = finiteRateNumber(item.consumption);

    if (charge !== null) current.totalCost += charge;

    if (consumption !== null) current.totalConsumption += consumption;

    grouped.set(key, current);

  }

  const final3556Records = await scanFinal3556Records();

  return Array.from(grouped.values())

    .map((group) => {

      const baseline =

        latest3556ForPair(

          final3556Records,

          group.utilityGroup,

          group.utilitySystem,

        );

      const baselineRate = baseline ? approvedA3Rate(baseline) : null;

      const currentRate =

        group.totalConsumption > 0

          ? group.totalCost / group.totalConsumption

          : null;

      const variancePercent =

        currentRate !== null &&

        baselineRate !== null &&

        baselineRate > 0

          ? ((currentRate - baselineRate) / baselineRate) * 100

          : null;

      let status: RateMonitoringStatus = "WITHIN_RANGE";

      if (group.totalConsumption <= 0) {

        status = "NO_CONSUMPTION";

      } else if (baselineRate === null) {

        status = "NO_BASELINE";

      } else if (

        variancePercent !== null &&

        Math.abs(variancePercent) >= RATE_VARIANCE_THRESHOLD_PERCENT

      ) {

        status = "REVIEW_REQUIRED";

      }

      return {

        ...group,

        currentRate,

        baselineRate,

        variancePercent,

        thresholdPercent: RATE_VARIANCE_THRESHOLD_PERCENT,

        status,

        baselineEffectiveDate:

          baseline ? String(baseline.effectiveDate ?? "") : undefined,

        baselineApprovedAt:

          baseline ? String(baseline.approvedAt ?? "") : undefined,

        baselinePK:

          baseline ? String(baseline.PK ?? "") : undefined,

        baselineSK:

          baseline ? String(baseline.SK ?? "") : undefined,

        checkedAt: new Date().toISOString(),

      };

    })

    .sort((a, b) => {

      const groupCompare =

        a.utilityGroup.localeCompare(b.utilityGroup);

      return groupCompare !== 0

        ? groupCompare

        : a.utilitySystem.localeCompare(b.utilitySystem);

    });

}

// ============================================================

// EXISTING PERIOD / COMPARISON HELPERS

// ============================================================

async function queryExistingPeriod(

  billingPeriodId: number,

): Promise<Record<string, unknown>[]> {

  const items: Record<string, unknown>[] = [];

  let exclusiveStartKey:

    | QueryCommandInput["ExclusiveStartKey"]

    | undefined;

  do {

    const result = await ddb.send(

      new QueryCommand({

        TableName: TABLE,

        IndexName: BILLING_PERIOD_INDEX,

        KeyConditionExpression: "#bp = :bp",

        ExpressionAttributeNames: {

          "#bp": "billing_period_id",

        },

        ExpressionAttributeValues: {

          ":bp": billingPeriodId,

        },

        ExclusiveStartKey: exclusiveStartKey,

      }),

    );

    items.push(

      ...((result.Items ?? []) as Record<string, unknown>[]),

    );

    exclusiveStartKey = result.LastEvaluatedKey;

  } while (exclusiveStartKey);

  return items;

}

function comparisonKey(

  item: Record<string, unknown>,

): string {

  return [

    text(item.billing_period_id),

    accountText(item.account_nbr),

    accountText(item.primary_account_nbr),

    text(item.utility_type_cd),

    text(item.utility_provider_cd),

    normalizeDate(item.billing_from_date),

    normalizeDate(item.billing_to_date),

  ].join("|");

}

const COMPARE_FIELDS = [

  "billing_period_id",

  "fy",

  "billing_month_nm",

  "utility_group_id",

  "utility_type_cd",

  "utility_provider_cd",

  "primary_account_nbr",

  "account_nbr",

  "billing_from_date",

  "billing_to_date",

  "consumption",

  "consumption_um",

  "charge",

  "invoice_comments",

] as const;

function comparableValue(

  value: unknown,

): string {

  if (value === undefined || value === null) return "";

  if (typeof value === "number") return String(value);

  return text(value);

}

function changedFields(

  existing: Record<string, unknown>,

  uploaded: Record<string, unknown>,

) {

  return COMPARE_FIELDS

    .filter(

      (field) =>

        comparableValue(existing[field]) !==

        comparableValue(uploaded[field]),

    )

    .map((field) => ({

      field,

      existing: comparableValue(existing[field]),

      uploaded: comparableValue(uploaded[field]),

    }));

}

type ComparisonRow = {

  status: "new" | "changed" | "unchanged" | "removed";

  key: string;

  existing?: Record<string, unknown>;

  uploaded?: Record<string, unknown>;

  changes?: {

    field: string;

    existing: string;

    uploaded: string;

  }[];

};

function comparePeriod(

  existingItems: Record<string, unknown>[],

  uploadedItems: Record<string, unknown>[],

) {

  const existingMap = new Map<string, Record<string, unknown>[]>();

  const uploadedMap = new Map<string, Record<string, unknown>[]>();

  function add(

    map: Map<string, Record<string, unknown>[]>,

    item: Record<string, unknown>,

  ) {

    const key = comparisonKey(item);

    const list = map.get(key) ?? [];

    list.push(item);

    map.set(key, list);

  }

  existingItems.forEach((item) => add(existingMap, item));

  uploadedItems.forEach((item) => add(uploadedMap, item));

  const rows: ComparisonRow[] = [];

  const keys = new Set([

    ...existingMap.keys(),

    ...uploadedMap.keys(),

  ]);

  for (const key of keys) {

    const existingList = existingMap.get(key) ?? [];

    const uploadedList = uploadedMap.get(key) ?? [];

    const max = Math.max(existingList.length, uploadedList.length);

    for (let index = 0; index < max; index++) {

      const existing = existingList[index];

      const uploaded = uploadedList[index];

      if (!existing && uploaded) {

        rows.push({

          status: "new",

          key,

          uploaded,

        });

        continue;

      }

      if (existing && !uploaded) {

        rows.push({

          status: "removed",

          key,

          existing,

        });

        continue;

      }

      if (existing && uploaded) {

        const changes = changedFields(existing, uploaded);

        rows.push({

          status: changes.length ? "changed" : "unchanged",

          key,

          existing,

          uploaded,

          changes,

        });

      }

    }

  }

  const summary = {

    existing: existingItems.length,

    uploaded: uploadedItems.length,

    new: rows.filter((row) => row.status === "new").length,

    changed: rows.filter((row) => row.status === "changed").length,

    unchanged: rows.filter((row) => row.status === "unchanged").length,

    removed: rows.filter((row) => row.status === "removed").length,

  };

  return {

    summary,

    rows,

  };

}

async function deleteExistingPeriod(

  existingItems: Record<string, unknown>[],

) {

  const requests: InvoiceWriteRequest[] = existingItems

    .filter((item) => text(item.invoiceid))

    .map((item) => ({

      DeleteRequest: {

        Key: {

          invoiceid: item.invoiceid,

        },

      },

    }));

  if (!requests.length) return 0;

  const batches = chunkArray(requests, BATCH_SIZE);

  return writeBatches(batches);

}

// ============================================================

// DELETE

//

// Supports deleting one or multiple invoice records by invoiceid.

//

// Request body:

// {

//   "invoiceids": [

//     "invoice-id-1",

//     "invoice-id-2"

//   ]

// }

//

// IMPORTANT:

// If this file lives at:

//   app/api/monthly-data/invoices/upload/route.ts

//

// then the client must call:

//   DELETE /api/monthly-data/invoices/upload

//

// If you want the client to call:

//   DELETE /api/monthly-data/invoices

//

// put the DELETE handler in:

//   app/api/monthly-data/invoices/route.ts

// ============================================================

export async function DELETE(

  request: Request,

) {

  try {

    // ========================================================

    // AUTHENTICATION

    //

    // Validate the current Auth.js session before reading

    // invoice IDs from the request body or performing any

    // DynamoDB delete operations.

    //

    // When enabled, an unauthenticated caller receives HTTP 401 and cannot

    // reach the invoice deletion logic below.

    // ========================================================

    const session =

      await getAppSession();

    if (!session?.user) {

      return NextResponse.json(

        {

          error:

            "Unauthorized",

        },

        {

          status: 401,

        },

      );

    }

    // ========================================================

    // AUTHENTICATED REQUEST

    //

    // Once authentication is enabled and succeeds, The request may now continue

    // to invoice ID validation and DynamoDB deletion.

    // ========================================================

    const body =

      (await request.json()) as {

        invoiceids?: unknown[];

      };

    const invoiceids =

      Array.from(

        new Set(

          (

            Array.isArray(

              body.invoiceids,

            )

              ? body.invoiceids

              : []

          )

            .map(

              (value) =>

                text(

                  value,

                ),

            )

            .filter(

              Boolean,

            ),

        ),

      );

    if (

      invoiceids.length ===

      0

    ) {

      return NextResponse.json(

        {

          error:

            "At least one invoiceid is required for deletion.",

        },

        {

          status: 400,

        },

      );

    }

    let nextIndex =

      0;

    let deleted =

      0;

    let notFound =

      0;

    async function worker() {

      while (

        true

      ) {

        const index =

          nextIndex++;

        if (

          index >=

          invoiceids.length

        ) {

          return;

        }

        const invoiceid =

          invoiceids[

            index

          ];

        try {

          await ddb.send(

            new DeleteCommand({

              TableName:

                TABLE,

              Key: {

                invoiceid,

              },

              ConditionExpression:

                "attribute_exists(#invoiceid)",

              ExpressionAttributeNames: {

                "#invoiceid":

                  "invoiceid",

              },

            }),

          );

          deleted++;

        } catch (

          error

        ) {

          const name =

            error &&

            typeof error ===

              "object" &&

            "name" in error

              ? String(

                  (

                    error as {

                      name?: unknown;

                    }

                  ).name,

                )

              : "";

          if (

            name ===

            "ConditionalCheckFailedException"

          ) {

            notFound++;

            continue;

          }

          throw error;

        }

      }

    }

    const workerCount =

      Math.min(

        8,

        invoiceids.length,

      );

    await Promise.all(

      Array.from(

        {

          length:

            workerCount,

        },

        () =>

          worker(),

      ),

    );

    return NextResponse.json({

      success:

        true,

      requested:

        invoiceids.length,

      deleted,

      notFound,

    });

  } catch (

    error

  ) {

    console.error(

      "Invoice delete error:",

      error,

    );

    return NextResponse.json(

      {

        error:

          error instanceof

          Error

            ? error.message

            : "Unable to delete invoice record(s).",

      },

      {

        status: 500,

      },

    );

  }

}

// ============================================================

// POST

// /api/monthly-data/invoices/upload

//

// ZERO EXTRA NPM PACKAGES.

//

// Workflow:

//   Excel workbook

//       -> Save As CSV UTF-8

//       -> Upload CSV

//       -> Map source columns by NAME

//       -> Ignore all other columns

//       -> Validate FY + Billing Month + Billing Period ID

//       -> Skip invalid rows

//       -> BatchWrite valid invoices

// ============================================================

export async function POST(

  request: Request,

) {

  try {

    // ========================================================

    // AUTHENTICATION

    //

    // Validate the current Auth.js session before reading the

    // uploaded CSV or performing invoice processing.

    //

    // This protects all operations below, including:

    //

    //   - CSV upload

    //   - Invoice preview

    //   - Existing-period comparison

    //   - New invoice import

    //   - Billing-period replacement

    //   - DynamoDB batch writes

    //

    // When enabled, an unauthenticated caller receives HTTP 401 before the

    // uploaded file is read or DynamoDB is accessed.

    // ========================================================

    const session =

      await getAppSession();

    if (!session?.user) {

      return NextResponse.json(

        {

          error:

            "Unauthorized",

        },

        {

          status: 401,

        },

      );

    }

    // ========================================================

    // AUTHENTICATED REQUEST

    //

    // Once authentication is enabled and succeeds, Continue with CSV upload,

    // validation, preview/import, and replacement processing.

    // ========================================================

    const formData =

      await request.formData();

    const file =

      formData.get(

        "file",

      );

    // ========================================================

    // VALIDATE FILE

    // ========================================================

    if (

      !(file instanceof File)

    ) {

      return NextResponse.json(

        {

          error:

            "CSV invoice file is required.",

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

      return NextResponse.json(

        {

          error:

            "The invoice file must be a CSV file. Save the Excel workbook as CSV UTF-8 before uploading.",

        },

        {

          status: 400,

        },

      );

    }

    // ========================================================

    // READ CSV

    // ========================================================

    const csv =

      await file.text();

    const {

      headers,

      rows,

    } =

      csvToObjects(

        csv,

      );

    if (

      rows.length ===

      0

    ) {

      return NextResponse.json(

        {

          error:

            "The CSV contains no invoice data.",

        },

        {

          status: 400,

        },

      );

    }

    // ========================================================

    // VALIDATE SOURCE HEADERS

    //

    // Extra CSV columns are allowed and ignored.

    // ========================================================

    const missingColumns =

      REQUIRED_SOURCE_COLUMNS.filter(

        (column) =>

          !headers.includes(

            normalizeHeader(

              column,

            ),

          ),

      );

    if (

      missingColumns.length >

      0

    ) {

      return NextResponse.json(

        {

          error:

            `Missing required CSV column(s): ${missingColumns.join(", ")}. Detected CSV headers: ${headers.join(", ") || "(none)"}`,

        },

        {

          status: 400,

        },

      );

    }

    // ========================================================

    // BUILD VALID DYNAMODB ITEMS

    // ========================================================

    const items:

      Record<

        string,

        unknown

      >[] = [];

    const skippedRows: {

      row: number;

      reason: string;

    }[] = [];

    const generatedIds =

      new Set<

        string

      >();

    rows.forEach(

      (

        row,

        index,

      ) => {

        // CSV row 1 = header,

        // so first data row is row 2.

        const csvRowNumber =

          index +

          2;

        // ----------------------------------------------------

        // REQUIRED PERIOD VALUES COME FROM THE ROW ITSELF.

        // ----------------------------------------------------

        const fy =

          integerValue(

            row[

              "FY"

            ],

          );

        const billingMonth =

          normalizeMonth(

            row[

              "BILLING MONTH"

            ],

          );

        const billingPeriodId =

          integerValue(

            row[

              "BILLING PERIOD ID"

            ],

          );

        // ----------------------------------------------------

        // HARD VALIDATION:

        // FY + month + billing period are REQUIRED.

        //

        // If any are blank or invalid, skip the ENTIRE row.

        // ----------------------------------------------------

        if (

          fy ===

            null ||

          fy <

            2000 ||

          fy >

            2100 ||

          !billingMonth ||

          billingPeriodId ===

            null ||

          billingPeriodId <=

            0

        ) {

          skippedRows.push({

            row:

              csvRowNumber,

            reason:

              "Missing or invalid FY, Billing Month, or Billing Period ID.",

          });

          return;

        }

        // ----------------------------------------------------

        // VERIFY FY + MONTH + BILLING PERIOD MATCH.

        // ----------------------------------------------------

        const expectedPeriod =

          expectedBillingPeriodId(

            fy,

            billingMonth,

          );

        if (

          expectedPeriod ===

            null ||

          billingPeriodId !==

            expectedPeriod

        ) {

          skippedRows.push({

            row:

              csvRowNumber,

            reason:

              `${billingMonth} FY${fy} should use Billing Period ${expectedPeriod}, but CSV contains ${billingPeriodId}.`,

          });

          return;

        }

        // ----------------------------------------------------

        // ACCOUNT NUMBER VALIDATION

        //

        // At least one account field must exist.

        // If one is blank, copy from the other.

        // ----------------------------------------------------

        const accountNbr =

          accountText(

            row[

              "ACCOUNT #"

            ],

          );

        const primaryAccountNbr =

          accountText(

            row[

              "PRIMARY ACCOUNT #"

            ],

          );

        if (

          !accountNbr &&

          !primaryAccountNbr

        ) {

          skippedRows.push({

            row:

              csvRowNumber,

            reason:

              "Both Account # and Primary Account # are blank.",

          });

          return;

        }

        const finalAccountNbr =

          accountNbr ||

          primaryAccountNbr;

        const finalPrimaryAccountNbr =

          primaryAccountNbr ||

          accountNbr;

        // ----------------------------------------------------

        // MAP SOURCE COLUMNS TO CUBE INVOICE ATTRIBUTES

        // ----------------------------------------------------

        const utilityTypeCd =

          text(

            row[

              "UTILITY TYPE"

            ],

          );

        const utilityGroupId =

          integerValue(

            row[

              "UTI GRP ID"

            ],

          );

        const utilityProviderCd =

          integerValue(

            row[

              "COMPANY ID"

            ],

          );

        const invoiceComments =

          text(

            row[

              "ACCOUNT COMMENTS"

            ],

          );

        const billingFromDate =

          normalizeDate(

            row[

              "FROM DATE"

            ],

          );

        const billingToDate =

          normalizeDate(

            row[

              "TO DATE"

            ],

          );

        const consumption =

          numericValue(

            row[

              "CONSUMPTION"

            ],

          );

        const consumptionUm =

          text(

            row[

              "UOM"

            ],

          );

        const isServiceFee =

          consumptionUm.toUpperCase() === "ALL";

        const charge =

          numericValue(

            row[

              "CHARGE"

            ],

          );

        // ----------------------------------------------------

        // GENERATE INVOICE ID

        //

        // Row number is included so duplicate-looking source

        // lines in the same CSV still receive unique IDs.

        // ----------------------------------------------------

        const source =

          [

            billingPeriodId,

            fy,

            billingMonth,

            utilityTypeCd,

            utilityGroupId ??

              "",

            utilityProviderCd ??

              "",

            finalPrimaryAccountNbr,

            finalAccountNbr,

            billingFromDate,

            billingToDate,

            consumption ??

              "",

            charge ??

              "",

            csvRowNumber,

          ].join(

            "#",

          );

        const hash =

          createHash(

            "sha1",

          )

            .update(

              source,

            )

            .digest(

              "hex",

            )

            .slice(

              0,

              16,

            );

        let invoiceid =

          `${billingPeriodId}#${finalAccountNbr}#${hash}`;

        // Very unlikely, but protect against an ID collision.

        let suffix =

          2;

        while (

          generatedIds.has(

            invoiceid,

          )

        ) {

          invoiceid =

            `${billingPeriodId}#${finalAccountNbr}#${hash}#${suffix}`;

          suffix++;

        }

        generatedIds.add(

          invoiceid,

        );

        // ----------------------------------------------------

        // EXISTING CUBE INVOICE DATA TYPES

        //

        // Number:

        //   billing_period_id

        //   fy

        //   utility_group_id

        //   utility_provider_cd

        //   consumption

        //   charge

        //

        // String:

        //   all identifiers/text/date strings

        //

        // "period" is intentionally NOT created.

        // ----------------------------------------------------

        const item:

          Record<

            string,

            unknown

          > = {

          invoiceid,

          billing_period_id:

            billingPeriodId,

          fy,

          billing_month_nm:

            billingMonth,

          utility_type_cd:

            utilityTypeCd,

          primary_account_nbr:

            finalPrimaryAccountNbr,

          account_nbr:

            finalAccountNbr,

          billing_from_date:

            billingFromDate,

          billing_to_date:

            billingToDate,

          consumption_um:

            consumptionUm,

          invoice_comments:

            invoiceComments,

        };

        // Only add optional numeric values when the source

        // contains a valid number. Blank values are not forced

        // to zero.

        if (

          utilityGroupId !==

          null

        ) {

          item.utility_group_id =

            utilityGroupId;

        }

        if (

          utilityProviderCd !==

          null

        ) {

          item.utility_provider_cd =

            utilityProviderCd;

        }

        if (

          consumption !== null &&

          !isServiceFee

        ) {

          item.consumption =

            consumption;

        }

        if (

          charge !==

          null

        ) {

          item.charge =

            charge;

        }

        items.push(

          item,

        );

      },

    );

    // ========================================================

    // NO VALID ROWS

    // ========================================================

    if (

      items.length ===

      0

    ) {

      return NextResponse.json(

        {

          success:

            false,

          imported:

            0,

          skipped:

            skippedRows.length,

          skippedRows:

            skippedRows.slice(

              0,

              200,

            ),

          skippedRowsTruncated:

            skippedRows.length >

            200,

          error:

            "No valid invoice rows were found.",

        },

        {

          status: 400,

        },

      );

    }

    // ========================================================

    // PERIOD-LEVEL SAFETY CHECK

    //

    // Every valid row in one upload must belong to one billing

    // period. This prevents an accidental multi-period delete.

    // ========================================================

    const periodIds = Array.from(

      new Set(

        items.map((item) => Number(item.billing_period_id)),

      ),

    );

    if (periodIds.length !== 1) {

      return NextResponse.json(

        {

          error:

            "One CSV upload may contain only one Billing Period ID. Split multiple billing periods into separate files.",

        },

        {

          status: 400,

        },

      );

    }

    const billingPeriodId = periodIds[0];

    const action =

      text(formData.get("action")).toLowerCase() || "preview";

    if (!["preview", "replace"].includes(action)) {

      return NextResponse.json(

        {

          error: "Invalid upload action.",

        },

        {

          status: 400,

        },

      );

    }

    const existingItems =

      await queryExistingPeriod(billingPeriodId);

    const comparison =

      comparePeriod(existingItems, items);

    // ========================================================

    const rateMonitoring =

      await calculateInvoiceRateMonitoring(items);

    // Persist the rate-monitoring snapshot with every invoice row.

    // This keeps the Invoice Data tab and future dashboard alerts durable

    // without having to recalculate the comparison every time the page loads.

    const rateMonitoringByPair =

      new Map(

        rateMonitoring.map((row) => [

          `${row.utilityGroupId}#${row.utilityType}`,

          row,

        ]),

      );

    for (const item of items) {

      const key =

        `${Number(item.utility_group_id)}#${String(

          item.utility_type_cd ?? "",

        )

          .trim()

          .toUpperCase()}`;

      const monitoring =

        rateMonitoringByPair.get(key);

      if (!monitoring) continue;

      item.rate_monitoring_status =

        monitoring.status;

      item.rate_monitoring_current_rate =

        monitoring.currentRate;

      item.rate_monitoring_baseline_rate =

        monitoring.baselineRate;

      item.rate_monitoring_variance_percent =

        monitoring.variancePercent;

      item.rate_monitoring_threshold_percent =

        monitoring.thresholdPercent;

      item.rate_monitoring_checked_at =

        monitoring.checkedAt;

      item.rate_monitoring_baseline_effective_date =

        monitoring.baselineEffectiveDate ?? "";

      item.rate_monitoring_baseline_approved_at =

        monitoring.baselineApprovedAt ?? "";

      item.rate_monitoring_baseline_pk =

        monitoring.baselinePK ?? "";

      item.rate_monitoring_baseline_sk =

        monitoring.baselineSK ?? "";

    }

    // PREVIEW

    //

    // Nothing is written during preview. The client receives

    // the differences and decides whether to replace.

    // ========================================================

    if (action === "preview") {

      if (existingItems.length > 0) {

        return NextResponse.json({

          success: true,

          requiresConfirmation: true,

          billingPeriodId,

          imported: 0,

          skipped: skippedRows.length,

          totalProcessed: rows.length,

          skippedRows: skippedRows.slice(0, 200),

          skippedRowsTruncated: skippedRows.length > 200,

          rateMonitoring,

          comparison: {

            ...comparison.summary,

            rows: comparison.rows

              .filter((row) => row.status !== "unchanged")

              .slice(0, 500),

            rowsTruncated:

              comparison.rows.filter((row) => row.status !== "unchanged").length >

              500,

          },

        });

      }

      // No existing records: safe to import immediately.

      const requests: InvoiceWriteRequest[] =

        items.map((Item) => ({

          PutRequest: {

            Item,

          },

        }));

      const batches =

        chunkArray(requests, BATCH_SIZE);

      const imported =

        await writeBatches(batches);

      return NextResponse.json({

        success: true,

        requiresConfirmation: false,

        billingPeriodId,

        imported,

        skipped: skippedRows.length,

        totalProcessed: rows.length,

        batches: batches.length,

        rateMonitoring,

        skippedRows: skippedRows.slice(0, 200),

        skippedRowsTruncated: skippedRows.length > 200,

      });

    }

    // ========================================================

    // REPLACE

    //

    // Re-query happened above, so replacement uses the current

    // contents of DynamoDB rather than trusting preview state.

    //

    // Delete the whole billing period, then write the validated

    // CSV rows.

    // ========================================================

    const deleted =

      await deleteExistingPeriod(existingItems);

    const requests: InvoiceWriteRequest[] =

      items.map((Item) => ({

        PutRequest: {

          Item,

        },

      }));

    const batches =

      chunkArray(requests, BATCH_SIZE);

    const imported =

      await writeBatches(batches);

    return NextResponse.json({

      success: true,

      replaced: true,

      billingPeriodId,

      deleted,

      imported,

      skipped: skippedRows.length,

      totalProcessed: rows.length,

      batches: batches.length,

      comparison: comparison.summary,

      rateMonitoring,

      skippedRows: skippedRows.slice(0, 200),

      skippedRowsTruncated: skippedRows.length > 200,

    });

  } catch (

    error

  ) {

    console.error(

      "Invoice CSV import error:",

      error,

    );

    return NextResponse.json(

      {

        error:

          error instanceof

          Error

            ? error.message

            : "Unable to import invoice CSV.",

      },

      {

        status: 500,

      },

    );

  }

}
