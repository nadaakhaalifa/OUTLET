// StrykerJS mutation testing for this package (master prompt A2.10). Run: pnpm --filter <pkg> mutation
// Paths are relative to the package directory. See ../../stryker.config.mjs and docs/engineering/mutation-testing.md.

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  testRunner: "vitest",
  plugins: ["@stryker-mutator/vitest-runner"],
  coverageAnalysis: "perTest",
  mutate: [
    "src/**/*.ts",
    "!src/**/*.test.ts",
    "!src/index.ts",
    "!src/test-fixtures.ts",
    "!src/test-helpers.ts",
    "!src/fixtures.ts",
  ],
  ignorePatterns: ["node_modules", "reports", ".stryker-tmp", "dist"],
  tempDirName: ".stryker-tmp",
  cleanTempDir: true,
  reporters: ["clear-text", "progress", "html", "json"],
  htmlReporter: { fileName: "reports/mutation/index.html" },
  jsonReporter: { fileName: "reports/mutation/mutation.json" },
  // high = green, low = amber, break = CI failure (ratchet set at the measured baseline; target 80).
  thresholds: { high: 80, low: 60, break: 52 },
  timeoutMS: 20000,
  ignoreStatic: false,
  concurrency: 1,
  tsconfigFile: "tsconfig.json",
  disableTypeChecks: "src/**/*.ts",
};
