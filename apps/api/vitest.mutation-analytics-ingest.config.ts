import swc from "unplugin-swc";
import { defineConfig } from "vitest/config";

// Used only by stryker.analytics-ingest.mjs: the HTTP suite and the unit suite cover ingest; PGlite suites are skipped.
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
      "src/modules/analytics-ingest/test/ingest.http.test.ts",
      "src/modules/analytics-ingest/test/terms-and-boundaries.test.ts",
    ],
    exclude: ["**/.stryker-tmp*/**", "**/node_modules/**"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
