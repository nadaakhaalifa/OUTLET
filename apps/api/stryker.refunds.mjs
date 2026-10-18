// Mutation testing for the refund application layer: ledger-first processing, intake and the entry codec
// (master prompt A2.10, ADR-0019 per-module floor with ratchet).
// Run from apps/api on Node 24:  pnpm exec stryker run stryker.refunds.mjs
// `break` is the ratchet at measured score minus margin; never lower it to make a run pass.
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  testRunner: "vitest",
  plugins: ["@stryker-mutator/vitest-runner"],
  coverageAnalysis: "perTest",
  mutate: [
    "src/modules/refunds/application/process.ts",
    "src/modules/refunds/application/intake.ts",
    "src/modules/refunds/application/entry-codec.ts",
    "src/modules/refunds/application/provider.ts",
  ],
  vitest: { configFile: "vitest.mutation-refunds.config.ts" },
  ignorePatterns: ["node_modules", "reports", ".stryker-tmp*", "dist", "build"],
  tempDirName: ".stryker-tmp-refunds",
  cleanTempDir: true,
  reporters: ["clear-text", "progress", "json"],
  jsonReporter: { fileName: "reports/mutation/refunds-application.json" },
  thresholds: { high: 90, low: 80, break: 89 },
  timeoutMS: 30000,
  ignoreStatic: false,
  concurrency: 2,
  tsconfigFile: "tsconfig.json",
  disableTypeChecks: "src/**/*.ts",
};
