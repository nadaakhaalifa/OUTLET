import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const src = (p: string): string => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: "@outlet/db/testing", replacement: src("../db/src/testing.ts") },
      { find: "@outlet/db", replacement: src("../db/src/index.ts") },
      { find: "@outlet/ids", replacement: src("../ids/src/index.ts") },
      { find: "@outlet/logger", replacement: src("../logger/src/index.ts") },
      { find: "@outlet/money", replacement: src("../money/src/index.ts") },
      { find: "@outlet/outbox", replacement: src("../outbox/src/index.ts") },
      { find: "@outlet/privacy", replacement: src("../privacy/src/index.ts") },
    ],
  },
  test: { name: "notifications", include: ["test/**/*.test.ts"], testTimeout: 30_000, hookTimeout: 60_000 },
});
