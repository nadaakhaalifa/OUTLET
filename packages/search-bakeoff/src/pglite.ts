import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { unaccent } from "@electric-sql/pglite/contrib/unaccent";
import { PostgresFtsAdapter } from "./adapters/postgres-fts.js";

/** In-process Postgres (WASM) with unaccent and pg_trgm. Bake-off and tests only. */
export const createPgliteFts = async (): Promise<{ adapter: PostgresFtsAdapter; close: () => Promise<void> }> => {
  const db = new PGlite({ extensions: { unaccent, pg_trgm } });
  await db.waitReady;
  return { adapter: new PostgresFtsAdapter(db), close: () => db.close() };
};
