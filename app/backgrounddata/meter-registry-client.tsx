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



  ChevronsUpDown,

  Download,



  Pencil,



  Plus,



  Save,



  Search,



  Trash2,



  X,



} from "lucide-react";







export type MeterRecord = {



  meterid: string;







  sub_inst_cd: string;



  site_cd: string;



  facility_nbr: string;







  utility_type_cd: string;



  meter_type_cd: string;







  amp: string;



  device_id: string;



  zone: string;



  floor: string;







  serial_nbr: string;



  rollover: string;



  expr1015: string;



  multiplier: string;







  utm_x: string;



  utm_y: string;







  vendor_id: string;



  model_nbr: string;







  install_date: string;



  in_service_date: string;



  inv_survey_date: string;







  inv_tagged: string;



  outside: string;



  inv_read_method_id: string;







  network_ip_address: string;



  meter_ip_address: string;



  xmit_ip_address: string;



  subnet_mask: string;



  default_gateway: string;



  mac_id: string;







  analog_link: string;



  digital_link: string;







  eng_assessment_tx: string;



  narrative: string;







  meter_status_id: string;



  owner_id: string;







  // Derived from the latest billing-period reading.



  // This is display-only in the meter registry.



  zero_reading_streak: string;



};







type SortKey =



  | "meterid"



  | "model_nbr"



  | "serial_nbr"



  | "vendor_id"



  | "site_cd"



  | "facility_nbr"



  | "zero_reading_streak"



  | "eng_assessment_tx"



  | "narrative";







type SortDirection =



  | "asc"



  | "desc";







type ZeroStreakFilter =



  | "all"



  | "normal"



  | "monitor"



  | "investigate"



  | "likely"



  | "critical";







type Props = {



  meters: MeterRecord[];



};







const EMPTY_METER: MeterRecord = {



  meterid: "",







  sub_inst_cd: "",



  site_cd: "",



  facility_nbr: "",







  utility_type_cd: "",



  meter_type_cd: "",







  amp: "",



  device_id: "",



  zone: "",



  floor: "",







  serial_nbr: "",



  rollover: "",



  expr1015: "",



  multiplier: "",







  utm_x: "",



  utm_y: "",







  vendor_id: "",



  model_nbr: "",







  install_date: "",



  in_service_date: "",



  inv_survey_date: "",







  inv_tagged: "",



  outside: "",



  inv_read_method_id: "",







  network_ip_address: "",



  meter_ip_address: "",



  xmit_ip_address: "",



  subnet_mask: "",



  default_gateway: "",



  mac_id: "",







  analog_link: "",



  digital_link: "",







  eng_assessment_tx: "",



  narrative: "",







  meter_status_id: "",



  owner_id: "",







  zero_reading_streak: "0",



};







type FieldProps = {



  label: string;



  name: keyof MeterRecord;



  value: string;



  disabled?: boolean;



  placeholder?: string;

  type?: string;



  onChange: (



    event:



      | ChangeEvent<HTMLInputElement>



      | ChangeEvent<HTMLTextAreaElement>



      | ChangeEvent<HTMLSelectElement>,



  ) => void;



};







