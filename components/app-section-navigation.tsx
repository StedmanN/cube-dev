"use client";

import { createContext, useContext, useState, type ReactNode } from "react";

type Page = "Monthly Data" | "Yearly Data" | "Background Data";
type Section = { id: string; label: string };
type Group = { label: string; sections: Section[] };

const groups: Record<Page, Group[]> = {
  "Monthly Data": [
    { label: "Monthly records", sections: [
      { id: "Invoices", label: "Invoices" },
      { id: "Meter Readings", label: "Meter Readings" },
      { id: "Real Property", label: "Real Property" },
      { id: "Plant Unit", label: "Plant Unit" },
    ] },
    { label: "Review", sections: [
      { id: "Monthly Summary", label: "Monthly Summary" },
      { id: "Monthly Reconciliation", label: "Monthly Reconciliation" },
    ] },
  ],
  "Yearly Data": [{ label: "Yearly reference data", sections: [
    { id: "category-codes", label: "Category Codes" },
    { id: "space-types", label: "Space Types" },
    { id: "intensity-values", label: "Intensity Values" },
  ] }],
  "Background Data": [{ label: "Registries", sections: [
    { id: "Meter", label: "Meters" },
    { id: "Facility", label: "Facilities" },
    { id: "Customer", label: "Customers" },
  ] }],
};

type SectionContextValue = { page: Page; activeSection: string; setActiveSection: (section: string) => void };
const SectionContext = createContext<SectionContextValue | null>(null);

export function AppSectionProvider({ page, initialSection, children }: { page: Page; initialSection: string; children: ReactNode }) {
  const [activeSection, setActiveSection] = useState(initialSection);
  return <SectionContext.Provider value={{ page, activeSection, setActiveSection }}>{children}</SectionContext.Provider>;
}

export function useAppSection() {
  const context = useContext(SectionContext);
  if (!context) throw new Error("Page sections require AppSectionProvider");
  return context;
}

export function AppSectionNavigation({ mobile = false }: { mobile?: boolean }) {
  const { page, activeSection, setActiveSection } = useAppSection();
  return <nav className={mobile ? "ce-mobile-section-nav" : "ce-section-nav"} aria-label={`${page} sections`}>
    {groups[page].map(group => <div className="ce-section-group" key={group.label}>
      <p className="ce-section-heading">{group.label}</p>
      {group.sections.map(section => <button
        key={section.id}
        type="button"
        className={`ce-section-item ${activeSection === section.id ? "ce-section-item-active" : ""}`}
        aria-pressed={activeSection === section.id}
        onClick={() => setActiveSection(section.id)}
      >{section.label}</button>)}
    </div>)}
  </nav>;
}
