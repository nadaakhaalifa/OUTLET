// Mutation testing for @outlet/ledger (A2.10: score >= 80). Manual/nightly, not part of CI.
// Run from the repo root (the sandbox copy must contain the sibling packages the vitest aliases point at): `pnpm --filter @outlet/ledger mutation`.
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  testRunner: "command",
  commandRunner: { command: "pnpm exec vitest run --config packages/ledger/vitest.mutation.config.ts --bail 1" },
  mutate: ["packages/ledger/src/domain/**/*.ts", "packages/ledger/src/application/**/*.ts", "!packages/ledger/src/**/errors.ts"],
  coverageAnalysis: "off",
  incremental: false,
  thresholds: { high: 90, low: 80, break: 80 },
  reporters: ["clear-text", "progress", "json"],
  jsonReporter: { fileName: "reports/mutation/ledger.json" },
  tempDirName: ".stryker-tmp",
  cleanTempDir: true,
  concurrency: 2,
  timeoutMS: 60000,
  timeoutFactor: 3,
};
