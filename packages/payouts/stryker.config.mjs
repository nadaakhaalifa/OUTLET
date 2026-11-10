// Mutation testing for @outlet/payouts (A2.10: score >= 80). Manual/nightly, not part of CI.
// Run from the repo root (the sandbox copy must contain the sibling packages the vitest aliases point at): `pnpm --filter @outlet/payouts mutation`.
import { createRequire } from "node:module";

// pnpm does not hoist the runner next to @stryker-mutator/core, so load it explicitly from the workspace root.
const vitestRunner = createRequire(import.meta.url).resolve("@stryker-mutator/vitest-runner");

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  plugins: [vitestRunner],
  testRunner: "vitest",
  vitest: { configFile: "packages/payouts/vitest.mutation.config.ts", related: false },
  mutate: ["packages/payouts/src/domain/**/*.ts", "packages/payouts/src/application/**/*.ts", "!packages/payouts/src/**/errors.ts"],
  coverageAnalysis: "perTest",
  incremental: false,
  thresholds: { high: 90, low: 80, break: 80 },
  reporters: ["clear-text", "progress", "json"],
  jsonReporter: { fileName: "reports/mutation/payouts.json" },
  tempDirName: ".stryker-tmp",
  cleanTempDir: true,
  concurrency: 2,
  timeoutMS: 60000,
  timeoutFactor: 3,
};
