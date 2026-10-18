// Mutation testing for family-student (master prompt A2.10, ADR-0019 per-module floor with ratchet).
// Run from packages/domain on Node 24:  pnpm exec stryker run stryker.family-student.mjs
// `break` is the ratchet at measured score minus margin; never lower it to make a run pass.
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  testRunner: "vitest",
  plugins: ["@stryker-mutator/vitest-runner"],
  coverageAnalysis: "perTest",
  mutate: [
    "src/subscriptions/family.ts",
    "src/subscriptions/student.ts",
  ],
  ignorePatterns: ["node_modules", "reports", ".stryker-tmp*", "dist"],
  tempDirName: ".stryker-tmp-family-student",
  cleanTempDir: true,
  reporters: ["clear-text", "progress", "json"],
  jsonReporter: { fileName: "reports/mutation/family-student.json" },
  thresholds: { high: 90, low: 80, break: 94 },
  timeoutMS: 20000,
  ignoreStatic: false,
  concurrency: 2,
  tsconfigFile: "tsconfig.json",
  disableTypeChecks: "src/**/*.ts",
};
