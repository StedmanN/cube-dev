import "server-only";

import { auth } from "@/lib/auth";
import { isLocalAuth } from "@/lib/auth-mode";

// DEV ONLY: exclude this connection from production promotion.
import { getDevSession } from "@/dev-only/auth/session";

export async function getAppSession() {
  if (isLocalAuth) return getDevSession();
  return auth();
}

export async function requireAppSession() {
  const session = await getAppSession();
  return session?.user ? session : null;
}