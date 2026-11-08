import type { Queryable, SqlClient } from "./sql.js";

export const DB_ROLES = ["outlet_app", "outlet_auth", "outlet_worker"] as const;
export type DbRole = (typeof DB_ROLES)[number];

declare const roleBrand: unique symbol;
/** A SqlClient known to connect as role R (compile-time brand; assertRuntimeRole proves it at boot). */
export type RoleSqlClient<R extends DbRole> = SqlClient & { readonly [roleBrand]: R };

/** A client with no role brand. withDbContext's unbranded overload only accepts these, so a branded client cannot dodge its ContextFor check. */
export type UnbrandedSqlClient = SqlClient & { readonly [roleBrand]?: never };

/** Brands a client after assertRuntimeRole succeeded for that pool. */
export const brandClient = <R extends DbRole>(client: SqlClient): RoleSqlClient<R> => client as RoleSqlClient<R>;

const APP_AUTH_ONLY_TABLES = ["otp_challenges", "refresh_tokens", "age_blocks", "rate_limit_hits"] as const;

/** The only store_members columns outlet_auth may SELECT (policy store_members__auth_my_memberships, migration 0015). */
export const AUTH_STORE_MEMBERS_COLUMNS: readonly string[] = ["store_id", "user_id", "role_code", "status", "strong_auth_enrolled_at"];

const exists = async (db: Queryable, table: string): Promise<boolean> => {
  const r = await db.query<{ ok: boolean }>("SELECT to_regclass($1) IS NOT NULL AS ok", [`public.${table}`]);
  return r.rows[0]?.ok === true;
};

const anyPriv = async (db: Queryable, table: string, privs: string): Promise<boolean> => {
  if (!(await exists(db, table))) return false;
  for (const p of privs.split(",")) {
    // column-level grants count (has_any_column_privilege); DELETE only exists at table level
    const fn = p === "DELETE" ? "has_table_privilege" : "has_any_column_privilege";
    const r = await db.query<{ ok: boolean }>(`SELECT ${fn}(current_user, $1, $2) AS ok`, [`public.${table}`, p]);
    if (r.rows[0]?.ok === true) return true;
  }
  return false;
};

/**
 * Boot guard per pool (ADR-0011; replaces assertNotBypassingRls). Throws unless the connection is exactly
 * `expected`, has no superuser/BYPASSRLS/CREATEROLE, no role memberships, owns nothing, and holds none of
 * the privileges on the role's deny-list.
 */
export const assertRuntimeRole = async (db: Queryable, expected: DbRole): Promise<void> => {
  const r = await db.query<{ who: string; sup: boolean; byp: boolean; crt: boolean; members: number | string; owned: number | string }>(
    `SELECT current_user::text AS who, r.rolsuper AS sup, r.rolbypassrls AS byp, r.rolcreaterole AS crt,
            (SELECT count(*) FROM pg_auth_members m WHERE m.member = r.oid OR m.roleid = r.oid) AS members,
            (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE c.relowner = r.oid AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_%') AS owned
       FROM pg_roles r WHERE r.rolname = current_user`,
  );
  const row = r.rows[0];
  const problems: string[] = [];
  if (!row) problems.push("current role not found");
  else {
    if (row.who !== expected) problems.push(`connected as ${row.who}, expected ${expected}`);
    if (row.sup) problems.push("superuser");
    if (row.byp) problems.push("BYPASSRLS");
    if (row.crt) problems.push("CREATEROLE");
    if (Number(row.members) > 0) problems.push("has role memberships");
    if (Number(row.owned) > 0) problems.push("owns relations");
  }
  if (problems.length === 0) {
    const denied: string[] = [];
    const deny = async (table: string, privs: string): Promise<void> => {
      if (await anyPriv(db, table, privs)) denied.push(`${privs} on ${table}`);
    };
    if (expected === "outlet_app") {
      for (const t of APP_AUTH_ONLY_TABLES) await deny(t, "SELECT,INSERT,UPDATE,DELETE");
      await deny("outbox_events", "SELECT,UPDATE,DELETE");
      await deny("dlq_messages", "SELECT,INSERT,UPDATE,DELETE");
      // Ledger is append-only (ledger-chart P4): the request path may insert and read, never mutate.
      await deny("postings", "UPDATE,DELETE");
      await deny("journal_entries", "UPDATE,DELETE");
    } else if (expected === "outlet_auth") {
      await deny("outbox_events", "SELECT,UPDATE,DELETE");
      await deny("privacy_requests", "SELECT,INSERT,UPDATE,DELETE");
      const st = await db.query<{ t: string }>(
        `SELECT c.relname AS t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relkind IN ('r','p')
            AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'store_id' AND NOT a.attisdropped)`,
      );
      for (const x of st.rows) {
        if (x.t === "store_members") {
          // Reviewed exception (ADR-0011 decision log, 2026-11-08): the pre-auth store switcher reads the
          // caller's own memberships through store_members__auth_my_memberships. outlet_auth may hold
          // column SELECT on exactly AUTH_STORE_MEMBERS_COLUMNS and nothing else on the table.
          await deny(x.t, "INSERT,UPDATE,DELETE");
          const cols = await db.query<{ c: string }>(
            `SELECT a.attname AS c FROM pg_attribute a
              WHERE a.attrelid = 'public.store_members'::regclass AND a.attnum > 0 AND NOT a.attisdropped
                AND has_column_privilege(current_user, 'public.store_members', a.attname, 'SELECT')`,
          );
          const extra = cols.rows.map((c) => c.c).filter((c) => !AUTH_STORE_MEMBERS_COLUMNS.includes(c));
          if (extra.length > 0) denied.push(`SELECT on store_members.${extra.join(",")}`);
          continue;
        }
        await deny(x.t, "SELECT,INSERT,UPDATE,DELETE");
      }
    } else {
      for (const t of ["users", "devices", "session_families"]) await deny(t, "INSERT");
    }
    problems.push(...denied.map((d) => `forbidden privilege ${d}`));
  }
  if (problems.length > 0) {
    throw new Error(`runtime role check failed for ${expected}: ${problems.join("; ")}`);
  }
};
