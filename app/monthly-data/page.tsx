import DevUserMenu from "@/dev-only/auth/user-menu";
// app/monthly-data/page.tsx

import Link from "next/link";

import { redirect } from "next/navigation";

import {

  QueryCommand,

  ScanCommand,

  type QueryCommandInput,

  type ScanCommandInput,

} from "@aws-sdk/lib-dynamodb";

import { ddb } from "@/lib/dynamo";

import { signOut } from "@/lib/auth";
import { getAppSession } from "@/lib/app-session";
import { isLocalAuth } from "@/lib/auth-mode";

import {

  Button,

} from "@/components/ui/button";

import {

  BarChart3,

  Bell,

  CalendarDays,

  ChevronDown,

  CircleHelp,

  Database,

  FileText,

  Home,

  Settings,

  ShieldCheck,

  Table2,

} from "lucide-react";

import {

  MonthlyDataClient,

  type InvoiceRecord,

  type MeterReadingRecord,

  type CorrectionRuleRecord,

  type MeterMasterRecord,

} from "./monthly-data-client";

import "./monthlydata.css";
import { AppSectionNavigation, AppSectionProvider } from "@/components/app-section-navigation";

export const dynamic = "force-dynamic";

export const revalidate = 0;

// ============================================================

// TABLES

// ============================================================

const INVOICES_TABLE =

  "p72-CUBE-INVOICES";

const METER_READINGS_TABLE =

  "p72-CUBE-METER-READINGS";

const METERS_TABLE =

  "p72-CUBE-METERS";

const CORRECTION_RULES_TABLE =

  "p72-CUBE-METER-CORRECTION-RULES";

// ============================================================

// INDEXES

// ============================================================

const FY_INDEX =

  "fy-index";

const BILLING_PERIOD_INDEX =

  "billing-period-index";

// ============================================================

// MONTHS

// ============================================================

const MONTHS = [

  "January",

  "February",

  "March",

  "April",

  "May",

  "June",

  "July",

  "August",

  "September",

  "October",

  "November",

  "December",

];

// ============================================================

// NAVIGATION

// ============================================================

const navItems = [

  {

    label: "Dashboard",

    icon: Home,

    href: "/dashboard",

  },

  {

    label: "Background Data",

    icon: Database,

    href: "/backgrounddata",

  },

  {

    label: "Billing",

    icon: FileText,

    href: "/billing",

  },

  {

    label: "Data Validation",

    icon: ShieldCheck,

    href: "/data-validation",

  },

  {

    label: "Monthly Data",

    icon: CalendarDays,

    href: "/monthly-data",

    active: true,

  },

  {

    label: "Yearly Data",

    icon: Table2,

    href: "/yearly-data",

  },

  {

    label: "Report & Analysis",

    icon: BarChart3,

    href: "/reports",

  },

];

// ============================================================

// HELPERS

// ============================================================

function value(

  item: Record<string, unknown>,

  name: string,

): string {

  const raw =

    item[name];

  if (

    raw === undefined ||

    raw === null

  ) {

    return "";

  }

  return String(

    raw,

  ).trim();

}

function getCurrentFiscalYear() {

  const now =

    new Date();

  const month =

    now.getMonth() +

    1;

  return String(

    month >= 10

      ? now.getFullYear() + 1

      : now.getFullYear(),

  );

}

function getCurrentMonthName() {

  return MONTHS[

    new Date().getMonth()

  ];

}

function getFiscalYears(

  selectedFY: string,

) {

  const current =

    Number(

      getCurrentFiscalYear(),

    );

  const requested =

    Number(

      selectedFY,

    );

  const highest =

    Math.max(

      current,

      Number.isFinite(

        requested,

      )

        ? requested

        : current,

    );

  return Array.from(

    {

      length: 12,

    },

    (_, index) =>

      String(

        highest -

          index,

      ),

  );

}

// ============================================================

// BILLING PERIOD HELPERS

//

// Existing DynamoDB data always wins.

//

// If the selected month has no data yet, derive its Billing

// Period ID from the nearest existing fiscal month found in

// either meter readings or invoices. This avoids depending on

