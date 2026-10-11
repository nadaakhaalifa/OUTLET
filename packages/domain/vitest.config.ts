import { configDefaults, defineConfig } from "vitest/config";

// Stryker copies the package into .stryker-tmp-* sandboxes; never collect tests from them.
export default defineConfig({
  test: { exclude: [...configDefaults.exclude, "**/.stryker-tmp*/**"] },
});
