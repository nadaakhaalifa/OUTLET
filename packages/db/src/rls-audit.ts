import type { Queryable } from "./sql.js";

export interface RlsAuditRow {
  readonly schema: string;
  readonly table: string;
  readonly kind: "table" | "view";
  readonly rlsEnabled: boolean;
  readonly rlsForced: boolean;
  readonly policyCount: number;
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

export interface RlsException {
  readonly table: string;
  readonly policy: string;
  readonly role: string;
  readonly cmd: "all" | "select" | "insert" | "update" | "delete";
}

interface RawPolicy {
  schema: string;
  table: string;
  policy: string;
  roles: string[];
  cmd: string;
  qual: string;
  has_market: boolean;
}

const CMD: Record<string, RlsException["cmd"]> = { "*": "all", r: "select", a: "insert", w: "update", d: "delete" };
const EXCEPTION_ROLES = ["outlet_auth", "outlet_worker"] as const;
const SLUG = "[a-z0-9]+(?:_[a-z0-9]+)*";

const rawPolicies = async (db: Queryable): Promise<RawPolicy[]> =>
  (
    await db.query<RawPolicy>(
      `SELECT n.nspname AS schema, c.relname AS "table", p.polname AS policy,
              CASE WHEN p.polroles = '{0}' THEN ARRAY['PUBLIC']
                   ELSE ARRAY(SELECT r.rolname::text FROM pg_roles r WHERE r.oid = ANY (p.polroles) ORDER BY r.rolname) END AS roles,
              p.polcmd::text AS cmd,
              COALESCE(pg_get_expr(p.polqual, p.polrelid), '') || ' ' || COALESCE(pg_get_expr(p.polwithcheck, p.polrelid), '') AS qual,
              EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'market_id' AND a.attnum > 0 AND NOT a.attisdropped) AS has_market
         FROM pg_policy p
         JOIN pg_class c ON c.oid = p.polrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_%'
          AND p.polname NOT IN (c.relname || '_user_isolation', c.relname || '_store_isolation')
        ORDER BY n.nspname, c.relname, p.polname`,
    )
  ).rows;

/** Every policy that is not a plain isolation policy, as (table, policy, role, cmd), sorted. Snapshot-tested. */
export const listRlsExceptions = async (db: Queryable): Promise<RlsException[]> =>
  (await rawPolicies(db)).map((p) => ({ table: p.table, policy: p.policy, role: p.roles.join(","), cmd: CMD[p.cmd] ?? "all" }));

/** Rules of ADR-0011 for exception policies, plus the retention-policy coverage check. Returns problems. */
const exceptionProblems = async (db: Queryable): Promise<string[]> => {
  const out: string[] = [];
  for (const p of await rawPolicies(db)) {
    const where = `${p.table}.${p.policy}`;
    const role = p.roles.length === 1 ? p.roles[0] : undefined;
    const appInsert = role === "outlet_app" && p.policy === `${p.table}__app_insert` && p.cmd === "a";
    if (!appInsert && !(role !== undefined && (EXCEPTION_ROLES as readonly string[]).includes(role))) {
      out.push(`exception policy ${where} must be TO exactly one of ${EXCEPTION_ROLES.join(", ")} (got ${p.roles.join(",") || "none"})`);
      continue;
    }
    if (!appInsert) {
      const kind = role === "outlet_auth" ? "auth" : "worker";
      if (!new RegExp(`^${p.table}__${kind}_${SLUG}$`).test(p.policy)) out.push(`exception policy ${where} must be named ${p.table}__${kind}_<purpose>`);
      if (!p.qual.includes("app.ctx()")) out.push(`exception policy ${where} does not use app.ctx()`);
      if (kind === "worker" && !p.qual.includes("app.job()")) out.push(`worker policy ${where} does not use app.job()`);
    }
    if (p.has_market && !p.qual.includes("app.current_market_id()")) out.push(`exception policy ${where} does not pin app.current_market_id()`);
    if (isConstantTrueQual(p.qual.trim())) out.push(`exception policy ${where} has a constant-true predicate`);
  }
  const hasRet = (await db.query<{ ok: boolean }>("SELECT to_regclass('public.retention_policies') IS NOT NULL AS ok")).rows[0]?.ok === true;
  if (hasRet) {
    const missing = await db.query<{ t: string }>(
      `SELECT rp.table_name AS t FROM retention_policies rp
        WHERE to_regclass(format('public.%I', rp.table_name)) IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = to_regclass(format('public.%I', rp.table_name))
                            AND p.polname LIKE rp.table_name || '__worker_privacy_retention%')`,
    );
    for (const m of missing.rows) out.push(`retention policy for table ${m.t} has no ${m.t}__worker_privacy_retention_* worker policy`);
  }
  return out;
};

/** Throws listing every tenant relation or exception policy with a problem. Returns all rows when clean. */
export const assertTenantTablesProtected = async (db: Queryable): Promise<RlsAuditRow[]> => {
  const rows = await listTenantTables(db);
  const bad = rows.filter((x) => x.problems.length > 0);
  const exc = await exceptionProblems(db);
  if (bad.length > 0 || exc.length > 0) {
    const parts: string[] = [];
    if (bad.length > 0) {
      parts.push(
        `tenant relations without full RLS: ${bad
          .map((x) => `${x.schema}.${x.table}(enabled=${String(x.rlsEnabled)},forced=${String(x.rlsForced)},policies=${String(x.policyCount)}: ${x.problems.join("; ")})`)
          .join(", ")}`,
      );
    }
    if (exc.length > 0) parts.push(`exception policy violations: ${exc.join("; ")}`);
    throw new Error(parts.join(" | "));
  }
  return rows;
};
