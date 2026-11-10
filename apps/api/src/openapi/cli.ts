import "reflect-metadata";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { CONTROLLERS } from "../controllers.js";
import { assertRoutes, collectRoutes } from "../platform/route-registry.js";
import { renderOpenApi } from "./render.js";

/** `pnpm --filter api openapi`: writes apps/api/openapi.generated.yaml from the route table (no database needed). */
const routes = collectRoutes(CONTROLLERS);
assertRoutes(routes);
const out = fileURLToPath(new URL("../../openapi.generated.yaml", import.meta.url));
await writeFile(out, renderOpenApi(routes));
process.stdout.write(`wrote ${out}\n`);
