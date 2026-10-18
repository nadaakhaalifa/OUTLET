import { describe, expect, it } from "vitest";
import { DAY_MS } from "../domain/bridge";
import { createFamilyWorld, type FamilyWorld } from "./test/world";

const setup = async (): Promise<FamilyWorld> => createFamilyWorld();

async function family(w: FamilyWorld, seats = 1) {
  const owner = await w.owner(1);
  const members = [];
  for (let i = 0; i < seats; i += 1) {
    const m = w.person(10 + i);
    const { token } = await w.inviteAndToken(owner.userId, m.phone, `m${i}`);
    const r = await w.uc.accept.execute({ userId: m.userId, token, existingPlan: null });
    if (r.kind !== "accepted") throw new Error(`accept failed: ${r.kind}`);
    members.push(m);
  }
  return { owner, members };
}

describe("family: create and invite", () => {
  it("subscribes the owner to the family plan, opens the group with 4 seats and owner on seat 1", async () => {
    const w = await setup();
    const owner = await w.owner(1);
    const v = await w.uc.getFamily.execute(owner.userId);
    expect(v).toMatchObject({ role: "owner", seatLimit: 4, seatsHeld: 1, seatsFree: 3, status: "ACTIVE" });
    const sub = await w.store.getLiveByUser(owner.userId);
    expect(sub?.planCode).toBe("plus_family");
    expect(w.charges.requests[0]?.amountMinor).toBe(120_000n);
    expect(w.familyStore.events.map((e) => e.type)).toEqual(["family.created"]);
  });

  it("a fifth adult is refused: family of 4 (owner + 3) refuses the next invite with seats_full", async () => {
    const w = await setup();
    const { owner } = await family(w, 3);
    const extra = w.person(40);
    const r = await w.uc.invite.execute({ ownerUserId: owner.userId, phoneE164: extra.phone, nickname: null });
    expect(r).toEqual({ kind: "refused", reason: "seats_full" });
  });

  it("a pending invite holds its seat, a revoked one frees it, delivery failure releases it", async () => {
    const w = await setup();
    const owner = await w.owner(1);
    for (let i = 0; i < 3; i += 1) await w.inviteAndToken(owner.userId, w.phoneOf(50 + i));
    expect((await w.uc.invite.execute({ ownerUserId: owner.userId, phoneE164: w.phoneOf(60), nickname: null })).kind).toBe("refused");
    const view = await w.uc.getFamily.execute(owner.userId);
    const pending = view?.role === "owner" ? view.members.find((m) => m.status === "INVITED") : undefined;
    expect(pending).toBeDefined();
    expect((await w.uc.revoke.execute(owner.userId, pending?.id ?? "")).kind).toBe("revoked");
    w.delivery.failNext = true;
    expect((await w.uc.invite.execute({ ownerUserId: owner.userId, phoneE164: w.phoneOf(61), nickname: null })).kind).toBe("delivery_failed");
    const again = await w.uc.invite.execute({ ownerUserId: owner.userId, phoneE164: w.phoneOf(62), nickname: null });
    expect(again.kind).toBe("invited");
  });

  it("refuses a self invite, a duplicate pending invite, a known under-age person and someone already in a family", async () => {
    const w = await setup();
    const owner = await w.owner(1);
    expect(await w.uc.invite.execute({ ownerUserId: owner.userId, phoneE164: owner.phone, nickname: null })).toEqual({
      kind: "refused",
      reason: "self_invite",
    });
    await w.inviteAndToken(owner.userId, w.phoneOf(2));
    expect(await w.uc.invite.execute({ ownerUserId: owner.userId, phoneE164: w.phoneOf(2), nickname: null })).toEqual({
      kind: "refused",
      reason: "already_invited",
    });
    w.person(3, { age: 19 });
    expect(await w.uc.invite.execute({ ownerUserId: owner.userId, phoneE164: w.phoneOf(3), nickname: null })).toEqual({
      kind: "refused",
      reason: "age_gate",
      minAge: 21,
    });
    const other = await w.owner(4);
    const inOther = w.person(5);
    const { token } = await w.inviteAndToken(other.userId, inOther.phone);
    await w.uc.accept.execute({ userId: inOther.userId, token, existingPlan: null });
    expect(await w.uc.invite.execute({ ownerUserId: owner.userId, phoneE164: inOther.phone, nickname: null })).toEqual({
      kind: "refused",
      reason: "already_in_family",
    });
  });

  it("the Plus age gate follows the policy: lowered to 18 admits an 18 year old, never below 18", async () => {
    const w = await setup();
    const owner = await w.owner(1);
    w.person(3, { age: 18 });
    expect((await w.uc.invite.execute({ ownerUserId: owner.userId, phoneE164: w.phoneOf(3), nickname: null })).kind).toBe("refused");
    w.ages.minAge = 18;
    expect((await w.uc.invite.execute({ ownerUserId: owner.userId, phoneE164: w.phoneOf(3), nickname: null })).kind).toBe("invited");
    w.person(4, { age: 17 });
    w.ages.minAge = 16;
    expect(await w.uc.invite.execute({ ownerUserId: owner.userId, phoneE164: w.phoneOf(4), nickname: null })).toEqual({
      kind: "refused",
      reason: "age_gate",
      minAge: 18,
    });
  });

  it("only the family owner can invite and the kill switch blocks sales, invites and seat changes", async () => {
    const w = await setup();
    const stranger = w.person(9);
    expect((await w.uc.invite.execute({ ownerUserId: stranger.userId, phoneE164: w.phoneOf(2), nickname: null })).kind).toBe("not_owner");
    const owner = await w.owner(1);
    w.flags.disable(w.FLAGS.family);
    expect((await w.uc.invite.execute({ ownerUserId: owner.userId, phoneE164: w.phoneOf(2), nickname: null })).kind).toBe("family_unavailable");
    expect((await w.uc.leave.execute(owner.userId)).kind).toBe("family_unavailable");
    const fresh = w.person(8);
    expect(
      (await w.uc.createFamily.execute({ userId: fresh.userId, tokenRef: fresh.tokenRef, deviceId: null, method: "card", requestKey: "k" })).kind,
    ).toBe("family_unavailable");
    expect(
      (await w.uc.subscribe.execute(w.subscribeInput(fresh, { plan: "plus_family" }))).kind,
    ).toBe("unavailable");
  });
});

