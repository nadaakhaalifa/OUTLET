import { describe, expect, it } from "vitest";
import { fakeApi, problem } from "../../services/fake-api";
import { PortError } from "../worlds/model";
import { ApiFamilyPort, familyFromWire } from "./api";
import {
  FIXTURE_FAMILY_SNAPSHOT, InMemoryFamilyPort, buildOwnerView, buildStudentView, canStartStudent, isPlausibleEmail, isPlausibleInviteToken, safeVerifierUrl,
  validateInvite, type FamilySeat, type FamilySnapshot, type FamilyView,
} from "./model";

const U1 = "0192f3a4-5b6c-7d8e-9f01-23456789abc1";
const U2 = "0192f3a4-5b6c-7d8e-9f01-23456789abc2";
const U3 = "0192f3a4-5b6c-7d8e-9f01-23456789abc3";
const TOKEN = "AbCdEfGhIjKlMnOp_-123456";
const TS = "2026-10-11T10:00:00Z";

const seat = (over: Partial<FamilySeat>): FamilySeat => ({
  id: "s", role: "member", status: "ACTIVE", nickname: null, seatNo: 2, seatEffectiveFromMs: null, seatEndAtMs: null, inviteExpiresAtMs: null, ...over,
});
type Owner = Extract<FamilyView, { role: "owner" }>;
const owner = (over: Partial<Owner> = {}): Owner => ({
  role: "owner", groupId: U1, status: "ACTIVE", seatLimit: 4, seatsHeld: 2, seatsFree: 2,
  members: [seat({ id: "o", role: "owner", seatNo: 1 }), seat({ id: "m", seatNo: 2 }), seat({ id: "i", status: "INVITED", seatNo: 3 }), seat({ id: "r", status: "REMOVED", seatNo: 4 })], ...over,
});

describe("invite input and tokens", () => {
  it("normalises an Egyptian mobile to E.164 and rejects the rest", () => {
    expect(validateInvite("01012345678", " Mona ")).toEqual({ ok: true, phone: "+201012345678", nickname: "Mona" });
    expect(validateInvite("", "")).toEqual({ ok: false, error: "phoneEmpty" });
    expect(validateInvite("123", "")).toMatchObject({ ok: false });
    expect(validateInvite("01012345678", "x".repeat(41))).toEqual({ ok: false, error: "nicknameTooLong" });
  });
  it("only a well-formed token is ever sent", () => {
    expect(isPlausibleInviteToken(TOKEN)).toBe(true);
    expect(isPlausibleInviteToken("short")).toBe(false);
    expect(isPlausibleInviteToken("has spaces and is long enough!!")).toBe(false);
    expect(isPlausibleInviteToken("a".repeat(129))).toBe(false);
  });
  it("opens only https verifier urls", () => {
    expect(safeVerifierUrl("https://verifier.example/x")).toBe("https://verifier.example/x");
    expect(safeVerifierUrl("http://verifier.example/x")).toBeNull();
    expect(safeVerifierUrl("javascript:alert(1)")).toBeNull();
    expect(safeVerifierUrl(null)).toBeNull();
    expect(isPlausibleEmail("a@uni.edu.eg")).toBe(true);
    expect(isPlausibleEmail("nope")).toBe(false);
  });
});

