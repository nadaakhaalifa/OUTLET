import { defineConfig } from "vitest/config";
export default defineConfig({ test: { name: "ui-tokens", include: ["test/**/*.test.ts"], testTimeout: 30_000 } });
