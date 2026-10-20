// Mutation testing for the promotion stacking, funding and application code (master prompt A2.10:
// promotions need mutation score >= 80%).
// Run from packages/domain:  pnpm exec stryker run stryker.promotions.mjs   (Node 24)
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  testRunner: "vitest",
  plugins: ["@stryker-mutator/vitest-runner"],
  coverageAnalysis: "perTest",
  mutate: [
    "src/promotions/stacking.ts",
    "src/promotions/funding.ts",
    "src/promotions/apply.ts",
    "src/promotions/evaluate.ts",
  ],
  ignorePatterns: ["node_modules", "reports", ".stryker-tmp*", "dist"],
  tempDirName: ".stryker-tmp-promotions",
  cleanTempDir: true,
  reporters: ["clear-text", "progress", "json"],
  jsonReporter: { fileName: "reports/mutation/promotions.json" },
  thresholds: { high: 80, low: 70, break: 87 },
  timeoutMS: 20000,
  ignoreStatic: false,
  concurrency: 2,
  tsconfigFile: "tsconfig.json",
  disableTypeChecks: "src/**/*.ts",
  vitest: {},
};
