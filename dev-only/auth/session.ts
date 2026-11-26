import "server-only";

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { SignJWT, jwtVerify } from "jose";
import { cookies, headers } from "next/headers";
import type { Session } from "next-auth";

import { isLocalAuth } from "@/lib/auth-mode";
import { verifyDevCredentials } from "./users.mjs";

const COOKIE_NAME = "cube-dev-session";
const SESSION_SECONDS = 8 * 60 * 60;
const ISSUER = "cube-dev";
const AUDIENCE = "cube-dev";

type DevUser = {
  username: string;
  name?: string;
  email?: string;
  passwordHash: string;
  enabled: boolean;
  groups?: string[];
};

async function signingKey() {
  const secret = (
    await readFile(
      resolve(process.cwd(), ".dev-auth", "session-secret"),
      "utf8",
    )
  ).trim();

  if (!/^[a-f0-9]{64}$/.test(secret)) {
    throw new Error("Invalid dev session secret.");
  }

  return Buffer.from(secret, "hex");
}

async function findUser(username: string): Promise<DevUser | null> {
  const config = JSON.parse(
    await readFile(
      resolve(process.cwd(), ".dev-auth", "users.json"),
      "utf8",
    ),
  );

  if (!Array.isArray(config.users)) return null;

  const matches = config.users.filter(
    (user: DevUser) =>
      typeof user?.username === "string" &&
      user.username.trim().toLowerCase() ===
        username.trim().toLowerCase(),
  );

  if (matches.length !== 1) return null;

  const user = matches[0] as DevUser;

  return user.enabled === true &&
    typeof user.passwordHash === "string"
    ? user
    : null;
}

function passwordVersion(user: DevUser) {
  return createHash("sha256")
    .update(user.passwordHash)
    .digest("hex");
}

async function cookieOptions() {
  const host = (await headers()).get("host") ?? "";
  const loopback =
    /^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(host);

  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: !loopback,
    path: "/",
  };
}

export async function startDevSession(
  username: string,
  password: string,
): Promise<boolean> {
  if (!isLocalAuth) throw new Error("Dev login is disabled.");

  const user = await findUser(username);
  const verified = await verifyDevCredentials(username, password);

  if (!user || !verified) return false;

  const token = await new SignJWT({
    passwordVersion: passwordVersion(user),
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(user.username)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime("8h")
    .sign(await signingKey());

  (await cookies()).set(COOKIE_NAME, token, {
    ...(await cookieOptions()),
    maxAge: SESSION_SECONDS,
  });

  return true;
}

export async function getDevSession(): Promise<Session | null> {
  if (!isLocalAuth) return null;

  const token = (await cookies()).get(COOKIE_NAME)?.value;
  if (!token) return null;

  try {
    const { payload } = await jwtVerify(token, await signingKey(), {
      algorithms: ["HS256"],
      issuer: ISSUER,
      audience: AUDIENCE,
      requiredClaims: ["sub", "exp", "iat", "passwordVersion"],
    });

    const user = await findUser(payload.sub!);

    if (
      !user ||
      payload.passwordVersion !== passwordVersion(user)
    ) {
      return null;
    }

    return {
      expires: new Date(payload.exp! * 1000).toISOString(),
      user: {
        id: `dev:${user.username}`,
        name: user.name || user.username,
        email: user.email || null,
        groups: Array.isArray(user.groups)
          ? user.groups.filter((group) => typeof group === "string")
          : [],
      },
    };
  } catch {
    return null;
  }
}

export async function endDevSession() {
  if (!isLocalAuth) throw new Error("Dev login is disabled.");

  (await cookies()).set(COOKIE_NAME, "", {
    ...(await cookieOptions()),
    maxAge: 0,
  });
}