// a hard-coded historical Billing Period anchor.

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

function fiscalMonthSerial(

  fy: string,

  month: string,

): number | null {

  const numericFY = Number(fy);

  const monthIndex =

    FISCAL_MONTH_ORDER.indexOf(month);

  if (

    !Number.isFinite(numericFY) ||

    monthIndex < 0

  ) {

    return null;

  }

  return numericFY * 12 + monthIndex;

}

function deriveBillingPeriodId(

  targetFY: string,

  targetMonth: string,

  referenceFY: string,

  referenceMonth: string,

  referenceBillingPeriodId: string,

): string {

  const targetSerial =

    fiscalMonthSerial(

      targetFY,

      targetMonth,

    );

  const referenceSerial =

    fiscalMonthSerial(

      referenceFY,

      referenceMonth,

    );

  const referenceBP =

    Number(

      referenceBillingPeriodId,

    );

  if (

    targetSerial === null ||

    referenceSerial === null ||

    !Number.isFinite(referenceBP)

  ) {

    return "";

  }

  return String(

    referenceBP +

      (

        targetSerial -

        referenceSerial

      ),

  );

}

type BillingPeriodReference = {

  fy: string;

  month: string;

  billingPeriodId: string;

};

async function findNearestBillingPeriodReference(

  targetFY: string,

  targetMonth: string,

): Promise<BillingPeriodReference | null> {

  const targetSerial =

    fiscalMonthSerial(

      targetFY,

      targetMonth,

    );

  if (targetSerial === null) {

    return null;

  }

  // Search outward from the selected month. Existing meter-reading

  // data is preferred, then invoice data for the same candidate month.

  // 120 months gives us a 10-year window in either direction.

  for (

    let distance = 1;

    distance <= 120;

    distance += 1

  ) {

    for (

      const offset of [

        distance,

        -distance,

      ]

    ) {

      const candidate =

        getFiscalPeriodOffset(

          targetFY,

          targetMonth,

          offset,

        );

      const meterBP =

        await findBillingPeriodId(

          METER_READINGS_TABLE,

          candidate.fy,

          candidate.month,

        );

      if (meterBP) {

        return {

          fy: candidate.fy,

          month: candidate.month,

          billingPeriodId:

            meterBP,

        };

      }

      const invoiceBP =

        await findBillingPeriodId(

          INVOICES_TABLE,

          candidate.fy,

          candidate.month,

        );

      if (invoiceBP) {

        return {

          fy: candidate.fy,

          month: candidate.month,

          billingPeriodId:

            invoiceBP,

        };

      }

    }

  }

  return null;

}

// ============================================================

// FISCAL PERIOD OFFSET

// ============================================================

function getFiscalPeriodOffset(

  fy: string,

  month: string,

  offset: number,

) {

  const monthIndex =

    MONTHS.indexOf(month);

  if (monthIndex < 0) {

    return {

      fy,

      month,

    };

  }

  const fiscalYear =

    Number(fy);

  const calendarYear =

    monthIndex >= 9

      ? fiscalYear - 1

      : fiscalYear;

  const date =

    new Date(

      Date.UTC(

        calendarYear,

        monthIndex + offset,

        1,

      ),

    );

  const shiftedMonthIndex =

    date.getUTCMonth();

  const shiftedCalendarYear =

    date.getUTCFullYear();

  const shiftedFY =

    shiftedMonthIndex >= 9

      ? shiftedCalendarYear + 1

      : shiftedCalendarYear;

  return {

    fy: String(

      shiftedFY,

    ),

    month:

      MONTHS[

        shiftedMonthIndex

      ],

  };

}

// ============================================================

// SMALL TABLE SCAN

// ============================================================

async function scanTable(

  tableName: string,

  projectionExpression?: string,

): Promise<

  Record<string, unknown>[]

