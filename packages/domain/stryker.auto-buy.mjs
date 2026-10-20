// Mutation testing for auto-buy (master prompt A2.10, ADR-0019 per-module floor with ratchet).
// Run from packages/domain on Node 24:  pnpm exec stryker run stryker.auto-buy.mjs
// `break` is the ratchet at measured score minus margin; never lower it to make a run pass.
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  testRunner: "vitest",
  plugins: ["@stryker-mutator/vitest-runner"],
  coverageAnalysis: "perTest",
  mutate: [
    "src/auto-buy/attempt.ts",
    "src/auto-buy/charge.ts",
    "src/auto-buy/terms.ts",
    "src/auto-buy/trigger.ts",
  ],
  ignorePatterns: ["node_modules", "reports", ".stryker-tmp*", "dist"],
  tempDirName: ".stryker-tmp-auto-buy",
  cleanTempDir: true,
  reporters: ["clear-text", "progress", "json"],
  jsonReporter: { fileName: "reports/mutation/auto-buy.json" },
  thresholds: { high: 90, low: 80, break: 97 },
  timeoutMS: 20000,
  ignoreStatic: false,
  concurrency: 2,
  tsconfigFile: "tsconfig.json",
  disableTypeChecks: "src/**/*.ts",
};
