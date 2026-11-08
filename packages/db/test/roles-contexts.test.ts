import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import {
  applyDbContext,
  applyMigrations,
  assertRuntimeRole,
  assertTenantTablesProtected,
  listRlsExceptions,
  withDbContext,
  withTenant,
} from "../src/index.js";
import type { AuthContext, DbContext, UserContext } from "../src/index.js";
import type { SqlClient } from "../src/sql.js";
import { asRole, createTestClient, roleClient } from "../src/testing.js";

const U1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const U2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const D1 = "d1d1d1d1-d1d1-4d1d-8d1d-d1d1d1d1d1d1";
const D2 = "d2d2d2d2-d2d2-4d2d-8d2d-d2d2d2d2d2d2";
const PH1 = "01".repeat(32);
const PH2 = "02".repeat(32);
const INST = "0a".repeat(32);
const TS = "2026-11-08T10:00:00Z";

const seed = async () => {
  const { client, close } = await createTestClient();
  for (const [u, ph] of [[U1, 1], [U2, 2]] as const) {
    await client.query("INSERT INTO users (id, market_id, phone_bidx, created_at, updated_at) VALUES ($1,'EG',$2,$3,$3)", [u, Buffer.alloc(32, ph), TS]);
  }
  await client.query(
    "INSERT INTO devices (id, market_id, user_id, platform, install_id_hash, first_seen_at, last_seen_at) VALUES ($1,'EG',$2,'ios',$3,$4,$4)",
    [D1, U1, Buffer.alloc(32, 0xd1), TS],
  );
  await client.query(
    "INSERT INTO otp_challenges (id, market_id, phone_bidx, purpose, code_hash, channel, provider, expires_at, device_id, created_at) VALUES (gen_random_uuid(),'EG',$1,'login',$2,'sms','p',$3,$4,$3)",
    [Buffer.alloc(32, 1), Buffer.alloc(32, 9), TS, D1],
  );
  await client.query("INSERT INTO rate_limit_hits (key, hit_at) VALUES ('k', now())");
  await client.query("INSERT INTO age_blocks (id, market_id, device_hash, dob_hash, blocked_until, created_at) VALUES (gen_random_uuid(),'EG',$1,$1,now() + interval '1 day',$2)", [Buffer.alloc(32, 0x0a), TS]);
  await client.query(
    "INSERT INTO outbox_events (id, market_id, aggregate_type, aggregate_id, event_type, payload, occurred_at) VALUES (gen_random_uuid(),'EG','order',gen_random_uuid(),'order.placed','{}',now())",
  );
  return { client, close };
};

