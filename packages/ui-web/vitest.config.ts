import { defineConfig } from "vitest/config";
export default defineConfig({
  oxc: { jsx: { runtime: "automatic" } },
  test: { name: "ui-web", include: ["test/**/*.test.{ts,tsx}"], environment: "jsdom", setupFiles: ["./test/setup.ts"], testTimeout: 15_000 },
});
