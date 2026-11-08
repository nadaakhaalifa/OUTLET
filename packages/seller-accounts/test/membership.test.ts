import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withDbContext } from "@outlet/db";
import type { Principal } from "@outlet/policy";
import { MARKET, staff } from "./fixtures.js";
import type { World } from "./fixtures.js";
import { buildWorld, countQueries } from "./fixtures.js";

let w: World;
beforeAll(async () => {
  w = await buildWorld();
});
afterAll(async () => {
  await w.close();
});

/** An approved seller with its store and an owner who has enrolled strong auth. */
const storeWithOwner = async (): Promise<{ storeId: string; owner: string; ownerP: Principal }> => {
  const owner = await w.user();
  const { storeId } = await w.approvedSeller(owner);
  await w.members.bootstrapOwner(owner, storeId);
  await w.members.enrollStrongAuth(owner, storeId, "passkey", "ok:1");
  return { storeId, owner, ownerP: staff(owner, [storeId], ["owner"]) };
};

/** Invites `phone`'s user with `role`, accepts, enrolls strong auth; returns the member id. */
const addMember = async (s: { storeId: string; ownerP: Principal }, role: "owner" | "manager" | "catalog" | "support" | "finance" | "warehouse", enroll = true): Promise<{ userId: string; memberId: string }> => {
  const userId = await w.user();
  const phone = w.phone.get(userId)!;
  const inv = await w.members.invite(s.ownerP, s.storeId, { contact: { kind: "phone", value: phone }, role });
  await w.members.accept(userId, s.storeId, inv.id);
  if (enroll) await w.members.enrollStrongAuth(userId, s.storeId, "totp", "ok:2");
  return { userId, memberId: inv.id };
};

