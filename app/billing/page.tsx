import DevUserMenu from "@/dev-only/auth/user-menu";
// app/billing/page.tsx

// Production only: uncomment when enabling authentication.
import { redirect } from "next/navigation";

import { Bell, ChevronDown } from "lucide-react";

// PRODUCTION AUTHENTICATION: Enable these imports together with the
// authentication and sign-out blocks below.
import { signOut } from "@/lib/auth";
import { getAppSession } from "@/lib/app-session";
import { isLocalAuth } from "@/lib/auth-mode";
import { Button } from "@/components/ui/button";

import { BillingClient } from "./billing-client";
import "./billing.css";

// ============================================================
// PAGE
// ============================================================

export default async function BillingPage() {
  // ==========================================================
  // AUTHENTICATION (selected centrally through AUTH_MODE)
  //
  // To enable production authentication:
  // 1. Uncomment the auth/signOut and redirect imports above.
  // 2. Uncomment the session and redirect checks below.
  // 3. Comment out the entire LOCAL DEVELOPMENT SESSION object.
  // 4. Optionally enable the sign-out form and Button import below.
  //
  // The session check must run before rendering protected content.
  // NOTE: Authentication is not currently enforced by this page.
  // ==========================================================

  const session = await getAppSession();
  if (!session?.user) {
    redirect("/");
  }

  // ==========================================================
  // LOCAL DEVELOPMENT SESSION (provided centrally when AUTH_MODE=local)
  //
  // This placeholder session keeps the existing local UI behavior.
  // Disable it before enabling production authentication.
  // Never deploy to production with this session enabled.
  // ==========================================================

  // Local development sessions are provided by lib/local-session.ts.

  const displayName =
    session.user.name?.trim() ||
    session.user.email?.trim() ||
    "CUBE User";

  const userInitials = displayName
    .split(" ")
    .filter(Boolean)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  return (
    <div className="ce-app billing-app">
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

      <BillingClient />
    </div>
  );
}
