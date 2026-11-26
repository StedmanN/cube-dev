"use client";

import {
  AlertTriangle,
  BarChart3,
  Building2,
  CheckCircle2,
  CircleDollarSign,
  Database,
  Gauge,
  ReceiptText,
  ShieldAlert,
  TrendingDown,
  TrendingUp,
  Waves,
  Zap,
} from "lucide-react";

import { useRouter } from "next/navigation";

import {
  useMemo,
  useState,
} from "react";

// ============================================================
// DASHBOARD CONTRACT
// Must match app/dashboard/page.tsx
// ============================================================

export type DashboardData = {
  selectedFY: string;
  selectedMonth: string;
  billingPeriodId: number | null;

  fiscalYears: string[];

  processing: {
    realPropertyLoaded: boolean;
    estimatesGenerated: boolean;
    meterDataLoaded: boolean;
    validationReviews: number;
    invoicesLoaded: boolean;
  };

  kpis: {
    meteredConsumption: number;
    invoicedConsumption: number;
    estimatedConsumption: number;
    invoiceCharges: number;
    validationReviews: number;
    zeroReadingMeters: number;
  };

  reconciliation: {
    month: string;
    short: string;
    billingPeriodId: number | null;
    metered: number;
    invoiced: number;
    estimated: number;
  }[];

  utilities: {
    utility: string;
    name: string;
    metered: number;
    invoiced: number;
    estimated: number;
    invoiceCharges: number;
    meterInvoiceVariance: number | null;
    invoiceEstimateVariance: number | null;
    meterEstimateVariance: number | null;
  }[];

  attention: {
    validationReviews: number;
    zeroReadingMeters: number;
    missingCategoryMappings: number;
    missingIntensityMappings: number;
  };

  realProperty: {
    records: number;
    estimates: number;
    customerMapped: number;
    facilityMapped: number;
    categoryMapped: number;
    currentFYIntensities: number;
    priorFYIntensityFallbacks: number;
  };
};

type DashboardClientProps = {
  data: DashboardData;
};

// ============================================================
// CONSTANTS
// ============================================================

