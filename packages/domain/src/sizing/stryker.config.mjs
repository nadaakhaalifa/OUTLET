// Mutation testing for the pure fit engine (master prompt A2.10; sizing spec acceptance).
// Run from packages/domain:  pnpm exec stryker run src/sizing/stryker.config.mjs
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  testRunner: "vitest",
  plugins: ["@stryker-mutator/vitest-runner"],
  coverageAnalysis: "perTest",
  mutate: ["src/sizing/fit.ts"],
  ignorePatterns: ["node_modules", "reports", ".stryker-tmp", "dist"],
  tempDirName: ".stryker-tmp-sizing",
  cleanTempDir: true,
  reporters: ["clear-text", "progress", "json"],
  jsonReporter: { fileName: "reports/mutation/sizing.json" },
  thresholds: { high: 80, low: 70, break: 80 },
  timeoutMS: 20000,
  ignoreStatic: false,
  concurrency: 2,
  tsconfigFile: "tsconfig.json",
  disableTypeChecks: "src/**/*.ts",
  vitest: {},
};