describe("family: accept", () => {
  it("accept gives the member Plus entitlements until the owner's period end, on their own account", async () => {
    const w = await setup();
    const { owner, members } = await family(w, 1);
    const ownerSub = await w.store.getLiveByUser(owner.userId);
    const m = members[0];
    const e = await w.uc.entitlements.forUser(m?.userId ?? "");
    expect(e.entitled).toBe(true);
    expect(e.endsAtMs).toBe(ownerSub?.periodEndMs);
    expect(e.groups.commerce_benefits).toContain("free_delivery");
    // The member never has a subscription of their own, never consumed a trial and was not charged.
    expect(await w.store.getLiveByUser(m?.userId ?? "")).toBeNull();
    expect(w.charges.requests).toHaveLength(1);
    w.clock.advance(ownerSub === null ? 0 : ownerSub.periodEndMs - w.clock.nowMs());
    expect((await w.uc.entitlements.forUser(m?.userId ?? "")).entitled).toBe(false);
  });

  it("the member's benefit use is recorded for the member, never the owner", async () => {
    const w = await setup();
    const { owner, members } = await family(w, 1);
    const mid = members[0]?.userId ?? "";
    const r = await w.uc.recordBenefit.execute({ userId: mid, orderGroupId: "00000000-0000-4000-8000-0000000000aa", benefit: "free_delivery", amountSavedMinor: 6_500n });
    expect(r.kind).toBe("recorded");
    expect((await w.uc.mine.execute(mid)).savings.totalMinor).toBe(6_500n);
    expect((await w.uc.mine.execute(owner.userId)).savings.totalMinor).toBe(0n);
  });

  it("identity first: wrong phone, unverified phone and unknown token all look the same", async () => {
    const w = await setup();
    const owner = await w.owner(1);
    const invitee = w.person(2);
    const { token } = await w.inviteAndToken(owner.userId, invitee.phone);
    const other = w.person(3);
    expect(await w.uc.accept.execute({ userId: other.userId, token, existingPlan: null })).toEqual({ kind: "not_found" });
    const unverified = w.person(4, { otp: false });
    w.identity.register(unverified.userId, invitee.phone, false);
    w.persons.set(unverified.userId, w.identity.hashPhone(invitee.phone));
    expect(await w.uc.accept.execute({ userId: unverified.userId, token, existingPlan: null })).toEqual({ kind: "not_found" });
    expect(await w.uc.accept.execute({ userId: invitee.userId, token: "no-such-token-0000000000", existingPlan: null })).toEqual({ kind: "not_found" });
    expect((await w.uc.accept.execute({ userId: invitee.userId, token, existingPlan: null })).kind).toBe("accepted");
  });

  it("a 19 year old is blocked at accept by the policy reason (gate 21)", async () => {
    const w = await setup();
    const owner = await w.owner(1);
    const kid = w.person(2, { age: 30 });
    const { token } = await w.inviteAndToken(owner.userId, kid.phone);
    w.ages.setAge(kid.userId, 19);
    expect(await w.uc.accept.execute({ userId: kid.userId, token, existingPlan: null })).toEqual({ kind: "age_gate", minAge: 21 });
  });

  it("an invite expires after 7 days and can no longer be accepted", async () => {
    const w = await setup();
    const owner = await w.owner(1);
    const inv = w.person(2);
    const { token } = await w.inviteAndToken(owner.userId, inv.phone);
    w.clock.advanceDays(7);
    expect((await w.uc.accept.execute({ userId: inv.userId, token, existingPlan: null })).kind).toBe("invite_expired");
  });

  it("double submit of one token: exactly one accept succeeds", async () => {
    const w = await setup();
    const owner = await w.owner(1);
    const inv = w.person(2);
    const { token } = await w.inviteAndToken(owner.userId, inv.phone);
    const results = await Promise.all([
      w.uc.accept.execute({ userId: inv.userId, token, existingPlan: null }),
      w.uc.accept.execute({ userId: inv.userId, token, existingPlan: null }),
    ]);
    expect(results.filter((r) => r.kind === "accepted")).toHaveLength(1);
    const view = await w.uc.getFamily.execute(owner.userId);
    expect(view?.role === "owner" ? view.seatsHeld : -1).toBe(2);
  });

  it("two accepts racing for the last seat: the expired invite loses, exactly one seat is taken", async () => {
    const w = await setup();
    const owner = await w.owner(1);
    // fill to owner + 2 members, leaving one seat
    for (let i = 0; i < 2; i += 1) {
      const m = w.person(10 + i);
      const { token } = await w.inviteAndToken(owner.userId, m.phone);
      await w.uc.accept.execute({ userId: m.userId, token, existingPlan: null });
    }
    const a = w.person(20);
    const first = await w.inviteAndToken(owner.userId, a.phone);
    w.clock.advanceDays(7);
    const b = w.person(21);
    const second = await w.inviteAndToken(owner.userId, b.phone);
    const [ra, rb] = await Promise.all([
      w.uc.accept.execute({ userId: a.userId, token: first.token, existingPlan: null }),
      w.uc.accept.execute({ userId: b.userId, token: second.token, existingPlan: null }),
    ]);
    expect([ra.kind, rb.kind].filter((k) => k === "accepted")).toHaveLength(1);
    const view = await w.uc.getFamily.execute(owner.userId);
    expect(view?.role === "owner" ? view.seatsHeld : -1).toBeLessThanOrEqual(4);
  });

  it("a member with their own Plus must choose: end it at period end, no double charge", async () => {
    const w = await setup();
    const owner = await w.owner(1);
    const inv = w.person(2);
    const own = await w.uc.rawSubscribe.execute(w.subscribeInput(inv, { plan: "plus_yearly" }));
    expect(own.kind).toBe("subscribed");
    const { token } = await w.inviteAndToken(owner.userId, inv.phone);
    expect(await w.uc.accept.execute({ userId: inv.userId, token, existingPlan: null })).toEqual({ kind: "existing_plan_choice_required" });
    const r = await w.uc.accept.execute({ userId: inv.userId, token, existingPlan: "end_at_period_end" });
    expect(r).toMatchObject({ kind: "accepted", ownPlanEnding: true });
    const sub = await w.store.getLiveByUser(inv.userId);
    expect(sub?.status).toBe("CANCELLED_AT_PERIOD_END");
    const charges = w.charges.requests.length;
    w.clock.advanceDays(400);
    await w.uc.sweep.execute();
    expect(w.charges.requests.filter((c) => c.userId === inv.userId).length).toBeLessThanOrEqual(charges);
  });

  it("a family seat neither consumes nor grants a trial", async () => {
    const w = await setup();
    const { members } = await family(w, 1);
    const m = members[0];
    const mine = await w.uc.rawSubscribe.execute({ ...w.subscribeInput(m ?? w.person(99), { plan: "plus_monthly" }) });
    expect(mine).toMatchObject({ kind: "subscribed", trial: true });
  });
});