describe("owner and student views", () => {
  it("lists active and invited seats only, owner first, with the right actions", () => {
    const v = buildOwnerView(owner());
    expect(v.rows.map((r) => r.seat.id)).toEqual(["o", "m", "i"]);
    expect(v.rows.map((r) => [r.canRevoke, r.canRemove])).toEqual([[false, false], [false, true], [true, false]]);
    expect(v.canInvite).toBe(true);
  });
  it("cannot invite when no seat is free or the plan ended", () => {
    expect(buildOwnerView(owner({ seatsFree: 0 })).canInvite).toBe(false);
    expect(buildOwnerView(owner({ status: "ENDED" })).canInvite).toBe(false);
  });
  it("student view follows the server state and the price flag", () => {
    expect(buildStudentView({ status: "VERIFIED", validUntilMs: 1, priceApplies: false, verifier: null })).toMatchObject({ kind: "verified", priceApplies: false });
    expect(buildStudentView({ status: "NONE", validUntilMs: null, priceApplies: false, verifier: null }).kind).toBe("none");
    expect(canStartStudent({ status: "PENDING", validUntilMs: null, priceApplies: false, verifier: null })).toBe(false);
    expect(canStartStudent({ status: "EXPIRED", validUntilMs: null, priceApplies: false, verifier: null })).toBe(true);
    expect(canStartStudent({ status: "VERIFIED", validUntilMs: 1, priceApplies: true, verifier: null })).toBe(false);
  });
});

describe("in-memory port", () => {
  const ownerSnap = (): FamilySnapshot => ({ ...FIXTURE_FAMILY_SNAPSHOT, family: owner({ members: [seat({ id: "o", role: "owner", seatNo: 1 })], seatsHeld: 1, seatsFree: 3 }) });
  it("invites until the seats are full, then refuses with the reason", async () => {
    const p = new InMemoryFamilyPort({ ...ownerSnap(), family: owner({ members: [seat({ id: "o", role: "owner", seatNo: 1 })], seatsHeld: 4, seatsFree: 0 }) });
    expect(await p.invite("+201012345678", null, "k1")).toMatchObject({ kind: "refused", reason: "seatsFull" });
  });
  it("replays an invite for the same idempotency key and revokes it", async () => {
    const p = new InMemoryFamilyPort(ownerSnap(), null, () => 0);
    const a = await p.invite("+201012345678", "Mona", "k1");
    const b = await p.invite("+201012345678", "Mona", "k1");
    expect(a).toEqual(b);
    const snap = await p.load();
    expect(snap.family?.role === "owner" && snap.family.seatsHeld).toBe(2);
    const id = snap.family?.role === "owner" ? snap.family.members.find((m) => m.status === "INVITED")?.id : undefined;
    await p.revokeInvite(id ?? "");
    const after = await p.load();
    expect(after.family?.role === "owner" && after.family.seatsFree).toBe(3);
  });
  it("accept handles the own-plan choice and refuses young or expired invites", async () => {
    const p = new InMemoryFamilyPort();
    expect(await p.acceptInvite("hasplan_aaaaaaaaaaaaaaaa", false, "a")).toEqual({ kind: "choiceRequired" });
    expect(await p.acceptInvite("hasplan_aaaaaaaaaaaaaaaa", true, "b")).toEqual({ kind: "accepted", ownPlanEnding: true });
    expect(await p.acceptInvite("young_aaaaaaaaaaaaaaaaaa", false, "c")).toMatchObject({ kind: "refused", reason: "ageGate", minAge: 21 });
    expect(await p.acceptInvite("expired_aaaaaaaaaaaaaaaaa", false, "d")).toMatchObject({ kind: "refused", reason: "expired" });
    expect(await p.acceptInvite("x", false, "e")).toMatchObject({ kind: "refused", reason: "unknown" });
  });
  it("student verification goes pending; offline surfaces as PortError", async () => {
    const p = new InMemoryFamilyPort();
    expect(await p.startStudentVerification("universityEmail", "a@uni.edu.eg", "k")).toMatchObject({ kind: "started" });
    expect((await p.load()).student.status).toBe("PENDING");
    p.setFailure("offline");
    await expect(p.load()).rejects.toBeInstanceOf(PortError);
  });
});

