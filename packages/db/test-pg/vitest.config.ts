import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const src = (p: string): string => fileURLToPath(new URL(p, import.meta.url));

// Real-Postgres project. Needs DATABASE_URL_DIRECT (+ _APP/_AUTH/_WORKER, optional _MIGRATOR); see README.md.
export default defineConfig({
  resolve: {
    alias: [
      { find: "@outlet/db", replacement: src("../src/index.ts") },
      { find: "@outlet/ids", replacement: src("../../ids/src/index.ts") },
      { find: "@outlet/outbox", replacement: src("../../outbox/src/index.ts") },
      { find: "@outlet/policy", replacement: src("../../policy/src/index.ts") },
      { find: "@outlet/inventory", replacement: src("../../inventory/src/index.ts") },
      { find: "@outlet/ledger", replacement: src("../../ledger/src/index.ts") },
      { find: "@outlet/idempotency", replacement: src("../../idempotency/src/index.ts") },
      { find: "@outlet/money", replacement: src("../../money/src/index.ts") },
    ],
  },
  test: {
    name: "db-pg",
    root: src("."),
    include: ["**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // One file at a time: the files share one database and the concurrency tests want the whole server.
    fileParallelism: false,
  },
});
