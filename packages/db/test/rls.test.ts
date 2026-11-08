import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { applyMigrations, assertNotBypassingRls, assertTenantTablesProtected, listTenantTables, withTenant } from "../src/index.js";
import { createTestClient } from "../src/testing.js";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

/** PGlite is superuser: it bypasses RLS even when forced. Tests therefore SET ROLE to a plain role. */
const setup = async () => {
  const { client, close } = await createTestClient();
  await client.query("CREATE ROLE app_user NOLOGIN NOSUPERUSER NOBYPASSRLS");
  await client.query("GRANT USAGE ON SCHEMA app TO app_user");
  await client.query("GRANT SELECT, INSERT, UPDATE, DELETE ON tenancy_rls_smoke TO app_user");
  await client.query("INSERT INTO tenancy_rls_smoke (store_id, market_id, note) VALUES ($1,'EG','a'),($2,'EG','b')", [A, B]);
  await client.query("SET ROLE app_user");
  return { client, close };
};

describe("tenancy RLS (non-superuser role via SET ROLE)", () => {
  it("superuser really bypasses, so the role switch is necessary", async () => {
    const { client, close } = await createTestClient();
    await client.query("INSERT INTO tenancy_rls_smoke (store_id, market_id) VALUES ($1,'EG')", [A]);
    const r = await client.query("SELECT count(*)::int AS n FROM tenancy_rls_smoke");
    expect(r.rows[0]).toEqual({ n: 1 });
    await close();
  });

  it("isolates stores", async () => {
    const { client, close } = await setup();
    const a = await withTenant(client, { storeId: A, marketId: "EG" }, (tx) => tx.query<{ note: string }>("SELECT note FROM tenancy_rls_smoke"));
    const b = await withTenant(client, { storeId: B, marketId: "EG" }, (tx) => tx.query<{ note: string }>("SELECT note FROM tenancy_rls_smoke"));
    expect(a.rows).toEqual([{ note: "a" }]);
    expect(b.rows).toEqual([{ note: "b" }]);
    await close();
  });

  it("rejects insert with another store_id (WITH CHECK)", async () => {
    const { client, close } = await setup();
    await expect(
      withTenant(client, { storeId: A, marketId: "EG" }, (tx) => tx.query("INSERT INTO tenancy_rls_smoke (store_id, market_id) VALUES ($1,'EG')", [B])),
    ).rejects.toThrow(/row-level security/);
    await withTenant(client, { storeId: A, marketId: "EG" }, (tx) => tx.query("INSERT INTO tenancy_rls_smoke (store_id, market_id) VALUES ($1,'EG')", [A]));
    await close();
  });

  it("cannot update or delete another store's rows", async () => {
    const { client, close } = await setup();
    await withTenant(client, { storeId: A, marketId: "EG" }, async (tx) => {
      await tx.query("UPDATE tenancy_rls_smoke SET note='x' WHERE store_id=$1", [B]);
      await tx.query("DELETE FROM tenancy_rls_smoke WHERE store_id=$1", [B]);
    });
    const r = await withTenant(client, { storeId: B, marketId: "EG" }, (tx) => tx.query<{ note: string }>("SELECT note FROM tenancy_rls_smoke"));
    expect(r.rows).toEqual([{ note: "b" }]);
    await close();
  });

  it("no tenant set -> zero rows, and nothing leaks after commit", async () => {
    const { client, close } = await setup();
    expect((await client.query("SELECT 1 FROM tenancy_rls_smoke")).rows).toHaveLength(0);
    await withTenant(client, { storeId: A, marketId: "EG" }, async (tx) => {
      expect((await tx.query<{ m: string }>("SELECT app.current_market_id() AS m")).rows[0]?.m).toBe("EG");
    });
    expect((await client.query("SELECT 1 FROM tenancy_rls_smoke")).rows).toHaveLength(0);
    expect((await client.query<{ s: string | null }>("SELECT app.current_store_id()::text AS s")).rows[0]?.s).toBeNull();
    await close();
  });

  it("rolls back and unsets the tenant when fn throws", async () => {
    const { client, close } = await setup();
    await expect(withTenant(client, { storeId: A, marketId: "EG" }, () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect((await client.query("SELECT 1 FROM tenancy_rls_smoke")).rows).toHaveLength(0);
    await close();
  });

  it("a malformed store id fails closed", async () => {
    const { client, close } = await setup();
    await expect(withTenant(client, { storeId: "not-a-uuid", marketId: "EG" }, (tx) => tx.query("SELECT 1 FROM tenancy_rls_smoke"))).rejects.toThrow();
    await close();
  });
});

describe("app.enable_store_rls", () => {
  it("rejects missing tables and tables without store_id", async () => {
    const db = new PGlite();
    await applyMigrations(db);
    await expect(db.query("SELECT app.enable_store_rls('nope')")).rejects.toThrow(/does not exist/);
    await db.exec("CREATE TABLE no_tenant (id int)");
    await expect(db.query("SELECT app.enable_store_rls('no_tenant')")).rejects.toThrow(/store_id/);
    await db.query("SELECT app.enable_store_rls('tenancy_rls_smoke')"); // idempotent
    await db.close();
  });
});

describe("cross-market isolation (L7)", () => {
  it("a store id in another market is invisible and unwritable", async () => {
    const { client, close } = await createTestClient();
    await client.query("CREATE ROLE app_user NOLOGIN NOSUPERUSER NOBYPASSRLS");
    await client.query("GRANT USAGE ON SCHEMA app TO app_user");
    await client.query("GRANT SELECT, INSERT ON tenancy_rls_smoke TO app_user");
    await client.query("INSERT INTO tenancy_rls_smoke (store_id, market_id, note) VALUES ($1,'EG','eg'),($1,'AE','ae')", [A]);
    await client.query("SET ROLE app_user");
    const eg = await withTenant(client, { storeId: A, marketId: "EG" }, (tx) => tx.query<{ note: string }>("SELECT note FROM tenancy_rls_smoke"));
    expect(eg.rows).toEqual([{ note: "eg" }]);
    await expect(
      withTenant(client, { storeId: A, marketId: "EG" }, (tx) => tx.query("INSERT INTO tenancy_rls_smoke (store_id, market_id) VALUES ($1,'AE')", [A])),
    ).rejects.toThrow(/row-level security/);
    await close();
  });
});

describe("user isolation (M8)", () => {
  const U1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const U2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const D1 = "d1d1d1d1-d1d1-4d1d-8d1d-d1d1d1d1d1d1";
  const D2 = "d2d2d2d2-d2d2-4d2d-8d2d-d2d2d2d2d2d2";
  const F1 = "f1f1f1f1-f1f1-4f1f-8f1f-f1f1f1f1f1f1";
  const F2 = "f2f2f2f2-f2f2-4f2f-8f2f-f2f2f2f2f2f2";

  const seed = async () => {
    const { client, close } = await createTestClient();
    const ts = "2026-11-08T10:00:00Z";
    for (const [u, d, f, n] of [[U1, D1, F1, 1], [U2, D2, F2, 2]] as const) {
      await client.query("INSERT INTO users (id, market_id, created_at, updated_at) VALUES ($1,'EG',$2,$2)", [u, ts]);
      await client.query(
        "INSERT INTO devices (id, market_id, user_id, platform, install_id_hash, first_seen_at, last_seen_at) VALUES ($1,'EG',$2,'ios',$3,$4,$4)",
        [d, u, Buffer.alloc(32, n), ts],
      );
      await client.query("INSERT INTO session_families (id, user_id, device_id, amr, created_at) VALUES ($1,$2,$3,'{otp}',$4)", [f, u, d, ts]);
    }
    await client.query("CREATE ROLE app_user NOLOGIN NOSUPERUSER NOBYPASSRLS");
    await client.query("GRANT USAGE ON SCHEMA app TO app_user");
    await client.query("GRANT SELECT, UPDATE, DELETE ON users, devices, session_families, user_identities, age_attestations TO app_user");
    await client.query("SET ROLE app_user");
    return { client, close };
  };

  it("user A cannot read user B's user row or sessions; devices are intentionally not user-RLS until 0007", async () => {
    const { client, close } = await seed();
    const a = await withTenant(client, { userId: U1, marketId: "EG" }, async (tx) => ({
      users: (await tx.query<{ id: string }>("SELECT id FROM users")).rows.map((r) => r.id),
      sessions: (await tx.query<{ id: string }>("SELECT id FROM session_families")).rows.map((r) => r.id),
    }));
    expect(a).toEqual({ users: [U1], sessions: [F1] });
    // devices stay pre-auth reachable (ADR-0011): not RLS-forced, both rows visible
    const devs = await withTenant(client, { userId: U1, marketId: "EG" }, (tx) => tx.query<{ id: string }>("SELECT id FROM devices ORDER BY id"));
    expect(devs.rows.map((r) => r.id)).toEqual([D1, D2]);
    const upd = await withTenant(client, { userId: U1, marketId: "EG" }, (tx) => tx.query("UPDATE session_families SET revoked_at = now() WHERE id = $1 RETURNING id", [F2]));
    expect(upd.rows).toHaveLength(0);
    await close();
  });

  it("no user bound -> zero rows", async () => {
    const { client, close } = await seed();
    for (const t of ["users", "session_families"]) {
      expect((await client.query(`SELECT 1 FROM ${t}`)).rows).toHaveLength(0);
    }
    await close();
  });

  it("0006 forces user RLS on users, session_families, age_attestations and not on devices/consent_records", async () => {
    const { client, close } = await createTestClient();
    const forced = await client.query<{ relname: string; f: boolean }>(
      "SELECT relname, relforcerowsecurity AS f FROM pg_class WHERE relname IN ('users','session_families','age_attestations','devices','consent_records') AND relkind = 'r'",
    );
    const m = Object.fromEntries(forced.rows.map((r) => [r.relname, r.f]));
    expect(m).toMatchObject({ users: true, session_families: true, age_attestations: true, devices: false, consent_records: false });
    await close();
  });

  it("the migration DO block skips a table whose user_id is nullable", async () => {
    const db = new PGlite();
    await applyMigrations(db);
    // re-run the 0006 auto-apply block against fresh tables
    await db.exec("CREATE TABLE nullable_t (user_id uuid); CREATE TABLE notnull_t (user_id uuid NOT NULL)");
    const sql = (await import("node:fs")).readFileSync(new URL("../migrations/0006_auth_policy_hardening.sql", import.meta.url), "utf8");
    const block = /DO \$\$[\s\S]*?\$\$;/.exec(sql)?.[0];
    expect(block).toBeDefined();
    await db.exec(block ?? "");
    const rows = await db.query<{ relname: string; f: boolean }>("SELECT relname, relforcerowsecurity AS f FROM pg_class WHERE relname IN ('nullable_t','notnull_t')");
    expect(Object.fromEntries(rows.rows.map((r) => [r.relname, r.f]))).toEqual({ nullable_t: false, notnull_t: true });
    await db.close();
  });

  it("enable_user_rls rejects a missing table and a missing column", async () => {
    const db = new PGlite();
    await applyMigrations(db);
    await expect(db.query("SELECT app.enable_user_rls('nope')")).rejects.toThrow(/does not exist/);
    await expect(db.query("SELECT app.enable_user_rls('devices', 'nope')")).rejects.toThrow(/needs a uuid/);
    await db.close();
  });
});

describe("assertNotBypassingRls (M7)", () => {
  it("throws for a superuser and passes for a plain role", async () => {
    const { client, close } = await createTestClient();
    await expect(assertNotBypassingRls(client)).rejects.toThrow(/bypasses row-level security/);
    await client.query("CREATE ROLE app_user NOLOGIN NOSUPERUSER NOBYPASSRLS");
    await client.query("SET ROLE app_user");
    await expect(assertNotBypassingRls(client)).resolves.toBeUndefined();
    await close();
  });
});

describe("rls-audit", () => {
  it("passes on the shipped schema and lists the canary and the identity tables", async () => {
    const { client, close } = await createTestClient();
    const rows = await assertTenantTablesProtected(client);
    const names = rows.map((r) => r.table);
    expect(names).toEqual(expect.arrayContaining(["tenancy_rls_smoke", "users", "devices", "session_families", "user_identities", "age_attestations"]));
    await close();
  });

  it("fails on a tenant table without RLS, naming it, and on a permissive policy", async () => {
    const { client, close } = await createTestClient();
    await client.query("CREATE TABLE leaky (store_id uuid)");
    await expect(assertTenantTablesProtected(client)).rejects.toThrow(/leaky/);
    await client.query("ALTER TABLE leaky ENABLE ROW LEVEL SECURITY");
    await client.query("CREATE POLICY p ON leaky USING (true)");
    await expect(assertTenantTablesProtected(client)).rejects.toThrow(/forced=false/);
    await client.query("ALTER TABLE leaky FORCE ROW LEVEL SECURITY");
    // any policy is not enough: the name and the predicate matter
    await expect(assertTenantTablesProtected(client)).rejects.toThrow(/leaky_store_isolation/);
    await client.query("DROP POLICY p ON leaky");
    // a correctly named but permissive USING (true) policy now FAILS (it used to pass)
    await client.query("CREATE POLICY leaky_store_isolation ON leaky USING (true)");
    await expect(assertTenantTablesProtected(client)).rejects.toThrow(/not using app.current_store_id/);
    await client.query("DROP POLICY leaky_store_isolation ON leaky");
    await client.query("SELECT app.enable_store_rls('leaky')");
    expect((await listTenantTables(client)).find((r) => r.table === "leaky")).toMatchObject({ policyCount: 1, problems: [] });
    await expect(assertTenantTablesProtected(client)).resolves.toBeDefined();
    await close();
  });

  it("fails a PUBLIC policy whose qual is true or has an OR true disjunct", async () => {
    const { client, close } = await createTestClient();
    await client.query("CREATE TABLE pubt (store_id uuid)");
    await client.query("ALTER TABLE pubt ENABLE ROW LEVEL SECURITY");
    await client.query("ALTER TABLE pubt FORCE ROW LEVEL SECURITY");
    await client.query("CREATE POLICY pubt_store_isolation ON pubt USING (true)");
    await expect(assertTenantTablesProtected(client)).rejects.toThrow(/constant-true/);
    await client.query("DROP POLICY pubt_store_isolation ON pubt");
    await client.query("CREATE POLICY pubt_store_isolation ON pubt USING (store_id = app.current_store_id() OR true)");
    await expect(assertTenantTablesProtected(client)).rejects.toThrow(/constant-true/);
    await client.query("DROP POLICY pubt_store_isolation ON pubt");
    await client.query("SELECT app.enable_store_rls('pubt')");
    await expect(assertTenantTablesProtected(client)).resolves.toBeDefined();
    await close();
  });

  it("requires the market predicate when the table has market_id", async () => {
    const { client, close } = await createTestClient();
    await client.query("CREATE TABLE mk (store_id uuid, market_id text)");
    await client.query("ALTER TABLE mk ENABLE ROW LEVEL SECURITY");
    await client.query("ALTER TABLE mk FORCE ROW LEVEL SECURITY");
    await client.query("CREATE POLICY mk_store_isolation ON mk USING (store_id = app.current_store_id())");
    await expect(assertTenantTablesProtected(client)).rejects.toThrow(/current_market_id/);
    await close();
  });

  it("requires a user policy on user_id tables", async () => {
    const { client, close } = await createTestClient();
    await client.query("CREATE TABLE mine (user_id uuid)");
    await expect(assertTenantTablesProtected(client)).rejects.toThrow(/mine/);
    await client.query("SELECT app.enable_user_rls('mine')");
    await expect(assertTenantTablesProtected(client)).resolves.toBeDefined();
    await close();
  });

  it("scans other schemas and rejects views without security_invoker, and materialized views", async () => {
    const { client, close } = await createTestClient();
    await client.query("CREATE SCHEMA other");
    await client.query("CREATE TABLE other.t (store_id uuid)");
    await expect(assertTenantTablesProtected(client)).rejects.toThrow(/other\.t/);
    await client.query("DROP TABLE other.t");
    await client.query("CREATE VIEW v_leak AS SELECT store_id FROM tenancy_rls_smoke");
    await expect(assertTenantTablesProtected(client)).rejects.toThrow(/v_leak.*security_invoker/);
    await client.query("ALTER VIEW v_leak SET (security_invoker = true)");
    await expect(assertTenantTablesProtected(client)).resolves.toBeDefined();
    await client.query("CREATE MATERIALIZED VIEW mv_leak AS SELECT store_id FROM tenancy_rls_smoke");
    await expect(assertTenantTablesProtected(client)).rejects.toThrow(/mv_leak/);
    await close();
  });
});
