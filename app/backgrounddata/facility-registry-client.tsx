"use client";

import {
  type ChangeEvent,
  type KeyboardEvent,
  useMemo,
  useState,
} from "react";

import { useRouter } from "next/navigation";

import {
  Building2,
  ChevronDown,
  ChevronUp,
  CircleCheck,
  CircleX,
  Plus,
  RotateCcw,
  Save,
  Search,
  X,
} from "lucide-react";

// ============================================================
// FACILITY RECORD
// ============================================================

export type FacilityRecord = {
  FacilityID: string;

  SUB_INST_CD: string;
  SITE_CD: string;

  FacilityNumber: string;
  FacilityType: string;
  FacilityName: string;

  AreaQty: string;
  AreaUM: string;

  OtherQty: string;
  OtherUM: string;

  Active: boolean;

  CreatedDate: string;
  InactiveDate: string;
};

// ============================================================
// PROPS
// ============================================================

type Props = {
  facilities: FacilityRecord[];
};

// ============================================================
// FIELD TYPES
// ============================================================

type FacilityStringField =
  | "FacilityID"
  | "SUB_INST_CD"
  | "SITE_CD"
  | "FacilityNumber"
  | "FacilityType"
  | "FacilityName"
  | "AreaQty"
  | "AreaUM"
  | "OtherQty"
  | "OtherUM"
  | "CreatedDate"
  | "InactiveDate";

type StatusFilter =
  | "active"
  | "inactive"
  | "all";

type SortKey =
  | "FacilityID"
  | "SUB_INST_CD"
  | "SITE_CD"
  | "FacilityNumber"
  | "FacilityType"
  | "FacilityName"
  | "AreaQty"
  | "Active";

type SortDirection =
  | "asc"
  | "desc";

// ============================================================
// EMPTY FACILITY
// ============================================================

const EMPTY_FACILITY: FacilityRecord = {
  FacilityID: "",

  SUB_INST_CD: "",
  SITE_CD: "",

  FacilityNumber: "",
  FacilityType: "",
  FacilityName: "",

  AreaQty: "",
  AreaUM: "",

  OtherQty: "",
  OtherUM: "",

  Active: true,

  CreatedDate: "",
  InactiveDate: "",
};

// ============================================================
// TEXT FIELD
// ============================================================

