import swc from "unplugin-swc";
import { defineConfig } from "vitest/config";

// Used only by stryker.refunds.mjs: the refund application layer is exercised by the in-memory flow tests,
// so the mutation run skips the PGlite and HTTP suites (they boot a WASM Postgres and a Nest app).
export default defineConfig({
  plugins: [
    swc.vite({
      module: { type: "es6" },
      jsc: {
        target: "es2022",
        parser: { syntax: "typescript", decorators: true },
        transform: { legacyDecorator: true, decoratorMetadata: true },
      },
    }),
  ],
  test: {
    environment: "node",
    include: [
      "src/modules/refunds/test/flow.test.ts",
      "src/modules/refunds/test/in-memory.contract.test.ts",
      "src/modules/refunds/test/intent-contract.test.ts",
      "src/modules/refunds/test/*.mutation.test.ts",
    ],
    exclude: ["**/.stryker-tmp*/**", "**/node_modules/**"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
