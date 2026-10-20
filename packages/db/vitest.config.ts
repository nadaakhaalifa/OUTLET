import { defineConfig } from "vitest/config";

// PGlite suites boot a WASM Postgres and apply every migration; on a loaded CI runner two of them
// (migration rollback, isolated test-database copies) ran past the 5 s default. Same limits as apps/api.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
