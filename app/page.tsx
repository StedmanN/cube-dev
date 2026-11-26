// app/page.tsx

import { Database, IdCard, LockKeyhole, ShieldCheck } from "lucide-react";
import { redirect } from "next/navigation";

import { signIn } from "@/lib/auth";
import { isLocalAuth } from "@/lib/auth-mode";
import { getAppSession } from "@/lib/app-session";
import DevLoginForm from "@/dev-only/auth/login-form";

import "./login.css";

// ============================================================
// LOGIN PAGE
// ============================================================
export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ devLogin?: string | string[] }>;
}) {
  const params = await searchParams;
  const status =
    typeof params.devLogin === "string"
      ? params.devLogin
      : undefined;

  const session = await getAppSession();

  if (session?.user) {
    redirect("/dashboard");
  }

  return (
    <main className="cube-login-page">
      {/* TOP BRAND BAR */}
      <header className="cube-login-topbar">
        <div className="cube-login-brand">
          <div className="cube-login-brand-icon">
            <Database size={21} />
          </div>
          <div>
            <span className="cube-login-brand-name">CUBE</span>
            <span className="cube-login-brand-divider">/</span>
            <span className="cube-login-brand-org">72 ABW</span>
          </div>
        </div>
        <div className="cube-login-security-label">
          <ShieldCheck size={16} />
          <span>{isLocalAuth ? "Local Development Mode" : "CAC Authentication"}</span>
        </div>
      </header>

      {/* LOGIN AREA */}
      <section className="cube-login-content">
        <div className="cube-login-card">
          {/* HEADER */}
          <div className="cube-login-card-header">
            <div className="cube-login-logo">
              <ShieldCheck size={31} />
            </div>
            <p className="cube-login-eyebrow">72nd Air Base Wing</p>
            <h1>
              Centralized Utility
              <br />
              and Billing Environment
            </h1>
            <div className="cube-login-acronym">CUBE</div>
            <p className="cube-login-description">
              Utility management and billing environment for Tinker Air Force Base.
            </p>
          </div>

          {/* AUTHENTICATION */}
          <div className="cube-login-auth">
            <div className="cube-login-auth-heading">
              <IdCard size={20} />
              <div>
                <h2>{isLocalAuth ? "Local Development Sign In" : "CAC Sign In"}</h2>
                <p>
                  {isLocalAuth
                    ? "Use the local development session to continue."
                    : "Insert your Common Access Card and continue to authenticate."}
                </p>
              </div>
            </div>

            {isLocalAuth ? (
              <DevLoginForm status={status} />
            ) : (
              <form
                action={async () => {
                  "use server";
                  await signIn("cognito", { 
                    redirectTo: "/dashboard",
                  });
                }}
              >
                <button type="submit" className="cube-login-button">
                  <IdCard size={19} />
                  <span>Sign in with CAC</span>
                </button>
              </form>
            )}
          </div>

          {/* SECURITY INFORMATION */}
          <div className="cube-login-security">
            <LockKeyhole size={17} />
            <p>
              {isLocalAuth
                ? "Local development authentication is enabled on this computer only."
                : "Your certificate is verified at the load balancer against the DoD trust store. CUBE never receives or stores your private key."}
            </p>
          </div>
        </div>

        {/* FOOTER */}
        <div className="cube-login-footer">
          <span>Centralized Utility and Billing Environment</span>
          <span className="cube-login-footer-dot">{"\u2022"}</span>
          <span>Tinker AFB</span>
        </div>
      </section>
    </main>
  );
}