const FISCAL_MONTHS = [
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

const UTILITY_ICONS: Record<
  string,
  typeof Zap
> = {
  EL: Zap,
  NG: Gauge,
  PW: Waves,
  SS: Waves,
};

// ============================================================
// FORMATTERS
// ============================================================

function formatNumber(
  value: number | null | undefined,
  maximumFractionDigits = 0,
): string {
  const safe =
    typeof value === "number" &&
    Number.isFinite(value)
      ? value
      : 0;

  return safe.toLocaleString(
    undefined,
    {
      maximumFractionDigits,
    },
  );
}

function formatCompact(
  value: number | null | undefined,
): string {
  const safe =
    typeof value === "number" &&
    Number.isFinite(value)
      ? value
      : 0;

  if (
    Math.abs(safe) >=
    1_000_000_000
  ) {
    return `${(
      safe / 1_000_000_000
    ).toFixed(2)}B`;
  }

  if (
    Math.abs(safe) >=
    1_000_000
  ) {
    return `${(
      safe / 1_000_000
    ).toFixed(2)}M`;
  }

  if (
    Math.abs(safe) >=
    1_000
  ) {
    return `${(
      safe / 1_000
    ).toFixed(1)}K`;
  }

  return formatNumber(safe);
}

function formatCurrency(
  value: number | null | undefined,
): string {
  const safe =
    typeof value === "number" &&
    Number.isFinite(value)
      ? value
      : 0;

  return safe.toLocaleString(
    undefined,
    {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 0,
    },
  );
}

function formatPercent(
  value: number | null | undefined,
): string {
  if (
    value === null ||
    value === undefined ||
    !Number.isFinite(value)
  ) {
    return "—";
  }

  const prefix =
    value > 0 ? "+" : "";

  return `${prefix}${value.toFixed(
    1,
  )}%`;
}

function percentOf(
  value: number,
  total: number,
): number {
  if (
    total <= 0
  ) {
    return 0;
  }

  return Math.min(
    Math.max(
      (value / total) * 100,
      0,
    ),
    100,
  );
}

// ============================================================
// STATUS COMPONENT
// ============================================================

function ProcessingStep({
  label,
  complete,
  detail,
  warning = false,
}: {
  label: string;
  complete: boolean;
  detail: string;
  warning?: boolean;
}) {
  return (
    <div
      className={`ce-dashboard-process-step ${
        complete
          ? "ce-dashboard-process-complete"
          : warning
            ? "ce-dashboard-process-warning"
            : "ce-dashboard-process-pending"
      }`}
    >
      <div className="ce-dashboard-process-icon">
        {complete ? (
          <CheckCircle2 size={21} />
        ) : (
          <AlertTriangle size={21} />
        )}
      </div>

      <div>
        <strong>{label}</strong>
        <span>{detail}</span>
      </div>
    </div>
  );
}

// ============================================================
// KPI CARD
// ============================================================

function KpiCard({
  label,
  value,
  detail,
  icon: Icon,
  tone = "default",
}: {
  label: string;
  value: string;
  detail: string;
  icon: typeof Zap;
  tone?:
    | "default"
    | "purple"
    | "blue"
    | "green"
    | "amber";
}) {
  return (
    <article
      className={`ce-dashboard-kpi-card ce-dashboard-kpi-${tone}`}
    >
      <div className="ce-dashboard-kpi-top">
        <span>{label}</span>

        <div className="ce-dashboard-kpi-icon">
          <Icon size={20} />
        </div>
      </div>

      <strong>{value}</strong>
      <small>{detail}</small>
    </article>
  );
}

// ============================================================
// VARIANCE DISPLAY
// ============================================================

function VarianceValue({
  value,
}: {
  value: number | null;
}) {
  const positive =
    value !== null &&
    value > 0;

  const negative =
    value !== null &&
    value < 0;

  return (
    <span
      className={`ce-dashboard-variance ${
        positive
          ? "ce-dashboard-variance-up"
          : negative
            ? "ce-dashboard-variance-down"
            : ""
      }`}
    >
      {positive ? (
        <TrendingUp size={14} />
      ) : negative ? (
        <TrendingDown size={14} />
      ) : null}

      {formatPercent(value)}
    </span>
  );
}

// ============================================================
// MAIN CLIENT
// ============================================================

export function DashboardClient({
  data,
}: DashboardClientProps) {
  const router =
    useRouter();

  const [
    selectedFY,
    setSelectedFY,
  ] = useState(
    data.selectedFY,
  );

  const [
    selectedMonth,
    setSelectedMonth,
  ] = useState(
    data.selectedMonth,
  );

  const maxReconciliation =
    useMemo(
      () =>
        Math.max(
          ...data.reconciliation.flatMap(
            (item) => [
              item.metered,
              item.invoiced,
              item.estimated,
            ],
          ),
          1,
        ),
      [data.reconciliation],
    );

  const attentionTotal =
    data.attention
      .validationReviews +
    data.attention
      .zeroReadingMeters +
    data.attention
      .missingCategoryMappings +
    data.attention
      .missingIntensityMappings;

  const rpCustomerPercent =
    percentOf(
      data.realProperty
        .customerMapped,
      data.realProperty.records,
    );

  const rpFacilityPercent =
    percentOf(
      data.realProperty
        .facilityMapped,
      data.realProperty.records,
    );

  const rpCategoryPercent =
    percentOf(
      data.realProperty
        .categoryMapped,
      data.realProperty.records,
    );

  function navigate(
    fy: string,
    month: string,
  ) {
    const params =
      new URLSearchParams();

    params.set("fy", fy);
    params.set(
      "month",
      month,
    );

    router.push(
      `/dashboard?${params.toString()}`,
    );
  }

  function changeFY(
    fy: string,
  ) {
    setSelectedFY(fy);
    navigate(
      fy,
      selectedMonth,
    );
  }

  function changeMonth(
    month: string,
  ) {
    setSelectedMonth(
      month,
    );

    navigate(
      selectedFY,
      month,
    );
  }

  return (
    <div className="ce-dashboard">
      {/* ======================================================
          PAGE HEADER
      ====================================================== */}

      <section className="ce-dashboard-header">
        <div>
          <p className="ce-dashboard-eyebrow">
            CUBE Operations
          </p>

          <h1>
            Utility Operations Dashboard
          </h1>

          <p className="ce-dashboard-subtitle">
            Real Property → Estimates → Metered → Validation → Invoiced → Reconciliation
          </p>
        </div>

        <div className="ce-dashboard-period-controls">
          <label>
            <span>
              Fiscal Year
            </span>

            <select
              value={selectedFY}
              onChange={(
                event,
              ) =>
                changeFY(
                  event
                    .target
                    .value,
                )
              }
            >
              {data.fiscalYears.map(
                (fy) => (
                  <option
                    key={fy}
                    value={fy}
                  >
                    FY {fy}
                  </option>
                ),
              )}
            </select>
          </label>

          <label>
            <span>
              Billing Month
            </span>

            <select
              value={
                selectedMonth
              }
              onChange={(
                event,
              ) =>
                changeMonth(
                  event
                    .target
                    .value,
                )
              }
            >
              {FISCAL_MONTHS.map(
                (month) => (
                  <option
                    key={
                      month
                    }
                    value={
                      month
                    }
                  >
                    {month}
                  </option>
                ),
              )}
            </select>
          </label>

          <div className="ce-dashboard-period-id">
            <span>
              Billing Period
            </span>

            <strong>
              {data.billingPeriodId ??
                "—"}
            </strong>
          </div>
        </div>
      </section>

      {/* ======================================================
          PROCESSING PIPELINE
      ====================================================== */}

      <section className="ce-dashboard-section">
        <div className="ce-dashboard-section-heading">
          <div>
            <p>
              Monthly Processing
            </p>

            <h2>
              Billing Period Status
            </h2>
          </div>
        </div>

        <div className="ce-dashboard-process-grid">
          <ProcessingStep
            label="Real Property"
            complete={
              data.processing
                .realPropertyLoaded
            }
            detail={
              data.processing
                .realPropertyLoaded
                ? "RP data loaded"
                : "RP data not loaded"
            }
          />

          <ProcessingStep
            label="Estimates"
            complete={
              data.processing
                .estimatesGenerated
            }
            detail={
              data.processing
                .estimatesGenerated
                ? "Estimates generated"
                : "No estimates"
            }
          />

          <ProcessingStep
            label="Meter Data"
            complete={
              data.processing
                .meterDataLoaded
            }
            detail={
              data.processing
                .meterDataLoaded
                ? "Meter data loaded"
                : "Meter data not loaded"
            }
          />

          <ProcessingStep
            label="Validation"
            complete={
              data.processing
                .meterDataLoaded &&
              data.processing
                .validationReviews ===
                0
            }
            warning={
              data.processing
                .validationReviews >
              0
            }
            detail={
              data.processing
                .validationReviews >
              0
                ? `${formatNumber(
                    data
                      .processing
                      .validationReviews,
                  )} require review`
                : data.processing
                      .meterDataLoaded
                  ? "No reviews pending"
                  : "Awaiting meter data"
            }
          />

          <ProcessingStep
            label="Invoices"
            complete={
              data.processing
                .invoicesLoaded
            }
            detail={
              data.processing
                .invoicesLoaded
                ? "Invoices loaded"
                : "Invoices not loaded"
            }
          />
        </div>
      </section>

      {/* ======================================================
          KPIs
      ====================================================== */}

      <section className="ce-dashboard-kpi-grid">
        <KpiCard
          label="Metered Consumption"
          value={formatCompact(
            data.kpis
              .meteredConsumption,
          )}
          detail={`${data.selectedMonth} FY ${data.selectedFY}`}
          icon={Gauge}
          tone="purple"
        />

        <KpiCard
          label="Invoiced Consumption"
          value={formatCompact(
            data.kpis
              .invoicedConsumption,
          )}
          detail="Utility invoice consumption"
          icon={ReceiptText}
          tone="blue"
        />

        <KpiCard
          label="Estimated Consumption"
          value={formatCompact(
            data.kpis
              .estimatedConsumption,
          )}
          detail="RP intensity estimate"
          icon={Building2}
          tone="green"
        />

        <KpiCard
          label="Invoice Charges"
          value={formatCurrency(
            data.kpis
              .invoiceCharges,
          )}
          detail="Selected billing period"
          icon={CircleDollarSign}
          tone="default"
        />

        <KpiCard
          label="Validation Reviews"
          value={formatNumber(
            data.kpis
              .validationReviews,
          )}
          detail="Meter readings requiring attention"
          icon={ShieldAlert}
          tone="amber"
        />

        <KpiCard
          label="Zero-Streak Meters"
          value={formatNumber(
            data.kpis
              .zeroReadingMeters,
          )}
          detail="Meters currently reporting a zero streak"
          icon={AlertTriangle}
          tone="amber"
        />
      </section>

      {/* ======================================================
          FY RECONCILIATION CHART
      ====================================================== */}

      <section className="ce-dashboard-panel">
        <div className="ce-dashboard-panel-heading">
          <div>
            <p>
              Fiscal Year
            </p>

            <h2>
              FY {data.selectedFY} Consumption Reconciliation
            </h2>

            <span>
              Compare metered, invoiced, and Real Property estimated consumption by month.
            </span>
          </div>

          <div className="ce-dashboard-chart-legend">
            <span>
              <i className="ce-dashboard-legend-metered" />
              Metered
            </span>

            <span>
              <i className="ce-dashboard-legend-invoiced" />
              Invoiced
            </span>

            <span>
              <i className="ce-dashboard-legend-estimated" />
              Estimated
            </span>
          </div>
        </div>

        <div className="ce-dashboard-reconciliation-chart">
          {data.reconciliation.map(
            (item) => {
              const active =
                item.month ===
                data.selectedMonth;

              const meteredHeight =
                item.metered > 0
                  ? Math.max(
                      (item.metered /
                        maxReconciliation) *
                        100,
                      3,
                    )
                  : 0;

              const invoicedHeight =
                item.invoiced > 0
                  ? Math.max(
                      (item.invoiced /
                        maxReconciliation) *
                        100,
                      3,
                    )
                  : 0;

              const estimatedHeight =
                item.estimated > 0
                  ? Math.max(
                      (item.estimated /
                        maxReconciliation) *
                        100,
                      3,
                    )
                  : 0;

              return (
                <div
                  key={
                    item.month
                  }
                  className={`ce-dashboard-chart-month ${
                    active
                      ? "ce-dashboard-chart-month-active"
                      : ""
                  }`}
                  onClick={() =>
                    changeMonth(
                      item.month,
                    )
                  }
                  role="button"
                  tabIndex={0}
                >
                  <div className="ce-dashboard-chart-values">
                    {active ? (
                      <>
                        <span>
                          M{" "}
                          {formatCompact(
                            item.metered,
                          )}
                        </span>
                        <span>
                          I{" "}
                          {formatCompact(
                            item.invoiced,
                          )}
                        </span>
                        <span>
                          E{" "}
                          {formatCompact(
                            item.estimated,
                          )}
                        </span>
                      </>
                    ) : null}
                  </div>

                  <div className="ce-dashboard-chart-track">
                    <div
                      className="ce-dashboard-chart-bar ce-dashboard-chart-metered"
                      style={{
                        height: `${meteredHeight}%`,
                      }}
                      title={`Metered ${formatNumber(
                        item.metered,
                      )}`}
                    />

                    <div
                      className="ce-dashboard-chart-bar ce-dashboard-chart-invoiced"
                      style={{
                        height: `${invoicedHeight}%`,
                      }}
                      title={`Invoiced ${formatNumber(
                        item.invoiced,
                      )}`}
                    />

                    <div
                      className="ce-dashboard-chart-bar ce-dashboard-chart-estimated"
                      style={{
                        height: `${estimatedHeight}%`,
                      }}
                      title={`Estimated ${formatNumber(
                        item.estimated,
                      )}`}
                    />
                  </div>

                  <strong>
                    {item.short}
                  </strong>
                </div>
              );
            },
          )}
        </div>
      </section>

      {/* ======================================================
          UTILITY CARDS
      ====================================================== */}

      <section className="ce-dashboard-section">
        <div className="ce-dashboard-section-heading">
          <div>
            <p>
              Selected Period
            </p>

            <h2>
              Utility Reconciliation
            </h2>
          </div>
        </div>

        <div className="ce-dashboard-utility-grid">
          {data.utilities.map(
            (utility) => {
              const Icon =
                UTILITY_ICONS[
                  utility.utility
                ] ?? Gauge;

              return (
                <article
                  key={
                    utility.utility
                  }
                  className="ce-dashboard-utility-card"
                >
                  <div className="ce-dashboard-utility-heading">
                    <div className="ce-dashboard-utility-icon">
                      <Icon
                        size={22}
                      />
                    </div>

                    <div>
                      <span>
                        {
                          utility.utility
                        }
                      </span>

                      <h3>
                        {
                          utility.name
                        }
                      </h3>
                    </div>
                  </div>

                  <div className="ce-dashboard-utility-values">
                    <div>
                      <span>
                        Metered
                      </span>
                      <strong>
                        {formatCompact(
                          utility.metered,
                        )}
                      </strong>
                    </div>

                    <div>
                      <span>
                        Invoiced
                      </span>
                      <strong>
                        {formatCompact(
                          utility.invoiced,
                        )}
                      </strong>
                    </div>

                    <div>
                      <span>
                        Estimated
                      </span>
                      <strong>
                        {formatCompact(
                          utility.estimated,
                        )}
                      </strong>
                    </div>
                  </div>

                  <div className="ce-dashboard-utility-variances">
                    <div>
                      <span>
                        Meter vs Invoice
                      </span>
                      <VarianceValue
                        value={
                          utility
                            .meterInvoiceVariance
                        }
                      />
                    </div>

                    <div>
                      <span>
                        Invoice vs Estimate
                      </span>
                      <VarianceValue
                        value={
                          utility
                            .invoiceEstimateVariance
                        }
                      />
                    </div>

                    <div>
                      <span>
                        Meter vs Estimate
                      </span>
                      <VarianceValue
                        value={
                          utility
                            .meterEstimateVariance
                        }
                      />
                    </div>
                  </div>
                </article>
              );
            },
          )}
        </div>
      </section>

      {/* ======================================================
          ATTENTION + RP HEALTH
      ====================================================== */}

      <div className="ce-dashboard-two-column">
        <section className="ce-dashboard-panel">
          <div className="ce-dashboard-panel-heading">
            <div>
              <p>
                Work Queue
              </p>

              <h2>
                Requires Attention
              </h2>

              <span>
                {attentionTotal ===
                0
                  ? "No current dashboard exceptions."
                  : `${formatNumber(
                      attentionTotal,
                    )} current exception indicators.`}
              </span>
            </div>

            <AlertTriangle
              size={25}
            />
          </div>

          <div className="ce-dashboard-attention-list">
            <a href="/data-validation">
              <div>
                <ShieldAlert
                  size={19}
                />
                <span>
                  Validation reviews
                </span>
              </div>

              <strong>
                {formatNumber(
                  data.attention
                    .validationReviews,
                )}
              </strong>
            </a>

            <a href="/backgrounddata">
              <div>
                <Gauge
                  size={19}
                />
                <span>
                  Zero-streak meters
                </span>
              </div>

              <strong>
                {formatNumber(
                  data.attention
                    .zeroReadingMeters,
                )}
              </strong>
            </a>

            <a href="/monthly-data">
              <div>
                <Building2
                  size={19}
                />
                <span>
                  Missing CAT mappings
                </span>
              </div>

              <strong>
                {formatNumber(
                  data.attention
                    .missingCategoryMappings,
                )}
              </strong>
            </a>

            <a href="/monthly-data">
              <div>
                <Database
                  size={19}
                />
                <span>
                  Missing estimates / intensity mappings
                </span>
              </div>

              <strong>
                {formatNumber(
                  data.attention
                    .missingIntensityMappings,
                )}
              </strong>
            </a>
          </div>
        </section>

        <section className="ce-dashboard-panel">
          <div className="ce-dashboard-panel-heading">
            <div>
              <p>
                Real Property
              </p>

              <h2>
                Estimate Health
              </h2>

              <span>
                Mapping and intensity coverage for the selected period.
              </span>
            </div>

            <Building2
              size={25}
            />
          </div>

          <div className="ce-dashboard-rp-summary">
            <div>
              <span>
                RP Records
              </span>

              <strong>
                {formatNumber(
                  data.realProperty
                    .records,
                )}
              </strong>
            </div>

            <div>
              <span>
                Estimates
              </span>

              <strong>
                {formatNumber(
                  data.realProperty
                    .estimates,
                )}
              </strong>
            </div>

            <div>
              <span>
                Current FY Intensities
              </span>

              <strong>
                {formatNumber(
                  data.realProperty
                    .currentFYIntensities,
                )}
              </strong>
            </div>

            <div>
              <span>
                Prior FY Fallbacks
              </span>

              <strong>
                {formatNumber(
                  data.realProperty
                    .priorFYIntensityFallbacks,
                )}
              </strong>
            </div>
          </div>

          <div className="ce-dashboard-rp-bars">
            <div>
              <div>
                <span>
                  Customer Mapping
                </span>
                <strong>
                  {rpCustomerPercent.toFixed(
                    1,
                  )}
                  %
                </strong>
              </div>

              <div className="ce-dashboard-progress">
                <i
                  style={{
                    width: `${rpCustomerPercent}%`,
                  }}
                />
              </div>
            </div>

            <div>
              <div>
                <span>
                  Facility Mapping
                </span>
                <strong>
                  {rpFacilityPercent.toFixed(
                    1,
                  )}
                  %
                </strong>
              </div>

              <div className="ce-dashboard-progress">
                <i
                  style={{
                    width: `${rpFacilityPercent}%`,
                  }}
                />
              </div>
            </div>

            <div>
              <div>
                <span>
                  Category Mapping
                </span>
                <strong>
                  {rpCategoryPercent.toFixed(
                    1,
                  )}
                  %
                </strong>
              </div>

              <div className="ce-dashboard-progress">
                <i
                  style={{
                    width: `${rpCategoryPercent}%`,
                  }}
                />
              </div>
            </div>
          </div>
        </section>
      </div>

      {/* ======================================================
          BILLING RECONCILIATION TABLE
      ====================================================== */}

      <section className="ce-dashboard-panel">
        <div className="ce-dashboard-panel-heading">
          <div>
            <p>
              Billing Analysis
            </p>

            <h2>
              Utility Reconciliation Detail
            </h2>

            <span>
              Selected-period comparison of meter, invoice, estimate, and invoice charges.
            </span>
          </div>

          <BarChart3
            size={25}
          />
        </div>

        <div className="ce-dashboard-table-wrap">
          <table className="ce-dashboard-table">
            <thead>
              <tr>
                <th>
                  Utility
                </th>
                <th>
                  Metered
                </th>
                <th>
                  Invoiced
                </th>
                <th>
                  Estimated
                </th>
                <th>
                  Invoice Charges
                </th>
                <th>
                  Meter ↔ Invoice
                </th>
                <th>
                  Invoice ↔ Estimate
                </th>
                <th>
                  Meter ↔ Estimate
                </th>
              </tr>
            </thead>

            <tbody>
              {data.utilities.map(
                (utility) => (
                  <tr
                    key={
                      utility.utility
                    }
                  >
                    <td>
                      <strong>
                        {
                          utility.name
                        }
                      </strong>

                      <span>
                        {
                          utility.utility
                        }
                      </span>
                    </td>

                    <td>
                      {formatNumber(
                        utility.metered,
                      )}
                    </td>

                    <td>
                      {formatNumber(
                        utility.invoiced,
                      )}
                    </td>

                    <td>
                      {formatNumber(
                        utility.estimated,
                      )}
                    </td>

                    <td>
                      {formatCurrency(
                        utility.invoiceCharges,
                      )}
                    </td>

                    <td>
                      <VarianceValue
                        value={
                          utility
                            .meterInvoiceVariance
                        }
                      />
                    </td>

                    <td>
                      <VarianceValue
                        value={
                          utility
                            .invoiceEstimateVariance
                        }
                      />
                    </td>

                    <td>
                      <VarianceValue
                        value={
                          utility
                            .meterEstimateVariance
                        }
                      />
                    </td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
