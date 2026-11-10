import type { NextConfig } from "next";
import { staticSecurityHeaders } from "./src/security/headers";

// The nonce-bearing Content-Security-Policy is set per request in src/proxy.ts. Everything static is declared here.
const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ["@outlet/i18n", "@outlet/ui-tokens", "@outlet/money", "@outlet/markets-config"],
  experimental: { globalNotFound: true },
  webpack(config: { resolve: { extensionAlias?: Record<string, string[]> } }) {
    config.resolve.extensionAlias = { ...config.resolve.extensionAlias, ".js": [".ts", ".tsx", ".js"] };
    return config;
  },
  headers() {
    return Promise.resolve([{ source: "/:path*", headers: staticSecurityHeaders() }]);
  },
};

export default config;
