import { defineConfig } from "vitest/config";

// Domain-bearing packages must hold >= 90 percent coverage (master prompt A2.10). Money is the first.
export default defineConfig({
  test: {
    projects: ["packages/*/vitest.config.ts", "apps/*/vitest.config.ts", "tooling/eslint-rules/vitest.config.ts", "tooling/privacy/vitest.config.ts",
      // Real-Postgres suite: only when a server is provided (CI job postgres-integration, or a local database).
      ...(process.env.DATABASE_URL_DIRECT ? ["packages/db/test-pg/vitest.config.ts"] : []),
    ],
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**/*.ts", "packages/*/src/**/*.tsx", "apps/*/src/**/*.ts", "apps/*/src/**/*.tsx"],
      exclude: ["**/index.ts", "**/*.d.ts", "**/testing.ts", "**/cli.ts", "apps/web/src/app/**", "apps/seller/src/app/**", "apps/web/src/fonts/**", "apps/web/src/components/ui.tsx"],
      reporter: ["text", "lcov"],
      thresholds: { lines: 90, functions: 90, statements: 90, branches: 90 },
    },
  },
});
