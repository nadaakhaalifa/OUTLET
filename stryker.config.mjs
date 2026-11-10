// Mutation testing (A2.10: score >= 80 on ledger, pricing, promotions, reservation, refunds, subscription billing, payouts).
// One package at a time: `pnpm mutation` runs the payouts scope below. Add the next package by overriding `mutate` and the vitest config
// on the command line (`pnpm mutation --mutate "packages/x/src/**/*.ts" --vitest.configFile packages/x/vitest.config.ts`).
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  testRunner: "command",
  commandRunner: { command: "pnpm exec vitest run --config packages/payouts/vitest.mutation.config.ts --bail 1" },
  mutate: [
    "packages/payouts/src/domain/netting.ts",
    "packages/payouts/src/domain/eligibility.ts",
    "packages/payouts/src/application/payout-service.ts",
  ],
  coverageAnalysis: "off",
  // SQL text, error messages and audit/event names are string literals; they are exercised end to end by the PGlite integration tests (a wrong
  // string fails the query or the assertion) but mutating each one costs a full suite run, so StringLiteral is excluded.
  mutator: { excludedMutations: ["StringLiteral"] },
  thresholds: { high: 90, low: 80, break: 80 },
  reporters: ["clear-text", "progress", "json"],
  jsonReporter: { fileName: "reports/mutation/mutation.json" },
  tempDirName: ".stryker-tmp",
  cleanTempDir: true,
  concurrency: 4,
  timeoutMS: 60000,
  timeoutFactor: 3,
};
