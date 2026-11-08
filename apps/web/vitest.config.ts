import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const src = (p: string): string => fileURLToPath(new URL(p, import.meta.url));
const pkg = (name: string): { find: string; replacement: string } => ({ find: `@outlet/${name}`, replacement: src(`../../packages/${name}/src/index.ts`) });

export default defineConfig({
  // test/bff-contract.test.ts boots the real API test app (NestJS, legacy decorators, workspace packages from source), like apps/api does.
  oxc: { jsx: { runtime: "automatic" }, decorator: { legacy: true } },
  resolve: {
    alias: [
      // next/headers, next/navigation etc. are mocked per test; server-only guard is not needed under jsdom.
      { find: "@", replacement: src("./src") },
      { find: "@outlet/media/testing", replacement: src("../../packages/media/src/testing.ts") },
      { find: "@outlet/db/testing", replacement: src("../../packages/db/src/testing.ts") },
      { find: "@outlet/checkout/testing", replacement: src("../../packages/checkout/src/testing.ts") },
      { find: "@outlet/returns/testing", replacement: src("../../packages/returns/src/testing.ts") },
      { find: "@outlet/seller-accounts/testing", replacement: src("../../packages/seller-accounts/src/testing.ts") },
      { find: "@outlet/shipping/testing", replacement: src("../../packages/shipping/src/testing.ts") },
      ...["db", "cart", "checkout", "inventory", "tax", "seller-accounts", "returns", "shipping", "ledger", "ids", "outbox", "policy", "catalog", "auth-core", "flags", "idempotency", "logger", "media", "observability", "pricing-integrity"].map(pkg),
    ],
  },
  test: {
    name: "web",
    include: ["test/**/*.test.{ts,tsx}"],
    environment: "jsdom",
    setupFiles: ["./test/setup.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