describe("bootstrap and invitations", () => {
  it("only the approved applicant becomes first owner, once", async () => {
    const owner = await w.user();
    const { storeId } = await w.approvedSeller(owner);
    const stranger = await w.user();
    await expect(w.members.bootstrapOwner(stranger, storeId)).rejects.toMatchObject({ code: "not_found" });
    await expect(w.members.bootstrapOwner(owner, randomUUID())).rejects.toMatchObject({ code: "not_found" });
    expect((await w.members.bootstrapOwner(owner, storeId)).role).toBe("owner");
    await expect(w.members.bootstrapOwner(owner, storeId)).rejects.toMatchObject({ code: "conflict" });
  });

  it("B1: an approved applicant of seller X cannot become owner of seller Y's store, even by inserting directly as the worker job", async () => {
    const x = await w.user();
    await w.approvedSeller(x);
    const y = await w.user();
    const { storeId: yStore } = await w.approvedSeller(y);
    await expect(w.members.bootstrapOwner(x, yStore)).rejects.toMatchObject({ code: "not_found" });
    await expect(
      withDbContext(w.deps.worker, { kind: "worker", marketId: MARKET, job: "seller.kyc", userId: x }, (tx) =>
        tx.query("INSERT INTO store_members (id, store_id, market_id, user_id, role_code, status, accepted_at) VALUES ($1,$2,'EG',$3,'owner','active',now())", [randomUUID(), yStore, x]),
      ),
    ).rejects.toThrow(/row-level security/);
    expect((await w.raw.query("SELECT 1 FROM store_members WHERE store_id = $1", [yStore])).rows).toHaveLength(0);
  });

  it("B3: a non-member cannot read other members, and accept/find bind no store context for them", async () => {
    const s = await storeWithOwner();
    const stranger = await w.user();
    const inv = await w.members.invite(s.ownerP, s.storeId, { contact: { kind: "phone", value: "+201099999999" }, role: "support" });
    // outlet_app with a user context (what the stranger would hold) sees no store_members row; there is no invite-read policy for outlet_app.
    const seen = await withDbContext(w.deps.app, { kind: "user", marketId: MARKET, userId: stranger }, (tx) => tx.query("SELECT id FROM store_members"));
    expect(seen.rows).toHaveLength(0);
    // The stranger cannot accept someone else's invite, and the invite is untouched.
    await expect(w.members.accept(stranger, s.storeId, inv.id)).rejects.toMatchObject({ code: "not_found" });
    expect((await w.raw.query<{ status: string }>("SELECT status FROM store_members WHERE id = $1", [inv.id])).rows[0]?.status).toBe("invited");
    // The job may flip an invite only to the narrowed user's own active row.
    await expect(
      withDbContext(w.deps.worker, { kind: "worker", marketId: MARKET, job: "seller.kyc", userId: stranger }, (tx) =>
        tx.query("UPDATE store_members SET status = 'active', user_id = $2, accepted_at = now() WHERE id = $1", [inv.id, s.owner]),
      ),
    ).rejects.toThrow(/row-level security/);
    await expect(
      withDbContext(w.deps.worker, { kind: "worker", marketId: MARKET, job: "seller.kyc", userId: stranger }, (tx) =>
        tx.query("UPDATE store_members SET role_code = 'owner' WHERE id = $1", [inv.id]),
      ),
    ).rejects.toThrow(/permission denied/);
    expect(await w.members.find(MARKET, stranger, s.storeId)).toBeNull();
  });

  it("an unapproved applicant cannot bootstrap", async () => {
    const u = await w.user();
    const { sellerId } = await w.onboarding.createDraft(u, { legal_type: "company" });
    const storeId = randomUUID();
    await w.raw.query(`INSERT INTO stores (id, seller_id, market_id, slug, display_name_ar, kind, ships_from_country) VALUES ($1,$2,'EG',$3,'م','local','EG')`, [storeId, sellerId, `d-${storeId.slice(0, 6)}`]);
    await expect(w.members.bootstrapOwner(u, storeId)).rejects.toMatchObject({ code: "not_found" });
  });

  it("invite -> accept -> active; the contact is never stored, only its blind index", async () => {
    const s = await storeWithOwner();
    const m = await addMember(s, "catalog");
    const rows = (await w.raw.query("SELECT * FROM store_members WHERE id = $1", [m.memberId])).rows[0]!;
    expect(rows.status).toBe("active");
    expect(rows.user_id).toBe(m.userId);
    expect(rows.invitee_bidx).toBeNull();
    expect(JSON.stringify(rows)).not.toContain(w.phone.get(m.userId)!);
    expect(await w.members.find(MARKET, m.userId, s.storeId)).toEqual({ roles: ["catalog"] });
  });

  it("only the invited person can accept; wrong user, repeat accept and expired invites are not_found", async () => {
    const s = await storeWithOwner();
    const invitee = await w.user();
    const inv = await w.members.invite(s.ownerP, s.storeId, { contact: { kind: "phone", value: w.phone.get(invitee)! }, role: "support" });
    const other = await w.user();
    await expect(w.members.accept(other, s.storeId, inv.id)).rejects.toMatchObject({ code: "not_found" });
    expect(await w.members.find(MARKET, other, s.storeId)).toBeNull();
    await expect(w.members.invite(s.ownerP, s.storeId, { contact: { kind: "phone", value: w.phone.get(invitee)! }, role: "support" })).rejects.toMatchObject({ code: "conflict" });
    await w.raw.query("UPDATE store_members SET invite_expires_at = '2020-01-01' WHERE id = $1", [inv.id]);
    await expect(w.members.accept(invitee, s.storeId, inv.id)).rejects.toMatchObject({ code: "not_found" });
  });

  it("store A owner cannot invite into store B (not_found) and gets nothing from B's data", async () => {
    const a = await storeWithOwner();
    const b = await storeWithOwner();
    await expect(w.members.invite(a.ownerP, b.storeId, { contact: { kind: "phone", value: "+201000000001" }, role: "support" })).rejects.toMatchObject({ code: "not_found" });
    await expect(w.members.listMembers(a.ownerP, b.storeId)).rejects.toMatchObject({ code: "not_found" });
    // Forged principal claiming store B: the database refuses (actor is not a member there).
    const forged = staff(a.owner, [b.storeId], ["owner"]);
    await expect(w.members.invite(forged, b.storeId, { contact: { kind: "phone", value: "+201000000002" }, role: "support" })).rejects.toMatchObject({ code: "not_found" });
    expect(await w.members.find(MARKET, a.owner, b.storeId)).toBeNull();
    // Cross-store member ids are invisible (RLS)
    const mine = await w.members.listMembers(a.ownerP, a.storeId);
    await expect(w.members.suspend(a.ownerP, b.storeId, (mine[0] as { id: string }).id)).rejects.toMatchObject({ code: "not_found" });
  });

  it("find answers null for another market and for suspended or removed members", async () => {
    const s = await storeWithOwner();
    const m = await addMember(s, "manager");
    expect(await w.members.find("AE", m.userId, s.storeId)).toBeNull();
    await w.members.suspend(s.ownerP, s.storeId, m.memberId);
    expect(await w.members.find(MARKET, m.userId, s.storeId)).toBeNull();
    expect(await w.members.isMember(m.userId, s.storeId)).toBe(false);
    await w.members.reinstate(s.ownerP, s.storeId, m.memberId);
    expect(await w.members.isMember(m.userId, s.storeId)).toBe(true);
    await w.members.remove(s.ownerP, s.storeId, m.memberId);
    expect(await w.members.isMember(m.userId, s.storeId)).toBe(false);
  });
});

