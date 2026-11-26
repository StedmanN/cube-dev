import { decodeJwt } from "jose";
import NextAuth, { type NextAuthConfig } from "next-auth";
import Cognito from "next-auth/providers/cognito";
import { isLocalAuth } from "@/lib/auth-mode";

/**
 * Production CAC/Cognito implementation retained for application compatibility.
 *
 * TEST-COPY SAFETY BOUNDARY: lib/auth-mode.ts always selects local auth, all
 * provider values below are loopback-only placeholders, and token refresh exits
 * before fetch. Environment values cannot re-enable the GovCloud provider.
 *
 * The client never touches a certificate here. The chain is:
 *
 *   browser presents CAC
 *     -> captify-tertiary-cac-alb terminates TLS and verifies the cert against
 *        the captify-dod-truststore (16 DoD CAs)
 *     -> nginx forwards the leaf to the captify-auth OIDC IdP
 *     -> that IdP is federated into the "Captify Tertiary Apps" Cognito pool as
 *        the OIDC provider named "CAC"
 *     -> this app is an ordinary OIDC client of that pool
 *
 * The original callback and token handling are otherwise left intact so billing
 * and application behavior are not mixed with this test-copy isolation change.
 */

const REFRESH_LEEWAY_SECONDS = 300;

async function refreshAccessToken(token: Record<string, unknown>) {
  if (isLocalAuth) {
    return { ...token, error: "CognitoDisabledInLocalTestCopy" };
  }

  const domain = "http://127.0.0.1:9";
  const clientId = "COGNITO_DISABLED_IN_LOCAL_TEST_COPY";
  const clientSecret = "COGNITO_DISABLED_IN_LOCAL_TEST_COPY";
  const refreshToken = token.refreshToken as string | undefined;

  if (!domain || !clientId || !refreshToken) {
    return { ...token, error: "RefreshTokenMissingConfig" };
  }

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: clientId,
    refresh_token: refreshToken,
  });

  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
  };
  if (clientSecret) {
    headers.Authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;
  }

  try {
    const res = await fetch(`${domain}/oauth2/token`, { method: "POST", headers, body });
    if (!res.ok) return { ...token, error: "RefreshAccessTokenError" };
    const data = (await res.json()) as {
      access_token?: string;
      id_token?: string;
      refresh_token?: string;
    };
    return {
      ...token,
      accessToken: data.access_token ?? token.accessToken,
      idToken: data.id_token ?? token.idToken,
      // Cognito omits refresh_token on refresh; keep the existing one.
      refreshToken: data.refresh_token ?? refreshToken,
      error: undefined,
    };
  } catch {
    return { ...token, error: "RefreshAccessTokenError" };
  }
}

const config: NextAuthConfig = {
  trustHost: true,
  providers: [
    Cognito({
      // The authentication route is not used in local mode. Loopback-only
      // placeholders make accidental invocation fail closed without reaching AWS.
      clientId: "COGNITO_DISABLED_IN_LOCAL_TEST_COPY",
      clientSecret: "COGNITO_DISABLED_IN_LOCAL_TEST_COPY",
      issuer: "http://127.0.0.1:9",
      checks: ["pkce", "state", "nonce"],
      authorization: {
        params: {
          scope: "openid email profile aws.cognito.signin.user.admin",
        },
      },
    }),
  ],
  callbacks: {
    async jwt({ token, account }) {
      if (account) {
        token.accessToken = account.access_token;
        token.idToken = account.id_token;
        token.refreshToken = account.refresh_token;
        token.id = account.providerAccountId;

        if (account.id_token) {
          try {
            const payload = decodeJwt(account.id_token) as Record<string, unknown>;
            token.groups = (payload["cognito:groups"] as string[]) ?? [];
            token.given_name = payload.given_name as string | undefined;
            token.family_name = payload.family_name as string | undefined;
            token.name = payload.name as string | undefined;
          } catch {
            token.groups = [];
          }
        }
        return token;
      }

      // Cognito ID tokens live one hour, so refresh shortly before expiry.
      if (token.idToken) {
        try {
          const { exp = 0 } = decodeJwt(token.idToken as string);
          if (exp > Date.now() / 1000 + REFRESH_LEEWAY_SECONDS) return token;
          return await refreshAccessToken(token as Record<string, unknown>);
        } catch {
          return {};
        }
      }
      return token;
    },
    async session({ session, token }) {
      if (!token.idToken || token.error) {
        return null as unknown as typeof session;
      }
      session.idToken = token.idToken as string;
      session.accessToken = token.accessToken as string;
      session.user.id = token.id as string;
      session.user.groups = (token.groups as string[]) ?? [];

      const composed = [token.given_name, token.family_name].filter(Boolean).join(" ").trim();
      session.user.name =
        composed ||
        (token.name as string | undefined) ||
        session.user.email ||
        (token.id as string);
      return session;
    },
  },
  pages: {
    signIn: "/",
    error: "/",
  },
};

export const { handlers, signIn, signOut, auth } = NextAuth(config);