> {

  const items:

    Record<

      string,

      unknown

    >[] = [];

  let exclusiveStartKey:

    | ScanCommandInput["ExclusiveStartKey"]

    | undefined;

  do {

    const result =

      await ddb.send(

        new ScanCommand({

          TableName:

            tableName,

          ...(projectionExpression

            ? { ProjectionExpression: projectionExpression }

            : {}),

          ExclusiveStartKey:

            exclusiveStartKey,

        }),

      );

    items.push(

      ...((result.Items ??

        []) as Record<

        string,

        unknown

      >[]),

    );

    exclusiveStartKey =

      result.LastEvaluatedKey;

  } while (

    exclusiveStartKey

  );

  return items;

}

// ============================================================

// FIND BILLING PERIOD ID

//

// Uses fy-index to find the billing_period_id belonging to

// a fiscal year + month.

//

// We only project the two fields we need.

// ============================================================

async function findBillingPeriodId(

  tableName: string,

  fy: string,

  month: string,

): Promise<string> {

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

            FY_INDEX,

          KeyConditionExpression:

            "#fy = :fy",

          FilterExpression:

            "#month = :month",

          ExpressionAttributeNames: {

            "#fy":

              "fy",

            "#month":

              "billing_month_nm",

          },

          ExpressionAttributeValues: {

            ":fy":

              Number(fy),

            ":month":

              month,

          },

          ProjectionExpression:

            "billing_period_id",

          ExclusiveStartKey:

            exclusiveStartKey,

        }),

      );

    const first =

      result.Items?.[

        0

      ];

    const billingPeriodId =

      first

        ? value(

            first as Record<

              string,

              unknown

            >,

            "billing_period_id",

          )

        : "";

    if (

      billingPeriodId

    ) {

      return billingPeriodId;

    }

    exclusiveStartKey =

      result.LastEvaluatedKey;

  } while (

    exclusiveStartKey

  );

  return "";

}

// ============================================================

// QUERY EXACT BILLING PERIOD

// ============================================================

async function queryBillingPeriod(

  tableName: string,

  billingPeriodId: string,

): Promise<

  Record<string, unknown>[]

> {

  if (

    !billingPeriodId

  ) {

    return [];

  }

  const items:

    Record<

      string,

      unknown

    >[] = [];

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

              Number(

                billingPeriodId,

              ),

          },

          ExclusiveStartKey:

            exclusiveStartKey,

        }),

      );

    items.push(

      ...((result.Items ??

        []) as Record<

        string,

        unknown

      >[]),

    );

    exclusiveStartKey =

      result.LastEvaluatedKey;

  } while (

    exclusiveStartKey

  );

  return items;

}

// ============================================================

// INVOICE MAPPER

// ============================================================

function toInvoiceRecord(

  item: Record<string, unknown>,

): InvoiceRecord {

  return {

    invoiceid:

      value(

        item,

        "invoiceid",

      ),

    billing_period_id:

      value(

        item,

        "billing_period_id",

      ),

    fy:

      value(

        item,

        "fy",

      ),

    billing_month_nm:

      value(

        item,

        "billing_month_nm",

      ),

    utility_group_id:

      value(

        item,

        "utility_group_id",

      ),

    utility_type_cd:

      value(

        item,

        "utility_type_cd",

      ),

    utility_provider_cd:

      value(

        item,

        "utility_provider_cd",

      ),

    primary_account_nbr:

      value(

        item,

        "primary_account_nbr",

      ),

    account_nbr:

      value(

        item,

        "account_nbr",

      ),

    distribution_system:

      value(

        item,

        "distribution_system",

      ),

    billing_from_date:

      value(

        item,

        "billing_from_date",

      ),

    billing_to_date:

      value(

        item,

        "billing_to_date",

      ),

    consumption:

      value(

        item,

        "consumption",

      ),

    consumption_um:

      value(

        item,

        "consumption_um",

      ),

    charge:

      value(

        item,

        "charge",

      ),

    account_detail:

      value(

        item,

        "account_detail",

      ),

    entry_instruction:

      value(

        item,

        "entry_instruction",

      ),

    invoice_comments:

      value(

        item,

        "invoice_comments",

      ),

    period:

      value(

        item,

        "period",

      ),

  };

}

// ============================================================

// METER READING MAPPER

// ============================================================

