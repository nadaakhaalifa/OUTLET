// Mutation testing for store-theme (master prompt A2.10, ADR-0019 per-module floor with ratchet).
// Run from packages/domain on Node 24:  pnpm exec stryker run stryker.store-theme.mjs
// `break` is the ratchet at measured score minus margin; never lower it to make a run pass.
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  testRunner: "vitest",
  plugins: ["@stryker-mutator/vitest-runner"],
  coverageAnalysis: "perTest",
  mutate: [
    "src/store-theme/contrast.ts",
    "src/store-theme/suggest.ts",
    "src/store-theme/copy-guard.ts",
    "src/store-theme/validate.ts",
  ],
  ignorePatterns: ["node_modules", "reports", ".stryker-tmp*", "dist"],
  tempDirName: ".stryker-tmp-store-theme",
  cleanTempDir: true,
  reporters: ["clear-text", "progress", "json"],
  jsonReporter: { fileName: "reports/mutation/store-theme.json" },
  thresholds: { high: 90, low: 80, break: 86 },
  timeoutMS: 20000,
  ignoreStatic: false,
  concurrency: 2,
  tsconfigFile: "tsconfig.json",
  disableTypeChecks: "src/**/*.ts",
};
