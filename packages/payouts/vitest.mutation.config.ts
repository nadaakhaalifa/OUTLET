import { fileURLToPath } from "node:url";
import { defineConfig, mergeConfig } from "vitest/config";
import base from "./vitest.config.js";

/** Used only by StrykerJS (root `pnpm mutation`): pins the vitest root to this package so `test/**` resolves when Stryker runs from the repo root. */
export default mergeConfig(base, defineConfig({ root: fileURLToPath(new URL(".", import.meta.url)) }));