const egp = (n: number) => ({ amount_minor: String(n), currency: "EGP" as const });
const paywall = {
  plans: [
    { id: "p1", code: "plus_monthly", interval: "month", price: egp(20_000), trial_days: 14, version: 1, default: false, kind: "individual", seat_limit: null },
    { id: "p2", code: "plus_family", interval: "year", price: egp(120_000), trial_days: 0, version: 1, default: false, kind: "family", seat_limit: 4 },
    { id: "p3", code: "plus_student", interval: "year", price: egp(40_000), trial_days: 0, version: 1, default: false, kind: "student", seat_limit: null },
  ],
  yearly_offer: null, family_offer: null, auto_renew: true, cancel_path: "/v1/plus/cancel",
};
const student = { status: "VERIFIED", valid_until: "2027-10-11T10:00:00Z", price_applies: true };
const wireOwner = {
  role: "owner", group_id: U1, status: "ACTIVE", seat_limit: 4, seats_held: 2, seats_free: 2, seat_changes_90d: 0,
  members: [
    { id: U2, role: "owner", status: "ACTIVE", nickname: null, seat_no: 1, seat_effective_from: TS, seat_end_at: null, invite_expires_at: null },
    { id: U3, role: "member", status: "INVITED", nickname: "Mona", seat_no: 2, seat_effective_from: null, seat_end_at: null, invite_expires_at: "2026-10-18T10:00:00Z" },
  ],
};

