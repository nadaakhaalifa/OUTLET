import { defineConfig } from "vitest/config";

// Domain-bearing packages must hold >= 90 percent coverage (master prompt A2.10). Money is the first.
export default defineConfig({
  test: {
    projects: ["packages/*/vitest.config.ts", "apps/*/vitest.config.ts", "tooling/eslint-rules/vitest.config.ts"],
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**/*.ts", "packages/*/src/**/*.tsx", "apps/*/src/**/*.ts", "apps/*/src/**/*.tsx"],
      exclude: ["**/index.ts", "**/*.d.ts", "**/testing.ts", "**/cli.ts", "apps/web/src/app/**", "apps/web/src/fonts/**", "apps/web/src/components/ui.tsx"],
      reporter: ["text", "lcov"],
      thresholds: { lines: 90, functions: 90, statements: 90, branches: 90 },
    },
  },
});