const count = async (c: SqlClient, role: "outlet_app" | "outlet_auth" | "outlet_worker", ctx: DbContext | undefined, sql: string): Promise<number> =>
  asRole(c, role, async (tx) => {
    if (ctx) await applyDbContext(tx, ctx);
    return (await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM (${sql}) q`)).rows[0]?.n ?? -1;
  });

const AUTH_TABLES = ["otp_challenges", "refresh_tokens", "age_blocks", "rate_limit_hits"] as const;

describe("migration 0007 prerequisites", () => {
  it("fails with a clear message when a role is missing", async () => {
    const db = new PGlite();
    await expect(applyMigrations(db)).rejects.toThrow(/requires database role outlet_app/);
    await db.close();
  });
});

describe("role x context x table x command matrix", () => {
  it("outlet_app has no access to the auth-only tables, even in auth ctx", async () => {
    const { client, close } = await seed();
    for (const t of AUTH_TABLES) {
      await expect(count(client, "outlet_app", { kind: "user", marketId: "EG", userId: U1 }, `SELECT 1 FROM ${t}`)).rejects.toThrow(/permission denied/);
    }
    await expect(asRole(client, "outlet_app", (tx) => tx.query("DELETE FROM dlq_messages"))).rejects.toThrow(/permission denied/);
    await close();
  });

  it("outlet_app is INSERT-only on outbox_events, pinned to the market", async () => {
    const { client, close } = await seed();
    const ins = (market: string) =>
      withDbContext(roleClient(client, "outlet_app"), { kind: "user", marketId: "EG", userId: U1 }, (tx) =>
        tx.query("INSERT INTO outbox_events (id, market_id, aggregate_type, aggregate_id, event_type, payload, occurred_at) VALUES (gen_random_uuid(),$1,'o',gen_random_uuid(),'o.x','{}',now())", [market]),
      );
    await ins("EG");
    await expect(ins("AE")).rejects.toThrow(/row-level security/);
    await expect(asRole(client, "outlet_app", (tx) => tx.query("SELECT 1 FROM outbox_events"))).rejects.toThrow(/permission denied/);
    await expect(asRole(client, "outlet_app", (tx) => tx.query("UPDATE outbox_events SET attempts = 1"))).rejects.toThrow(/permission denied/);
    await close();
  });

  it("outlet_auth can INSERT outbox_events in auth ctx and market only; cannot SELECT or UPDATE them", async () => {
    const { client, close } = await seed();
    const ins = (ctx: AuthContext | UserContext, market = "EG") =>
      withDbContext(roleClient(client, "outlet_auth"), ctx, (tx) =>
        tx.query("INSERT INTO outbox_events (id, market_id, aggregate_type, aggregate_id, event_type, payload, occurred_at) VALUES (gen_random_uuid(),$1,'user',gen_random_uuid(),'user.registered','{}',now())", [market]),
      );
    await ins({ kind: "auth", marketId: "EG" });
    await expect(ins({ kind: "auth", marketId: "EG" }, "AE")).rejects.toThrow(/row-level security/);
    await expect(ins({ kind: "user", marketId: "EG", userId: U1 })).rejects.toThrow(/row-level security/);
    await expect(asRole(client, "outlet_auth", (tx) => tx.query("SELECT 1 FROM outbox_events"))).rejects.toThrow(/permission denied/);
    await expect(asRole(client, "outlet_auth", (tx) => tx.query("UPDATE outbox_events SET attempts = 1"))).rejects.toThrow(/permission denied/);
    await close();
  });

  it("outlet_auth reads users only through the phone_bidx context, 0 rows without it", async () => {
    const { client, close } = await seed();
    const q = "SELECT id FROM users";
    expect(await count(client, "outlet_auth", { kind: "auth", marketId: "EG" }, q)).toBe(0);
    expect(await count(client, "outlet_auth", { kind: "auth", marketId: "EG", auth: { phoneBidx: PH1 } }, q)).toBe(1);
    expect(await count(client, "outlet_auth", { kind: "auth", marketId: "EG", auth: { phoneBidx: PH2 } }, q)).toBe(1);
    expect(await count(client, "outlet_auth", { kind: "auth", marketId: "AE", auth: { phoneBidx: PH1 } }, q)).toBe(0);
    expect(await count(client, "outlet_auth", undefined, q)).toBe(0);
    // column grant: nothing beyond id, market_id, status, phone_bidx
    await expect(asRole(client, "outlet_auth", async (tx) => {
      await applyDbContext(tx, { kind: "auth", marketId: "EG", auth: { phoneBidx: PH1 } });
      return tx.query("SELECT email_ct FROM users");
    })).rejects.toThrow(/permission denied/);
    // outlet_app in auth ctx still sees nothing: the policy is role-scoped
    await expect(count(client, "outlet_app", { kind: "user", marketId: "EG" }, q)).resolves.toBe(0);
    await close();
  });

  it("outlet_app in an auth-shaped context cannot see a user by phone", async () => {
    const { client, close } = await seed();
    const n = await asRole(client, "outlet_app", async (tx) => {
      await tx.query("SELECT set_config('app.ctx','auth',true), set_config('app.current_market_id','EG',true), set_config('app.auth_phone_bidx',$1,true)", [PH1]);
      return (await tx.query("SELECT id FROM users")).rows.length;
    });
    expect(n).toBe(0);
    await close();
  });

  it("outlet_auth inserts a pre-auth device (NULL user_id) but not a bound one", async () => {
    const { client, close } = await seed();
    const ctx: DbContext = { kind: "auth", marketId: "EG", auth: { installHash: INST } };
    const ins = (user: string | null) =>
      withDbContext(roleClient(client, "outlet_auth"), ctx, (tx) =>
        tx.query("INSERT INTO devices (id, market_id, user_id, platform, install_id_hash, first_seen_at, last_seen_at) VALUES ($1,'EG',$2,'web',$3,now(),now())", [D2, user, Buffer.from(INST, "hex")]),
      );
    await expect(ins(U1)).rejects.toThrow(/row-level security/);
    await ins(null);
    const seen = await withDbContext(roleClient(client, "outlet_auth"), ctx, (tx) => tx.query("SELECT id FROM devices"));
    expect(seen.rows).toEqual([{ id: D2 }]);
    // binding to the signed-in user is allowed; binding to someone else is not
    const bind = (u: string) =>
      withDbContext(roleClient(client, "outlet_auth"), { ...ctx, userId: U2 } as AuthContext, (tx) => tx.query("UPDATE devices SET user_id = $1 WHERE id = $2", [u, D2]));
    await expect(bind(U1)).rejects.toThrow(/row-level security/);
    await bind(U2);
    await close();
  });

  it("session_families: auth rebind may only touch revoked_at/revoke_reason of the device's families", async () => {
    const { client, close } = await seed();
    const F = "f1f1f1f1-f1f1-4f1f-8f1f-f1f1f1f1f1f1";
    await client.query("INSERT INTO session_families (id, user_id, device_id, amr, created_at) VALUES ($1,$2,$3,'{otp}',$4)", [F, U1, D1, TS]);
    const ctx: DbContext = { kind: "auth", marketId: "EG", auth: { deviceId: D1 } };
    await withDbContext(roleClient(client, "outlet_auth"), ctx, (tx) => tx.query("UPDATE session_families SET revoked_at = now(), revoke_reason = 'logout' WHERE device_id = $1", [D1]));
    await expect(withDbContext(roleClient(client, "outlet_auth"), ctx, (tx) => tx.query("UPDATE session_families SET user_id = $1 WHERE id = $2", [U2, F]))).rejects.toThrow(/permission denied/);
    const other: DbContext = { kind: "auth", marketId: "EG", auth: { deviceId: D2 } };
    const r = await withDbContext(roleClient(client, "outlet_auth"), other, (tx) => tx.query("UPDATE session_families SET revoked_at = now() RETURNING id"));
    expect(r.rows).toHaveLength(0);
    await close();
  });

  it("outlet_auth sees its OTP challenge only with the matching phone, and has no outbox/privacy access", async () => {
    const { client, close } = await seed();
    expect(await count(client, "outlet_auth", { kind: "auth", marketId: "EG", auth: { phoneBidx: PH1 } }, "SELECT 1 FROM otp_challenges")).toBe(1);
    expect(await count(client, "outlet_auth", { kind: "auth", marketId: "EG", auth: { phoneBidx: PH2 } }, "SELECT 1 FROM otp_challenges")).toBe(0);
    await expect(asRole(client, "outlet_auth", (tx) => tx.query("SELECT 1 FROM outbox_events"))).rejects.toThrow(/permission denied/);
    await expect(asRole(client, "outlet_auth", (tx) => tx.query("SELECT 1 FROM privacy_requests"))).rejects.toThrow(/permission denied/);
    await close();
  });

  it("outlet_worker: outbox.relay may UPDATE outbox_events, privacy.deletion may not", async () => {
    const { client, close } = await seed();
    const upd = (job: "outbox.relay" | "privacy.deletion") =>
      withDbContext(roleClient(client, "outlet_worker"), { kind: "worker", marketId: "EG", job }, (tx) => tx.query("UPDATE outbox_events SET attempts = attempts + 1 RETURNING id"));
    expect((await upd("outbox.relay")).rows).toHaveLength(1);
    expect((await upd("privacy.deletion")).rows).toHaveLength(0);
    const sel = (job: "outbox.relay" | "privacy.deletion") =>
      count(client, "outlet_worker", { kind: "worker", marketId: "EG", job }, "SELECT 1 FROM outbox_events");
    expect(await sel("outbox.relay")).toBe(1);
    expect(await sel("privacy.deletion")).toBe(0);
    // relay reads no users
    await expect(count(client, "outlet_worker", { kind: "worker", marketId: "EG", job: "outbox.relay" }, "SELECT 1 FROM users")).resolves.toBe(0);
    // worker cannot create users
    await expect(asRole(client, "outlet_worker", (tx) => tx.query("INSERT INTO users (id, market_id, created_at, updated_at) VALUES (gen_random_uuid(),'EG',now(),now())"))).rejects.toThrow(/permission denied/);
    await close();
  });

  it("retention policy: the database refuses rows younger than the cutoff even with WHERE true", async () => {
    const { client, close } = await seed();
    await client.query("DELETE FROM rate_limit_hits");
    await client.query("INSERT INTO rate_limit_hits (key, hit_at) VALUES ('old', now() - interval '48 hours 1 second'), ('young', now() - interval '47 hours 59 minutes 59 seconds')");
    const ctx: DbContext = { kind: "worker", marketId: "EG", job: "privacy.retention" };
    const del = await withDbContext(roleClient(client, "outlet_worker"), ctx, (tx) => tx.query<{ key: string }>("DELETE FROM rate_limit_hits WHERE true RETURNING key"));
    expect(del.rows).toEqual([{ key: "old" }]);
    expect((await client.query("SELECT key FROM rate_limit_hits")).rows).toEqual([{ key: "young" }]);
    // a different job cannot use the retention policy
    const other = await withDbContext(roleClient(client, "outlet_worker"), { kind: "worker", marketId: "EG", job: "outbox.relay" }, (tx) => tx.query("DELETE FROM rate_limit_hits WHERE true RETURNING key"));
    expect(other.rows).toHaveLength(0);
    await close();
  });

  it("no context -> zero rows for every role on every protected table", async () => {
    const { client, close } = await seed();
    const tables = ["users", "devices", "session_families", "age_attestations", "consent_records", "otp_challenges", "refresh_tokens", "age_blocks", "rate_limit_hits", "outbox_events", "dlq_messages", "privacy_requests"];
    for (const role of ["outlet_app", "outlet_auth", "outlet_worker"] as const) {
      for (const t of tables) {
        let n = 0;
        try {
          n = await count(client, role, undefined, `SELECT 1 FROM ${t}`);
        } catch (e) {
          expect(String(e)).toMatch(/permission denied/);
        }
        expect(n, `${role} on ${t}`).toBe(0);
      }
    }
    await close();
  });
});

describe("context lifecycle", () => {
  it("sets every key, and nothing survives commit or rollback", async () => {
    const { client, close } = await createTestClient();
    const read = () => client.query<Record<string, string | null>>("SELECT app.ctx() AS c, app.job() AS j, app.current_market_id() AS m, app.current_user_id()::text AS u, app.auth_phone_bidx()::text AS p");
    await withDbContext(client, { kind: "worker", marketId: "EG", job: "auth.purge", userId: U1 }, async (tx) => {
      const r = (await tx.query<Record<string, string | null>>("SELECT app.ctx() AS c, app.job() AS j, app.current_market_id() AS m, app.current_user_id()::text AS u, app.auth_phone_bidx() IS NULL AS p")).rows[0];
      expect(r).toEqual({ c: "worker", j: "auth.purge", m: "EG", u: U1, p: true });
    });
    expect((await read()).rows[0]).toEqual({ c: null, j: null, m: null, u: null, p: null });
    await expect(withDbContext(client, { kind: "auth", marketId: "EG", auth: { phoneBidx: PH1 } }, () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect((await read()).rows[0]).toEqual({ c: null, j: null, m: null, u: null, p: null });
    await withTenant(client, { marketId: "EG", userId: U1 }, async (tx) => {
      expect((await tx.query<{ c: string }>("SELECT app.ctx() AS c")).rows[0]?.c).toBe("user");
    });
    await close();
  });

  it("rejects malformed values before touching the database", async () => {
    const { client, close } = await createTestClient();
    await expect(withDbContext(client, { kind: "auth", marketId: "EG", auth: { phoneBidx: "zz" } }, () => Promise.resolve(1))).rejects.toThrow(/invalid auth.phoneBidx/);
    await expect(withDbContext(client, { kind: "user", marketId: "" }, () => Promise.resolve(1))).rejects.toThrow(/marketId/);
    await expect(withDbContext(client, { kind: "worker", marketId: "EG", job: "nope" as never }, () => Promise.resolve(1))).rejects.toThrow(/unknown worker job/);
    await close();
  });
});

describe("assertRuntimeRole", () => {
  it("passes for each runtime role and fails for the superuser and the wrong role", async () => {
    const { client, close } = await createTestClient();
    await expect(assertRuntimeRole(client, "outlet_app")).rejects.toThrow(/superuser/);
    for (const role of ["outlet_app", "outlet_auth", "outlet_worker"] as const) {
      await asRole(client, role, (tx) => assertRuntimeRole(tx, role));
    }
    await expect(asRole(client, "outlet_auth", (tx) => assertRuntimeRole(tx, "outlet_app"))).rejects.toThrow(/expected outlet_app/);
    await close();
  });

  it("fails when the role holds a forbidden privilege or a membership", async () => {
    const { client, close } = await createTestClient();
    await client.query("GRANT SELECT ON otp_challenges TO outlet_app");
    await expect(asRole(client, "outlet_app", (tx) => assertRuntimeRole(tx, "outlet_app"))).rejects.toThrow(/otp_challenges/);
    await client.query("REVOKE SELECT ON otp_challenges FROM outlet_app");
    await client.query("GRANT INSERT ON users TO outlet_worker");
    await expect(asRole(client, "outlet_worker", (tx) => assertRuntimeRole(tx, "outlet_worker"))).rejects.toThrow(/INSERT on users/);
    await client.query("REVOKE INSERT ON users FROM outlet_worker");
    await client.query("GRANT outlet_app TO outlet_auth");
    await expect(asRole(client, "outlet_auth", (tx) => assertRuntimeRole(tx, "outlet_auth"))).rejects.toThrow(/memberships/);
    await close();
  });
});

describe("rls-audit exceptions", () => {
  it("passes on the shipped schema", async () => {
    const { client, close } = await createTestClient();
    await expect(assertTenantTablesProtected(client)).resolves.toBeDefined();
    await close();
  });

  it("fails when a PUBLIC exception policy is added, or a role/name/ctx rule is broken", async () => {
    const { client, close } = await createTestClient();
    await client.query("CREATE POLICY users__auth_sneaky ON users FOR SELECT USING (app.ctx() = 'auth' AND market_id = app.current_market_id())");
    await expect(assertTenantTablesProtected(client)).rejects.toThrow(/users__auth_sneaky must be TO exactly one/);
    await client.query("DROP POLICY users__auth_sneaky ON users");
    await client.query("CREATE POLICY users__auth_x ON users FOR SELECT TO outlet_auth, outlet_worker USING (app.ctx() = 'auth' AND market_id = app.current_market_id())");
    await expect(assertTenantTablesProtected(client)).rejects.toThrow(/exactly one/);
    await client.query("DROP POLICY users__auth_x ON users");
    await client.query("CREATE POLICY users_badname ON users FOR SELECT TO outlet_auth USING (app.ctx() = 'auth' AND market_id = app.current_market_id())");
    await expect(assertTenantTablesProtected(client)).rejects.toThrow(/must be named users__auth_/);
    await client.query("DROP POLICY users_badname ON users");
    await client.query("CREATE POLICY users__auth_noctx ON users FOR SELECT TO outlet_auth USING (market_id = app.current_market_id())");
    await expect(assertTenantTablesProtected(client)).rejects.toThrow(/does not use app.ctx/);
    await client.query("DROP POLICY users__auth_noctx ON users");
    await client.query("CREATE POLICY users__auth_nomarket ON users FOR SELECT TO outlet_auth USING (app.ctx() = 'auth')");
    await expect(assertTenantTablesProtected(client)).rejects.toThrow(/pin app.current_market_id/);
    await client.query("DROP POLICY users__auth_nomarket ON users");
    await client.query("CREATE POLICY outbox_events__worker_nojob ON outbox_events FOR SELECT TO outlet_worker USING (app.ctx() = 'worker' AND market_id = app.current_market_id())");
    await expect(assertTenantTablesProtected(client)).rejects.toThrow(/does not use app.job/);
    await client.query("DROP POLICY outbox_events__worker_nojob ON outbox_events");
    await expect(assertTenantTablesProtected(client)).resolves.toBeDefined();
    await close();
  });

  it("fails when a retention policy lost its worker policy", async () => {
    const { client, close } = await createTestClient();
    await client.query("DROP POLICY otp_challenges__worker_privacy_retention_delete ON otp_challenges");
    await client.query("DROP POLICY otp_challenges__worker_privacy_retention_select ON otp_challenges");
    await expect(assertTenantTablesProtected(client)).rejects.toThrow(/retention policy for table otp_challenges/);
    await close();
  });

  it("the exception list matches the reviewed snapshot (new cross-user path = reviewed diff)", async () => {
    const { client, close } = await createTestClient();
    const actual = await listRlsExceptions(client);
    const expected: unknown = JSON.parse(readFileSync(new URL("./fixtures/rls-exceptions.json", import.meta.url), "utf8"));
    expect(actual).toEqual(expected);
    await close();
  });
});