describe("ApiFamilyPort", () => {
  it("loads family, student status and the family/student plans; 404 means no family", async () => {
    const { ctx } = fakeApi({
      "GET /v1/me/plus/family": () => problem(404, "not_found"),
      "GET /v1/me/plus/student": () => ({ body: student }),
      "GET /v1/plus/plans": () => ({ body: paywall }),
    });
    const s = await new ApiFamilyPort(ctx).load();
    expect(s.family).toBeNull();
    expect(s.student).toEqual({ status: "VERIFIED", validUntilMs: Date.parse("2027-10-11T10:00:00Z"), priceApplies: true, verifier: null });
    expect(s.familyPlan).toEqual({ code: "plus_family", price: 120_000n, interval: "year", seatLimit: 4 });
    expect(s.studentPlan?.code).toBe("plus_student");
  });

  it("maps the owner and member views", () => {
    const o = familyFromWire(wireOwner as never);
    expect(o).toMatchObject({ role: "owner", seatLimit: 4, seatsFree: 2 });
    const m = familyFromWire({ role: "member", group_id: U1, status: "ACTIVE", seat_status: "ACTIVE", seat_effective_from: TS, seat_end_at: null, entitlement_ends_at: "2027-01-01T00:00:00Z" } as never);
    expect(m).toMatchObject({ role: "member", seatStatus: "ACTIVE", entitlementEndsAtMs: Date.parse("2027-01-01T00:00:00Z") });
  });

  it("invite: success, age gate with min age, seats full, and idempotency header", async () => {
    let mode: "ok" | "age" | "full" = "ok";
    const { ctx, calls } = fakeApi({
      "POST /v1/plus/family/invites": () => (mode === "ok" ? { body: { id: U3, invite_id: U2, status: "INVITED", expires_at: "2026-10-18T10:00:00Z" } } : mode === "age" ? problem(403, "age_gate", { min_age: 21 }) : problem(422, "invite_seats_full")),
    });
    const p = new ApiFamilyPort(ctx);
    expect(await p.invite("+201012345678", "Mona", "idem-1")).toEqual({ kind: "invited", expiresAtMs: Date.parse("2026-10-18T10:00:00Z") });
    expect(calls[0]?.headers["Idempotency-Key"]).toBe("idem-1");
    expect(calls[0]?.body).toEqual({ phone: "+201012345678", nickname: "Mona" });
    mode = "age";
    expect(await p.invite("+201012345678", null, "idem-2")).toEqual({ kind: "refused", reason: "ageGate", minAge: 21 });
    mode = "full";
    expect(await p.invite("+201012345678", null, "idem-3")).toEqual({ kind: "refused", reason: "seatsFull", minAge: null });
  });

  it("accept: the token goes in the path only, a malformed token never hits the network, the own-plan choice is surfaced", async () => {
    let choice = true;
    const { ctx, calls } = fakeApi({
      [`POST /v1/plus/family/invites/${TOKEN}/accept`]: (r) => (choice && (r.body as { existing_plan?: string }).existing_plan === undefined
        ? problem(409, "existing_plan_choice_required")
        : { body: { accepted: true, group_id: U1, own_plan_ending: true } }),
    });
    const p = new ApiFamilyPort(ctx);
    expect(await p.acceptInvite("tiny", false, "k0")).toMatchObject({ kind: "refused", reason: "unknown" });
    expect(calls).toHaveLength(0);
    expect(await p.acceptInvite(TOKEN, false, "k1")).toEqual({ kind: "choiceRequired" });
    choice = false;
    expect(await p.acceptInvite(TOKEN, true, "k2")).toEqual({ kind: "accepted", ownPlanEnding: true });
    expect(calls[1]?.body).toEqual({ existing_plan: "end_at_period_end" });
  });

  it("accept maps expired, unavailable and age gate; failure messages never contain the token", async () => {
    const cases: [ReturnType<typeof problem>, string][] = [
      [problem(410, "invite_expired"), "expired"], [problem(410, "invite_unavailable"), "unavailable"], [problem(403, "age_gate", { min_age: 21 }), "ageGate"],
      [problem(409, "already_in_family"), "alreadyInFamily"], [problem(404, "not_found"), "unknown"],
    ];
    for (const [r, reason] of cases) {
      const { ctx } = fakeApi({ [`POST /v1/plus/family/invites/${TOKEN}/accept`]: () => r });
      expect(await new ApiFamilyPort(ctx).acceptInvite(TOKEN, false, "k")).toMatchObject({ kind: "refused", reason });
    }
    const { ctx } = fakeApi({ [`POST /v1/plus/family/invites/${TOKEN}/accept`]: () => problem(500, "internal") });
    const err = await new ApiFamilyPort(ctx).acceptInvite(TOKEN, false, "k").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PortError);
    expect(String((err as Error).message)).not.toContain(TOKEN);
  });

  it("leave, remove and revoke use the documented routes with idempotency keys", async () => {
    const { ctx, calls } = fakeApi({
      "POST /v1/plus/family/leave": () => ({ body: { left: true, seat_end_at: "2026-11-01T00:00:00Z" } }),
      [`DELETE /v1/plus/family/members/${U2}`]: () => ({ body: { removed: true, seat_end_at: "2026-11-01T00:00:00Z" } }),
      [`DELETE /v1/plus/family/invites/${U3}`]: () => ({ body: { revoked: true } }),
    });
    const p = new ApiFamilyPort(ctx);
    await p.leave("k1");
    await p.removeMember(U2, "k2");
    await p.revokeInvite(U3, "k3");
    expect(calls.map((c) => c.headers["Idempotency-Key"])).toEqual(["k1", "k2", "k3"]);
  });

  it("student start returns only an https redirect and maps a refused domain", async () => {
    let url = "https://verifier.example/s/1";
    let refuse = false;
    const { ctx, calls } = fakeApi({
      "POST /v1/plus/student/verify": () => (refuse ? problem(422, "domain_not_allowed") : { body: { verification_id: U1, status: "PENDING", client_action: { type: "redirect", url } } }),
    });
    const p = new ApiFamilyPort(ctx);
    expect(await p.startStudentVerification("universityEmail", "a@uni.edu.eg", "k1")).toEqual({ kind: "started", redirectUrl: "https://verifier.example/s/1" });
    expect(calls[0]?.body).toEqual({ method: "university_email", university_email: "a@uni.edu.eg" });
    url = "http://verifier.example/plain";
    expect(await p.startStudentVerification("universityEmail", "a@uni.edu.eg", "k2")).toEqual({ kind: "started", redirectUrl: null });
    refuse = true;
    expect(await p.startStudentVerification("universityEmail", "a@x.com", "k3")).toEqual({ kind: "refused", reason: "domainNotAllowed" });
  });
});
