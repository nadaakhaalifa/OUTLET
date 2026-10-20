import swc from "unplugin-swc";
import { defineConfig } from "vitest/config";

// Used only by stryker.ledger-integrity.mjs: the state function, the report mapper and the recorder are
// exercised by the in-memory unit tests, so the mutation run skips the PGlite and HTTP suites.
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
    include: ["src/modules/ledger/application/integrity-recorder.test.ts"],
    exclude: ["**/.stryker-tmp*/**", "**/node_modules/**"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
