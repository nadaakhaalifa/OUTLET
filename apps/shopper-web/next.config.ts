import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Workspace packages ship TypeScript source (main: src/index.ts).
  transpilePackages: ["@outlet/api-client", "@outlet/i18n", "@outlet/ui-tokens"],
  // Build-time SRI hashes on scripts, on top of the per-request CSP nonce (src/csp.ts).
  experimental: { sri: { algorithm: "sha384" } },
};

export default config;