function MeterField({



  label,



  name,



  value,



  disabled = false,



  placeholder,

  type = "text",



  onChange,



}: FieldProps) {



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







function SelectField({



  label,



  name,



  value,



  options,



  onChange,



}: {



  label: string;



  name: keyof MeterRecord;



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



        <option value="">Select...</option>







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







function display(value: string) {



  return value.trim() || "—";



}







function zeroStreakInfo(



  value: string,



) {



  const streak =



    Number(value) || 0;







  if (streak >= 12) {



    return {



      streak,



      className:



        "bd-zero-streak bd-zero-streak-critical",



      label: "Long-term zero",



    };



  }







  if (streak >= 6) {



    return {



      streak,



      className:



        "bd-zero-streak bd-zero-streak-likely",



      label: "Likely issue",



    };



  }







  if (streak >= 3) {



    return {



      streak,



      className:



        "bd-zero-streak bd-zero-streak-investigate",



      label: "Investigate",



    };



  }







  if (streak >= 1) {



    return {



      streak,



      className:



        "bd-zero-streak bd-zero-streak-monitor",



      label: "Monitor",



    };



  }







  return {



    streak: 0,



    className:



      "bd-zero-streak bd-zero-streak-normal",



    label: "Normal",



  };



}







export function MeterRegistryClient({



  meters,



}: Props) {



  const router = useRouter();







  const [search, setSearch] = useState("");







  const [sortKey, setSortKey] =



    useState<SortKey>("meterid");







  const [sortDirection, setSortDirection] =



    useState<SortDirection>("asc");







  const [zeroStreakFilter, setZeroStreakFilter] =



    useState<ZeroStreakFilter>("all");







  const [selectedMeter, setSelectedMeter] =



    useState<MeterRecord | null>(null);







  const [form, setForm] =



    useState<MeterRecord>(EMPTY_METER);







  const [mode, setMode] =



    useState<"create" | "edit">("edit");







  const [saving, setSaving] = useState(false);

  const [selectedMeterIds, setSelectedMeterIds] =
    useState<Set<string>>(new Set());

  const [bulkDeleting, setBulkDeleting] = useState(false);







  const [error, setError] =



    useState<string | null>(null);







  const zeroStreakSummary = useMemo(() => {



    const summary = {



      all: meters.length,



      normal: 0,



      monitor: 0,



      investigate: 0,



      likely: 0,



      critical: 0,



    };







    meters.forEach((meter) => {



      const streak =



        Number(meter.zero_reading_streak) || 0;







      if (streak >= 12) {



        summary.critical++;



      } else if (streak >= 6) {



        summary.likely++;



      } else if (streak >= 3) {



        summary.investigate++;



      } else if (streak >= 1) {



        summary.monitor++;



      } else {



        summary.normal++;



      }



    });







    return summary;



  }, [meters]);







  const filteredMeters = useMemo(() => {



    const searchValue = search



      .trim()



      .toLowerCase();







    const results = meters.filter((meter) => {



      const matchesSearch =



        !searchValue ||



        Object.values(meter).some((value) =>



          value



            .toLowerCase()



            .includes(searchValue),



        );







      if (!matchesSearch) {



        return false;



      }







      const streak =



        Number(meter.zero_reading_streak) || 0;







      switch (zeroStreakFilter) {



        case "normal":



          return streak === 0;



        case "monitor":



          return streak >= 1 && streak <= 2;



        case "investigate":



          return streak >= 3 && streak <= 5;



        case "likely":



          return streak >= 6 && streak <= 11;



        case "critical":



          return streak >= 12;



        default:



          return true;



      }



    });







    results.sort((a, b) => {



      let comparison = 0;







      if (



        sortKey ===



        "zero_reading_streak"



      ) {



        comparison =



          (Number(



            a.zero_reading_streak,



          ) || 0) -



          (Number(



            b.zero_reading_streak,



          ) || 0);



      } else {



        comparison =



          a[sortKey].localeCompare(



            b[sortKey],



            undefined,



            {



              numeric: true,



              sensitivity: "base",



            },



          );



      }







      return sortDirection === "asc"



        ? comparison



        : -comparison;



    });







    return results;



  }, [



    meters,



    search,



    zeroStreakFilter,



    sortKey,



    sortDirection,



  ]);







  function handleZeroStreakFilter(



    filter: ZeroStreakFilter,



  ) {



    setZeroStreakFilter((current) =>



      current === filter && filter !== "all"



        ? "all"



        : filter,



    );



  }







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







  function openMeter(meter: MeterRecord) {



    setMode("edit");



    setSelectedMeter(meter);



    setForm({ ...meter });



    setError(null);



  }







  function openNewMeter() {



    setMode("create");



    setSelectedMeter(EMPTY_METER);



    setForm({ ...EMPTY_METER });



    setError(null);



  }







  function closeDialog() {



    if (saving) return;







    setSelectedMeter(null);



    setForm({ ...EMPTY_METER });



    setError(null);



  }







  function handleChange(



    event:



      | ChangeEvent<HTMLInputElement>



      | ChangeEvent<HTMLTextAreaElement>



      | ChangeEvent<HTMLSelectElement>,



  ) {



    const { name, value } = event.target;







    setForm((current) => ({



      ...current,



      [name]: value,



    }));



  }







  function handleRowKeyDown(



    event: KeyboardEvent<HTMLTableRowElement>,



    meter: MeterRecord,



  ) {



    if (



      event.key === "Enter" ||



      event.key === " "



    ) {



      event.preventDefault();



      openMeter(meter);



    }



  }







  async function saveMeter() {



    setError(null);







    if (!form.meterid.trim()) {



      setError("Meter ID is required.");



      return;



    }







    setSaving(true);







    try {



      const response = await fetch(



        "/api/meters",



        {



          method:



            mode === "create"



              ? "POST"



              : "PUT",







          headers: {



            "Content-Type":



              "application/json",



          },







          body: JSON.stringify(form),



        },



      );







      const result = await response.json();







      if (!response.ok) {



        throw new Error(



          result.error ||



            "Unable to save meter.",



        );



      }







      closeDialog();







      router.refresh();



    } catch (err) {



      setError(



        err instanceof Error



          ? err.message



          : "Unable to save meter.",



      );



    } finally {



      setSaving(false);



    }



  }







  async function deleteMeter() {



    if (!form.meterid) return;







    const confirmed = window.confirm(



      `Delete meter ${form.meterid}? This cannot be undone.`,



    );







    if (!confirmed) return;







    setSaving(true);



    setError(null);







    try {



      const response = await fetch(



        `/api/meters?meterid=${encodeURIComponent(



          form.meterid,



        )}`,



        {



          method: "DELETE",



        },



      );







      const result = await response.json();







      if (!response.ok) {



        throw new Error(



          result.error ||



            "Unable to delete meter.",



        );



      }







      closeDialog();







      router.refresh();



    } catch (err) {



      setError(



        err instanceof Error



          ? err.message



          : "Unable to delete meter.",



      );



    } finally {



      setSaving(false);



    }



  }









  const visibleMeterIds = useMemo(
    () => filteredMeters.map((meter) => meter.meterid),
    [filteredMeters],
  );

  const allVisibleSelected =
    visibleMeterIds.length > 0 &&
    visibleMeterIds.every((meterId) =>
      selectedMeterIds.has(meterId),
    );

  const someVisibleSelected =
    visibleMeterIds.some((meterId) =>
      selectedMeterIds.has(meterId),
    );

  function toggleMeterSelection(meterId: string) {
    setSelectedMeterIds((current) => {
      const next = new Set(current);
      if (next.has(meterId)) next.delete(meterId);
      else next.add(meterId);
      return next;
    });
  }

  function toggleAllVisibleMeters() {
    setSelectedMeterIds((current) => {
      const next = new Set(current);

      if (allVisibleSelected) {
        visibleMeterIds.forEach((meterId) =>
          next.delete(meterId),
        );
      } else {
        visibleMeterIds.forEach((meterId) =>
          next.add(meterId),
        );
      }

      return next;
    });
  }

  async function deleteSelectedMeters() {
    const meterIds = Array.from(selectedMeterIds);
    if (meterIds.length === 0) return;

    const confirmed = window.confirm(
      `Delete ${meterIds.length} selected meter${
        meterIds.length === 1 ? "" : "s"
      }? This cannot be undone.`,
    );

    if (!confirmed) return;

    setBulkDeleting(true);
    setError(null);

    try {
      const response = await fetch("/api/meters", {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          meterids: meterIds,
        }),
      });

      const result = await response.json();

      if (!response.ok) {
        throw new Error(
          result.error ||
            "Unable to delete selected meters.",
        );
      }

      setSelectedMeterIds(new Set());
      router.refresh();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Unable to delete selected meters.",
      );
    } finally {
      setBulkDeleting(false);
    }
  }

  function exportVisibleMetersToCsv() {

    if (filteredMeters.length === 0) {

      return;

    }



    const headers = [

      "Meter ID",

      "Model No.",

      "Serial No.",

      "Vendor",

      "Site ID",

      "Facility No.",

      "Zero Streak",

      "Engineer Text",

      "Narrative",

    ];



    const escapeCsv = (value: string | number) => {

      const text = String(value ?? "");



      if (

        text.includes(",") ||

        text.includes('"') ||

        text.includes("\n") ||

        text.includes("\r")

      ) {

        return `"${text.replace(/"/g, '""')}"`;

      }



      return text;

    };



    const rows = filteredMeters.map((meter) => [

      meter.meterid,

      meter.model_nbr,

      meter.serial_nbr,

      meter.vendor_id,

      meter.site_cd,

      meter.facility_nbr,

      meter.zero_reading_streak,

      meter.eng_assessment_tx,

      meter.narrative,

    ]);



    const csv = [

      headers.map(escapeCsv).join(","),

      ...rows.map((row) =>

        row.map(escapeCsv).join(","),

      ),

    ].join("\r\n");



    const blob = new Blob(

      ["\uFEFF", csv],

      {

        type: "text/csv;charset=utf-8;",

      },

    );



    const url = URL.createObjectURL(blob);

    const link = document.createElement("a");



    link.href = url;

    link.download = `CUBE-Meter-Registry-${new Date()

      .toISOString()

      .slice(0, 10)}.csv`;



    document.body.appendChild(link);

    link.click();

    document.body.removeChild(link);



    URL.revokeObjectURL(url);

  }



  return (



    <>



      <div className="bd-actions bd-meter-actions">



        <label className="bd-search">



          <Search size={18} />







          <span className="bd-sr-only">



            Search meters



          </span>







          <input



            type="search"



            placeholder="Search meters"



            value={search}



            onChange={(event) =>



              setSearch(event.target.value)



            }



          />



        </label>







        {selectedMeterIds.size > 0 && (
          <button
            type="button"
            className="bd-delete-button"
            onClick={deleteSelectedMeters}
            disabled={bulkDeleting}
          >
            <Trash2 size={18} />
            {bulkDeleting
              ? "Deleting..."
              : `Delete Selected (${selectedMeterIds.size})`}
          </button>
        )}

        <button

          type="button"

          className="bd-add-button"

          onClick={exportVisibleMetersToCsv}

          disabled={filteredMeters.length === 0}

          title={`Export ${filteredMeters.length} shown meters to CSV`}

        >

          <Download size={18} />

          Export CSV

        </button>



        <button



          type="button"



          className="bd-add-button"



          onClick={openNewMeter}



        >



          <Plus size={18} />



          Add New Meter



        </button>



      </div>







      <section



        className="bd-zero-summary"



        aria-label="Zero reading streak summary"



      >



        <div className="bd-zero-summary-heading">



          <div>



            <h2>Zero Reading Summary</h2>



            <p>



              Current consecutive zero-reading periods



              across the meter registry



            </p>



          </div>



        </div>







        <div className="bd-zero-summary-grid">



          <ZeroSummaryCard



            label="All Meters"



            range="All"



            count={zeroStreakSummary.all}



            active={zeroStreakFilter === "all"}



            className="bd-zero-summary-all"



            onClick={() =>



              handleZeroStreakFilter("all")



            }



          />







          <ZeroSummaryCard



            label="Normal"



            range="0"



            count={zeroStreakSummary.normal}



            active={zeroStreakFilter === "normal"}



            className="bd-zero-summary-normal"



            onClick={() =>



              handleZeroStreakFilter("normal")



            }



          />







          <ZeroSummaryCard



            label="Monitor"



            range="1–2"



            count={zeroStreakSummary.monitor}



            active={zeroStreakFilter === "monitor"}



            className="bd-zero-summary-monitor"



            onClick={() =>



              handleZeroStreakFilter("monitor")



            }



          />







          <ZeroSummaryCard



            label="Investigate"



            range="3–5"



            count={zeroStreakSummary.investigate}



            active={zeroStreakFilter === "investigate"}



            className="bd-zero-summary-investigate"



            onClick={() =>



              handleZeroStreakFilter("investigate")



            }



          />







          <ZeroSummaryCard



            label="Likely Issue"



            range="6–11"



            count={zeroStreakSummary.likely}



            active={zeroStreakFilter === "likely"}



            className="bd-zero-summary-likely"



            onClick={() =>



              handleZeroStreakFilter("likely")



            }



          />







          <ZeroSummaryCard



            label="Long-term Zero"



            range="12+"



            count={zeroStreakSummary.critical}



            active={zeroStreakFilter === "critical"}



            className="bd-zero-summary-critical"



            onClick={() =>



              handleZeroStreakFilter("critical")



            }



          />



        </div>



      </section>







      <div className="bd-table-panel">



        <div className="bd-table-heading">



          <div>



            <h2>Meter Registry</h2>







            <p>



              Core meter identification



              and service details



            </p>



          </div>







          <span>



            {filteredMeters.length} shown



          </span>



        </div>







        <div className="bd-table-scroll">



          <table className="bd-table">



            <thead>



              <tr>



                <th scope="col" className="bd-select-cell">
                  <input
                    type="checkbox"
                    checked={allVisibleSelected}
                    ref={(input) => {
                      if (input) {
                        input.indeterminate =
                          !allVisibleSelected &&
                          someVisibleSelected;
                      }
                    }}
                    onChange={toggleAllVisibleMeters}
                    aria-label="Select all shown meters"
                    title="Select all shown meters"
                  />
                </th>

                <SortHeading



                  sortKey="meterid"



                  activeKey={sortKey}



                  direction={sortDirection}



                  onSort={handleSort}



                >



                  Meter ID



                </SortHeading>







                <SortHeading



                  sortKey="model_nbr"



                  activeKey={sortKey}



                  direction={sortDirection}



                  onSort={handleSort}



                >



                  Model No.



                </SortHeading>







                <SortHeading



                  sortKey="serial_nbr"



                  activeKey={sortKey}



                  direction={sortDirection}



                  onSort={handleSort}



                >



                  Serial No.



                </SortHeading>







                <SortHeading



                  sortKey="vendor_id"



                  activeKey={sortKey}



                  direction={sortDirection}



                  onSort={handleSort}



                >



                  Vendor



                </SortHeading>







                <SortHeading



                  sortKey="site_cd"



                  activeKey={sortKey}



                  direction={sortDirection}



                  onSort={handleSort}



                >



                  Site ID



                </SortHeading>







                <SortHeading



                  sortKey="facility_nbr"



                  activeKey={sortKey}



                  direction={sortDirection}



                  onSort={handleSort}



                >



                  Facility No.



                </SortHeading>







                <SortHeading



                  sortKey="zero_reading_streak"



                  activeKey={sortKey}



                  direction={sortDirection}



                  onSort={handleSort}



                >



                  Zero Streak



                </SortHeading>







                <SortHeading



                  sortKey="eng_assessment_tx"



                  activeKey={sortKey}



                  direction={sortDirection}



                  onSort={handleSort}



                >



                  Engineer Text



                </SortHeading>







                <SortHeading



                  sortKey="narrative"



                  activeKey={sortKey}



                  direction={sortDirection}



                  onSort={handleSort}



                >



                  Narrative



                </SortHeading>



              </tr>



            </thead>







            <tbody>



              {filteredMeters.map(



                (meter) => (



                  <tr



                    key={meter.meterid}



                    className="bd-clickable-row"



                    tabIndex={0}



                    role="button"



                    aria-label={`Open meter ${meter.meterid}`}



                    onClick={() =>



                      openMeter(meter)



                    }



                    onKeyDown={(event) =>



                      handleRowKeyDown(



                        event,



                        meter,



                      )



                    }



                  >



                    <td
                      className="bd-select-cell"
                      onClick={(event) =>
                        event.stopPropagation()
                      }
                    >
                      <input
                        type="checkbox"
                        checked={selectedMeterIds.has(
                          meter.meterid,
                        )}
                        onChange={() =>
                          toggleMeterSelection(
                            meter.meterid,
                          )
                        }
                        onKeyDown={(event) =>
                          event.stopPropagation()
                        }
                        aria-label={`Select meter ${meter.meterid}`}
                      />
                    </td>

                    <td className="bd-id-cell">



                      <span className="bd-meter-id-link">



                        {display(



                          meter.meterid,



                        )}



                      </span>



                    </td>







                    <td>



                      {display(



                        meter.model_nbr,



                      )}



                    </td>







                    <td>



                      {display(



                        meter.serial_nbr,



                      )}



                    </td>







                    <td>



                      {display(



                        meter.vendor_id,



                      )}



                    </td>







                    <td>



                      {display(



                        meter.site_cd,



                      )}



                    </td>







                    <td>



                      {display(



                        meter.facility_nbr,



                      )}



                    </td>







                    <td className="bd-zero-streak-cell">



                      {(() => {



                        const info =



                          zeroStreakInfo(



                            meter.zero_reading_streak,



                          );







                        return (



                          <span



                            className={



                              info.className



                            }



                            title={



                              info.streak === 0



                                ? "No current consecutive zero-reading periods"



                                : `${info.label}: ${info.streak} consecutive billing period${info.streak === 1 ? "" : "s"} with a zero reading`



                            }



                          >



                            <strong>



                              {info.streak}



                            </strong>







                            <span>



                              {info.streak === 1



                                ? "period"



                                : "periods"}



                            </span>



                          </span>



                        );



                      })()}



                    </td>







                    <td className="bd-long-cell">



                      {display(



                        meter.eng_assessment_tx,



                      )}



                    </td>







                    <td className="bd-long-cell">



                      {display(



                        meter.narrative,



                      )}



                    </td>



                  </tr>



                ),



              )}







              {filteredMeters.length === 0 && (



                <tr>



                  <td



                    colSpan={10}



                    className="bd-empty-row"



                  >



                    No meters match your



                    search.



                  </td>



                </tr>



              )}



            </tbody>



          </table>



        </div>



      </div>







      {selectedMeter && (



        <div



          className="bd-modal-backdrop"



          onMouseDown={(event) => {



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



            aria-labelledby="meter-dialog-title"



          >



            <div className="bd-modal-header">



              <div>



                <div className="bd-modal-icon">



                  {mode === "create" ? (



                    <Plus size={22} />



                  ) : (



                    <Pencil size={22} />



                  )}



                </div>







                <div>



                  <p className="bd-modal-eyebrow">



                    {mode === "create"



                      ? "New meter record"



                      : "Meter record"}



                  </p>







                  <h2 id="meter-dialog-title">



                    {mode === "create"



                      ? "Add New Meter"



                      : form.meterid}



                  </h2>



                </div>



              </div>







              <button



                type="button"



                className="bd-modal-close"



                onClick={closeDialog}



                aria-label="Close"



              >



                <X size={21} />



              </button>



            </div>







            <div className="bd-modal-body">



              {error && (



                <div



                  className="bd-form-error"



                  role="alert"



                >



                  {error}



                </div>



              )}







              <FormSection



                title="Meter Identification"



                description="Primary identification and classification."



              >



                <MeterField



                  label="Meter ID"



                  name="meterid"



                  value={form.meterid}



                  disabled={



                    mode === "edit"



                  }



                  placeholder="E0001"



                  onChange={handleChange}



                />







                <MeterField



                  label="Sub Installation"



                  name="sub_inst_cd"

                  value={



                    form.sub_inst_cd



                  }



                  onChange={handleChange}



                />







                <MeterField



                  label="Site Code"



                  name="site_cd"



                  value={form.site_cd}



                  onChange={handleChange}



                />







                <MeterField



                  label="Facility Number"



                  name="facility_nbr"



                  value={



                    form.facility_nbr



                  }



                  onChange={handleChange}



                />







                <MeterField



                  label="Utility Type"



                  name="utility_type_cd"



                  value={



                    form.utility_type_cd



                  }



                  placeholder="EL, NG, WATER..."



                  onChange={handleChange}



                />







                <MeterField



                  label="Meter Type"



                  name="meter_type_cd"



                  value={



                    form.meter_type_cd



                  }



                  placeholder="FAC_MAIN"



                  onChange={handleChange}



                />







                <MeterField



                  label="Status ID"



                  name="meter_status_id"



                  value={



                    form.meter_status_id



                  }



                  onChange={handleChange}



                />







                <MeterField



                  label="Owner ID"



                  name="owner_id"



                  value={form.owner_id}



                  onChange={handleChange}



                />



              </FormSection>







              <FormSection



                title="Equipment"



                description="Meter hardware and reading configuration."



              >



                <MeterField



                  label="Vendor"



                  name="vendor_id"



                  value={form.vendor_id}



                  onChange={handleChange}



                />







                <MeterField



                  label="Model Number"



                  name="model_nbr"



                  value={form.model_nbr}



                  onChange={handleChange}



                />







                <MeterField



                  label="Serial Number"



                  name="serial_nbr"



                  value={form.serial_nbr}



                  onChange={handleChange}



                />







                <MeterField



                  label="Device ID"



                  name="device_id"



                  value={form.device_id}



                  onChange={handleChange}



                />







                <MeterField



                  label="AMP"



                  name="amp"



                  value={form.amp}



                  onChange={handleChange}



                />







                <MeterField



                  label="Rollover"



                  name="rollover"



                  value={form.rollover}



                  onChange={handleChange}



                />







                <MeterField



                  label="Expression 1015"



                  name="expr1015"



                  value={form.expr1015}



                  onChange={handleChange}



                />







                <MeterField



                  label="Multiplier"



                  name="multiplier"



                  value={form.multiplier}



                  onChange={handleChange}



                />



              </FormSection>







              <FormSection



                title="Location"



                description="Physical meter location."



              >



                <MeterField



                  label="Zone"



                  name="zone"



                  value={form.zone}



                  onChange={handleChange}



                />







                <MeterField



                  label="Floor"



                  name="floor"



                  value={form.floor}



                  onChange={handleChange}



                />







                <MeterField



                  label="UTM X"



                  name="utm_x"



                  value={form.utm_x}



                  onChange={handleChange}



                />







                <MeterField



                  label="UTM Y"



                  name="utm_y"



                  value={form.utm_y}



                  onChange={handleChange}



                />







                <SelectField



                  label="Outside"



                  name="outside"



                  value={form.outside}



                  options={[



                    {



                      value: "0",



                      label: "No",



                    },



                    {



                      value: "1",



                      label: "Yes",



                    },



                  ]}



                  onChange={



                    handleChange



                  }



                />







                <SelectField



                  label="Inventory Tagged"



                  name="inv_tagged"



                  value={



                    form.inv_tagged



                  }



                  options={[



                    {



                      value: "0",



                      label: "No",



                    },



                    {



                      value: "1",



                      label: "Yes",



                    },



                  ]}



                  onChange={



                    handleChange



                  }



                />







                <MeterField



                  label="Inventory Read Method"



                  name="inv_read_method_id"



                  value={



                    form.inv_read_method_id



                  }



                  onChange={handleChange}



                />



              </FormSection>







              <FormSection



                title="Dates"



                description="Installation and inventory dates."



              >



                <MeterField



                  label="Install Date"



                  name="install_date"



                  type="date"



                  value={form.install_date}



                  onChange={handleChange}



                />







                <MeterField



                  label="In Service Date"



                  name="in_service_date"



                  type="date"



                  value={



                    form.in_service_date



                  }



                  onChange={handleChange}



                />







                <MeterField



                  label="Inventory Survey Date"



                  name="inv_survey_date"



                  type="date"



                  value={



                    form.inv_survey_date



                  }



                  onChange={handleChange}



                />



              </FormSection>







              <FormSection



                title="Network & Communications"



                description="Meter network and communication information."



              >



                <MeterField



                  label="Network IP Address"



                  name="network_ip_address"



                  value={



                    form.network_ip_address



                  }



                  onChange={handleChange}



                />







                <MeterField



                  label="Meter IP Address"



                  name="meter_ip_address"



                  value={



                    form.meter_ip_address



                  }



                  onChange={handleChange}



                />







                <MeterField



                  label="Transmit IP Address"



                  name="xmit_ip_address"



                  value={



                    form.xmit_ip_address



                  }



                  onChange={handleChange}



                />







                <MeterField



                  label="Subnet Mask"



                  name="subnet_mask"



                  value={



                    form.subnet_mask



                  }



                  onChange={handleChange}



                />







                <MeterField



                  label="Default Gateway"



                  name="default_gateway"



                  value={



                    form.default_gateway



                  }



                  onChange={handleChange}



                />







                <MeterField



                  label="MAC ID"



                  name="mac_id"



                  value={form.mac_id}



                  onChange={handleChange}



                />







                <MeterField



                  label="Analog Link"



                  name="analog_link"



                  value={



                    form.analog_link



                  }



                  onChange={handleChange}



                />







                <MeterField



                  label="Digital Link"



                  name="digital_link"



                  value={



                    form.digital_link



                  }



                  onChange={handleChange}



                />



              </FormSection>







              <div className="bd-form-section">



                <div className="bd-form-section-heading">



                  <h3>



                    Engineering & Notes



                  </h3>







                  <p>



                    Engineering assessment



                    and meter location



                    narrative.



                  </p>



                </div>







                <div className="bd-form-textareas">



                  <label className="bd-form-field">



                    <span>



                      Engineering Assessment



                    </span>







                    <textarea



                      name="eng_assessment_tx"



                      value={



                        form.eng_assessment_tx



                      }



                      rows={5}



                      onChange={



                        handleChange



                      }



                    />



                  </label>







                  <label className="bd-form-field">



                    <span>Narrative</span>







                    <textarea



                      name="narrative"



                      value={



                        form.narrative



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







            <div className="bd-modal-footer">



              <div>



                {mode === "edit" && (



                  <button



                    type="button"



                    className="bd-delete-button"



                    disabled={saving}



                    onClick={deleteMeter}



                  >



                    <Trash2 size={17} />



                    Delete Meter



                  </button>



                )}



              </div>







              <div className="bd-modal-footer-actions">



                <button



                  type="button"



                  className="bd-cancel-button"



                  disabled={saving}



                  onClick={closeDialog}



                >



                  Cancel



                </button>







                <button



                  type="button"



                  className="bd-save-button"



                  disabled={saving}



                  onClick={saveMeter}



                >



                  <Save size={17} />







                  {saving



                    ? "Saving..."



                    : mode === "create"



                      ? "Add Meter"



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







function ZeroSummaryCard({



  label,



  range,



  count,



  active,



  className,



  onClick,



}: {



  label: string;



  range: string;



  count: number;



  active: boolean;



  className: string;



  onClick: () => void;



}) {



  return (



    <button



      type="button"



      className={`bd-zero-summary-card ${className} ${



        active ? "bd-zero-summary-card-active" : ""



      }`}



      onClick={onClick}



      aria-pressed={active}



      title={`Show ${label.toLowerCase()} meters`}



    >



      <span className="bd-zero-summary-label">



        {label}



      </span>







      <strong className="bd-zero-summary-count">



        {count.toLocaleString()}



      </strong>







      <span className="bd-zero-summary-range">



        {range}



      </span>



    </button>



  );



}







function SortHeading({



  children,



  sortKey,



  activeKey,



  direction,



  onSort,



}: {



  children: React.ReactNode;



  sortKey: SortKey;



  activeKey: SortKey;



  direction: SortDirection;



  onSort: (



    key: SortKey,



  ) => void;



}) {



  const active =



    sortKey === activeKey;







  return (



    <th



      scope="col"



      aria-sort={



        active



          ? direction === "asc"



            ? "ascending"



            : "descending"



          : "none"



      }



    >



      <button



        type="button"



        className={`bd-sort-button ${



          active



            ? "bd-sort-button-active"



            : ""



        }`}



        onClick={() =>



          onSort(sortKey)



        }



        title={



          active



            ? direction === "asc"



              ? "Sorted low to high / A to Z. Click for reverse order."



              : "Sorted high to low / Z to A. Click for reverse order."



            : "Click to sort"



        }



      >



        <span>{children}</span>







        {active ? (



          direction === "asc" ? (



            <ChevronUp



              size={14}



              aria-hidden="true"



            />



          ) : (



            <ChevronDown



              size={14}



              aria-hidden="true"



            />



          )



        ) : (



          <ChevronsUpDown



            size={14}



            aria-hidden="true"



          />



        )}



      </button>



    </th>



  );



}







function FormSection({



  title,



  description,



  children,



}: {



  title: string;



  description: string;



  children: React.ReactNode;



}) {



  return (



    <div className="bd-form-section">



      <div className="bd-form-section-heading">



        <h3>{title}</h3>



        <p>{description}</p>



      </div>







      <div className="bd-form-grid">



        {children}



      </div>



    </div>



  );



}
