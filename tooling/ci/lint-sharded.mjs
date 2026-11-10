#!/usr/bin/env node
// Runs eslint one workspace at a time so the typed-lint program never holds every package in one heap.
// A single `eslint .` over the monorepo ran out of memory on the CI runner (6 GB) once the Admin Console,
// reporting and ops-attention packages landed. Same rules, same cache; the exit code is non-zero if any shard fails.
import { spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const shards = [];
for (const group of ["apps", "packages"]) {
  for (const name of readdirSync(join(root, group)).sort()) {
    const dir = join(group, name);
    if (statSync(join(root, dir)).isDirectory()) shards.push(dir);
  }
}
shards.push("tooling");
// Root-level config and script files (eslint.config.mjs, vitest.config.ts, ...) in their own shard.
shards.push(".");

const extraArgs = process.argv.slice(2);
let failed = 0;
for (const shard of shards) {
  const args = shard === "."
    ? ["eslint", "--cache", "--cache-location", ".cache/eslint", "--no-error-on-unmatched-pattern", "--ignore-pattern", "apps/**", "--ignore-pattern", "packages/**", "--ignore-pattern", "tooling/**", ".", ...extraArgs]
    : ["eslint", "--cache", "--cache-location", ".cache/eslint", "--no-error-on-unmatched-pattern", shard, ...extraArgs];
  const r = spawnSync("pnpm", ["exec", ...args], {
    stdio: "inherit",
    env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=4096" },
  });
  if (r.status !== 0) {
    failed += 1;
    console.error(`lint failed in ${shard}`);
  }
}
process.exit(failed === 0 ? 0 : 1);
