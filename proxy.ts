// Next 16 replaced middleware.ts with proxy.ts. Same role: gate routes before render.

import { type NextRequest, NextResponse } from "next/server";
import { getAppSession } from "@/lib/app-session";

const PUBLIC_ROUTES = new Set<string>(["/", "/about"]);

export async function proxy(request: NextRequest) {
  const { nextUrl } = request;
  const pathname = nextUrl.pathname;

  // API routes authenticate themselves and must return JSON, not an HTML redirect.
  if (pathname.startsWith("/api")) return NextResponse.next();

  if (PUBLIC_ROUTES.has(pathname)) return NextResponse.next();

  const session = await getAppSession();

  if (!session) {
    const callbackUrl = encodeURIComponent(
      `${pathname}${nextUrl.search ?? ""}`
    );

    return NextResponse.redirect(
      new URL(`/?callbackUrl=${callbackUrl}`, request.url)
    );
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml|images|fonts).*)",
  ],
};
