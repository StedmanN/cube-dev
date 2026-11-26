import "server-only";

export type AuthMode = "cac" | "local";

// TEST-COPY SAFETY BOUNDARY: ignore AUTH_MODE and never initialize a live
// Cognito/CAC session. This remains local even for an optimized Next.js build.
export const AUTH_MODE: AuthMode = "local";
export const isLocalAuth = true;
