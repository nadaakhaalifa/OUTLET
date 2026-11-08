import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
export default defineConfig({ test: { name: "privacy", root: dirname(fileURLToPath(import.meta.url)), include: ["*.test.mjs"] } });
