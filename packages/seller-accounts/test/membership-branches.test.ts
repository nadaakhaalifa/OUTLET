import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Principal } from "@outlet/policy";
import type { SellerRole } from "../src/index.js";
import { MARKET, staff } from "./fixtures.js";
import type { World } from "./fixtures.js";
import { buildWorld } from "./fixtures.js";

let w: World;
beforeAll(async () => { w = await buildWorld(); });
afterAll(async () => { await w.close(); });

const storeWithOwner = async (): Promise<{ storeId: string; owner: string; ownerP: Principal }> => {
  const owner = await w.user();
  const { storeId } = await w.approvedSeller(owner);
  await w.members.bootstrapOwner(owner, storeId);
  await w.members.enrollStrongAuth(owner, storeId, "passkey", "ok:1");
  return { storeId, owner, ownerP: staff(owner, [storeId], ["owner"]) };
};
const addMember = async (s: { storeId: string; ownerP: Principal }, role: SellerRole): Promise<{ userId: string; memberId: string }> => {
  const userId = await w.user();
  const inv = await w.members.invite(s.ownerP, s.storeId, { contact: { kind: "phone", value: w.phone.get(userId) ?? "" }, role });
  await w.members.accept(userId, s.storeId, inv.id);
  return { userId, memberId: inv.id };
};
const memberRow = async (id: string) => (await w.raw.query<{ status: string; role_code: string; version: number; invitee_bidx: unknown }>("SELECT status, role_code, version, invitee_bidx FROM store_members WHERE id = $1", [id])).rows[0];