function FacilityField({
  label,
  name,
  value,
  disabled = false,
  placeholder,
  type = "text",
  onChange,
}: {
  label: string;
  name: FacilityStringField;
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
// DISPLAY HELPERS
// ============================================================

function display(
  value: string | null | undefined,
) {
  if (!value) {
    return "—";
  }

  return value.trim() || "—";
}

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
// DROPDOWN HELPERS
// ============================================================

function uniqueValues(
  values: string[],
): string[] {
  return Array.from(
    new Set(
      values
        .map((value) =>
          value.trim(),
        )
        .filter(Boolean),
    ),
  ).sort((a, b) =>
    a.localeCompare(
      b,
      undefined,
      {
        numeric: true,
        sensitivity: "base",
      },
    ),
  );
}

// ============================================================
// SELECT FIELD
// ============================================================

function FacilitySelectField({
  label,
  name,
  value,
  options,
  disabled = false,
  placeholder = "Select...",
  onChange,
}: {
  label: string;

  name:
    FacilityStringField;

  value:
    string;

  options:
    string[];

  disabled?:
    boolean;

  placeholder?:
    string;

  onChange: (
    event:
      ChangeEvent<HTMLSelectElement>,
  ) => void;
}) {
  return (
    <label className="bd-form-field">
      <span>
        {label}
      </span>

      <select
        name={name}
        value={value}
        disabled={disabled}
        onChange={onChange}
      >
        <option value="">
          {placeholder}
        </option>

        {/*
          If an older facility contains a value that is
          no longer in the current option list, preserve
          it while editing that facility.
        */}

        {value &&
          !options.includes(
            value,
          ) && (
            <option value={value}>
              {value}
            </option>
          )}

        {options.map(
          (option) => (
            <option
              key={option}
              value={option}
            >
              {option}
            </option>
          ),
        )}
      </select>
    </label>
  );
}

// ============================================================
// MAIN CLIENT
// ============================================================

export function FacilityRegistryClient({
  facilities,
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
    selectedFacility,
    setSelectedFacility,
  ] =
    useState<FacilityRecord | null>(
      null,
    );

  const [
    form,
    setForm,
  ] =
    useState<FacilityRecord>(
      EMPTY_FACILITY,
    );

  const [
    mode,
    setMode,
  ] =
    useState<
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
    sortKey,
    setSortKey,
  ] =
    useState<SortKey>(
      "FacilityNumber",
    );

  const [
    sortDirection,
    setSortDirection,
  ] =
    useState<SortDirection>(
      "asc",
    );

  // ==========================================================
  // FACILITY REFERENCE DROPDOWNS
  //
  // Values are derived from the full facility master, including
  // inactive facilities, so valid historical values remain
  // available when adding or editing records.
  // ==========================================================

  const subInstallationOptions =
    useMemo(
      () =>
        uniqueValues(
          facilities.map(
            (facility) =>
              facility.SUB_INST_CD,
          ),
        ),
      [facilities],
    );

  const facilityTypeOptions =
    useMemo(
      () =>
        uniqueValues(
          facilities.map(
            (facility) =>
              facility.FacilityType,
          ),
        ),
      [facilities],
    );

  const areaUMOptions =
    useMemo(
      () =>
        uniqueValues(
          facilities.map(
            (facility) =>
              facility.AreaUM,
          ),
        ),
      [facilities],
    );

  const otherUMOptions =
    useMemo(
      () =>
        uniqueValues(
          facilities.map(
            (facility) =>
              facility.OtherUM,
          ),
        ),
      [facilities],
    );

  // Site is dependent on the selected Sub Installation.
  const siteOptions =
    useMemo(() => {
      if (!form.SUB_INST_CD) {
        return uniqueValues(
          facilities.map(
            (facility) =>
              facility.SITE_CD,
          ),
        );
      }

      return uniqueValues(
        facilities
          .filter(
            (facility) =>
              facility.SUB_INST_CD ===
              form.SUB_INST_CD,
          )
          .map(
            (facility) =>
              facility.SITE_CD,
          ),
      );
    }, [
      facilities,
      form.SUB_INST_CD,
    ]);

  // ==========================================================
  // COUNTS
  // ==========================================================

  const activeCount =
    useMemo(
      () =>
        facilities.filter(
          (facility) =>
            facility.Active,
        ).length,
      [facilities],
    );

  const inactiveCount =
    facilities.length -
    activeCount;

  // ==========================================================
  // FILTER + SEARCH + SORT
  // ==========================================================

  const filteredFacilities =
    useMemo(() => {
      const searchValue =
        search
          .trim()
          .toLowerCase();

      const result =
        facilities.filter(
          (facility) => {
            if (
              statusFilter ===
                "active" &&
              !facility.Active
            ) {
              return false;
            }

            if (
              statusFilter ===
                "inactive" &&
              facility.Active
            ) {
              return false;
            }

            if (!searchValue) {
              return true;
            }

            const searchableValues = [
              facility.FacilityID,
              facility.SUB_INST_CD,
              facility.SITE_CD,
              facility.FacilityNumber,
              facility.FacilityType,
              facility.FacilityName,
              facility.AreaQty,
              facility.AreaUM,
              facility.OtherQty,
              facility.OtherUM,
              facility.CreatedDate,
              facility.InactiveDate,
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
      facilities,
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
  // OPEN EXISTING FACILITY
  // ==========================================================

  function openFacility(
    facility: FacilityRecord,
  ) {
    setMode("edit");

    setSelectedFacility(
      facility,
    );

    setForm({
      ...facility,
    });

    setError(null);
  }

  // ==========================================================
  // OPEN NEW FACILITY
  // ==========================================================

  function openNewFacility() {
    setMode("create");

    const facility = {
      ...EMPTY_FACILITY,

      Active: true,
    };

    setSelectedFacility(
      facility,
    );

    setForm(facility);

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

    setSelectedFacility(
      null,
    );

    setForm({
      ...EMPTY_FACILITY,
    });

    setError(null);
  }

  // ==========================================================
  // CHANGE
  // ==========================================================

  function handleChange(
    event:
      | ChangeEvent<HTMLInputElement>
      | ChangeEvent<HTMLSelectElement>,
  ) {
    const {
      name,
      value,
    } = event.target;

    setForm(
      (current) => {
        // When Sub Installation changes, keep the current Site
        // only when that Site is valid for the new selection.
        if (name === "SUB_INST_CD") {
          const validSites =
            facilities
              .filter(
                (facility) =>
                  facility.SUB_INST_CD ===
                  value,
              )
              .map(
                (facility) =>
                  facility.SITE_CD,
              );

          return {
            ...current,

            SUB_INST_CD:
              value,

            SITE_CD:
              validSites.includes(
                current.SITE_CD,
              )
                ? current.SITE_CD
                : "",
          };
        }

        return {
          ...current,

          [name]:
            value,
        };
      },
    );
  }

  // ==========================================================
  // ROW KEYBOARD ACCESS
  // ==========================================================

  function handleRowKeyDown(
    event:
      KeyboardEvent<HTMLTableRowElement>,

    facility:
      FacilityRecord,
  ) {
    if (
      event.key === "Enter" ||
      event.key === " "
    ) {
      event.preventDefault();

      openFacility(
        facility,
      );
    }
  }

  // ==========================================================
  // SAVE FACILITY
  // ==========================================================

  async function saveFacility() {
    setError(null);

    if (
      mode === "edit" &&
      !form.FacilityID.trim()
    ) {
      setError(
        "Facility ID is required.",
      );

      return;
    }

    if (
      !form.SUB_INST_CD.trim()
    ) {
      setError(
        "Sub Installation Code is required.",
      );

      return;
    }

    if (
      !form.SITE_CD.trim()
    ) {
      setError(
        "Site Code is required.",
      );

      return;
    }

    if (
      !form.FacilityNumber.trim()
    ) {
      setError(
        "Facility Number is required.",
      );

      return;
    }

    setSaving(true);

    try {
      const response =
        await fetch(
          "/api/facilities",
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
            "Unable to save facility.",
        );
      }

      closeDialog();

      router.refresh();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Unable to save facility.",
      );
    } finally {
      setSaving(false);
    }
  }

  // ==========================================================
  // ACTIVATE / DEACTIVATE
  // ==========================================================

  async function toggleFacilityStatus() {
    if (
      !form.FacilityID
    ) {
      return;
    }

    const newStatus =
      !form.Active;

    const action =
      newStatus
        ? "activate"
        : "deactivate";

    const facilityLabel =
      form.FacilityName ||
      form.FacilityNumber ||
      form.FacilityID;

    const confirmed =
      window.confirm(
        `Are you sure you want to ${action} ${facilityLabel}?`,
      );

    if (!confirmed) {
      return;
    }

    setStatusSaving(true);
    setError(null);

    try {
      const response =
        await fetch(
          "/api/facilities",
          {
            method: "PATCH",

            headers: {
              "Content-Type":
                "application/json",
            },

            body:
              JSON.stringify({
                FacilityID:
                  form.FacilityID,

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
            "Unable to update facility status.",
        );
      }

      closeDialog();

      router.refresh();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Unable to update facility status.",
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
          ACTION BAR
          ==================================================== */}

      <div className="bd-actions bd-meter-actions">
        <label className="bd-search">
          <Search size={18} />

          <span className="bd-sr-only">
            Search facilities
          </span>

          <input
            type="search"
            placeholder="Search facilities"
            value={search}
            onChange={(event) =>
              setSearch(
                event.target.value,
              )
            }
          />
        </label>

        <label className="bd-form-field bd-facility-status-filter">
          <span className="bd-sr-only">
            Facility status
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
              Active Facilities
            </option>

            <option value="inactive">
              Inactive Facilities
            </option>

            <option value="all">
              All Facilities
            </option>
          </select>
        </label>

        <button
          type="button"
          className="bd-add-button"
          onClick={
            openNewFacility
          }
        >
          <Plus size={18} />

          Add New Facility
        </button>
      </div>

      {/* ====================================================
          SUMMARY
          ==================================================== */}

      <div className="bd-facility-summary">
        <div className="bd-facility-summary-item">
          <span>
            Total Facilities
          </span>

          <strong>
            {facilities.length}
          </strong>
        </div>

        <div className="bd-facility-summary-item">
          <span>
            Active
          </span>

          <strong>
            {activeCount}
          </strong>
        </div>

        <div className="bd-facility-summary-item">
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
              Facility Registry
            </h2>

            <p>
              CUBE facility master
              and facility reference
              information
            </p>
          </div>

          <span>
            {
              filteredFacilities.length
            }{" "}
            shown
          </span>
        </div>

        <div className="bd-table-scroll">
          <table className="bd-table bd-facility-table">
            <thead>
              <tr>
                <SortHeading
                  column="FacilityID"
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
                  Facility ID
                </SortHeading>

                <SortHeading
                  column="SUB_INST_CD"
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
                  Sub Installation
                </SortHeading>

                <SortHeading
                  column="SITE_CD"
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
                  Site
                </SortHeading>

                <SortHeading
                  column="FacilityNumber"
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
                  Facility #
                </SortHeading>

                <SortHeading
                  column="FacilityName"
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
                  Facility Name
                </SortHeading>

                <SortHeading
                  column="FacilityType"
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
                  Facility Type
                </SortHeading>

                <SortHeading
                  column="AreaQty"
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
                  Area
                </SortHeading>

                <th scope="col">
                  Area U/M
                </th>

                <th scope="col">
                  Other Qty
                </th>

                <th scope="col">
                  Other U/M
                </th>

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
              {filteredFacilities.map(
                (facility) => (
                  <tr
                    key={
                      facility.FacilityID
                    }
                    className={`bd-clickable-row ${
                      !facility.Active
                        ? "facility-row-inactive"
                        : ""
                    }`}
                    tabIndex={0}
                    role="button"
                    aria-label={`Open facility ${facility.FacilityID}`}
                    onClick={() =>
                      openFacility(
                        facility,
                      )
                    }
                    onKeyDown={(
                      event,
                    ) =>
                      handleRowKeyDown(
                        event,
                        facility,
                      )
                    }
                  >
                    <td className="bd-id-cell facility-id-cell">
                      <span className="bd-meter-id-link">
                        {display(
                          facility.FacilityID,
                        )}
                      </span>
                    </td>

                    <td>
                      {display(
                        facility.SUB_INST_CD,
                      )}
                    </td>

                    <td>
                      {display(
                        facility.SITE_CD,
                      )}
                    </td>

                    <td className="facility-number-cell">
                      <strong>
                        {display(
                          facility.FacilityNumber,
                        )}
                      </strong>
                    </td>

                    <td className="bd-long-cell facility-name-cell">
                      {display(
                        facility.FacilityName,
                      )}
                    </td>

                    <td>
                      {display(
                        facility.FacilityType,
                      )}
                    </td>

                    <td>
                      {display(
                        facility.AreaQty,
                      )}
                    </td>

                    <td>
                      {display(
                        facility.AreaUM,
                      )}
                    </td>

                    <td>
                      {display(
                        facility.OtherQty,
                      )}
                    </td>

                    <td>
                      {display(
                        facility.OtherUM,
                      )}
                    </td>

                    <td>
                      <StatusBadge
                        active={
                          facility.Active
                        }
                      />
                    </td>
                  </tr>
                ),
              )}

              {filteredFacilities.length ===
                0 && (
                <tr>
                  <td
                    colSpan={11}
                    className="bd-empty-row"
                  >
                    No facilities
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
          FACILITY MODAL
          ==================================================== */}

      {selectedFacility && (
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
            className="bd-meter-modal bd-facility-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="facility-dialog-title"
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
                    <Building2
                      size={22}
                    />
                  )}
                </div>

                <div>
                  <p className="bd-modal-eyebrow">
                    {mode ===
                    "create"
                      ? "New facility"
                      : "Facility master record"}
                  </p>

                  <h2 id="facility-dialog-title">
                    {mode ===
                    "create"
                      ? "Add New Facility"
                      : form.FacilityName ||
                        `Facility ${form.FacilityNumber}` ||
                        form.FacilityID}
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
                title="Facility Identification"
                description="Permanent CUBE facility identity and installation reference information."
              >
                <FacilityField
                  label="Facility ID"
                  name="FacilityID"
                  value={
                    form.FacilityID
                  }
                  disabled
                  placeholder={
                    mode === "create"
                      ? "Assigned automatically"
                      : ""
                  }
                  onChange={
                    handleChange
                  }
                />

                <FacilitySelectField
                  label="Sub Installation Code"
                  name="SUB_INST_CD"
                  value={
                    form.SUB_INST_CD
                  }
                  options={
                    subInstallationOptions
                  }
                  placeholder="Select sub installation"
                  onChange={
                    handleChange
                  }
                />

                <FacilitySelectField
                  label="Site Code"
                  name="SITE_CD"
                  value={
                    form.SITE_CD
                  }
                  options={
                    siteOptions
                  }
                  disabled={
                    !form.SUB_INST_CD
                  }
                  placeholder={
                    form.SUB_INST_CD
                      ? "Select site"
                      : "Select sub installation first"
                  }
                  onChange={
                    handleChange
                  }
                />

                <FacilityField
                  label="Facility Number"
                  name="FacilityNumber"
                  value={
                    form.FacilityNumber
                  }
                  placeholder="Enter facility number"
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
                  FACILITY INFORMATION
                  ============================================ */}

              <FormSection
                title="Facility Information"
                description="Facility name and classification."
              >
                <FacilityField
                  label="Facility Name"
                  name="FacilityName"
                  value={
                    form.FacilityName
                  }
                  placeholder="Enter facility name"
                  onChange={
                    handleChange
                  }
                />

                <FacilitySelectField
                  label="Facility Type"
                  name="FacilityType"
                  value={
                    form.FacilityType
                  }
                  options={
                    facilityTypeOptions
                  }
                  placeholder="Select facility type"
                  onChange={
                    handleChange
                  }
                />
              </FormSection>

              {/* ============================================
                  MEASUREMENTS
                  ============================================ */}

              <FormSection
                title="Facility Measurements"
                description="Facility area and other quantity measurements."
              >
                <FacilityField
                  label="Area Quantity"
                  name="AreaQty"
                  value={
                    form.AreaQty
                  }
                  placeholder="Enter area"
                  onChange={
                    handleChange
                  }
                />

                <FacilitySelectField
                  label="Area Unit of Measure"
                  name="AreaUM"
                  value={
                    form.AreaUM
                  }
                  options={
                    areaUMOptions
                  }
                  placeholder="Select area U/M"
                  onChange={
                    handleChange
                  }
                />

                <FacilityField
                  label="Other Quantity"
                  name="OtherQty"
                  value={
                    form.OtherQty
                  }
                  placeholder="Enter quantity"
                  onChange={
                    handleChange
                  }
                />

                <FacilitySelectField
                  label="Other Unit of Measure"
                  name="OtherUM"
                  value={
                    form.OtherUM
                  }
                  options={
                    otherUMOptions
                  }
                  placeholder="Select other U/M"
                  onChange={
                    handleChange
                  }
                />
              </FormSection>

              {/* ============================================
                  LIFECYCLE
                  ============================================ */}

              <FormSection
                title="Facility Lifecycle"
                description="Lifecycle dates are maintained automatically by CUBE."
              >
                <FacilityField
                  label="Created Date"
                  name="CreatedDate"
                  value={
                    form.CreatedDate
                  }
                  disabled
                  placeholder={
                    mode === "create"
                      ? "Set when created"
                      : ""
                  }
                  onChange={
                    handleChange
                  }
                />

                <FacilityField
                  label="Inactive Date"
                  name="InactiveDate"
                  value={
                    form.InactiveDate
                  }
                  disabled
                  placeholder={
                    form.Active
                      ? "Active facility"
                      : ""
                  }
                  onChange={
                    handleChange
                  }
                />
              </FormSection>
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
                    className={`bd-status-toggle-button ${
                      form.Active
                        ? "bd-deactivate-button"
                        : "bd-activate-button"
                    }`}
                    disabled={
                      saving ||
                      statusSaving
                    }
                    onClick={
                      toggleFacilityStatus
                    }
                  >
                    {form.Active ? (
                      <>
                        <CircleX
                          size={17}
                        />

                        {statusSaving
                          ? "Deactivating..."
                          : "Deactivate Facility"}
                      </>
                    ) : (
                      <>
                        <RotateCcw
                          size={17}
                        />

                        {statusSaving
                          ? "Activating..."
                          : "Activate Facility"}
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
                  Cancel
                </button>

                <button
                  type="button"
                  className="bd-save-button"
                  disabled={
                    saving ||
                    statusSaving
                  }
                  onClick={
                    saveFacility
                  }
                >
                  <Save size={17} />

                  {saving
                    ? "Saving..."
                    : mode ===
                        "create"
                      ? "Add Facility"
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