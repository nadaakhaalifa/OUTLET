// Mutation testing for the Plus billing calculator, dunning, refund eligibility and lifecycle (master prompt A2.10, spec phase2/01).
// Run from packages/domain (Node 24 pinned):  pnpm exec stryker run stryker.subscriptions.mjs
// `break` is the ratchet; target for critical modules is 80 (ADR-0019). Never lower it to make a run pass.
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  testRunner: "vitest",
  plugins: ["@stryker-mutator/vitest-runner"],
  coverageAnalysis: "perTest",
  mutate: [
    "src/subscriptions/billing.ts",
    "src/subscriptions/rules.ts",
    "src/subscriptions/lifecycle.ts",
  ],
  ignorePatterns: ["node_modules", "reports", ".stryker-tmp*", "dist"],
  tempDirName: ".stryker-tmp-subscriptions",
  cleanTempDir: true,
  reporters: ["clear-text", "progress", "json"],
  jsonReporter: { fileName: "reports/mutation/subscriptions.json" },
  thresholds: { high: 90, low: 80, break: 80 },
  timeoutMS: 20000,
  ignoreStatic: false,
  concurrency: 2,
  tsconfigFile: "tsconfig.json",
  disableTypeChecks: "src/**/*.ts",
};
