// Mutation testing for @outlet/inventory (A2.10: score >= 80). Manual/nightly, not part of CI.
// Run from the repo root (the sandbox copy must contain the sibling packages the vitest aliases point at): `pnpm --filter @outlet/inventory mutation`.
import { createRequire } from "node:module";

// pnpm does not hoist the runner next to @stryker-mutator/core, so load it explicitly from the workspace root.
const vitestRunner = createRequire(import.meta.url).resolve("@stryker-mutator/vitest-runner");

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  plugins: [vitestRunner],
  testRunner: "vitest",
  vitest: { configFile: "packages/inventory/vitest.mutation.config.ts", related: false },
  mutate: ["packages/inventory/src/domain/**/*.ts", "packages/inventory/src/application/**/*.ts", "!packages/inventory/src/**/errors.ts"],
  coverageAnalysis: "perTest",
  incremental: false,
  thresholds: { high: 90, low: 80, break: 80 },
  reporters: ["clear-text", "progress", "json"],
  jsonReporter: { fileName: "reports/mutation/inventory.json" },
  tempDirName: ".stryker-tmp",
  cleanTempDir: true,
  concurrency: 2,
  timeoutMS: 60000,
  timeoutFactor: 3,
};
