// Mutation testing for client analytics ingest validation, the consent re-check branch, term handling and producers
// (dashboard foundations track 5). Run from apps/api:  pnpm exec stryker run stryker.analytics-ingest.mjs
// `break` is the ratchet at measured score minus margin; never lower it to make a run pass.
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  testRunner: "vitest",
  plugins: ["@stryker-mutator/vitest-runner"],
  coverageAnalysis: "perTest",
  mutate: [
    "src/modules/analytics-ingest/application/ingest-batch.ts",
    "src/modules/analytics-ingest/domain/client-events.ts",
    "src/modules/analytics-ingest/domain/terms.ts",
    "src/modules/analytics-ingest/domain/producers.ts",
  ],
  vitest: { configFile: "vitest.mutation-analytics-ingest.config.ts" },
  ignorePatterns: ["node_modules", "reports", ".stryker-tmp*", "dist", "build"],
  tempDirName: ".stryker-tmp-analytics-ingest",
  cleanTempDir: true,
  reporters: ["clear-text", "progress", "json"],
  jsonReporter: { fileName: "reports/mutation/analytics-ingest.json" },
  thresholds: { high: 90, low: 80, break: 0 },
  timeoutMS: 30000,
  ignoreStatic: false,
  concurrency: 2,
  tsconfigFile: "tsconfig.json",
  disableTypeChecks: "src/**/*.ts",
};
