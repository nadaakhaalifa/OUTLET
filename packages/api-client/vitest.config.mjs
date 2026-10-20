// Contract tests boot the real Nest app in-process (apps/api harness), which needs the SWC decorator
// transform. Runtime deps are borrowed from apps/api/node_modules, as tooling/pact does.
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const req = createRequire(resolve(here, "../../apps/api/package.json"));
const swcMod = req("unplugin-swc");
const swc = swcMod.default ?? swcMod;

export default {
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
  resolve: { alias: [{ find: /^vitest$/, replacement: resolve(dirname(req.resolve("vitest/package.json")), "dist/index.js") }] },
  server: { fs: { strict: false } },
  test: { root: here, environment: "node", include: ["src/**/*.test.ts"], testTimeout: 30000, hookTimeout: 60000 },
};