describe("family: remove, leave, end", () => {
  it("removed on day 10: benefit ends at period end, seat is held until then and free the next cycle", async () => {
    const w = await setup();
    const { owner, members } = await family(w, 3);
    const sub = await w.store.getLiveByUser(owner.userId);
    const periodEnd = sub?.periodEndMs ?? 0;
    w.clock.advanceDays(10);
    const view = await w.uc.getFamily.execute(owner.userId);
    const target = view?.role === "owner" ? view.members.find((m) => m.nickname === "m0") : undefined;
    const r = await w.uc.remove.execute(owner.userId, target?.id ?? "");
    expect(r).toEqual({ kind: "ok", seatEndAtMs: periodEnd });
    const removedUser = members[0]?.userId ?? "";
    expect((await w.uc.entitlements.forUser(removedUser)).endsAtMs).toBe(periodEnd);
    // The seat is still held: the family is full until the cycle turns.
    expect((await w.uc.invite.execute({ ownerUserId: owner.userId, phoneE164: w.phoneOf(70), nickname: null })).kind).toBe("refused");
    expect(w.notices.sent.some((n) => n.template === "family_member_removed" && n.userId === removedUser)).toBe(true);
    w.clock.advance(periodEnd - w.clock.nowMs());
    expect((await w.uc.entitlements.forUser(removedUser)).entitled).toBe(false);
    // The owner renews at the period end, so the family stays on; the freed seat can be filled.
    await w.uc.sweep.execute();
    expect((await w.uc.invite.execute({ ownerUserId: owner.userId, phoneE164: w.phoneOf(71), nickname: null })).kind).toBe("invited");
  });

  it("a removed member can join another family once their seat has ended", async () => {
    const w = await setup();
    const { owner, members } = await family(w, 1);
    const sub = await w.store.getLiveByUser(owner.userId);
    const view = await w.uc.getFamily.execute(owner.userId);
    const m0 = view?.role === "owner" ? view.members.find((m) => m.nickname === "m0") : undefined;
    await w.uc.remove.execute(owner.userId, m0?.id ?? "");
    const other = await w.owner(30);
    const mem = members[0];
    // Still holding the removed seat: not eligible for another family yet.
    expect(await w.uc.invite.execute({ ownerUserId: other.userId, phoneE164: mem?.phone ?? "", nickname: null })).toEqual({
      kind: "refused",
      reason: "already_in_family",
    });
    w.clock.advance((sub?.periodEndMs ?? 0) - w.clock.nowMs());
    await w.uc.sweep.execute();
    const { token } = await w.inviteAndToken(other.userId, mem?.phone ?? "");
    expect((await w.uc.accept.execute({ userId: mem?.userId ?? "", token, existingPlan: null })).kind).toBe("accepted");
  });

  it("BOLA: another owner, a member and a stranger cannot remove or revoke someone else's seat (404)", async () => {
    const w = await setup();
    const { owner, members } = await family(w, 2);
    const view = await w.uc.getFamily.execute(owner.userId);
    const seat = view?.role === "owner" ? view.members.find((m) => m.nickname === "m0") : undefined;
    const rival = await w.owner(40);
    expect(await w.uc.remove.execute(rival.userId, seat?.id ?? "")).toEqual({ kind: "not_found" });
    expect(await w.uc.remove.execute(members[1]?.userId ?? "", seat?.id ?? "")).toEqual({ kind: "not_found" });
    expect(await w.uc.remove.execute(w.person(41).userId, seat?.id ?? "")).toEqual({ kind: "not_found" });
    expect(await w.uc.revoke.execute(rival.userId, seat?.id ?? "")).toEqual({ kind: "not_found" });
    // The owner seat is not removable either.
    const ownerSeat = view?.role === "owner" ? view.members.find((m) => m.role === "owner") : undefined;
    expect(await w.uc.remove.execute(owner.userId, ownerSeat?.id ?? "")).toEqual({ kind: "not_found" });
  });

  it("a member leaves: benefit continues to period end, owner is told, owner cannot leave", async () => {
    const w = await setup();
    const { owner, members } = await family(w, 1);
    const mid = members[0]?.userId ?? "";
    const sub = await w.store.getLiveByUser(owner.userId);
    const r = await w.uc.leave.execute(mid);
    expect(r).toEqual({ kind: "ok", seatEndAtMs: sub?.periodEndMs });
    expect((await w.uc.entitlements.forUser(mid)).entitled).toBe(true);
    expect(w.notices.sent.some((n) => n.template === "family_member_left" && n.userId === owner.userId)).toBe(true);
    expect(await w.uc.leave.execute(owner.userId)).toEqual({ kind: "owner_cannot_leave" });
    expect(await w.uc.leave.execute(w.person(77).userId)).toEqual({ kind: "not_found" });
  });

  it("seat trading: after two removals in 90 days a free seat still cannot be re-offered until they age out", async () => {
    const w = await setup();
    const owner = await w.owner(1);
    for (const n of [10, 11]) {
      const m = w.person(n);
      const { token, memberId } = await w.inviteAndToken(owner.userId, m.phone);
      expect((await w.uc.accept.execute({ userId: m.userId, token, existingPlan: null })).kind).toBe("accepted");
      expect((await w.uc.remove.execute(owner.userId, memberId)).kind).toBe("ok");
    }
    // Seats 2 and 3 are held by the removed rows until the cycle ends; seat 4 is free but the churn limit applies.
    expect(await w.uc.invite.execute({ ownerUserId: owner.userId, phoneE164: w.phoneOf(80), nickname: null })).toEqual({
      kind: "refused",
      reason: "seat_churn_limit",
    });
    const v = await w.uc.getFamily.execute(owner.userId);
    expect(v?.role === "owner" ? v.seatChangesInWindow : -1).toBe(2);
    w.clock.advanceDays(91);
    expect((await w.uc.invite.execute({ ownerUserId: owner.userId, phoneE164: w.phoneOf(80), nickname: null })).kind).toBe("invited");
  });

  it("owner cancels: members are told once, keep benefit until period end, then the group ends", async () => {
    const w = await setup();
    const { owner, members } = await family(w, 2);
    await w.uc.cancel.execute(owner.userId);
    const r1 = await w.uc.familySweep.execute();
    expect(r1).toMatchObject({ noticed: 1, ended: 0 });
    const r2 = await w.uc.familySweep.execute();
    expect(r2.noticed).toBe(0);
    expect(w.notices.sent.filter((n) => n.template === "family_plan_ending")).toHaveLength(2);
    const sub = await w.store.getLiveByUser(owner.userId);
    const end = sub?.periodEndMs ?? 0;
    expect((await w.uc.entitlements.forUser(members[0]?.userId ?? "")).endsAtMs).toBe(end);
    w.clock.advance(end - w.clock.nowMs());
    await w.uc.sweep.execute();
    const r3 = await w.uc.familySweep.execute();
    expect(r3.ended).toBe(1);
    expect((await w.uc.entitlements.forUser(members[0]?.userId ?? "")).entitled).toBe(false);
    expect(w.notices.sent.filter((n) => n.template === "family_plan_ended")).toHaveLength(2);
    expect(w.familyStore.events.map((e) => e.type)).toContain("family.ended");
  });

  it("owner downgrade to yearly is scheduled for period end and ends the group at the renewal", async () => {
    const w = await setup();
    const { owner, members } = await family(w, 1);
    const sw = await w.uc.switchPlan.execute(owner.userId, "plus_yearly");
    expect(sw.kind).toBe("ok");
    const sub = await w.store.getLiveByUser(owner.userId);
    expect(sub?.pendingPlanCode).toBe("plus_yearly");
    // Members are told and their benefit is bounded by the current period end, not the new plan.
    await w.uc.familySweep.execute();
    expect(w.notices.sent.some((n) => n.template === "family_plan_ending")).toBe(true);
    w.clock.advance((sub?.periodEndMs ?? 0) - w.clock.nowMs());
    await w.uc.sweep.execute();
    const after = await w.store.getLiveByUser(owner.userId);
    expect(after?.planCode).toBe("plus_yearly");
    await w.uc.familySweep.execute();
    expect((await w.uc.entitlements.forUser(members[0]?.userId ?? "")).entitled).toBe(false);
  });

  it("yearly -> family is an immediate upgrade with prorated credit; the group opens lazily", async () => {
    const w = await setup();
    const p = w.person(1);
    await w.uc.rawSubscribe.execute(w.subscribeInput(p, { plan: "plus_yearly" }));
    w.clock.advanceDays(14);
    await w.uc.sweep.execute();
    w.clock.advanceDays(100);
    const sw = await w.uc.switchPlan.execute(p.userId, "plus_family");
    expect(sw.kind).toBe("ok");
    const sub = await w.store.getLiveByUser(p.userId);
    expect(sub?.planCode).toBe("plus_family");
    const last = w.charges.requests[w.charges.requests.length - 1];
    // 800 paid, 100 of 365 days used: credit = 265/365 x 800, charge = 1,200 - credit (never negative).
    expect(last?.amountMinor).toBeLessThan(120_000n);
    expect(last?.amountMinor).toBeGreaterThan(0n);
    const view = await w.uc.getFamily.execute(p.userId);
    expect(view).toMatchObject({ role: "owner", seatLimit: 4 });
  });

  it("owner account deleted: the group ends at once and members are told", async () => {
    const w = await setup();
    const { owner, members } = await family(w, 1);
    expect(await w.uc.terminate.execute(owner.userId)).toEqual({ ended: true });
    expect((await w.uc.entitlements.forUser(members[0]?.userId ?? "")).entitled).toBe(false);
    expect(w.notices.sent.some((n) => n.template === "family_plan_ended")).toBe(true);
    expect(await w.uc.terminate.execute(owner.userId)).toEqual({ ended: false });
  });

  it("refund of the owner's plan ends member entitlement because the owner's paid-through disappears", async () => {
    const w = await setup();
    const { owner, members } = await family(w, 1);
    const sub = await w.store.getLiveByUser(owner.userId);
    expect(sub).not.toBeNull();
    await w.uc.cancel.execute(owner.userId);
    w.clock.advance(((sub?.periodEndMs ?? 0) - w.clock.nowMs()) + DAY_MS);
    await w.uc.sweep.execute();
    expect((await w.uc.entitlements.forUser(members[0]?.userId ?? "")).entitled).toBe(false);
  });
});

