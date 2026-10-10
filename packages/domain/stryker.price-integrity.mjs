// Mutation testing for the Price Integrity VRP and enforcement ladder (master prompt A2.10 requires >= 80 on pricing/VRP).
// Run from packages/domain on Node 24:  pnpm exec stryker run stryker.price-integrity.mjs
// `break` is 80, the ADR-0019 floor for critical modules; never lower it to make a run pass.
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  testRunner: "vitest",
  plugins: ["@stryker-mutator/vitest-runner"],
  coverageAnalysis: "perTest",
  mutate: [
    "src/price-integrity/vrp.ts",
    "src/price-integrity/enforcement.ts",
    "!src/price-integrity/**/*.test.ts",
  ],
  ignorePatterns: ["node_modules", "reports", ".stryker-tmp*", "dist", "coverage"],
  tempDirName: ".stryker-tmp-price-integrity",
  cleanTempDir: true,
  reporters: ["clear-text", "progress", "json"],
  jsonReporter: { fileName: "reports/mutation/price-integrity.json" },
  thresholds: { high: 90, low: 80, break: 80 },
  timeoutMS: 20000,
  ignoreStatic: false,
  concurrency: 2,
  tsconfigFile: "tsconfig.json",
  disableTypeChecks: "src/**/*.ts",
};
