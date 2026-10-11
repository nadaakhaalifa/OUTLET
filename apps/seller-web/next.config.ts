import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Workspace packages ship TypeScript source (main: src/index.ts).
  transpilePackages: ["@outlet/domain", "@outlet/i18n", "@outlet/ui-tokens", "@outlet/validation"],
};

export default config;
