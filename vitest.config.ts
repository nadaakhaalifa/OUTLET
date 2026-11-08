import { defineConfig } from "vitest/config";

// Domain-bearing packages must hold >= 90 percent coverage (master prompt A2.10). Money is the first.
export default defineConfig({
  test: {
    projects: ["packages/*/vitest.config.ts", "tooling/eslint-rules/vitest.config.ts"],
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**/*.ts"],
      exclude: ["**/index.ts"],
      reporter: ["text", "lcov"],
      thresholds: { lines: 90, functions: 90, statements: 90, branches: 90 },
    },
  },
});
