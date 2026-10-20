// Plain object config: this folder has no node_modules, so `vitest/config` is not resolvable from here.
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
  test: {
    root: here,
    environment: "node",
    include: ["src/**/*.test.ts"],
    testTimeout: 30000,
    hookTimeout: 60000,
  },
};
