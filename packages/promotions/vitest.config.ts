import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const src = (p: string): string => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: "@outlet/db/testing", replacement: src("../db/src/testing.ts") },
      { find: "@outlet/db", replacement: src("../db/src/index.ts") },
      { find: "@outlet/ids", replacement: src("../ids/src/index.ts") },
      { find: "@outlet/markets-config", replacement: src("../markets-config/src/index.ts") },
      { find: "@outlet/money", replacement: src("../money/src/index.ts") },
      { find: "@outlet/policy", replacement: src("../policy/src/index.ts") },
      { find: "@outlet/tax", replacement: src("../tax/src/index.ts") },
    ],
  },
  test: { name: "promotions", include: ["test/**/*.test.ts"], testTimeout: 60_000, hookTimeout: 60_000 },
});