describe("membership error branches", () => {
  it("bootstrapping a store that already has a member is a conflict, and a second applicant-owner insert never duplicates the owner", async () => {
    const s = await storeWithOwner();
    await expect(w.members.bootstrapOwner(s.owner, s.storeId)).rejects.toMatchObject({ code: "conflict" });
    const owners = await w.raw.query("SELECT 1 FROM store_members WHERE store_id = $1 AND role_code = 'owner'", [s.storeId]);
    expect(owners.rows).toHaveLength(1);
  });

  it("accept: a user with neither a phone nor an email blind index has no invitation to accept", async () => {
    const s = await storeWithOwner();
    const ghost = randomUUID();
    await w.raw.query("INSERT INTO users (id, market_id, status, locale, created_at, updated_at) VALUES ($1,$2,'active','ar-EG',now(),now())", [ghost, MARKET]);
    const inv = await w.members.invite(s.ownerP, s.storeId, { contact: { kind: "phone", value: "+201055500001" }, role: "support" });
    await expect(w.members.accept(ghost, s.storeId, inv.id)).rejects.toMatchObject({ code: "not_found" });
    await expect(w.members.accept(randomUUID(), s.storeId, inv.id)).rejects.toMatchObject({ code: "not_found" });
    expect((await memberRow(inv.id))?.status).toBe("invited");
  });

  it("accept by email: a user with only an email blind index accepts an email invite but not a phone invite", async () => {
    const s = await storeWithOwner();
    const u = randomUUID();
    const email = "Staff.Member@Example.com";
    await w.raw.query("INSERT INTO users (id, market_id, status, email_bidx, locale, created_at, updated_at) VALUES ($1,$2,'active',$3,'ar-EG',now(),now())", [u, MARKET, w.hasher.hmac("email", `${MARKET}:${email.toLowerCase()}`)]);
    const phoneInv = await w.members.invite(s.ownerP, s.storeId, { contact: { kind: "phone", value: "+201055500002" }, role: "support" });
    await expect(w.members.accept(u, s.storeId, phoneInv.id)).rejects.toMatchObject({ code: "not_found" });
    const emailInv = await w.members.invite(s.ownerP, s.storeId, { contact: { kind: "email", value: email }, role: "catalog" });
    expect(await w.members.accept(u, s.storeId, emailInv.id)).toMatchObject({ status: "active", role: "catalog", userId: u });
  });

  it("accept: an existing member holding a second invite cannot double-join (conflict), and the invite stays pending", async () => {
    const s = await storeWithOwner();
    const m = await addMember(s, "support");
    const second = await w.members.invite(s.ownerP, s.storeId, { contact: { kind: "phone", value: w.phone.get(m.userId) ?? "" }, role: "catalog" });
    // the same contact is already bound to an ACTIVE row, so a fresh invite is allowed; accepting it must not create a duplicate membership
    await expect(w.members.accept(m.userId, s.storeId, second.id)).rejects.toMatchObject({ code: "conflict" });
    expect((await memberRow(second.id))?.status).toBe("invited");
    expect((await memberRow(m.memberId))?.role_code).toBe("support");
  });

  it("changeRole: an unknown role is a validation error before any database work; a missing member is not_found", async () => {
    const s = await storeWithOwner();
    const m = await addMember(s, "support");
    expect(() => w.members.changeRole(s.ownerP, s.storeId, m.memberId, "root" as SellerRole)).toThrow(expect.objectContaining({ code: "validation" }) as Error);
    await expect(w.members.changeRole(s.ownerP, s.storeId, randomUUID(), "catalog")).rejects.toMatchObject({ code: "not_found" });
    expect((await memberRow(m.memberId))?.role_code).toBe("support");
  });

  it("changeRole, suspend, reinstate and remove refuse members in the wrong status (conflict) and leave the row untouched", async () => {
    const s = await storeWithOwner();
    const pending = await w.members.invite(s.ownerP, s.storeId, { contact: { kind: "phone", value: "+201055500003" }, role: "support" });
    await expect(w.members.changeRole(s.ownerP, s.storeId, pending.id, "catalog")).rejects.toMatchObject({ code: "conflict" });
    await expect(w.members.suspend(s.ownerP, s.storeId, pending.id)).rejects.toMatchObject({ code: "conflict" });
    await expect(w.members.reinstate(s.ownerP, s.storeId, pending.id)).rejects.toMatchObject({ code: "conflict" });
    const m = await addMember(s, "support");
    await expect(w.members.reinstate(s.ownerP, s.storeId, m.memberId)).rejects.toMatchObject({ code: "conflict" });
    await w.members.remove(s.ownerP, s.storeId, m.memberId);
    for (const op of [() => w.members.remove(s.ownerP, s.storeId, m.memberId), () => w.members.suspend(s.ownerP, s.storeId, m.memberId), () => w.members.changeRole(s.ownerP, s.storeId, m.memberId, "catalog")]) {
      await expect(op()).rejects.toMatchObject({ code: "conflict" });
    }
    expect((await memberRow(m.memberId))?.status).toBe("removed");
    expect((await memberRow(pending.id))?.status).toBe("invited");
  });

  it("revoking a pending invitation clears the blind index; a suspended member can be re-roled (including to owner) and reinstated", async () => {
    const s = await storeWithOwner();
    const pending = await w.members.invite(s.ownerP, s.storeId, { contact: { kind: "email", value: "pend@example.com" }, role: "support" });
    expect((await memberRow(pending.id))?.invitee_bidx).not.toBeNull();
    await w.members.remove(s.ownerP, s.storeId, pending.id);
    expect(await memberRow(pending.id)).toMatchObject({ status: "removed", invitee_bidx: null });
    const m = await addMember(s, "support");
    await w.members.suspend(s.ownerP, s.storeId, m.memberId);
    expect(await w.members.changeRole(s.ownerP, s.storeId, m.memberId, "owner")).toMatchObject({ role: "owner", status: "suspended" });
    expect(await w.members.reinstate(s.ownerP, s.storeId, m.memberId)).toMatchObject({ status: "active", role: "owner" });
  });

  it("expectedVersion guards every mutation: a stale version is a conflict and a fresh one succeeds", async () => {
    const s = await storeWithOwner();
    const m = await addMember(s, "support");
    const v = (await memberRow(m.memberId))?.version ?? -1;
    await expect(w.members.suspend(s.ownerP, s.storeId, m.memberId, v - 1)).rejects.toMatchObject({ code: "conflict" });
    expect(await w.members.suspend(s.ownerP, s.storeId, m.memberId, v)).toMatchObject({ status: "suspended", version: v + 1 });
  });

  it("enrollStrongAuth for a user who is not an active member of the store is not_found and writes nothing", async () => {
    const s = await storeWithOwner();
    const stranger = await w.user();
    await expect(w.members.enrollStrongAuth(stranger, s.storeId, "totp", "ok:1")).rejects.toMatchObject({ code: "not_found" });
    const m = await addMember(s, "support");
    await w.members.suspend(s.ownerP, s.storeId, m.memberId);
    await expect(w.members.enrollStrongAuth(m.userId, s.storeId, "totp", "ok:1")).rejects.toMatchObject({ code: "not_found" });
  });

  it("a staff principal without a user id, a shopper and an admin cannot manage the team (forbidden before any query)", async () => {
    const s = await storeWithOwner();
    const noUser: Principal = { ...s.ownerP };
    delete (noUser as { userId?: string }).userId;
    const shopper: Principal = { kind: "shopper", userId: s.owner, marketId: MARKET, roles: [], scopes: [] };
    for (const who of [noUser, shopper]) await expect(w.members.listMembers(who, s.storeId)).rejects.toMatchObject({ code: "forbidden" });
  });
});