function toMeterReadingRecord(

  item: Record<string, unknown>,

): MeterReadingRecord {

  return {

    meterid:

      value(

        item,

        "meterid",

      ),

    period:

      value(

        item,

        "period",

      ),

    billing_period_id:

      value(

        item,

        "billing_period_id",

      ),

    fy:

      value(

        item,

        "fy",

      ),

    billing_month_nm:

      value(

        item,

        "billing_month_nm",

      ),

    utility_type_cd:

      value(

        item,

        "utility_type_cd",

      ),

    inst_cd:

      value(

        item,

        "inst_cd",

      ),

    sub_inst_cd:

      value(

        item,

        "sub_inst_cd",

      ),

    site_cd:

      value(

        item,

        "site_cd",

      ),

    facility_nbr:

      value(

        item,

        "facility_nbr",

      ),

    multiplier:

      value(

        item,

        "multiplier",

      ),

    previous_reading:

      value(

        item,

        "previous_reading",

      ),

    previous_adjusted_reading:

      value(

        item,

        "previous_adjusted_reading",

      ),

    reading:

      value(

        item,

        "reading",

      ),

    consumption:

      value(

        item,

        "consumption",

      ),

    meter_correction_rule_cd:

      value(

        item,

        "meter_correction_rule_cd",

      ),

    adjusted_consumption:

      value(

        item,

        "adjusted_consumption",

      ),

    used_in_calculation:

      value(

        item,

        "used_in_calculation",

      ),

    isMasterOnly: !value(item, "reading"),

  };

}

// ============================================================

// METER MASTER MAPPER

// ============================================================

function toMeterMasterRecord(

  item: Record<string, unknown>,

): MeterMasterRecord {

  return {

    meterid:

      value(

        item,

        "meterid",

      ),

    facility_nbr:

      value(

        item,

        "facility_nbr",

      ),

    sub_inst_cd:

      value(

        item,

        "sub_inst_cd",

      ),

    utility_type_cd:

      value(

        item,

        "utility_type_cd",

      ),

  };

}

// ============================================================

// CORRECTION RULE MAPPER

// ============================================================

function toCorrectionRule(

  item: Record<string, unknown>,

): CorrectionRuleRecord {

  return {

    correction_rule_cd:

      value(

        item,

        "correction_rule_cd",

      ),

    correction_rule_name:

      value(

        item,

        "correction_rule_name",

      ),

    correction_rule_description:

      value(

        item,

        "correction_rule_description",

      ),

  };

}

// ============================================================

// SORT HELPERS

// ============================================================

function hasReadingValue(

  reading: string,

): boolean {

  const normalized =

    reading.trim();

  if (

    !normalized

  ) {

    return false;

  }

  const numeric =

    Number(

      normalized,

    );

  if (

    Number.isFinite(

      numeric,

    )

  ) {

    return numeric !== 0;

  }

  return true;

}

function sortMeterReadings(

  a: MeterReadingRecord,

  b: MeterReadingRecord,

) {

  const facility =

    a.facility_nbr.localeCompare(

      b.facility_nbr,

      undefined,

      {

        numeric: true,

        sensitivity:

          "base",

      },

    );

  if (

    facility !== 0

  ) {

    return facility;

  }

  const meter =

    a.meterid.localeCompare(

      b.meterid,

      undefined,

      {

        numeric: true,

        sensitivity:

          "base",

      },

    );

  if (

    meter !== 0

  ) {

    return meter;

  }

  const aHas =

    hasReadingValue(

      a.reading,

    );

  const bHas =

    hasReadingValue(

      b.reading,

    );

  if (

    aHas !== bHas

  ) {

    return aHas

      ? -1

      : 1;

  }

  return a.period.localeCompare(

    b.period,

    undefined,

    {

      numeric: true,

      sensitivity:

        "base",

    },

  );

}

// ============================================================

// PAGE PROPS

// ============================================================

type MonthlyDataPageProps = {

  searchParams?:

    Promise<{

      fy?: string;

      month?: string;

    }>;

};

// ============================================================

// PAGE

// ============================================================

