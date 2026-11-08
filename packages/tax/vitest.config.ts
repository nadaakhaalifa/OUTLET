import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const src = (p: string): string => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: "@outlet/money", replacement: src("../money/src/index.ts") },
      { find: "@outlet/markets-config", replacement: src("../markets-config/src/index.ts") },
    ],
  },
  test: { name: "tax", include: ["test/**/*.test.ts"] },
});
