import DevUserMenu from "@/dev-only/auth/user-menu";
import Link from "next/link";

import { redirect } from "next/navigation";

import {

  ScanCommand,

  type ScanCommandInput,

} from "@aws-sdk/lib-dynamodb";

import {

  BarChart3,

  Bell,

  CalendarDays,

  ChevronDown,

  Database,

  FileText,

  Home,

  ShieldCheck,

  Table2,

} from "lucide-react";

// Production only: uncomment this import when enabling real authentication.
import { signOut } from "@/lib/auth";
import { getAppSession } from "@/lib/app-session";
import { isLocalAuth } from "@/lib/auth-mode";

import { ddb } from "@/lib/dynamo";

import { Button } from "@/components/ui/button";
import { AppSectionNavigation, AppSectionProvider } from "@/components/app-section-navigation";

import {

  BackgroundDataRegistryClient,

} from "./background-data-registry-client";

import type {

  CustomerRecord,

} from "./customer-registry-client";

import type {

  MeterRecord,

} from "./meter-registry-client";

import type {

  FacilityRecord,

} from "./facility-registry-client";

import "./backgrouddata.css";

export const dynamic = "force-dynamic";

export const revalidate = 0;

// ============================================================

// DYNAMODB TABLES

// ============================================================

const METERS_TABLE =

  "p72-CUBE-METERS";

const CUSTOMERS_TABLE =

  "p72-CUBE-CUSTOMERS";

const FACILITIES_TABLE =

  "p72-CUBE-FACILITIES";

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

    active: true,

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

// VALUE HELPERS

// ============================================================

function value(

  item: Record<string, unknown>,

  name: string,

): string {

  const rawValue =

    item[name];

  if (

    rawValue === undefined ||

    rawValue === null

  ) {

    return "";

  }

  return String(

    rawValue,

  ).trim();

}

// ============================================================

// BOOLEAN HELPER

// ============================================================

function booleanValue(

  item: Record<string, unknown>,

  name: string,

  defaultValue = false,

): boolean {

  const rawValue =

    item[name];

  if (

    rawValue === undefined ||

    rawValue === null

  ) {

    return defaultValue;

  }

  if (

    typeof rawValue === "boolean"

  ) {

    return rawValue;

  }

  const normalized =

    String(rawValue)

      .trim()

      .toLowerCase();

  if (

    normalized === "true" ||

    normalized === "1" ||

    normalized === "yes"

  ) {

    return true;

  }

  if (

    normalized === "false" ||

    normalized === "0" ||

    normalized === "no"

  ) {

    return false;

  }

  return defaultValue;

}

// ============================================================

// STRING ARRAY HELPER

// ============================================================

function stringArrayValue(

  item: Record<string, unknown>,

  name: string,

): string[] {

  const rawValue =

    item[name];

  if (

    rawValue === undefined ||

    rawValue === null

  ) {

    return [];

  }

  // DynamoDB DocumentClient may return

  // String Sets as JavaScript Sets.

  if (

    rawValue instanceof Set

  ) {

    return Array.from(

      rawValue,

    )

      .map((item) =>

        String(item).trim(),

      )

      .filter(Boolean);

  }

  // Handle normal arrays.

  if (

    Array.isArray(rawValue)

  ) {

    return rawValue

      .map((item) =>

        String(item).trim(),

      )

      .filter(Boolean);

  }

  // Fallback for older/manual records

  // containing a single value.

  const singleValue =

    String(rawValue).trim();

  return singleValue

    ? [singleValue]

    : [];

}

// ============================================================

// METER RECORD MAPPING

// ============================================================

