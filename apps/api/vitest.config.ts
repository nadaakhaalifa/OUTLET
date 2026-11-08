import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const src = (p: string): string => fileURLToPath(new URL(p, import.meta.url));
const pkg = (name: string): { find: string; replacement: string } => ({ find: `@outlet/${name}`, replacement: src(`../../packages/${name}/src/index.ts`) });

export default defineConfig({
  // NestJS uses legacy (experimental) decorators. Every injection uses an explicit @Inject(token), so no decorator metadata is emitted.
  oxc: { decorator: { legacy: true } },
  resolve: {
    alias: [
      { find: "@outlet/media/testing", replacement: src("../../packages/media/src/testing.ts") },
      { find: "@outlet/db/testing", replacement: src("../../packages/db/src/testing.ts") },
      { find: "@outlet/checkout/testing", replacement: src("../../packages/checkout/src/testing.ts") },
      ...["db", "cart", "checkout", "inventory", "tax", "seller-accounts", "ledger", "ids", "money", "outbox", "policy", "catalog", "auth-core", "flags", "idempotency", "logger", "markets-config", "media", "observability", "pricing-integrity"].map(pkg),
    ],
  },
  // PGlite boots a WASM Postgres and applies every migration per app: same limits as the other PGlite suites.
  test: { name: "api", include: ["test/**/*.test.ts"], testTimeout: 30_000, hookTimeout: 60_000 },
});