describe("roles and authority", () => {
  it("support (and manager) cannot change roles; forbidden, not not_found", async () => {
    const s = await storeWithOwner();
    const sup = await addMember(s, "support");
    const mgr = await addMember(s, "manager");
    const victim = await addMember(s, "catalog");
    for (const [u, role] of [[sup, "support"], [mgr, "manager"]] as const) {
      const p = staff(u.userId, [s.storeId], [role]);
      await expect(w.members.changeRole(p, s.storeId, victim.memberId, "owner")).rejects.toMatchObject({ code: "forbidden" });
      await expect(w.members.invite(p, s.storeId, { contact: { kind: "email", value: "x@example.com" }, role: "support" })).rejects.toMatchObject({ code: "forbidden" });
      await expect(w.members.suspend(p, s.storeId, victim.memberId)).rejects.toMatchObject({ code: "forbidden" });
    }
    // A forged "owner" claim by a support member is caught by the database's view of the actor's role.
    const forged = staff(sup.userId, [s.storeId], ["owner"]);
    await expect(w.members.changeRole(forged, s.storeId, victim.memberId, "owner")).rejects.toMatchObject({ code: "forbidden" });
    expect((await w.members.listMembers(s.ownerP, s.storeId)).find((m) => m.id === victim.memberId)?.role).toBe("catalog");
  });

  it("owner changes a role; optimistic version conflict; a shopper principal is refused", async () => {
    const s = await storeWithOwner();
    const m = await addMember(s, "catalog");
    const changed = await w.members.changeRole(s.ownerP, s.storeId, m.memberId, "finance");
    expect(changed.role).toBe("finance");
    await expect(w.members.changeRole(s.ownerP, s.storeId, m.memberId, "support", changed.version - 1)).rejects.toMatchObject({ code: "conflict" });
    await expect(w.members.changeRole({ ...s.ownerP, kind: "shopper" }, s.storeId, m.memberId, "support")).rejects.toMatchObject({ code: "forbidden" });
    expect((await w.raw.query("SELECT 1 FROM outbox_events WHERE event_type = 'store_member.role_changed' AND aggregate_id = $1", [m.memberId])).rows).toHaveLength(1);
  });

  it("the last active owner cannot be demoted, suspended or removed; with a second owner it can", async () => {
    const s = await storeWithOwner();
    const me = (await w.members.listMembers(s.ownerP, s.storeId))[0] as { id: string };
    for (const op of [
      () => w.members.changeRole(s.ownerP, s.storeId, me.id, "manager"),
      () => w.members.suspend(s.ownerP, s.storeId, me.id),
      () => w.members.remove(s.ownerP, s.storeId, me.id),
    ]) await expect(op()).rejects.toMatchObject({ code: "last_owner" });
    const second = await addMember(s, "owner");
    expect((await w.members.changeRole(s.ownerP, s.storeId, me.id, "manager")).role).toBe("manager");
    // now `second` is the only owner
    const p2 = staff(second.userId, [s.storeId], ["owner"]);
    await expect(w.members.remove(p2, s.storeId, second.memberId)).rejects.toMatchObject({ code: "last_owner" });
  });

  it("an invited (pending) owner does not count as an owner", async () => {
    const s = await storeWithOwner();
    const me = (await w.members.listMembers(s.ownerP, s.storeId))[0] as { id: string };
    await w.members.invite(s.ownerP, s.storeId, { contact: { kind: "email", value: "pending@example.com" }, role: "owner" });
    await expect(w.members.remove(s.ownerP, s.storeId, me.id)).rejects.toMatchObject({ code: "last_owner" });
  });
});

