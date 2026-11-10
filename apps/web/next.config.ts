import type { NextConfig } from "next";
import { staticSecurityHeaders } from "./src/security/headers";

// The nonce-bearing Content-Security-Policy is set per request in src/proxy.ts (a static header cannot carry a nonce).
// Everything that does not vary per request is declared here.
const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ["@outlet/ui-web", "@outlet/i18n", "@outlet/ui-tokens", "@outlet/money", "@outlet/markets-config"],
  experimental: { globalNotFound: true },
  // Workspace packages are TypeScript source that imports "./x.js"; Turbopack cannot map that to x.ts, webpack can.
  webpack(config: { resolve: { extensionAlias?: Record<string, string[]> } }) {
    config.resolve.extensionAlias = { ...config.resolve.extensionAlias, ".js": [".ts", ".tsx", ".js"] };
    return config;
  },
  headers() {
    return Promise.resolve([{ source: "/:path*", headers: staticSecurityHeaders() }]);
  },
};

export default config;
