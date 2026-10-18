// Mutation testing for the ledger integrity result: freshness state, gauge values, report mapper and recorder
// (master prompt A2.10, ADR-0046 mutation targets). Run from apps/api on Node 24:
//   pnpm exec stryker run stryker.ledger-integrity.mjs
// `break` is the ratchet at the measured score minus a margin; never lower it to make a run pass.
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  testRunner: "vitest",
  plugins: ["@stryker-mutator/vitest-runner"],
  coverageAnalysis: "perTest",
  mutate: [
    "src/modules/ledger/domain/integrity-runs.ts",
    "src/modules/ledger/application/integrity-recorder.ts",
  ],
  vitest: { configFile: "vitest.mutation-ledger-integrity.config.ts" },
  ignorePatterns: ["node_modules", "reports", ".stryker-tmp*", "dist", "build"],
  tempDirName: ".stryker-tmp-ledger-integrity",
  cleanTempDir: true,
  reporters: ["clear-text", "progress", "json"],
  jsonReporter: { fileName: "reports/mutation/ledger-integrity.json" },
  thresholds: { high: 90, low: 80, break: 60 },
  timeoutMS: 30000,
  ignoreStatic: false,
  concurrency: 2,
  tsconfigFile: "tsconfig.json",
  disableTypeChecks: "src/**/*.ts",
};
