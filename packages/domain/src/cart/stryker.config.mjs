// Mutation testing for the pure cart pricing file (master prompt A2.10 critical pricing code).
// Run from packages/domain:  pnpm exec stryker run src/cart/stryker.config.mjs
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  testRunner: "vitest",
  plugins: ["@stryker-mutator/vitest-runner"],
  coverageAnalysis: "perTest",
  mutate: ["src/cart/pricing.ts", "src/cart/bag-rules.ts"],
  ignorePatterns: ["node_modules", "reports", ".stryker-tmp", "dist"],
  tempDirName: ".stryker-tmp-cart",
  cleanTempDir: true,
  reporters: ["clear-text", "progress", "json"],
  jsonReporter: { fileName: "reports/mutation/cart.json" },
  thresholds: { high: 80, low: 70, break: 80 },
  timeoutMS: 20000,
  ignoreStatic: false,
  concurrency: 1,
  tsconfigFile: "tsconfig.json",
  disableTypeChecks: "src/**/*.ts",
  vitest: {},
};
