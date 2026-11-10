import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const src = (p: string): string => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: "@outlet/db/testing", replacement: src("../db/src/testing.ts") },
      { find: "@outlet/db", replacement: src("../db/src/index.ts") },
      { find: "@outlet/money", replacement: src("../money/src/index.ts") },
      { find: "@outlet/orders", replacement: src("../orders/src/index.ts") },
      { find: "@outlet/ids", replacement: src("../ids/src/index.ts") },
      { find: "@outlet/inventory", replacement: src("../inventory/src/index.ts") },
      { find: "@outlet/ledger", replacement: src("../ledger/src/index.ts") },
      { find: "@outlet/outbox", replacement: src("../outbox/src/index.ts") },
      { find: "@outlet/tax", replacement: src("../tax/src/index.ts") },
      { find: "@outlet/markets-config", replacement: src("../markets-config/src/index.ts") },
      { find: "@outlet/promotions/testing", replacement: src("../promotions/src/testing.ts") },
      { find: "@outlet/promotions", replacement: src("../promotions/src/index.ts") },
      { find: "@outlet/shipping", replacement: src("../shipping/src/index.ts") },
      { find: "@outlet/flags", replacement: src("../flags/src/index.ts") },
      { find: "@outlet/policy", replacement: src("../policy/src/index.ts") },
      { find: "@outlet/idempotency", replacement: src("../idempotency/src/index.ts") },
      { find: "@outlet/returns/testing", replacement: src("../returns/src/testing.ts") },
      { find: "@outlet/returns", replacement: src("../returns/src/index.ts") },
      { find: "@outlet/admin-access", replacement: src("../admin-access/src/index.ts") },
      { find: "@outlet/audit-log", replacement: src("../audit-log/src/index.ts") },
      { find: "@outlet/payouts", replacement: src("../payouts/src/index.ts") },
    ],
  },
  test: { name: "checkout", include: ["test/**/*.test.ts"], testTimeout: 60_000, hookTimeout: 60_000 },
});
