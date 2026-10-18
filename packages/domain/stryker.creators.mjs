// Mutation testing for creators (master prompt A2.10, ADR-0019 per-module floor with ratchet).
// Run from packages/domain on Node 24:  pnpm exec stryker run stryker.creators.mjs
// `break` is the ratchet at measured score minus margin; never lower it to make a run pass.
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  testRunner: "vitest",
  plugins: ["@stryker-mutator/vitest-runner"],
  coverageAnalysis: "perTest",
  mutate: [
    "src/creators/accrual-gate.ts",
    "src/creators/attribution.ts",
    "src/creators/commission.ts",
    "src/creators/eligibility.ts",
    "src/creators/fraud.ts",
    "src/creators/machine.ts",
    "src/creators/payout.ts",
  ],
  ignorePatterns: ["node_modules", "reports", ".stryker-tmp*", "dist"],
  tempDirName: ".stryker-tmp-creators",
  cleanTempDir: true,
  reporters: ["clear-text", "progress", "json"],
  jsonReporter: { fileName: "reports/mutation/creators.json" },
  thresholds: { high: 90, low: 80, break: 92 },
  timeoutMS: 20000,
  ignoreStatic: false,
  concurrency: 2,
  tsconfigFile: "tsconfig.json",
  disableTypeChecks: "src/**/*.ts",
};
