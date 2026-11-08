import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { ScriptExecutor } from "./sql.js";

export interface Migration {
  readonly name: string;
  readonly sql: string;
}

const NAME = /^(\d{4})_[a-z0-9_]+\.sql$/;
const DEFAULT_DIR = fileURLToPath(new URL("../migrations/", import.meta.url));

/** Reads `NNNN_name.sql` files, sorted by number. Throws on gaps or duplicate numbers. */
export const loadMigrations = async (dir: string = DEFAULT_DIR): Promise<Migration[]> => {
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  let expected = 1;
  const out: Migration[] = [];
  for (const f of files) {
    const m = NAME.exec(f);
    if (!m) throw new Error(`bad migration file name: ${f}`);
    if (Number(m[1]) !== expected) throw new Error(`migration numbering gap or duplicate at ${f}`);
    expected += 1;
    out.push({ name: f.replace(/\.sql$/, ""), sql: await readFile(`${dir}/${f}`, "utf8") });
  }
  return out;
};

const checksum = (sql: string): string => createHash("sha256").update(sql).digest("hex");

/**
 * Applies pending migrations in order, once each, and records them in
 * `schema_migrations` with a checksum. An already-applied migration whose
 * file changed throws (migrations are immutable; add a new one instead).
 * Returns the names applied by this call.
 */
export const applyMigrations = async (sql: ScriptExecutor, migrations?: readonly Migration[]): Promise<string[]> => {
  const list = migrations ?? (await loadMigrations());
  await sql.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())",
  );
  const done = new Map(
    (await sql.query<{ name: string; checksum: string }>("SELECT name, checksum FROM schema_migrations")).rows.map((r) => [r.name, r.checksum]),
  );
  const applied: string[] = [];
  for (const m of list) {
    const sum = checksum(m.sql);
    const prior = done.get(m.name);
    if (prior !== undefined) {
      if (prior !== sum) throw new Error(`migration ${m.name} was modified after being applied`);
      continue;
    }
    await sql.exec(`BEGIN;\n${m.sql}\nINSERT INTO schema_migrations (name, checksum) VALUES ('${m.name}', '${sum}');\nCOMMIT;`);
    applied.push(m.name);
  }
  return applied;
};
