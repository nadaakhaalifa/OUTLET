import { afterAll, describe, expect, it, vi } from "vitest";
import { createAdminDatabase, type PgliteLike } from "../test/pglite-db";
import { describeAdminContract, S, U, approval, elevation, type AdminContractContext } from "../test/contract";
import { KyselyAdminAudit, KyselyAdminStore, KyselySellerKyc, type AdminDb } from "./kysely-store";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 }); // PGlite boots a fresh database per test

const open: AdminDb[] = [];

const fresh = async (): Promise<AdminContractContext & { pg: PgliteLike; db: AdminDb }> => {
  const { pg, db } = await createAdminDatabase();
  open.push(db);
  return {
    pg,
    db,
    store: new KyselyAdminStore(db),
    kyc: new KyselySellerKyc(db),
    audit: new KyselyAdminAudit(db),
    seedUser: async (id) => {
      await pg.query(`insert into users (id, status) values ($1, 'active') on conflict do nothing`, [id]);
    },
    seedSeller: async (id, state, name) => {
      await pg.query(
        `insert into stores (seller_id, kind, slug, name_ar, seller_kyc_state) values ($1, 'local', $2, $3, $4)`,
        [id, `slug-${id.slice(-4)}`, name, state],
      );
    },
    auditRows: async () => {
      const r = await pg.query<{ action: string; reason_code: string | null; actor_id: string | null }>(
        `select action, reason_code, actor_id::text as actor_id from audit_log order by seq`,
      );
      return r.rows.map((x) => ({ action: x.action, reasonCode: x.reason_code, actorId: x.actor_id }));
    },
  };
};

afterAll(async () => {
  await Promise.all(open.map((d) => d.destroy()));
});

describeAdminContract("kysely/pglite", fresh);

