#!/usr/bin/env node
// Applies every packages/db migration to a real Postgres as the migrator role, through @outlet/db applyMigrations.
//   DATABASE_URL_MIGRATOR=postgres://outlet_migrator:...@host/db node tooling/ci/apply-migrations.mjs
// Needs `pnpm --filter @outlet/db build` first (imports the built package).
import { createRequire } from "node:module";
import { URL, fileURLToPath, pathToFileURL } from "node:url";

const root = new URL("../../", import.meta.url);
const pg = createRequire(new URL("packages/db/package.json", root))("pg");
const { applyMigrations } = await import(pathToFileURL(fileURLToPath(new URL("packages/db/dist/index.js", root))).href);

const url = process.env.DATABASE_URL_MIGRATOR;
if (!url) throw new Error("DATABASE_URL_MIGRATOR is required");
const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  const who = (await client.query("SELECT current_user AS u")).rows[0].u;
  if (who !== "outlet_migrator") throw new Error(`refusing to migrate as ${who}; expected outlet_migrator`);
  const applied = await applyMigrations({ exec: (sql) => client.query(sql), query: async (sql, params) => ({ rows: (await client.query(sql, params)).rows }) });
  console.log(`applied ${String(applied.length)} migrations${applied.length > 0 ? `: ${applied.join(", ")}` : ""}`);
} finally {
  await client.end();
}
