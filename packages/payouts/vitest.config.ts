import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const src = (p: string): string => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: "@outlet/db/testing", replacement: src("../db/src/testing.ts") },
      { find: "@outlet/db", replacement: src("../db/src/index.ts") },
      { find: "@outlet/ids", replacement: src("../ids/src/index.ts") },
      { find: "@outlet/money", replacement: src("../money/src/index.ts") },
      { find: "@outlet/outbox", replacement: src("../outbox/src/index.ts") },
      { find: "@outlet/idempotency", replacement: src("../idempotency/src/index.ts") },
      { find: "@outlet/ledger", replacement: src("../ledger/src/index.ts") },
      { find: "@outlet/orders", replacement: src("../orders/src/index.ts") },
      { find: "@outlet/policy", replacement: src("../policy/src/index.ts") },
      { find: "@outlet/audit-log", replacement: src("../audit-log/src/index.ts") },
      { find: "@outlet/logger", replacement: src("../logger/src/index.ts") },
      { find: "@outlet/admin-access", replacement: src("../admin-access/src/index.ts") },
    ],
  },
  test: { name: "payouts", include: ["test/**/*.test.ts"], testTimeout: 60_000, hookTimeout: 60_000 },
});
