import type { NextConfig } from "next";

// Same baseline headers the rest of the estate sets. HSTS is safe to send here
// because the ALB terminates TLS and nginx only ever receives proxied HTTPS.
const securityHeaders = [
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];

const nextConfig: NextConfig = {
  // Permit this development server to serve Next.js assets through the tunnel.
  allowedDevOrigins: ["dev-cube.scn1993.com"],
  output: "standalone",
  // An integration run uses a separate compiler/output lock so it cannot
  // interfere with a developer's already-running CUBE server.
  distDir: process.env.CUBE_RP_INTEGRATION_TEST_NAMESPACE
    ? ".next-rp-integration-test"
    : ".next",
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
