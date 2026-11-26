"use server";

import { redirect } from "next/navigation";

import { isLocalAuth } from "@/lib/auth-mode";
import {
  startDevSession,
  endDevSession,
} from "./session";

type LoginLimits = {
  windowStarted: number;
  attempts: number;
  usernames: Map<string, number>;
  inFlight: number;
};

const serverState = globalThis as typeof globalThis & {
  cubeDevLoginLimits?: LoginLimits;
};

const limits = (serverState.cubeDevLoginLimits ??= {
  windowStarted: Date.now(),
  attempts: 0,
  usernames: new Map<string, number>(),
  inFlight: 0,
});

export async function devLogin(formData: FormData) {
  if (!isLocalAuth) {
    throw new Error("Dev login is disabled.");
  }

  const username = formData.get("username");
  const password = formData.get("password");

  if (
    typeof username !== "string" ||
    typeof password !== "string" ||
    !username.trim() ||
    username.length > 100 ||
    !password ||
    password.length > 1024
  ) {
    redirect("/?devLogin=failed");
  }

  const now = Date.now();

  if (now - limits.windowStarted >= 15 * 60 * 1000) {
    limits.windowStarted = now;
    limits.attempts = 0;
    limits.usernames.clear();
  }

  const key = username.trim().toLowerCase();
  const attempts = limits.usernames.get(key) ?? 0;

  if (
    limits.attempts >= 50 ||
    attempts >= 10 ||
    limits.inFlight >= 2
  ) {
    redirect("/?devLogin=limited");
  }

  limits.attempts += 1;
  limits.usernames.set(key, attempts + 1);
  limits.inFlight += 1;

  let signedIn = false;

  try {
    signedIn = await startDevSession(username.trim(), password);
  } catch {
    console.error("Dev sign-in failed. Check the private auth configuration.");
  } finally {
    limits.inFlight -= 1;
  }

  if (!signedIn) {
    redirect("/?devLogin=failed");
  }

  redirect("/dashboard");
}

export async function devLogout() {
  await endDevSession();
  redirect("/");
}