describe("KyselyAdminStore specifics", () => {
  it("schema refuses self approval and approval without an approver", async () => {
    const c = await fresh();
    await c.seedUser(U(1));
    const a = approval(1);
    await c.store.insertApproval(a);
    await expect(c.pg.query(`update admin_approval_requests set state='APPROVED', approver_id=requester_id, decided_at=now() where id=$1`, [a.id])).rejects.toThrow();
    await expect(c.pg.query(`update admin_approval_requests set state='APPROVED', decided_at=now() where id=$1`, [a.id])).rejects.toThrow();
    await expect(c.pg.query(`update admin_elevations set state='ACTIVE' where false`)).resolves.toBeDefined();
  });

  it("schema refuses an elevation longer than 4 hours and a self-reviewed suspension", async () => {
    const c = await fresh();
    await c.seedUser(U(1));
    const a = approval(2, { kind: "role_elevation", subjectType: "elevation", subjectId: U(2001) });
    await expect(
      c.store.createElevationWithApproval(a, { ...elevation(1, a.id), requestedTtlMs: 4 * 3_600_000 + 1 }),
    ).rejects.toThrow();
    await c.pg.query(`insert into kyc_suspension_reviews (id, seller_id, suspended_by, suspended_at, due_at, reason_code) values ($1,$2,$3,now(),now()+interval '7 days','x')`, [U(1), S(1), U(1)]);
    await expect(
      c.pg.query(`update kyc_suspension_reviews set state='REINSTATED', reviewed_by=suspended_by, reviewed_at=now() where id=$1`, [U(1)]),
    ).rejects.toThrow();
  });

  it("audit rows join the 0005 hash chain per month and verify clean", async () => {
    const c = await fresh();
    await c.seedUser(U(1));
    for (let i = 0; i < 3; i += 1) {
      await c.audit.append({ action: `a${i}`, actorId: U(1), targetType: null, targetId: null, reasonCode: "kyc_review", diff: {}, requestId: null, atMs: 1_800_000_000_000 + i });
    }
    const seqs = await c.pg.query<{ seq: string; chain_id: string }>(`select seq::text, chain_id from audit_log order by seq`);
    expect(seqs.rows.map((r) => r.seq)).toEqual(["1", "2", "3"]);
    expect(new Set(seqs.rows.map((r) => r.chain_id)).size).toBe(1);
    expect(seqs.rows[0]?.chain_id).toMatch(/^admin:\d{4}-\d{2}$/);
    await c.pg.query(`select set_config('app.role','system',false)`); // audit_log_verify is role-gated (0093)
    const problems = await c.pg.query(`select * from audit_log_verify('${seqs.rows[0]?.chain_id}')`);
    expect(problems.rows).toEqual([]);
  });

  it("the audit writer rejects P3 keys and PII-looking values before writing anything (fails closed)", async () => {
    const c = await fresh();
    await c.seedUser(U(1));
    const base = { action: "x", actorId: U(1), targetType: null, targetId: null, reasonCode: "kyc_review", requestId: null, atMs: 1_800_000_000_000 };
    await expect(c.audit.append({ ...base, diff: { phone_e164: "ok" } })).rejects.toThrow(/audit diff rejected/);
    await expect(c.audit.append({ ...base, diff: { iban: "x" } })).rejects.toThrow(/audit diff rejected/);
    await expect(c.audit.append({ ...base, diff: { note: "+201001234567" } })).rejects.toThrow(/audit diff rejected/);
    await expect(c.audit.append({ ...base, diff: { fields: "phone" } })).resolves.toBeUndefined();
    const n = await c.pg.query<{ n: string }>(`select count(*)::text as n from audit_log`);
    expect(n.rows[0]?.n).toBe("1");
  });

  it("row level security: staff roles see what they should, shoppers and sellers see nothing", async () => {
    const c = await fresh();
    for (const n of [1, 2, 3]) await c.seedUser(U(n));
    const a = approval(3); // requester U(1)
    await c.store.insertApproval(a);
    await c.store.insertReview({
      id: U(3001), sellerId: S(1), suspendedBy: U(1), suspendedAtMs: 1_800_000_000_000, dueAtMs: 1_800_600_000_000,
      reasonCode: "fraud_investigation", state: "OPEN", reviewedBy: null, reviewedAtMs: null,
    });
    const as = async (userId: string, role: string | null, stmt: string): Promise<{ rows: unknown[] }> => {
      await c.pg.exec(
        `set role app_user; select set_config('app.user_id', '${userId}', false); select set_config('app.role', '${role ?? ""}', false);`,
      );
      try {
        return await c.pg.query<unknown>(stmt);
      } finally {
        await c.pg.exec(`reset role`);
      }
    };
    const sel = `select id from admin_approval_requests`;
    expect((await as(U(1), "finance", sel)).rows).toHaveLength(1); // requester
    expect((await as(U(2), "finance", sel)).rows).toHaveLength(1); // approver-class role
    expect((await as(U(2), "security", sel)).rows).toHaveLength(1);
    expect((await as(U(2), "marketing", sel)).rows).toHaveLength(0);
    expect((await as(U(2), "user", sel)).rows).toHaveLength(0); // a shopper
    expect((await as(U(2), null, sel)).rows).toHaveLength(0);
    const rev = `select id from kyc_suspension_reviews`;
    expect((await as(U(2), "trust_safety", rev)).rows).toHaveLength(1);
    expect((await as(U(2), "finance", rev)).rows).toHaveLength(0);
    expect((await as(U(2), "user", rev)).rows).toHaveLength(0);
    // a staff member cannot insert an approval in someone else's name
    await expect(
      as(U(2), "finance", `insert into admin_approval_requests (id, kind, subject_type, subject_id, reason_code, requester_id, requested_at, expires_at)
        values ('${U(7001)}', 'refund', 'refund', 'r', 'kyc_review', '${U(1)}', now(), now() + interval '1 day')`),
    ).rejects.toThrow();
    // elevations are visible to the owner and to security only
    const ae = approval(4, { kind: "role_elevation", subjectType: "elevation", subjectId: U(2001) });
    await c.store.createElevationWithApproval(ae, elevation(1, ae.id));
    expect((await as(U(1), "ops", `select id from admin_elevations`)).rows).toHaveLength(1);
    expect((await as(U(3), "ops", `select id from admin_elevations`)).rows).toHaveLength(0);
    expect((await as(U(3), "security", `select id from admin_elevations`)).rows).toHaveLength(1);
  });
});