function toMeterRecord(

  item: Record<string, unknown>,

): MeterRecord {

  return {

    meterid: value(

      item,

      "meterid",

    ),

    sub_inst_cd: value(

      item,

      "sub_inst_cd",

    ),

    site_cd: value(

      item,

      "site_cd",

    ),

    facility_nbr: value(

      item,

      "facility_nbr",

    ),

    utility_type_cd: value(

      item,

      "utility_type_cd",

    ),

    meter_type_cd: value(

      item,

      "meter_type_cd",

    ),

    amp: value(

      item,

      "amp",

    ),

    device_id: value(

      item,

      "device_id",

    ),

    zone: value(

      item,

      "zone",

    ),

    floor: value(

      item,

      "floor",

    ),

    serial_nbr: value(

      item,

      "serial_nbr",

    ),

    rollover: value(

      item,

      "rollover",

    ),

    expr1015: value(

      item,

      "expr1015",

    ),

    multiplier: value(

      item,

      "multiplier",

    ),

    utm_x: value(

      item,

      "utm_x",

    ),

    utm_y: value(

      item,

      "utm_y",

    ),

    vendor_id: value(

      item,

      "vendor_id",

    ),

    model_nbr: value(

      item,

      "model_nbr",

    ),

    install_date: value(

      item,

      "install_date",

    ),

    in_service_date: value(

      item,

      "in_service_date",

    ),

    inv_survey_date: value(

      item,

      "inv_survey_date",

    ),

    inv_tagged: value(

      item,

      "inv_tagged",

    ),

    outside: value(

      item,

      "outside",

    ),

    inv_read_method_id: value(

      item,

      "inv_read_method_id",

    ),

    network_ip_address: value(

      item,

      "network_ip_address",

    ),

    meter_ip_address: value(

      item,

      "meter_ip_address",

    ),

    xmit_ip_address: value(

      item,

      "xmit_ip_address",

    ),

    subnet_mask: value(

      item,

      "subnet_mask",

    ),

    default_gateway: value(

      item,

      "default_gateway",

    ),

    mac_id: value(

      item,

      "mac_id",

    ),

    analog_link: value(

      item,

      "analog_link",

    ),

    digital_link: value(

      item,

      "digital_link",

    ),

    eng_assessment_tx: value(

      item,

      "eng_assessment_tx",

    ),

    narrative: value(

      item,

      "narrative",

    ),

    meter_status_id: value(

      item,

      "meter_status_id",

    ),

    owner_id: value(

      item,

      "owner_id",

    ),

    zero_reading_streak:

      value(

        item,

        "ZeroReadingStreak",

      ) || "0",

  };

}

// ============================================================

// CUSTOMER RECORD MAPPING

// ============================================================

function toCustomerRecord(

  item: Record<string, unknown>,

): CustomerRecord {

  return {

    CustomerID:

      value(

        item,

        "CustomerID",

      ),

    CustomerName:

      value(

        item,

        "CustomerName",

      ),

    NextGenNames:

      stringArrayValue(

        item,

        "NextGenNames",

      ),

    UMMName:

      value(

        item,

        "UMMName",

      ),

    CustomerType:

      value(

        item,

        "CustomerType",

      ),

    ReportType:

      value(

        item,

        "ReportType",

      ),

    RateClass:

      value(

        item,

        "RateClass",

      ),

    RCBLComment:

      value(

        item,

        "RCBLComment",

      ),

    Active:

      booleanValue(

        item,

        "Active",

        true,

      ),

    CreatedDate:

      value(

        item,

        "CreatedDate",

      ),

    InactiveDate:

      value(

        item,

        "InactiveDate",

      ),

  };

}

// ============================================================

// FACILITY RECORD MAPPING

// ============================================================

function toFacilityRecord(

  item: Record<string, unknown>,

): FacilityRecord {

  return {

    FacilityID:

      value(

        item,

        "FacilityID",

      ),

    SUB_INST_CD:

      value(

        item,

        "SUB_INST_CD",

      ),

    SITE_CD:

      value(

        item,

        "SITE_CD",

      ),

    FacilityNumber:

      value(

        item,

        "FacilityNumber",

      ),

    FacilityType:

      value(

        item,

        "FacilityType",

      ),

    FacilityName:

      value(

        item,

        "FacilityName",

      ),

    AreaQty:

      value(

        item,

        "AreaQty",

      ),

    AreaUM:

      value(

        item,

        "AreaUM",

      ),

    OtherQty:

      value(

        item,

        "OtherQty",

      ),

    OtherUM:

      value(

        item,

        "OtherUM",

      ),

    Active:

      booleanValue(

        item,

        "Active",

        true,

      ),

    CreatedDate:

      value(

        item,

        "CreatedDate",

      ),

    InactiveDate:

      value(

        item,

        "InactiveDate",

      ),

  };

}

// ============================================================

// GENERIC DYNAMODB TABLE SCAN

// ============================================================

async function scanTable(

  tableName: string,

): Promise<

  Record<string, unknown>[]

