import type { DefaultSession } from "next-auth";

declare module "next-auth" {
  interface Session {
    idToken?: string;
    accessToken?: string;
    user: {
      id: string;
      groups: string[];
    } & DefaultSession["user"];
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    id?: string;
    idToken?: string;
    accessToken?: string;
    refreshToken?: string;
    groups?: string[];
    given_name?: string;
    family_name?: string;
    error?: string;
  }
}
