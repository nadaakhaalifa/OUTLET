import { afterAll, describe, expect, it } from "vitest";
import { KyselySubscriptionStore, type PlusDb } from "../adapters/kysely-store";
import { createPlusDatabase } from "../test/pglite-db";
import { plan } from "../test/repository-contract";
import { startPaid } from "../domain/bridge";
import { KyselyFamilyStore, KyselyStudentStore } from "./kysely-store";
import { describeFamilyStoreContract, describeStudentStoreContract, T0, U, type FamilyFixture } from "./store-contract";

const open: PlusDb[] = [];
let seq = 0;
const ids = { uuidV7: (): string => `00000000-0000-7000-8000-${String(++seq).padStart(12, "0")}` };

const fresh = async () => {
  const { pg, db } = await createPlusDatabase();
  open.push(db);
  const subs = new KyselySubscriptionStore(db, ids);
  const ensureUser = async (n: number) => {
    await pg.query(`insert into users (id, status) values ($1, 'active') on conflict do nothing`, [U(n)]);
  };
  let planSaved = false;
  const p = plan(1, { code: "plus_family", interval: "year", kind: "family", seatLimit: 4, trialDays: 0 });
  const fixture: FamilyFixture & { pg: typeof pg; db: PlusDb } = {
    pg,
    db,
    family: new KyselyFamilyStore(db, ids),
    students: new KyselyStudentStore(db, ids),
    ensureUser,
    eventTypes: async () => {
      const r = await pg.query<{ event_type: string }>(`select event_type from outbox_events order by id`);
      return r.rows.map((x) => x.event_type);
    },
    seedOwner: async (n) => {
      await ensureUser(n);
      if (!planSaved) {
        await subs.savePlan(p, []);
        planSaved = true;
      }
      const sub = startPaid({ id: U(500 + n), userId: U(n), plan: p, pspTokenRef: "tok", nowMs: T0 });
      const r = await subs.commit({ subscription: { value: sub, expectedVersion: null }, events: [] });
      if (r !== "ok") throw new Error(`seed failed ${r}`);
      return sub.id;
    },
  };
  return fixture;
};

afterAll(async () => {
  await Promise.all(open.map((d) => d.destroy()));
});

describeFamilyStoreContract("kysely/pglite", fresh);
describeStudentStoreContract("kysely/pglite", fresh);