> {

  const items: Record<

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

// LOAD METERS

// ============================================================

async function loadMeters(): Promise<

  MeterRecord[]

> {

  const items =

    await scanTable(

      METERS_TABLE,

    );

  return items

    .map(

      toMeterRecord,

    )

    .sort(

      (a, b) =>

        a.meterid.localeCompare(

          b.meterid,

          undefined,

          {

            numeric: true,

            sensitivity:

              "base",

          },

        ),

    );

}

// ============================================================

// LOAD FACILITIES

// ============================================================

async function loadFacilities(): Promise<

  FacilityRecord[]

> {

  const items =

    await scanTable(

      FACILITIES_TABLE,

    );

  return items

    .map(

      toFacilityRecord,

    )

    .sort(

      (a, b) => {

        if (

          a.Active !==

          b.Active

        ) {

          return a.Active

            ? -1

            : 1;

        }

        const siteComparison =

          a.SITE_CD.localeCompare(

            b.SITE_CD,

            undefined,

            {

              numeric: true,

              sensitivity:

                "base",

            },

          );

        if (

          siteComparison !== 0

        ) {

          return siteComparison;

        }

        return (

          a.FacilityNumber.localeCompare(

            b.FacilityNumber,

            undefined,

            {

              numeric: true,

              sensitivity:

                "base",

            },

          )

        );

      },

    );

}

// ============================================================

// LOAD CUSTOMERS

// ============================================================

async function loadCustomers(): Promise<

  CustomerRecord[]

> {

  const items =

    await scanTable(

      CUSTOMERS_TABLE,

    );

  return items

    .map(

      toCustomerRecord,

    )

    .sort(

      (a, b) => {

        if (

          a.Active !==

          b.Active

        ) {

          return a.Active

            ? -1

            : 1;

        }

        const nameComparison =

          a.CustomerName.localeCompare(

            b.CustomerName,

            undefined,

            {

              numeric: true,

              sensitivity:

                "base",

            },

          );

        if (

          nameComparison !== 0

        ) {

          return nameComparison;

        }

        return (

          a.CustomerID.localeCompare(

            b.CustomerID,

            undefined,

            {

              numeric: true,

              sensitivity:

                "base",

            },

          )

        );

      },

    );

}

// ============================================================

// PAGE

// ============================================================

export default async function BackgroundDataPage() {
  // ==========================================================
  // AUTHENTICATION (selected centrally through AUTH_MODE)
  // ==========================================================
  // To enable production authentication:
  // 1. Uncomment the auth/signOut import above and the redirect import.
  // 2. Uncomment the auth() and redirect() lines below.
  // 3. Comment out the LOCAL DEVELOPMENT SESSION below.
  // 4. Optionally uncomment the existing sign-out form in the top bar.
  // IMPORTANT: Never deploy with the local development session enabled.
  // Run authentication before loading DynamoDB data.
  //
  const session = await getAppSession();
  if (!session?.user) redirect("/");

  // ==========================================================
  // LOCAL DEVELOPMENT SESSION (provided centrally when AUTH_MODE=local)
  // ==========================================================
  // Temporary local session for development without Auth.js/Cognito.
  // Disable this entire object when enabling production authentication.
  // Local development sessions are provided by lib/local-session.ts.

  // Show the current session user's name, falling back to email.
  const displayName =

    session.user.name?.trim() ||

    session.user.email?.trim() ||

    "CUBE User";

  // ==========================================================

  // LOAD DYNAMODB DATA

  //

  // In production, enable the auth() guard above before loading data.
  // Local development currently uses the temporary session.

  //

  // Load all three datasets concurrently.

  // ==========================================================

  const [

    meters,

    facilities,

    customers,

  ] =

    await Promise.all([

      loadMeters(),

      loadFacilities(),

      loadCustomers(),

    ]);

  return (

    <div className="ce-app bd-app">

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

              (

                _,

                index,

              ) => (

                <span

                  key={

                    index

                  }

                />

              ),

            )}

          </button>

          <span className="ce-power-apps">

            Centralized Utility

            and Billing

            Environment

          </span>

        </div>

        <div className="ce-topbar-right">

          <button

            className="ce-notification-button"

            aria-label="Notifications"

          >

            <Bell

              size={21}

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

                {displayName

                  .split(" ")

                  .map(

                    (

                      part,

                    ) =>

                      part[0],

                  )

                  .join("")

                  .slice(

                    0,

                    2,

                  )

                  .toUpperCase()}

              </div>

              <span className="ce-user-name">

                {displayName}

              </span>

              <ChevronDown

                size={17}

              />

            </div>
          )}

          {/* =================================================

              PRODUCTION SIGN OUT

              ================================================= */}

          {!isLocalAuth && (
          <form

            action={async () => {

              "use server";

              await signOut({

                redirectTo: "/",

              });

            }}

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

          BODY

          ==================================================== */}

      <AppSectionProvider page="Background Data" initialSection="Meter">
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

        </aside>

        {/* ==================================================

            MAIN CONTENT

            ================================================== */}

        <main className="ce-main bd-main">

          <section className="bd-title-row">

            <div>

              <p className="bd-eyebrow">

                Reference

                management

              </p>

              <h1>

                Background Data

              </h1>

              <p className="bd-subtitle">

                Manage meters,

                customers, and the

                reference records

                used throughout

                CUBE.

              </p>

            </div>

          </section>

          <AppSectionNavigation mobile />

          {/* =================================================

              WORKSPACE

              ================================================= */}

          <section

            className="bd-workspace"

            aria-label="Background data workspace"

          >

            <BackgroundDataRegistryClient

              meters={meters}

              facilities={

                facilities

              }

              customers={

                customers

              }

            />

          </section>

        </main>

      </div>
      </AppSectionProvider>

    </div>

  );

}
