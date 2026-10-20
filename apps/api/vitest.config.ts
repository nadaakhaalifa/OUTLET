import swc from "unplugin-swc";
import { defineConfig } from "vitest/config";

// NestJS needs legacy decorators and emitted decorator metadata, which esbuild does not provide.
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
  // PGlite suites boot a WASM Postgres and apply ~46 migrations; under `pnpm -r test` the machine
  // runs every package at once, which made a few of them miss the 5 s / 10 s defaults.
  // maxWorkers: every PGlite file boots its own WASM Postgres (CPU bound). With one worker per core the
  // full suite starved itself and heavy migrations/load tests missed their timeouts; capping at half the
  // cores keeps per-file wall time stable without raising any individual timeout.
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    maxWorkers: 4,
    minWorkers: 1,
  },
});
