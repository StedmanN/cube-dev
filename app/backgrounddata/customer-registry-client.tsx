"use client";

import {
  type ChangeEvent,
  type KeyboardEvent,
  useMemo,
  useState,
} from "react";

import { useRouter } from "next/navigation";

import {
  ChevronDown,
  ChevronUp,
  CircleCheck,
  CircleX,
  Pencil,
  Plus,
  RotateCcw,
  Save,
  Search,
  X,
} from "lucide-react";

// ============================================================
// CUSTOMER RECORD
// ============================================================

export type CustomerRecord = {
  CustomerID: string;
  CustomerName: string;
  NextGenNames: string[];
  UMMName: string;
  CustomerType: string;
  ReportType: string;
  RateClass: string;
  RCBLComment: string;
  Active: boolean;
  CreatedDate: string;
  InactiveDate: string;
};

type Props = {
  customers: CustomerRecord[];
};

type CustomerStringField =
  | "CustomerID"
  | "CustomerName"
  | "UMMName"
  | "CustomerType"
  | "ReportType"
  | "RateClass"
  | "RCBLComment"
  | "CreatedDate"
  | "InactiveDate";

type StatusFilter =
  | "active"
  | "inactive"
  | "all";

type SortKey =
  | "CustomerID"
  | "CustomerName"
  | "UMMName"
  | "CustomerType"
  | "ReportType"
  | "RateClass"
  | "CreatedDate"
  | "InactiveDate"
  | "Active";

type SortDirection =
  | "asc"
  | "desc";

// ============================================================
// EMPTY CUSTOMER
// ============================================================

const EMPTY_CUSTOMER: CustomerRecord = {
  CustomerID: "",
  CustomerName: "",
  NextGenNames: [],
  UMMName: "",
  CustomerType: "",
  ReportType: "",
  RateClass: "",
  RCBLComment: "",
  Active: true,
  CreatedDate: "",
  InactiveDate: "",
};

// ============================================================
// TEXT FIELD
// ============================================================

function CustomerField({
  label,
  name,
  value,
  disabled = false,
  placeholder,
  type = "text",
  onChange,
}: {
  label: string;
  name: CustomerStringField;
  value: string;
  disabled?: boolean;
  placeholder?: string;
  type?: string;
  onChange: (
    event: ChangeEvent<HTMLInputElement>,
  ) => void;
}) {
  return (
    <label className="bd-form-field">
      <span>{label}</span>

      <input
        name={name}
        type={type}
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        onChange={onChange}
      />
    </label>
  );
}

// ============================================================
// SELECT FIELD
// ============================================================

