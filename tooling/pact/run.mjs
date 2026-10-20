#!/usr/bin/env node
// CI entry: node tooling/pact/run.mjs [consumer|provider|adapters|all]
// Runs offline. Toolchain (vitest, swc, Nest, supertest) is borrowed from apps/api/node_modules.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const vitest = resolve(here, "../../apps/api/node_modules/.bin/vitest");
if (!existsSync(vitest)) {
  console.error("pact: apps/api/node_modules/.bin/vitest not found. Run `pnpm install` at the repo root first.");
  process.exit(2);
}
const target = process.argv[2] ?? "all";
const filters = { consumer: ["src/consumer"], provider: ["src/provider"], adapters: ["src/adapters"], all: [] };
if (!(target in filters)) {
  console.error(`pact: unknown target "${target}" (consumer|provider|adapters|all)`);
  process.exit(2);
}
const args = ["run", "--config", resolve(here, "vitest.config.mjs"), "--root", here, ...filters[target]];
const r = spawnSync(vitest, args, { stdio: "inherit", cwd: here, env: { ...process.env, NODE_ENV: "test" } });
if (r.status === 0) {
  const pactFile = resolve(here, "pacts/outlet-mobile-outlet-api.json");
  if (existsSync(pactFile)) {
    const p = JSON.parse(readFileSync(pactFile, "utf8"));
    console.log(`pact: ${p.consumer.name} -> ${p.provider.name}: ${p.interactions.length} interactions (v${p.metadata.pactSpecification.version}) at ${pactFile}`);
  }
}
process.exit(r.status ?? 1);
