import DevUserMenu from "@/dev-only/auth/user-menu";
// app/yearly-data/page.tsx

import Link from "next/link";
// Production authentication: uncomment when enabling Auth.js.
import { redirect } from "next/navigation";
import { signOut } from "@/lib/auth";
import { getAppSession } from "@/lib/app-session";
import { isLocalAuth } from "@/lib/auth-mode";

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

// Production sign-out button: uncomment when enabling sign-out.
import { Button } from "@/components/ui/button";

// Future sidebar links may use CircleHelp and Settings.
// import { CircleHelp, Settings } from "lucide-react";

import { YearlyDataClient } from "./yearly-data-client";
import { AppSectionNavigation, AppSectionProvider } from "@/components/app-section-navigation";
import "./yearlydata.css";

// ============================================================
// NAVIGATION
// ============================================================

const navItems = [
  { label: "Dashboard", icon: Home, href: "/dashboard" },
  { label: "Background Data", icon: Database, href: "/backgrounddata" },
  { label: "Billing", icon: FileText, href: "/billing" },
  { label: "Data Validation", icon: ShieldCheck, href: "/data-validation" },
  { label: "Monthly Data", icon: CalendarDays, href: "/monthly-data" },
  { label: "Yearly Data", icon: Table2, href: "/yearly-data", active: true },
  { label: "Report & Analysis", icon: BarChart3, href: "/reports" },
];

// ============================================================
// PAGE
// ============================================================

export default async function YearlyDataPage() {
  // ==========================================================
  // AUTHENTICATION (selected centrally through AUTH_MODE)
  //
  // When ready to enable production authentication:
  // 1. Uncomment the redirect and auth/signOut imports above.
  // 2. Uncomment the session and redirect code below.
  // 3. Comment out the local development session below.
  // 4. Optionally enable the sign-out form and Button import.
  //
  // IMPORTANT: Never deploy with the local development session
  // enabled. Authentication must be enforced server-side.
  // ==========================================================

  const session = await getAppSession();
  if (!session?.user) {
    redirect("/");
  }

  // ==========================================================
  // LOCAL DEVELOPMENT SESSION (provided centrally when AUTH_MODE=local)
  //
  // Temporary identity for local development only. Disable
  // this entire block before enabling production authentication.
  // ==========================================================

  // Local development sessions are provided by lib/local-session.ts.

  // User display falls back to email or a generic label.
  const displayName =
    session.user.name?.trim() ||
    session.user.email?.trim() ||
    "CUBE User";

  // Avatar initials are derived from the displayed user name.
  const userInitials = displayName
    .split(" ")
    .filter(Boolean)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  return (
    <div className="ce-app yd-app">
      {/* TOP BAR */}
      <header className="ce-topbar">
        <div className="ce-topbar-left">
          <button className="ce-app-grid" aria-label="Application menu">
            {Array.from({ length: 11 }).map((_, index) => (
              <span key={index} />
            ))}
          </button>
          <span className="ce-power-apps">
            Centralized Utility and Billing Environment
          </span>
        </div>

        <div className="ce-topbar-right">
          <button
            className="ce-notification-button"
            aria-label="Notifications"
          >
            <Bell size={21} />
            <span className="ce-notification-count">3</span>
          </button>

          <div className="ce-top-divider" />

          {isLocalAuth ? (
            <DevUserMenu name={displayName} />
          ) : (
            <div className="ce-user">
              <div className="ce-avatar">{userInitials}</div>
              <span className="ce-user-name">{displayName}</span>
              <ChevronDown size={17} />
            </div>
          )}

          {!isLocalAuth && (
            <form
              action={async () => {
                "use server";
                await signOut({ redirectTo: "/" });
              }}
            >
              <Button type="submit" variant="outline" size="sm">
                Sign out
              </Button>
            </form>
          )}

        </div>
      </header>

      {/* APPLICATION BODY */}
      <AppSectionProvider page="Yearly Data" initialSection="category-codes">
      <div className="ce-body">
        <aside className="ce-sidebar">
          <nav className="ce-nav" aria-label="Primary navigation">
            {navItems.map((item) => {
              const Icon = item.icon;
              return (
                <div key={item.label}>
                <Link
                  key={item.label}
                  href={item.href}
                  className={`ce-nav-item ${item.active ? "ce-nav-active" : ""}`}
                >
                  <Icon size={25} />
                  <span>{item.label}</span>
                </Link>
                {item.active && <AppSectionNavigation />}
                </div>
              );
            })}
          </nav>

          {/* FUTURE SIDEBAR ITEMS - NOT ENABLED
              If enabled later, uncomment CircleHelp and Settings
              in the lucide-react imports above.
          */}
          {/*
          <div className="ce-sidebar-footer">
            <Link href="/settings" className="ce-nav-item">
              <Settings size={25} />
              <span>Settings</span>
            </Link>
            <Link href="/help" className="ce-nav-item">
              <CircleHelp size={25} />
              <span>Help</span>
            </Link>
          </div>
          */}
        </aside>

        <main className="ce-main yd-main">
          <section className="yd-title-row">
            <div>
              <p className="bd-eyebrow">Yearly processing</p>
              <h1>Yearly Data</h1>
              <p className="bd-subtitle">
                Manage yearly reference data used by the Centralized Utility
                and Billing Environment.
              </p>
            </div>
          </section>
          <AppSectionNavigation mobile />
          <YearlyDataClient />
        </main>
      </div>
      </AppSectionProvider>
    </div>
  );
}