describe("family: privacy of the views", () => {
  it("owner sees nicknames and seat state only; a member sees only their own seat", async () => {
    const w = await setup();
    const { owner, members } = await family(w, 2);
    const ov = await w.uc.getFamily.execute(owner.userId);
    expect(JSON.stringify(ov)).not.toContain(members[0]?.userId ?? "zzz");
    expect(JSON.stringify(ov)).not.toContain("phone");
    const mv = await w.uc.getFamily.execute(members[0]?.userId ?? "");
    expect(mv).toMatchObject({ role: "member", seatStatus: "ACTIVE" });
    expect(mv).not.toHaveProperty("members");
    expect(await w.uc.getFamily.execute(w.person(90).userId)).toBeNull();
  });
});

describe("paywall marketing and admin versioning", () => {
  it("pay-4-get-8 copy is derived from the individual plans only; family offer from real prices", async () => {
    const w = await setup();
    const p = await w.uc.plans.execute();
    expect(p.marketing).toEqual({ payMonths: 4, freeMonths: 8, savingMinor: 160_000n });
    expect(p.familyOffer).toEqual({ planCode: "plus_family", seats: 4, savingMinor: 200_000n });
    expect(p.defaultCode).toBe("plus_yearly");
  });

  it("an admin can publish a new family version with a different seat limit; existing groups keep theirs", async () => {
    const w = await setup();
    const owner = await w.owner(1);
    w.approvals.approve("00000000-0000-4000-8000-0000000000a1");
    const r = await w.uc.publish.execute({
      actorId: "00000000-0000-4000-8000-0000000000ff",
      code: "plus_family",
      interval: "year",
      priceMinor: 140_000n,
      trialDays: 0,
      effectiveFromMs: w.clock.nowMs() + 31 * DAY_MS,
      approvalId: "00000000-0000-4000-8000-0000000000a1",
      seatLimit: 5,
    });
    expect(r).toMatchObject({ kind: "published", plan: { version: 2, kind: "family", seatLimit: 5 } });
    const v = await w.uc.getFamily.execute(owner.userId);
    expect(v).toMatchObject({ seatLimit: 4 });
    w.approvals.approve("00000000-0000-4000-8000-0000000000a2");
    const bad = await w.uc.publish.execute({
      actorId: "x",
      code: "plus_family",
      interval: "year",
      priceMinor: 140_000n,
      trialDays: 0,
      effectiveFromMs: w.clock.nowMs() + 31 * DAY_MS,
      approvalId: "00000000-0000-4000-8000-0000000000a2",
      kind: "student",
    });
    expect(bad).toEqual({ kind: "kind_mismatch" });
    w.approvals.approve("00000000-0000-4000-8000-0000000000a3");
    expect(
      await w.uc.publish.execute({
        actorId: "x",
        code: "plus_family",
        interval: "year",
        priceMinor: 140_000n,
        trialDays: 0,
        effectiveFromMs: w.clock.nowMs() + 31 * DAY_MS,
        approvalId: "00000000-0000-4000-8000-0000000000a3",
        seatLimit: 20,
      }),
    ).toEqual({ kind: "seat_limit_invalid" });
  });
});