describe("Kysely family persistence specifics", () => {
  it("plans round trip kind and seat limit; non family plans keep a null limit", async () => {
    const f = await fresh();
    const subs = new KyselySubscriptionStore(f.db, ids);
    const fam = plan(1, { code: "plus_family", interval: "year", kind: "family", seatLimit: 4, trialDays: 0 });
    const stu = plan(2, { code: "plus_student", interval: "year", kind: "student", seatLimit: null, trialDays: 0, priceMinor: 60_000n });
    const ind = plan(3, { code: "plus_yearly", interval: "year", priceMinor: 80_000n });
    for (const p of [fam, stu, ind]) expect(await subs.savePlan(p, [])).toBe("ok");
    const all = await subs.listPlanVersions();
    expect(all.map((p) => [p.code, p.kind, p.seatLimit])).toEqual([
      ["plus_family", "family", 4],
      ["plus_student", "student", null],
      ["plus_yearly", "individual", null],
    ]);
  });

  it("schema invariants: seat limit only for family, within 1..8; seats unique; owner is seat 1; student window <= 12 months", async () => {
    const f = await fresh();
    const subs = new KyselySubscriptionStore(f.db, ids);
    await expect(subs.savePlan(plan(1, { code: "plus_family", kind: "family", seatLimit: null }), [])).rejects.toThrow();
    await expect(subs.savePlan(plan(2, { code: "plus_family", version: 2, kind: "family", seatLimit: 9 }), [])).rejects.toThrow();
    await expect(subs.savePlan(plan(3, { code: "plus_x", kind: "individual", seatLimit: 4 }), [])).rejects.toThrow();
    await f.ensureUser(1);
    await expect(
      f.pg.query(
        `insert into student_verifications (id, user_id, verifier, ref, status, verified_at, valid_until)
         values ($1, $2, 'v', 'r', 'VERIFIED', now(), now() + interval '13 months')`,
        [U(1), U(1)],
      ),
    ).rejects.toThrow();
    const sub = await f.seedOwner(2);
    await f.family.createGroup(
      { id: U(1000), ownerUserId: U(2), subscriptionId: sub, seatLimit: 4, status: "ACTIVE", endingNoticeSentAtMs: null, createdAtMs: T0, version: 0 },
      { id: U(2000), groupId: U(1000), userId: U(2), role: "owner", status: "ACTIVE", seatNo: 1, nickname: null, invitedAtMs: T0, inviteExpiresAtMs: null, seatEffectiveFromMs: T0, seatEndAtMs: null, removedAtMs: null, removedBy: null },
      [],
    );
    await expect(
      f.pg.query(
        `insert into family_members (id, group_id, role, status, seat_no, invited_at) values ($1, $2, 'member', 'INVITED', 1, now())`,
        [U(2001), U(1000)],
      ),
    ).rejects.toThrow();
    await expect(
      f.pg.query(`insert into family_members (id, group_id, role, status, seat_no, invited_at) values ($1, $2, 'member', 'INVITED', 9, now())`, [U(2002), U(1000)]),
    ).rejects.toThrow();
    await expect(
      f.pg.query(
        `insert into family_members (id, group_id, user_id, role, status, seat_no, invited_at) values ($1, $2, $3, 'member', 'INVITED', 2, now())`,
        [U(2003), U(1000), U(2)],
      ),
    ).rejects.toThrow();
  });

  it("outbox payloads carry ids and enums only: no phone hash, token hash or nickname", async () => {
    const f = await fresh();
    const sub = await f.seedOwner(1);
    await f.family.createGroup(
      { id: U(1000), ownerUserId: U(1), subscriptionId: sub, seatLimit: 4, status: "ACTIVE", endingNoticeSentAtMs: null, createdAtMs: T0, version: 0 },
      { id: U(2000), groupId: U(1000), userId: U(1), role: "owner", status: "ACTIVE", seatNo: 1, nickname: null, invitedAtMs: T0, inviteExpiresAtMs: null, seatEffectiveFromMs: T0, seatEndAtMs: null, removedAtMs: null, removedBy: null },
      [{ type: "family.created", groupId: U(1000), ownerUserId: U(1), subscriptionId: sub, seatLimit: 4 }],
    );
    await f.students.save(
      { id: U(4001), userId: U(1), verifier: "v", ref: "r", status: "PENDING", verifiedAtMs: null, validUntilMs: null, noticeSentAtMs: null, createdAtMs: T0, version: 0 },
      null,
      [{ type: "student.verification_started", userId: U(1), verificationId: U(4001) }],
    );
    const rows = await f.pg.query<{ aggregate_type: string; payload: unknown }>(
      `select aggregate_type, payload from outbox_events where event_type like 'family.%' or event_type like 'student.%' order by event_type`,
    );
    expect(rows.rows.map((r) => r.aggregate_type)).toEqual(["family_group", "student_verification"]);
    expect(rows.rows[0]?.payload).toEqual({ groupId: U(1000), ownerUserId: U(1), subscriptionId: sub, seatLimit: 4 });
    expect(rows.rows[1]?.payload).toEqual({ userId: U(1), verificationId: U(4001) });
  });

  it("row level security: owner reads the group, seats and invites; a member only their seat; strangers nothing", async () => {
    const f = await fresh();
    for (const n of [1, 2, 3]) await f.ensureUser(n);
    const sub = await f.seedOwner(1);
    const g = { id: U(1000), ownerUserId: U(1), subscriptionId: sub, seatLimit: 4, status: "ACTIVE" as const, endingNoticeSentAtMs: null, createdAtMs: T0, version: 0 };
    await f.family.createGroup(g, { id: U(2000), groupId: U(1000), userId: U(1), role: "owner", status: "ACTIVE", seatNo: 1, nickname: null, invitedAtMs: T0, inviteExpiresAtMs: null, seatEffectiveFromMs: T0, seatEndAtMs: null, removedAtMs: null, removedBy: null }, []);
    await f.family.mutateGroup(g.id, T0, () => ({
      result: 1,
      members: [{ id: U(2001), groupId: g.id, userId: U(2), role: "member", status: "ACTIVE", seatNo: 2, nickname: "x", invitedAtMs: T0, inviteExpiresAtMs: null, seatEffectiveFromMs: T0, seatEndAtMs: null, removedAtMs: null, removedBy: null }],
      invites: [{ id: U(3001), groupId: g.id, memberId: U(2001), inviteePhoneHash: "a".repeat(64), tokenHash: "b".repeat(64), expiresAtMs: T0 + 1000, acceptedAtMs: T0, revokedAtMs: null, createdAtMs: T0 }],
      events: [],
    }));
    await f.students.save({ id: U(4001), userId: U(3), verifier: "v", ref: "r", status: "PENDING", verifiedAtMs: null, validUntilMs: null, noticeSentAtMs: null, createdAtMs: T0, version: 0 }, null, []);
    const asUser = async (userId: string, stmt: string): Promise<{ rows: unknown[] }> => {
      await f.pg.exec(`set role app_user; select set_config('app.user_id', '${userId}', false); select set_config('app.role', 'user', false);`);
      try {
        return await f.pg.query(stmt);
      } finally {
        await f.pg.exec(`reset role`);
      }
    };
    expect((await asUser(U(1), `select 1 from family_groups`)).rows).toHaveLength(1);
    expect((await asUser(U(2), `select 1 from family_groups`)).rows).toHaveLength(0);
    expect((await asUser(U(1), `select 1 from family_members`)).rows).toHaveLength(2);
    expect((await asUser(U(2), `select 1 from family_members`)).rows).toHaveLength(1);
    expect((await asUser(U(3), `select 1 from family_members`)).rows).toHaveLength(0);
    expect((await asUser(U(1), `select 1 from family_invites`)).rows).toHaveLength(1);
    expect((await asUser(U(2), `select 1 from family_invites`)).rows).toHaveLength(0);
    expect((await asUser(U(3), `select 1 from student_verifications`)).rows).toHaveLength(1);
    expect((await asUser(U(1), `select 1 from student_verifications`)).rows).toHaveLength(0);
    await expect(
      asUser(U(1), `update family_members set status = 'ENDED' where id = '${U(2001)}' returning id`),
    ).resolves.toEqual(expect.objectContaining({ rows: [] }));
  });
});