export default async function MonthlyDataPage({

  searchParams,

}: MonthlyDataPageProps) {

  // ==========================================================

  // PRODUCTION AUTHENTICATION (NOT ENABLED)

  //

  // Auth.js validates the authenticated session before any

  // Monthly Data content or DynamoDB data is returned.

  //

  // If there is no authenticated user, redirect to the CUBE

  // sign-in page.

  // ==========================================================

  const session =

    await getAppSession();

  if (

    !session?.user

  ) {

    redirect("/");

  }

  // ==========================================================

  // LOCAL DEVELOPMENT SESSION (provided centrally when AUTH_MODE=local)

  //

  // ACTIVE FOR LOCAL DEVELOPMENT.

  //

  // To bypass CAC/Cognito authentication during local

  // development:

  //

  // 1. Comment out the production auth block above.

  // 2. Uncomment the local session below.

  //

  // NEVER deploy with this block enabled.

  // ==========================================================

  // Local development sessions are provided by lib/local-session.ts.

  // ==========================================================

  // AUTHENTICATED USER DISPLAY

  // ==========================================================

  const displayName =

    session.user.name?.trim() ||

    session.user.email?.trim() ||

    "CUBE User";

  const userInitials =

    displayName

      .split(" ")

      .filter(Boolean)

      .map(

        (part) =>

          part[0],

      )

      .join("")

      .slice(0, 2)

      .toUpperCase();

  // ==========================================================

  // RESOLVE SELECTED FY / MONTH

  // ==========================================================

  const params =

    searchParams

      ? await searchParams

      : {};

  const requestedFY =

    value(

      params as Record<

        string,

        unknown

      >,

      "fy",

    );

  const requestedMonth =

    value(

      params as Record<

        string,

        unknown

      >,

      "month",

    );

  const selectedFY =

    /^\d{4}$/.test(

      requestedFY,

    )

      ? requestedFY

      : getCurrentFiscalYear();

  const selectedMonth =

    MONTHS.includes(

      requestedMonth,

    )

      ? requestedMonth

      : getCurrentMonthName();

  // ==========================================================

  // PERIOD CONTEXT FOR CORRECTION RULES

  //

  // Phase 1 performance change:

  //

  // The initial page no longer loads 24 months of readings or

  // scans the meter master for the summary tabs.

  //

  // We only load the periods needed by the Meter Readings tab:

  // current, previous 1/2/3, next 1, and same month prior FY.

  //

  // Monthly Summary and Facility Summary load on demand through

  // their API routes when the user opens those tabs.

  // ==========================================================

  const previous1 =

    getFiscalPeriodOffset(

      selectedFY,

      selectedMonth,

      -1,

    );

  const previous2 =

    getFiscalPeriodOffset(

      selectedFY,

      selectedMonth,

      -2,

    );

  const previous3 =

    getFiscalPeriodOffset(

      selectedFY,

      selectedMonth,

      -3,

    );

  const next1 =

    getFiscalPeriodOffset(

      selectedFY,

      selectedMonth,

      1,

    );

  const priorFYPeriod = {

    fy:

      String(

        Number(

          selectedFY,

        ) - 1,

      ),

    month:

      selectedMonth,

  };

  const [

    readingBillingPeriodId,

    invoiceBillingPeriodId,

    previous1BillingPeriodId,

    previous2BillingPeriodId,

    previous3BillingPeriodId,

    next1BillingPeriodId,

    priorFYBillingPeriodId,

    correctionItems,

    meterItems,

  ] = await Promise.all([

    findBillingPeriodId(

      METER_READINGS_TABLE,

      selectedFY,

      selectedMonth,

    ),

    findBillingPeriodId(

      INVOICES_TABLE,

      selectedFY,

      selectedMonth,

    ),

    findBillingPeriodId(

      METER_READINGS_TABLE,

      previous1.fy,

      previous1.month,

    ),

    findBillingPeriodId(

      METER_READINGS_TABLE,

      previous2.fy,

      previous2.month,

    ),

    findBillingPeriodId(

      METER_READINGS_TABLE,

      previous3.fy,

      previous3.month,

    ),

    findBillingPeriodId(

      METER_READINGS_TABLE,

      next1.fy,

      next1.month,

    ),

    findBillingPeriodId(

      METER_READINGS_TABLE,

      priorFYPeriod.fy,

      priorFYPeriod.month,

    ),

    scanTable(

      CORRECTION_RULES_TABLE,

    ),

    scanTable(

      METERS_TABLE,

      "meterid, facility_nbr, sub_inst_cd, utility_type_cd",

    ),

  ]);

  let billingPeriodId =

    readingBillingPeriodId ||

    invoiceBillingPeriodId;

  // If this is a new month with no records yet, derive the Billing

  // Period ID from the nearest existing month in DynamoDB.

  if (

    !billingPeriodId

  ) {

    const reference =

      await findNearestBillingPeriodReference(

        selectedFY,

        selectedMonth,

      );

    if (

      reference

    ) {

      billingPeriodId =

        deriveBillingPeriodId(

          selectedFY,

          selectedMonth,

          reference.fy,

          reference.month,

          reference.billingPeriodId,

        );

    }

  }

  const [

    invoiceItems,

    currentReadingItems,

    previous1ReadingItems,

    previous2ReadingItems,

    previous3ReadingItems,

    next1ReadingItems,

    priorFYReadingItems,

  ] = await Promise.all([

    queryBillingPeriod(

      INVOICES_TABLE,

      billingPeriodId,

    ),

    queryBillingPeriod(

      METER_READINGS_TABLE,

      billingPeriodId,

    ),

    queryBillingPeriod(

      METER_READINGS_TABLE,

      previous1BillingPeriodId,

    ),

    queryBillingPeriod(

      METER_READINGS_TABLE,

      previous2BillingPeriodId,

    ),

    queryBillingPeriod(

      METER_READINGS_TABLE,

      previous3BillingPeriodId,

    ),

    queryBillingPeriod(

      METER_READINGS_TABLE,

      next1BillingPeriodId,

    ),

    queryBillingPeriod(

      METER_READINGS_TABLE,

      priorFYBillingPeriodId,

    ),

  ]);

  // ==========================================================

  // MAP

  // ==========================================================

  const invoices =

    invoiceItems

      .map(

        toInvoiceRecord,

      )

      .sort(

        (a, b) =>

          a.account_nbr.localeCompare(

            b.account_nbr,

            undefined,

            {

              numeric: true,

              sensitivity:

                "base",

            },

          ),

      );

  const meterReadings =

    [

      ...currentReadingItems,

      ...previous1ReadingItems,

      ...previous2ReadingItems,

      ...previous3ReadingItems,

      ...next1ReadingItems,

      ...priorFYReadingItems,

    ]

      .map(

        toMeterReadingRecord,

      )

      .filter(

        (

          reading,

          index,

          all,

        ) =>

          index ===

          all.findIndex(

            (candidate) =>

              candidate.meterid ===

                reading.meterid &&

              (

                candidate.period

                  ? candidate.period ===

                    reading.period

                  : candidate.billing_period_id ===

                    reading.billing_period_id

              ),

          ),

      )

      .sort(

        sortMeterReadings,

      );

  const meterMaster =

    meterItems

      .map(

        toMeterMasterRecord,

      )

      .filter(

        (meter) => Boolean(meter.meterid),

      )

      .sort(

        (a, b) =>

          a.facility_nbr.localeCompare(

            b.facility_nbr,

            undefined,

            {

              numeric: true,

              sensitivity: "base",

            },

          ) ||

          a.meterid.localeCompare(

            b.meterid,

            undefined,

            {

              numeric: true,

              sensitivity: "base",

            },

          ),

      );

  const correctionRules =

    correctionItems

      .map(

        toCorrectionRule,

      )

      .sort(

        (a, b) =>

          a.correction_rule_cd.localeCompare(

            b.correction_rule_cd,

            undefined,

            {

              sensitivity:

                "base",

            },

          ),

      );

  const fiscalYears =

    getFiscalYears(

      selectedFY,

    );

  // ==========================================================

  // RENDER

  // ==========================================================

  return (

    <div className="ce-app md-app">

      {/* ====================================================

          TOP BAR

      ==================================================== */}

      <header className="ce-topbar">

        <div className="ce-topbar-left">

          <button

            className="ce-app-grid"

            aria-label="Application menu"

          >

            {Array.from({

              length: 11,

            }).map(

              (_, index) => (

                <span

                  key={

                    index

                  }

                />

              ),

            )}

          </button>

          <span className="ce-power-apps">

            Centralized Utility and Billing Environment

          </span>

        </div>

        <div className="ce-topbar-right">

          {/* =================================================

              NOTIFICATIONS

          ================================================= */}

          <button

            className="ce-notification-button"

            aria-label="Notifications"

          >

            <Bell

              size={

                21

              }

            />

            <span className="ce-notification-count">

              3

            </span>

          </button>

          <div className="ce-top-divider" />

          {/* =================================================

              AUTHENTICATED USER

          ================================================= */}

          {isLocalAuth ? (
            <DevUserMenu name={displayName} />
          ) : (
            <div className="ce-user">

              <div className="ce-avatar">

                {

                  userInitials

                }

              </div>

              <span className="ce-user-name">

                {

                  displayName

                }

              </span>

              <ChevronDown

                size={

                  17

                }

              />

            </div>
          )}

          {/* =================================================

              SIGN OUT

              This is a Server Action. Auth.js terminates the

              authenticated session and redirects the user to

              the CUBE sign-in page.

          ================================================= */}

          {!isLocalAuth && (
          <form

            action={

              async () => {

                "use server";

                await signOut({

                  redirectTo:

                    "/",

                });

              }

            }

          >

            <Button

              type="submit"

              variant="outline"

              size="sm"

            >

              Sign out

            </Button>

          </form>
          )}

        </div>

      </header>

      {/* ====================================================

          APPLICATION BODY

      ==================================================== */}

      <AppSectionProvider key={`${selectedFY}-${selectedMonth}-${billingPeriodId}`} page="Monthly Data" initialSection="Invoices">
      <div className="ce-body">

        {/* ==================================================

            SIDEBAR

        ================================================== */}

        <aside className="ce-sidebar">

          <nav

            className="ce-nav"

            aria-label="Primary navigation"

          >

            {navItems.map(

              (item) => {

                const Icon =

                  item.icon;

                return (

                  <div key={item.label}>
                  <Link

                    key={

                      item.label

                    }

                    href={

                      item.href

                    }

                    className={`ce-nav-item ${

                      item.active

                        ? "ce-nav-active"

                        : ""

                    }`}

                  >

                    <Icon

                      size={

                        25

                      }

                    />

                    <span>

                      {

                        item.label

                      }

                    </span>

                  </Link>

                  {item.active && <AppSectionNavigation />}

                  </div>

                );

              },

            )}

          </nav>

          {/* =================================================

              FUTURE SIDEBAR ITEMS

          ================================================= */}

          {/*

          <div className="ce-sidebar-footer">

            <Link

              href="/settings"

              className="ce-nav-item"

            >

              <Settings

                size={25}

              />

              <span>

                Settings

              </span>

            </Link>

            <Link

              href="/help"

              className="ce-nav-item"

            >

              <CircleHelp

                size={25}

              />

              <span>

                Help

              </span>

            </Link>

          </div>

          */}

        </aside>

        {/* ==================================================

            MAIN CONTENT

        ================================================== */}

        <main className="ce-main md-main">

          <section className="md-title-row">

            <div>

              <p className="bd-eyebrow">

                Monthly processing

              </p>

              <h1>

                Monthly Data

              </h1>

              <p className="bd-subtitle">

                Manage invoice, meter reading, AMR, manual,

                and real property data by billing period.

              </p>

            </div>

          </section>

          <AppSectionNavigation mobile />

          <MonthlyDataClient

            key={`${selectedFY}-${selectedMonth}-${billingPeriodId}`}

            invoices={

              invoices

            }

            meterReadings={

              meterReadings

            }

            correctionRules={

              correctionRules

            }

            meterMaster={

              meterMaster

            }

            initialFY={

              selectedFY

            }

            initialMonth={

              selectedMonth

            }

            billingPeriodId={

              billingPeriodId

            }

            fiscalYears={

              fiscalYears

            }

          />

        </main>

      </div>
      </AppSectionProvider>

    </div>

  );

}
