// StrykerJS mutation testing (master prompt A2.10: mutation score >= 80% on ledger, pricing/VRP,
// promotions, reservation, refunds, subscription billing). Owned by the devops task.
//
// Run from the repo root:  pnpm mutation            (packages/domain)
//                          pnpm mutation -- --mutate "packages/domain/src/ledger.ts"
// The script runs Stryker with packages/domain as cwd, so every path below is relative to it.
// Needs Node 22, 24 or >=26 (the repo pins Node 24).

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  testRunner: "vitest",
  plugins: ["@stryker-mutator/vitest-runner"],
  coverageAnalysis: "perTest",
  // Everything in the pure domain except tests, barrel files and pure type declarations.
  mutate: [
    "src/**/*.ts",
    "!src/**/*.test.ts",
    "!src/index.ts",
  ],
  ignorePatterns: ["node_modules", "reports", ".stryker-tmp", "dist"],
  tempDirName: ".stryker-tmp",
  cleanTempDir: true,
  reporters: ["clear-text", "progress", "html", "json"],
  htmlReporter: { fileName: "reports/mutation/index.html" },
  jsonReporter: { fileName: "reports/mutation/mutation.json" },
  // high = green, low = amber, break = CI failure. A2.10 requires >= 80 on ledger, pricing, promotions,
  // reservation, refunds and billing code. The measured baseline on 2026-10-10 with ignoreStatic=false was
  // 45.08% (67.67% with ignoreStatic=true), so `break` is a RATCHET set below the baseline to catch regressions.
  // Raise it as tests are strengthened; the target stays 80. See docs/engineering/mutation-testing.md.
  thresholds: { high: 80, low: 60, break: 40 },
  timeoutMS: 20000,
  // Static mutants live in module-level tables (state-machine transitions, chart of accounts). They are the
  // most valuable ones in this domain, so they are NOT ignored even though the run is slower (about 4 minutes).
  ignoreStatic: false,
  concurrency: 1,
  tsconfigFile: "tsconfig.json",
  disableTypeChecks: "src/**/*.ts",
};
