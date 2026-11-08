import type { Queryable } from "./sql.js";

export interface RlsAuditRow {
  readonly schema: string;
  readonly table: string;
  readonly kind: "table" | "view";
  readonly rlsEnabled: boolean;
  readonly rlsForced: boolean;
  readonly policyCount: number;
  /** Set when the relation is knowingly exempt (documented gap); problems stays empty. */
  readonly exemption?: string;
  /** Empty when the relation is fully protected. */
  readonly problems: readonly string[];
}

interface RawRow {
  schema: string;
  table: string;
  relkind: string;
  enabled: boolean;
  forced: boolean;
  policies: number | string;
  invoker: boolean;
  has_store: boolean;
  has_user: boolean;
  has_market: boolean;
  store_qual: string | null;
  user_qual: string | null;
  public_quals: string[] | null;
}

/**
 * Startup guard: the application role must not be a superuser or BYPASSRLS, otherwise every
 * row-level policy is silently ignored. Call once at boot with the production connection.
 * Not called by createTestClient, because PGlite always runs as superuser (tests SET ROLE instead).
 */
export const assertNotBypassingRls = async (db: Queryable): Promise<void> => {
  const r = await db.query<{ bypass: boolean }>(
    "SELECT (rolsuper OR rolbypassrls) AS bypass FROM pg_roles WHERE rolname = current_user",
  );
  const row = r.rows[0];
  if (!row || row.bypass) {
    throw new Error("database role bypasses row-level security (superuser or BYPASSRLS); refusing to start");
  }
};

/**
 * Lists every relation in every non-system schema that carries a store_id or user_id column
 * (plus public.users, keyed by id), with its RLS state and the problems found:
 * RLS enabled and forced, a policy named <tbl>_store_isolation using app.current_store_id()
 * (and app.current_market_id() when the table has market_id), a policy <tbl>_user_isolation
 * using app.current_user_id() for user-keyed tables without store_id, and
 * security_invoker=true on views (materialized views cannot be protected, so they always fail).
 */
/**
 * Heuristic for a constant-true qual: the whole qual is `true`, or `true` appears as a standalone
 * disjunct (`... OR true`, `true OR ...`) with optional parentheses. Not a boolean simplifier
 * (`1=1` is not caught); the named-policy predicate checks remain the primary gate.
 */
/**
 * Knowingly exempt until migration 0007 (ADR-0011) adds role-scoped policies: these tables have a NULLABLE
 * user_id and must stay reachable before a user is known (device registration, visitor consent).
 * Remove entries as 0007 lands. Only public.<name> in this list is exempt, and only while it has no policy.
 */
export const PRE_AUTH_EXEMPT: Readonly<Record<string, string>> = {
  devices: "pre-auth device registration (ADR-0011, migration 0007)",
  consent_records: "visitor consent before sign-in (ADR-0011, migration 0007)",
};

export const isConstantTrueQual = (qual: string): boolean => /(^|\bor\s+|\()\s*true\s*(\)|\s+or\b|$)/i.test(qual.trim());

export const listTenantTables = async (db: Queryable): Promise<RlsAuditRow[]> => {
  const r = await db.query<RawRow>(
    `SELECT n.nspname AS schema, c.relname AS "table", c.relkind AS relkind,
            c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced,
            (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid) AS policies,
            COALESCE(c.reloptions::text[] && ARRAY['security_invoker=true', 'security_invoker=on'], false) AS invoker,
            EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'store_id' AND a.attnum > 0 AND NOT a.attisdropped) AS has_store,
            (EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'user_id' AND a.attnum > 0 AND NOT a.attisdropped)
              OR (n.nspname = 'public' AND c.relname = 'users')) AS has_user,
            EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'market_id' AND a.attnum > 0 AND NOT a.attisdropped) AS has_market,
            (SELECT pg_get_expr(p.polqual, p.polrelid) FROM pg_policy p WHERE p.polrelid = c.oid AND p.polname = c.relname || '_store_isolation') AS store_qual,
            (SELECT pg_get_expr(p.polqual, p.polrelid) FROM pg_policy p WHERE p.polrelid = c.oid AND p.polname = c.relname || '_user_isolation') AS user_qual,
            (SELECT array_agg(COALESCE(pg_get_expr(p.polqual, p.polrelid), '')) FROM pg_policy p WHERE p.polrelid = c.oid AND p.polroles = '{0}') AS public_quals
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_%'
        AND c.relkind IN ('r', 'p', 'v', 'm')
        AND (
          EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname IN ('store_id', 'user_id') AND a.attnum > 0 AND NOT a.attisdropped)
          OR (n.nspname = 'public' AND c.relname = 'users' AND c.relkind IN ('r', 'p'))
        )
      ORDER BY n.nspname, c.relname`,
  );
  return r.rows.map((x): RlsAuditRow => {
    const exemption = x.schema === "public" && Number(x.policies) === 0 && x.relkind === "r" ? PRE_AUTH_EXEMPT[x.table] : undefined;
    if (exemption !== undefined) {
      return { schema: x.schema, table: x.table, kind: "table", rlsEnabled: x.enabled, rlsForced: x.forced, policyCount: 0, exemption, problems: [] };
    }
    const isView = x.relkind === "v" || x.relkind === "m";
    const problems: string[] = [];
    if (isView) {
      if (x.relkind === "m") problems.push("materialized views cannot enforce RLS");
      else if (!x.invoker) problems.push("view lacks security_invoker=true");
    } else {
      if (!x.enabled) problems.push("RLS not enabled");
      if (!x.forced) problems.push("RLS not forced");
      if (Number(x.policies) < 1) problems.push("no policy");
      if ((x.public_quals ?? []).some(isConstantTrueQual)) problems.push("PUBLIC policy with a constant-true predicate (USING (true) or ... OR true)");
      if (x.has_store) {
        if (!x.store_qual?.includes("app.current_store_id()")) problems.push(`policy ${x.table}_store_isolation missing or not using app.current_store_id()`);
        else if (x.has_market && !x.store_qual.includes("app.current_market_id()")) problems.push(`policy ${x.table}_store_isolation does not pin app.current_market_id()`);
      } else if (x.has_user && !x.user_qual?.includes("app.current_user_id()")) {
        problems.push(`policy ${x.table}_user_isolation missing or not using app.current_user_id()`);
      }
    }
    return {
      schema: x.schema,
      table: x.table,
      kind: isView ? "view" : "table",
      rlsEnabled: x.enabled,
      rlsForced: x.forced,
      policyCount: Number(x.policies),
      problems,
    };
  });
};

/** Throws listing every tenant relation with a problem. Returns all rows when clean. */
export const assertTenantTablesProtected = async (db: Queryable): Promise<RlsAuditRow[]> => {
  const rows = await listTenantTables(db);
  const bad = rows.filter((x) => x.problems.length > 0);
  if (bad.length > 0) {
    throw new Error(
      `tenant relations without full RLS: ${bad
        .map((x) => `${x.schema}.${x.table}(enabled=${String(x.rlsEnabled)},forced=${String(x.rlsForced)},policies=${String(x.policyCount)}: ${x.problems.join("; ")})`)
        .join(", ")}`,
    );
  }
  return rows;
};
