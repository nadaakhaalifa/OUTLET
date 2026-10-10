// Mutation testing for the inventory reservation, claim, pool and TTL domain (master prompt A2.10, ADR-0019 per-module floor with ratchet).
// Run from packages/domain on Node 24:  pnpm exec stryker run stryker.inventory.mjs
// `break` is the ratchet: set to the last measured score (see docs/engineering/mutation-testing.md).
// ADR-0019 target for critical modules is 80; never lower this value to make a run pass.
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  testRunner: "vitest",
  plugins: ["@stryker-mutator/vitest-runner"],
  coverageAnalysis: "perTest",
  mutate: [
    "src/inventory/**/*.ts",
    "!src/inventory/**/*.test.ts",
    "!src/inventory/index.ts",
    "!src/inventory/types.ts",
  ],
  ignorePatterns: ["node_modules", "reports", ".stryker-tmp*", "dist"],
  tempDirName: ".stryker-tmp-inventory",
  cleanTempDir: true,
  reporters: ["clear-text", "progress", "json"],
  jsonReporter: { fileName: "reports/mutation/inventory.json" },
  thresholds: { high: 80, low: 60, break: 71 },
  timeoutMS: 20000,
  ignoreStatic: false,
  concurrency: 2,
  tsconfigFile: "tsconfig.json",
  disableTypeChecks: "src/**/*.ts",
};