describe("strong auth", () => {
  it("requireStrongAuth: PASSKEY_REQUIRED until enrolled, then passes; non-members get not_found", async () => {
    const s = await storeWithOwner();
    const m = await addMember(s, "catalog", false);
    await expect(w.members.requireStrongAuth(m.userId, s.storeId)).rejects.toMatchObject({ code: "passkey_required" });
    await expect(w.members.enrollStrongAuth(m.userId, s.storeId, "passkey", "bad-proof")).rejects.toMatchObject({ code: "validation" });
    await expect(w.members.requireStrongAuth(m.userId, s.storeId)).rejects.toMatchObject({ code: "passkey_required" });
    await w.members.enrollStrongAuth(m.userId, s.storeId, "passkey", "ok:abc");
    await expect(w.members.requireStrongAuth(m.userId, s.storeId)).resolves.toBeUndefined();
    await expect(w.members.requireStrongAuth(await w.user(), s.storeId)).rejects.toMatchObject({ code: "not_found" });
    const row = (await w.raw.query<{ strong_auth_method: string }>("SELECT strong_auth_method FROM store_members WHERE id = $1", [m.memberId])).rows[0];
    expect(row?.strong_auth_method).toBe("passkey");
  });

  it("an owner without strong auth cannot manage the team", async () => {
    const owner = await w.user();
    const { storeId } = await w.approvedSeller(owner);
    await w.members.bootstrapOwner(owner, storeId);
    await expect(w.members.invite(staff(owner, [storeId]), storeId, { contact: { kind: "email", value: "n@example.com" }, role: "support" })).rejects.toMatchObject({ code: "passkey_required" });
    await w.members.enrollStrongAuth(owner, storeId, "totp", "ok:1");
    await expect(w.members.invite(staff(owner, [storeId]), storeId, { contact: { kind: "email", value: "n@example.com" }, role: "support" })).resolves.toMatchObject({ status: "invited" });
  });
});

describe("membershipsFor", () => {
  it("returns only the caller's active memberships in exactly one query", async () => {
    const s1 = await storeWithOwner();
    const s2 = await storeWithOwner();
    const m = await addMember(s1, "finance");
    const inv2 = await w.members.invite(s2.ownerP, s2.storeId, { contact: { kind: "phone", value: w.phone.get(m.userId)! }, role: "support" });
    // pending invite in s2 and a suspended row must not appear
    const counted = await countQueries(w, (svc) => svc.membershipsFor(m.userId));
    expect(counted.count, counted.statements.join("\n")).toBe(1);
    expect(counted.result).toEqual([{ storeId: s1.storeId, role: "finance", strongAuthEnrolled: true }]);
    await w.members.accept(m.userId, s2.storeId, inv2.id);
    const two = await w.members.membershipsFor(m.userId);
    expect(two.map((x) => x.storeId).sort()).toEqual([s1.storeId, s2.storeId].sort());
    await w.members.suspend(s2.ownerP, s2.storeId, inv2.id);
    expect((await w.members.membershipsFor(m.userId)).map((x) => x.storeId)).toEqual([s1.storeId]);
    expect(await w.members.membershipsFor(await w.user())).toEqual([]);
  });

  it("the auth role cannot read other users' rows or unlisted columns, and cannot write", async () => {
    const s = await storeWithOwner();
    const q = (sql: string, userId: string): Promise<unknown> =>
      w.auth.transaction(async (tx) => {
        await tx.query("SELECT set_config('app.ctx','auth',true), set_config('app.current_market_id','EG',true), set_config('app.current_user_id',$1,true)", [userId]);
        return tx.query(sql);
      });
    await expect(q("SELECT invitee_bidx FROM store_members", s.owner)).rejects.toThrow(/permission denied/u);
    await expect(q("UPDATE store_members SET role_code = 'support'", s.owner)).rejects.toThrow(/permission denied/u);
    const rows = (await q("SELECT user_id FROM store_members", randomUUID())) as { rows: unknown[] };
    expect(rows.rows).toHaveLength(0);
  });

  it("outlet_app with a user context (no store) sees no memberships at all", async () => {
    const s = await storeWithOwner();
    const rows = await w.app.transaction(async (tx) => {
      await tx.query("SELECT set_config('app.ctx','user',true), set_config('app.current_market_id','EG',true), set_config('app.current_user_id',$1,true)", [s.owner]);
      return tx.query("SELECT 1 FROM store_members");
    });
    expect(rows.rows).toHaveLength(0);
  });
});

describe("events", () => {
  it("emits PII-free outbox events in the same transaction", async () => {
    const s = await storeWithOwner();
    const m = await addMember(s, "warehouse");
    const ev = (await w.raw.query<{ payload: Record<string, unknown>; event_type: string }>("SELECT event_type, payload FROM outbox_events WHERE aggregate_id = $1 ORDER BY occurred_at", [m.memberId])).rows;
    expect(ev.map((e) => e.event_type)).toEqual(["store_member.invited", "store_member.accepted", "store_member.strong_auth_enrolled"]);
    expect(JSON.stringify(ev)).not.toContain(w.phone.get(m.userId)!);
  });
});
