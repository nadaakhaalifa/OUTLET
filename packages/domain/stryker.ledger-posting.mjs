// Mutation testing for the ledger posting templates, refund allocation, reversal, fingerprint, hash chain and integrity checks (master prompt A2.10, T4, ADR-0019).
// Run from packages/domain on Node 24:  pnpm exec stryker run stryker.ledger-posting.mjs
// `break` is the ratchet: set to the last measured score (see docs/engineering/mutation-testing.md).
// ADR-0019 target for critical modules is 80; never lower this value to make a run pass.
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  testRunner: "vitest",
  plugins: ["@stryker-mutator/vitest-runner"],
  coverageAnalysis: "perTest",
  mutate: [
    "src/ledger-posting/**/*.ts",
    "!src/ledger-posting/**/*.test.ts",
    "!src/ledger-posting/index.ts",
  ],
  ignorePatterns: ["node_modules", "reports", ".stryker-tmp*", "dist"],
  tempDirName: ".stryker-tmp-ledger-posting",
  cleanTempDir: true,
  reporters: ["clear-text", "progress", "json"],
  jsonReporter: { fileName: "reports/mutation/ledger-posting.json" },
  thresholds: { high: 95, low: 85, break: 94 },
  timeoutMS: 20000,
  ignoreStatic: false,
  concurrency: 2,
  tsconfigFile: "tsconfig.json",
  disableTypeChecks: "src/**/*.ts",
};
