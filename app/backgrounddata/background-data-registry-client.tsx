"use client";

import { useAppSection } from "@/components/app-section-navigation";

import {
  Database,
} from "lucide-react";

import {
  MeterRegistryClient,
  type MeterRecord,
} from "./meter-registry-client";

import {
  CustomerRegistryClient,
  type CustomerRecord,
} from "./customer-registry-client";

import {
  FacilityRegistryClient,
  type FacilityRecord,
} from "./facility-registry-client";

// ============================================================
// COMPONENT PROPS
// ============================================================

type BackgroundDataRegistryClientProps = {
  meters: MeterRecord[];

  facilities: FacilityRecord[];

  customers: CustomerRecord[];
};

// ============================================================
// BACKGROUND DATA TABS
// ============================================================

// ============================================================
// MAIN CLIENT COMPONENT
// ============================================================

export function BackgroundDataRegistryClient({
  meters,
  facilities,
  customers,
}: BackgroundDataRegistryClientProps) {
  const { activeSection: activeTab } = useAppSection();

  return (
    <>
      {/* ====================================================
          METER TAB
          ==================================================== */}

      {activeTab === "Meter" && (
        <MeterRegistryClient
          meters={meters}
        />
      )}

      {/* ====================================================
          FACILITY TAB
          ==================================================== */}

      {activeTab === "Facility" && (
        <FacilityRegistryClient
          facilities={facilities}
        />
      )}

      {/* ====================================================
          CUSTOMER TAB
          ==================================================== */}

      {activeTab === "Customer" && (
        <CustomerRegistryClient
          customers={customers}
        />
      )}

      {/* ====================================================
          FUTURE TABLES
          ==================================================== */}

      {activeTab !== "Meter" &&
        activeTab !== "Facility" &&
        activeTab !== "Customer" && (
          <EmptyTab
            name={activeTab}
          />
        )}
    </>
  );
}

// ============================================================
// EMPTY / FUTURE TAB
// ============================================================

function EmptyTab({
  name,
}: {
  name: string;
}) {
  return (
    <div className="bd-empty-state">
      <Database
        size={38}
      />

      <h3>
        {name}
      </h3>

      <p>
        This background data
        table has not been
        configured yet.
      </p>
    </div>
  );
}
