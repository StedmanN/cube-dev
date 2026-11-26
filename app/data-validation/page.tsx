import DevUserMenu from "@/dev-only/auth/user-menu";
// app/data-validation/page.tsx

import Link from "next/link";
import { redirect } from "next/navigation";
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

// PRODUCTION AUTHENTICATION:
// Uncomment this import and the production session block below when ready.
import { signOut } from "@/lib/auth";
import { getAppSession } from "@/lib/app-session";
import { isLocalAuth } from "@/lib/auth-mode";

// PRODUCTION SIGN OUT:
// Uncomment this import when enabling the sign-out form below.
import { Button } from "@/components/ui/button";

import { DataValidationClient } from "./data-validation-client";
import "./datavalidation.css";

export const dynamic = "force-dynamic";
export const revalidate = 0;

// ============================================================
// NAVIGATION
// ============================================================

const navItems = [
  { label: "Dashboard", icon: Home, href: "/dashboard" },
  { label: "Background Data", icon: Database, href: "/backgrounddata" },
  { label: "Billing", icon: FileText, href: "/billing" },
  { label: "Data Validation", icon: ShieldCheck, href: "/data-validation", active: true },
  { label: "Monthly Data", icon: CalendarDays, href: "/monthly-data" },
  { label: "Yearly Data", icon: Table2, href: "/yearly-data" },
  { label: "Report & Analysis", icon: BarChart3, href: "/reports" },
];

// ============================================================
// PAGE
// ============================================================

export default async function DataValidationPage() {
  // ==========================================================
  // AUTHENTICATION (selected centrally through AUTH_MODE)
  //
  // When ready for production:
  // 1. Uncomment the auth/signOut import at the top of this file.
  // 2. Comment out the local development session below.
  // 3. Uncomment the session and redirect statements here.
  // 4. Optionally enable the sign-out form and Button import.
  //
  // Authentication must run before rendering protected content.
  // ==========================================================

  const session = await getAppSession();
  if (!session?.user) {
    redirect("/");
  }

  // ==========================================================
  // LOCAL DEVELOPMENT SESSION (provided centrally when AUTH_MODE=local)
  //
  // Retained for local development without CAC/Cognito sign-in.
  // Disable this entire block before enabling production auth.
  // NEVER deploy to production with this session enabled.
  // ==========================================================

  // Local development sessions are provided by lib/local-session.ts.

  // Prefer the session name, then email, then a generic label.
  const displayName =
    session.user.name?.trim() ||
    session.user.email?.trim() ||
    "CUBE User";

  // User avatar initials in the application header.
  const userInitials = displayName
    .split(" ")
    .filter(Boolean)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  return (
    <div className="ce-app dv-app">
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
          {/* NOTIFICATIONS */}
          <button
            className="ce-notification-button"
            aria-label="Notifications"
          >
            <Bell size={21} />
            <span className="ce-notification-count">3</span>
          </button>

          <div className="ce-top-divider" />

          {/* USER DISPLAY */}
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
      <div className="ce-body">
        {/* SIDEBAR */}
        <aside className="ce-sidebar">
          <nav className="ce-nav" aria-label="Primary navigation">
            {navItems.map((item) => {
              const Icon = item.icon;
              return (
                <Link
                  key={item.label}
                  href={item.href}
                  className={`ce-nav-item ${item.active ? "ce-nav-active" : ""}`}
                >
                  <Icon size={25} />
                  <span>{item.label}</span>
                </Link>
              );
            })}
          </nav>

          {/* FUTURE SIDEBAR ITEMS - CURRENTLY DISABLED */}
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

        {/* MAIN CONTENT */}
        <main className="ce-main dv-main">
          <section className="dv-title-row">
            <div>
              <p className="dv-eyebrow">Monthly processing</p>
              <h1>Data Validation</h1>
              <p className="dv-subtitle">
                Review meter-reading deviations by billing period and correct
                records that require attention.
              </p>
            </div>
          </section>

          <DataValidationClient />
        </main>
      </div>
    </div>
  );
}