function SelectField({
  label,
  name,
  value,
  options,
  onChange,
}: {
  label: string;
  name: CustomerStringField;
  value: string;
  options: {
    value: string;
    label: string;
  }[];
  onChange: (
    event: ChangeEvent<HTMLSelectElement>,
  ) => void;
}) {
  return (
    <label className="bd-form-field">
      <span>{label}</span>

      <select
        name={name}
        value={value}
        onChange={onChange}
      >
        <option value="">
          Select...
        </option>

        {options.map((option) => (
          <option
            key={option.value}
            value={option.value}
          >
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

// ============================================================
// DISPLAY
// ============================================================

function display(
  value: string | null | undefined,
) {
  if (!value) {
    return "—";
  }

  return value.trim() || "—";
}

// ============================================================
// DATE DISPLAY
// ============================================================

function displayDate(
  value: string,
) {
  if (!value) {
    return "—";
  }

  const parts =
    value.split("-");

  if (parts.length === 3) {
    return `${parts[1]}/${parts[2]}/${parts[0]}`;
  }

  return value;
}

// ============================================================
// CLIENT
// ============================================================

export function CustomerRegistryClient({
  customers,
}: Props) {
  const router =
    useRouter();

  const [
    search,
    setSearch,
  ] = useState("");

  const [
    statusFilter,
    setStatusFilter,
  ] =
    useState<StatusFilter>(
      "active",
    );

  const [
    selectedCustomer,
    setSelectedCustomer,
  ] =
    useState<CustomerRecord | null>(
      null,
    );

  const [
    form,
    setForm,
  ] =
    useState<CustomerRecord>(
      EMPTY_CUSTOMER,
    );

  const [
    mode,
    setMode,
  ] = useState<
    "create" | "edit"
  >("edit");

  const [
    saving,
    setSaving,
  ] = useState(false);

  const [
    statusSaving,
    setStatusSaving,
  ] = useState(false);

  const [
    error,
    setError,
  ] =
    useState<string | null>(
      null,
    );

  const [
    newNextGenName,
    setNewNextGenName,
  ] = useState("");

  const [
    sortKey,
    setSortKey,
  ] =
    useState<SortKey>(
      "CustomerName",
    );

  const [
    sortDirection,
    setSortDirection,
  ] =
    useState<SortDirection>(
      "asc",
    );

  // ==========================================================
  // COUNTS
  // ==========================================================

  const activeCount =
    useMemo(
      () =>
        customers.filter(
          (customer) =>
            customer.Active,
        ).length,
      [customers],
    );

  const inactiveCount =
    customers.length -
    activeCount;

  // ==========================================================
  // FILTER + SEARCH + SORT
  // ==========================================================

  const filteredCustomers =
    useMemo(() => {
      const searchValue =
        search
          .trim()
          .toLowerCase();

      const result =
        customers.filter(
          (customer) => {
            if (
              statusFilter ===
                "active" &&
              !customer.Active
            ) {
              return false;
            }

            if (
              statusFilter ===
                "inactive" &&
              customer.Active
            ) {
              return false;
            }

            if (!searchValue) {
              return true;
            }

            const searchableValues = [
              customer.CustomerID,
              customer.CustomerName,
              customer.UMMName,
              customer.CustomerType,
              customer.ReportType,
              customer.RateClass,
              customer.RCBLComment,
              customer.CreatedDate,
              customer.InactiveDate,
              ...customer.NextGenNames,
            ];

            return searchableValues.some(
              (value) =>
                value
                  .toLowerCase()
                  .includes(
                    searchValue,
                  ),
            );
          },
        );

      return [...result].sort(
        (a, b) => {
          let aValue:
            string | boolean;

          let bValue:
            string | boolean;

          if (
            sortKey === "Active"
          ) {
            aValue = a.Active;
            bValue = b.Active;
          } else {
            aValue =
              a[sortKey];

            bValue =
              b[sortKey];
          }

          let comparison = 0;

          if (
            typeof aValue ===
              "boolean" &&
            typeof bValue ===
              "boolean"
          ) {
            comparison =
              Number(aValue) -
              Number(bValue);
          } else {
            comparison =
              String(aValue)
                .localeCompare(
                  String(bValue),
                  undefined,
                  {
                    numeric: true,
                    sensitivity:
                      "base",
                  },
                );
          }

          return sortDirection ===
            "asc"
            ? comparison
            : -comparison;
        },
      );
    }, [
      customers,
      search,
      statusFilter,
      sortKey,
      sortDirection,
    ]);

  // ==========================================================
  // SORT
  // ==========================================================

  function handleSort(
    key: SortKey,
  ) {
    if (sortKey === key) {
      setSortDirection(
        (current) =>
          current === "asc"
            ? "desc"
            : "asc",
      );

      return;
    }

    setSortKey(key);
    setSortDirection("asc");
  }

  // ==========================================================
  // OPEN EXISTING CUSTOMER
  // ==========================================================

  function openCustomer(
    customer: CustomerRecord,
  ) {
    setMode("edit");

    setSelectedCustomer(
      customer,
    );

    setForm({
      ...customer,

      NextGenNames: [
        ...customer.NextGenNames,
      ],
    });

    setNewNextGenName("");
    setError(null);
  }

  // ==========================================================
  // OPEN NEW CUSTOMER
  // ==========================================================

  function openNewCustomer() {
    setMode("create");

    const customer = {
      ...EMPTY_CUSTOMER,

      NextGenNames: [],

      Active: true,
    };

    setSelectedCustomer(
      customer,
    );

    setForm(customer);

    setNewNextGenName("");
    setError(null);
  }

  // ==========================================================
  // CLOSE
  // ==========================================================

  function closeDialog() {
    if (
      saving ||
      statusSaving
    ) {
      return;
    }

    setSelectedCustomer(
      null,
    );

    setForm({
      ...EMPTY_CUSTOMER,
      NextGenNames: [],
    });

    setNewNextGenName("");
    setError(null);
  }

  // ==========================================================
  // CHANGE
  // ==========================================================

  function handleChange(
    event:
      | ChangeEvent<HTMLInputElement>
      | ChangeEvent<HTMLTextAreaElement>
      | ChangeEvent<HTMLSelectElement>,
  ) {
    const {
      name,
      value,
    } = event.target;

    setForm(
      (current) => ({
        ...current,

        [name]:
          value,
      }),
    );
  }

  // ==========================================================
  // NEXTGEN ALIASES
  // ==========================================================

  function addNextGenName() {
    const value =
      newNextGenName.trim();

    if (!value) {
      return;
    }

    const alreadyExists =
      form.NextGenNames.some(
        (name) =>
          name.toLowerCase() ===
          value.toLowerCase(),
      );

    if (alreadyExists) {
      setNewNextGenName("");
      return;
    }

    setForm(
      (current) => ({
        ...current,

        NextGenNames: [
          ...current.NextGenNames,
          value,
        ],
      }),
    );

    setNewNextGenName("");
  }

  function removeNextGenName(
    value: string,
  ) {
    setForm(
      (current) => ({
        ...current,

        NextGenNames:
          current.NextGenNames.filter(
            (name) =>
              name !== value,
          ),
      }),
    );
  }

  function handleNextGenKeyDown(
    event:
      KeyboardEvent<HTMLInputElement>,
  ) {
    if (event.key === "Enter") {
      event.preventDefault();
      addNextGenName();
    }
  }

  // ==========================================================
  // ROW KEYBOARD ACCESS
  // ==========================================================

  function handleRowKeyDown(
    event:
      KeyboardEvent<HTMLTableRowElement>,

    customer:
      CustomerRecord,
  ) {
    if (
      event.key === "Enter" ||
      event.key === " "
    ) {
      event.preventDefault();

      openCustomer(
        customer,
      );
    }
  }

  // ==========================================================
  // SAVE CUSTOMER
  // ==========================================================

  async function saveCustomer() {
    setError(null);

    if (
      mode === "edit" &&
      !form.CustomerID.trim()
    ) {
      setError(
        "Customer ID is required.",
      );

      return;
    }

    if (
      !form.CustomerName.trim()
    ) {
      setError(
        "CUBE Customer Name is required.",
      );

      return;
    }

    setSaving(true);

    try {
      const response =
        await fetch(
          "/api/customers",
          {
            method:
              mode ===
              "create"
                ? "POST"
                : "PUT",

            headers: {
              "Content-Type":
                "application/json",
            },

            body:
              JSON.stringify(
                form,
              ),
          },
        );

      const result =
        await response.json();

      if (!response.ok) {
        throw new Error(
          result.error ||
            "Unable to save customer.",
        );
      }

      // ======================================================
      // NEW CUSTOMER
      //
      // POST returns the permanent CustomerID and CreatedDate.
      // Keep the modal open and immediately show the values
      // assigned by CUBE.
      // ======================================================

      if (
        mode === "create" &&
        result.customer
      ) {
        const createdCustomer =
          result.customer as CustomerRecord;

        setForm({
          ...createdCustomer,

          NextGenNames: [
            ...(createdCustomer.NextGenNames ??
              []),
          ],
        });

        setSelectedCustomer({
          ...createdCustomer,

          NextGenNames: [
            ...(createdCustomer.NextGenNames ??
              []),
          ],
        });

        setMode("edit");

        router.refresh();

        return;
      }

      // Existing customer update.
      closeDialog();

      router.refresh();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Unable to save customer.",
      );
    } finally {
      setSaving(false);
    }
  }

  // ==========================================================
  // ACTIVATE / DEACTIVATE
  // ==========================================================

  async function toggleCustomerStatus() {
    if (
      !form.CustomerID
    ) {
      return;
    }

    const newStatus =
      !form.Active;

    const action =
      newStatus
        ? "activate"
        : "deactivate";

    const confirmed =
      window.confirm(
        `Are you sure you want to ${action} ${form.CustomerName}?`,
      );

    if (!confirmed) {
      return;
    }

    setStatusSaving(true);
    setError(null);

    try {
      const response =
        await fetch(
          "/api/customers",
          {
            method: "PATCH",

            headers: {
              "Content-Type":
                "application/json",
            },

            body:
              JSON.stringify({
                CustomerID:
                  form.CustomerID,

                Active:
                  newStatus,
              }),
          },
        );

      const result =
        await response.json();

      if (!response.ok) {
        throw new Error(
          result.error ||
            "Unable to update customer status.",
        );
      }

      closeDialog();

      router.refresh();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Unable to update customer status.",
      );
    } finally {
      setStatusSaving(false);
    }
  }

  // ==========================================================
  // JSX
  // ==========================================================

  return (
    <>
      {/* ====================================================
          ACTIONS
          ==================================================== */}

      <div className="bd-actions bd-meter-actions">
        <label className="bd-search">
          <Search size={18} />

          <span className="bd-sr-only">
            Search customers
          </span>

          <input
            type="search"
            placeholder="Search CUBE, UMM or NextGen customers"
            value={search}
            onChange={(event) =>
              setSearch(
                event.target.value,
              )
            }
          />
        </label>

        <label className="bd-form-field bd-customer-status-filter">
          <span className="bd-sr-only">
            Customer status
          </span>

          <select
            value={statusFilter}
            onChange={(event) =>
              setStatusFilter(
                event.target
                  .value as StatusFilter,
              )
            }
          >
            <option value="active">
              Active Customers
            </option>

            <option value="inactive">
              Inactive Customers
            </option>

            <option value="all">
              All Customers
            </option>
          </select>
        </label>

        <button
          type="button"
          className="bd-add-button"
          onClick={
            openNewCustomer
          }
        >
          <Plus size={18} />

          Add New Customer
        </button>
      </div>

      {/* ====================================================
          SUMMARY
          ==================================================== */}

      <div className="bd-customer-summary">
        <div className="bd-customer-summary-item">
          <span>
            Total Customers
          </span>

          <strong>
            {customers.length}
          </strong>
        </div>

        <div className="bd-customer-summary-item">
          <span>
            Active
          </span>

          <strong>
            {activeCount}
          </strong>
        </div>

        <div className="bd-customer-summary-item">
          <span>
            Inactive
          </span>

          <strong>
            {inactiveCount}
          </strong>
        </div>
      </div>

      {/* ====================================================
          TABLE
          ==================================================== */}

      <div className="bd-table-panel">
        <div className="bd-table-heading">
          <div>
            <h2>
              Customer Registry
            </h2>

            <p>
              CUBE customer master
              and source-system
              mappings
            </p>
          </div>

          <span>
            {
              filteredCustomers.length
            }{" "}
            shown
          </span>
        </div>

        <div className="bd-table-scroll">
          <table className="bd-table">
            <thead>
              <tr>
                <SortHeading
                  column="CustomerID"
                  activeColumn={
                    sortKey
                  }
                  direction={
                    sortDirection
                  }
                  onSort={
                    handleSort
                  }
                >
                  Customer ID
                </SortHeading>

                <SortHeading
                  column="CustomerName"
                  activeColumn={
                    sortKey
                  }
                  direction={
                    sortDirection
                  }
                  onSort={
                    handleSort
                  }
                >
                  CUBE Customer
                </SortHeading>

                <th scope="col">
                  NextGen Name(s)
                </th>

                <SortHeading
                  column="UMMName"
                  activeColumn={
                    sortKey
                  }
                  direction={
                    sortDirection
                  }
                  onSort={
                    handleSort
                  }
                >
                  UMM Name
                </SortHeading>

                <SortHeading
                  column="CustomerType"
                  activeColumn={
                    sortKey
                  }
                  direction={
                    sortDirection
                  }
                  onSort={
                    handleSort
                  }
                >
                  Customer Type
                </SortHeading>

                <SortHeading
                  column="ReportType"
                  activeColumn={
                    sortKey
                  }
                  direction={
                    sortDirection
                  }
                  onSort={
                    handleSort
                  }
                >
                  Report Type
                </SortHeading>

                <SortHeading
                  column="RateClass"
                  activeColumn={
                    sortKey
                  }
                  direction={
                    sortDirection
                  }
                  onSort={
                    handleSort
                  }
                >
                  Rate Class
                </SortHeading>

                <SortHeading
                  column="CreatedDate"
                  activeColumn={
                    sortKey
                  }
                  direction={
                    sortDirection
                  }
                  onSort={
                    handleSort
                  }
                >
                  Created Date
                </SortHeading>

                <SortHeading
                  column="Active"
                  activeColumn={
                    sortKey
                  }
                  direction={
                    sortDirection
                  }
                  onSort={
                    handleSort
                  }
                >
                  Status
                </SortHeading>
              </tr>
            </thead>

            <tbody>
              {filteredCustomers.map(
                (customer) => (
                  <tr
                    key={
                      customer.CustomerID
                    }
                    className="bd-clickable-row"
                    tabIndex={0}
                    role="button"
                    aria-label={`Open customer ${customer.CustomerID}`}
                    onClick={() =>
                      openCustomer(
                        customer,
                      )
                    }
                    onKeyDown={(
                      event,
                    ) =>
                      handleRowKeyDown(
                        event,
                        customer,
                      )
                    }
                  >
                    <td className="bd-id-cell">
                      <span className="bd-meter-id-link">
                        {display(
                          customer.CustomerID,
                        )}
                      </span>
                    </td>

                    <td className="bd-long-cell">
                      <strong>
                        {display(
                          customer.CustomerName,
                        )}
                      </strong>
                    </td>

                    <td className="bd-long-cell">
                      {customer
                        .NextGenNames
                        .length > 0 ? (
                        <div className="bd-nextgen-table-list">
                          {customer.NextGenNames.map(
                            (
                              name,
                            ) => (
                              <div
                                key={
                                  name
                                }
                              >
                                {name}
                              </div>
                            ),
                          )}
                        </div>
                      ) : (
                        "—"
                      )}
                    </td>

                    <td>
                      {display(
                        customer.UMMName,
                      )}
                    </td>

                    <td>
                      {display(
                        customer.CustomerType,
                      )}
                    </td>

                    <td>
                      {display(
                        customer.ReportType,
                      )}
                    </td>

                    <td>
                      {display(
                        customer.RateClass,
                      )}
                    </td>

                    <td>
                      {displayDate(
                        customer.CreatedDate,
                      )}
                    </td>

                    <td>
                      <StatusBadge
                        active={
                          customer.Active
                        }
                      />
                    </td>
                  </tr>
                ),
              )}

              {filteredCustomers.length ===
                0 && (
                <tr>
                  <td
                    colSpan={9}
                    className="bd-empty-row"
                  >
                    No customers
                    match the selected
                    filters.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* ====================================================
          MODAL
          ==================================================== */}

      {selectedCustomer && (
        <div
          className="bd-modal-backdrop"
          onMouseDown={(
            event,
          ) => {
            if (
              event.target ===
              event.currentTarget
            ) {
              closeDialog();
            }
          }}
        >
          <section
            className="bd-meter-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="customer-dialog-title"
          >
            {/* ==============================================
                HEADER
                ============================================== */}

            <div className="bd-modal-header">
              <div>
                <div className="bd-modal-icon">
                  {mode ===
                  "create" ? (
                    <Plus
                      size={22}
                    />
                  ) : (
                    <Pencil
                      size={22}
                    />
                  )}
                </div>

                <div>
                  <p className="bd-modal-eyebrow">
                    {mode ===
                    "create"
                      ? "New customer"
                      : "Customer master record"}
                  </p>

                  <h2 id="customer-dialog-title">
                    {mode ===
                    "create"
                      ? "Add New Customer"
                      : form.CustomerName ||
                        form.CustomerID}
                  </h2>

                  {mode ===
                    "edit" && (
                    <div className="bd-modal-status">
                      <StatusBadge
                        active={
                          form.Active
                        }
                      />
                    </div>
                  )}
                </div>
              </div>

              <button
                type="button"
                className="bd-modal-close"
                onClick={
                  closeDialog
                }
                aria-label="Close"
              >
                <X size={21} />
              </button>
            </div>

            {/* ==============================================
                BODY
                ============================================== */}

            <div className="bd-modal-body">
              {error && (
                <div
                  className="bd-form-error"
                  role="alert"
                >
                  {error}
                </div>
              )}

              {/* ============================================
                  IDENTIFICATION
                  ============================================ */}

              <FormSection
                title="Customer Identification"
                description="Permanent CUBE customer identity and source-system names."
              >
                <CustomerField
                  label="Customer ID"
                  name="CustomerID"
                  value={
                    form.CustomerID
                  }
                  disabled
                  placeholder={
                    mode === "create"
                      ? "CUST-###### assigned when saved"
                      : ""
                  }
                  onChange={
                    handleChange
                  }
                />

                <CustomerField
                  label="CUBE Customer Name"
                  name="CustomerName"
                  value={
                    form.CustomerName
                  }
                  placeholder="552 ACW"
                  onChange={
                    handleChange
                  }
                />

                <CustomerField
                  label="UMM Name"
                  name="UMMName"
                  value={
                    form.UMMName
                  }
                  placeholder="552 ACW"
                  onChange={
                    handleChange
                  }
                />

                <div className="bd-form-field">
                  <span>Status</span>

                  <div className="bd-readonly-status">
                    <StatusBadge
                      active={
                        form.Active
                      }
                    />
                  </div>
                </div>
              </FormSection>

              {/* ============================================
                  NEXTGEN MAPPINGS
                  ============================================ */}

              <div className="bd-form-section">
                <div className="bd-form-section-heading">
                  <h3>
                    NextGen Customer Names
                  </h3>

                  <p>
                    Source-system customer
                    names that map to this
                    CUBE customer.
                  </p>
                </div>

                <div className="bd-nextgen-editor">
                  {form.NextGenNames
                    .length > 0 && (
                    <div className="bd-nextgen-list">
                      {form.NextGenNames.map(
                        (
                          name,
                        ) => (
                          <div
                            className="bd-nextgen-item"
                            key={
                              name
                            }
                          >
                            <span>
                              {name}
                            </span>

                            <button
                              type="button"
                              onClick={() =>
                                removeNextGenName(
                                  name,
                                )
                              }
                              aria-label={`Remove ${name}`}
                            >
                              <X
                                size={
                                  16
                                }
                              />
                            </button>
                          </div>
                        ),
                      )}
                    </div>
                  )}

                  <div className="bd-nextgen-add">
                    <input
                      type="text"
                      value={
                        newNextGenName
                      }
                      placeholder="Enter NextGen customer name"
                      onChange={(
                        event,
                      ) =>
                        setNewNextGenName(
                          event
                            .target
                            .value,
                        )
                      }
                      onKeyDown={
                        handleNextGenKeyDown
                      }
                    />

                    <button
                      type="button"
                      className="bd-add-button"
                      onClick={
                        addNextGenName
                      }
                    >
                      <Plus
                        size={17}
                      />

                      Add Name
                    </button>
                  </div>
                </div>
              </div>

              {/* ============================================
                  CLASSIFICATION
                  ============================================ */}

              <FormSection
                title="Classification"
                description="Customer billing, reporting, and rate classification."
              >
                <SelectField
                  label="Customer Type"
                  name="CustomerType"
                  value={
                    form.CustomerType
                  }
                  options={[
                    {
                      value:
                        "Reimbursable",
                      label:
                        "Reimbursable",
                    },
                    {
                      value:
                        "Non-Reimbursable",
                      label:
                        "Non-Reimbursable",
                    },
                  ]}
                  onChange={
                    handleChange
                  }
                />

                <SelectField
                  label="Report Type"
                  name="ReportType"
                  value={
                    form.ReportType
                  }
                  options={[
                    {
                      value:
                        "Reportable",
                      label:
                        "Reportable",
                    },
                    {
                      value:
                        "Non-Reportable",
                      label:
                        "Non-Reportable",
                    },
                  ]}
                  onChange={
                    handleChange
                  }
                />

                <SelectField
                  label="Rate Class"
                  name="RateClass"
                  value={
                    form.RateClass
                  }
                  options={[
                    {
                      value:
                        "DOD Fed",
                      label:
                        "DOD Fed",
                    },
                    {
                      value:
                        "DOD Fed (DBOF)",
                      label:
                        "DOD Fed (DBOF)",
                    },
                    {
                      value:
                        "DOD Fed (MFH)",
                      label:
                        "DOD Fed (MFH)",
                    },
                    {
                      value:
                        "Installation",
                      label:
                        "Installation",
                    },
                    {
                      value:
                        "Non DOD Fed",
                      label:
                        "Non DOD Fed",
                    },
                    {
                      value:
                        "Non Fed",
                      label:
                        "Non Fed",
                    },
                    {
                      value:
                        "Services",
                      label:
                        "Services",
                    },
                  ]}
                  onChange={
                    handleChange
                  }
                />
              </FormSection>

              {/* ============================================
                  LIFECYCLE
                  ============================================ */}

              <FormSection
                title="Customer Lifecycle"
                description="Lifecycle values are maintained automatically by CUBE."
              >
                <CustomerField
                  label="Created Date"
                  name="CreatedDate"
                  value={
                    mode === "edit"
                      ? displayDate(
                          form.CreatedDate,
                        )
                      : form.CreatedDate
                  }
                  disabled
                  placeholder={
                    mode === "create"
                      ? "Assigned when saved"
                      : ""
                  }
                  onChange={
                    handleChange
                  }
                />

                <CustomerField
                  label="Inactive Date"
                  name="InactiveDate"
                  value={
                    mode === "edit"
                      ? form.InactiveDate
                        ? displayDate(
                            form.InactiveDate,
                          )
                        : ""
                      : form.InactiveDate
                  }
                  disabled
                  placeholder={
                    form.Active
                      ? "Active customer"
                      : ""
                  }
                  onChange={
                    handleChange
                  }
                />
              </FormSection>

              {/* ============================================
                  NOTES
                  ============================================ */}

              <div className="bd-form-section">
                <div className="bd-form-section-heading">
                  <h3>
                    Billing Notes
                  </h3>

                  <p>
                    Customer billing and
                    reimbursable billing
                    information.
                  </p>
                </div>

                <div className="bd-form-textareas">
                  <label className="bd-form-field">
                    <span>
                      RCBL Comment
                    </span>

                    <textarea
                      name="RCBLComment"
                      value={
                        form.RCBLComment
                      }
                      rows={5}
                      onChange={
                        handleChange
                      }
                    />
                  </label>
                </div>
              </div>
            </div>

            {/* ==============================================
                FOOTER
                ============================================== */}

            <div className="bd-modal-footer">
              <div>
                {mode ===
                  "edit" && (
                  <button
                    type="button"
                    className={
                      form.Active
                        ? "bd-deactivate-button"
                        : "bd-activate-button"
                    }
                    disabled={
                      saving ||
                      statusSaving
                    }
                    onClick={
                      toggleCustomerStatus
                    }
                  >
                    {form.Active ? (
                      <>
                        <CircleX
                          size={17}
                        />

                        {statusSaving
                          ? "Deactivating..."
                          : "Deactivate Customer"}
                      </>
                    ) : (
                      <>
                        <RotateCcw
                          size={17}
                        />

                        {statusSaving
                          ? "Activating..."
                          : "Activate Customer"}
                      </>
                    )}
                  </button>
                )}
              </div>

              <div className="bd-modal-footer-actions">
                <button
                  type="button"
                  className="bd-cancel-button"
                  disabled={
                    saving ||
                    statusSaving
                  }
                  onClick={
                    closeDialog
                  }
                >
                  {mode === "create"
                    ? "Cancel"
                    : "Close"}
                </button>

                <button
                  type="button"
                  className="bd-save-button"
                  disabled={
                    saving ||
                    statusSaving
                  }
                  onClick={
                    saveCustomer
                  }
                >
                  <Save size={17} />

                  {saving
                    ? "Saving..."
                    : mode ===
                        "create"
                      ? "Add Customer"
                      : "Save Changes"}
                </button>
              </div>
            </div>
          </section>
        </div>
      )}
    </>
  );
}

// ============================================================
// STATUS BADGE
// ============================================================

function StatusBadge({
  active,
}: {
  active: boolean;
}) {
  return (
    <span
      className={
        active
          ? "bd-status-badge bd-status-active"
          : "bd-status-badge bd-status-inactive"
      }
    >
      {active ? (
        <CircleCheck
          size={14}
        />
      ) : (
        <CircleX
          size={14}
        />
      )}

      {active
        ? "Active"
        : "Inactive"}
    </span>
  );
}

// ============================================================
// SORT HEADING
// ============================================================

function SortHeading({
  children,
  column,
  activeColumn,
  direction,
  onSort,
}: {
  children:
    React.ReactNode;

  column:
    SortKey;

  activeColumn:
    SortKey;

  direction:
    SortDirection;

  onSort:
    (
      column: SortKey,
    ) => void;
}) {
  const active =
    activeColumn === column;

  return (
    <th scope="col">
      <button
        type="button"
        className="bd-sort-button"
        onClick={() =>
          onSort(column)
        }
      >
        {children}

        {active &&
        direction ===
          "desc" ? (
          <ChevronUp
            size={14}
          />
        ) : (
          <ChevronDown
            size={14}
          />
        )}
      </button>
    </th>
  );
}

// ============================================================
// FORM SECTION
// ============================================================

function FormSection({
  title,
  description,
  children,
}: {
  title: string;

  description: string;

  children:
    React.ReactNode;
}) {
  return (
    <div className="bd-form-section">
      <div className="bd-form-section-heading">
        <h3>
          {title}
        </h3>

        <p>
          {description}
        </p>
      </div>

      <div className="bd-form-grid">
        {children}
      </div>
    </div>
  );
}