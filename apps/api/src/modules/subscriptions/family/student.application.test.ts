import { describe, expect, it } from "vitest";
import { DAY_MS } from "../domain/bridge";
import { HandleStudentCallback, StartStudentVerification, type FamilyDeps } from "./application";
import { UnconfiguredStudentVerifier } from "./in-memory";
import { createFamilyWorld, type FamilyWorld } from "./test/world";

const body = (o: Record<string, unknown>): Uint8Array => new TextEncoder().encode(JSON.stringify(o));
const OK = { "x-verifier-signature": "ok" } as const;

async function verified(w: FamilyWorld, n: number) {
  const p = w.person(n);
  const s = await w.uc.startStudent.execute({ userId: p.userId, method: "university_email", universityEmail: `s${n}@cu.edu.eg` });
  if (s.kind !== "started") throw new Error(`start failed: ${s.kind}`);
  const ref = w.verifier.started.length === 0 ? "" : `fake-ref-${w.verifier.started.length}`;
  const r = await w.uc.studentCallback.execute({ rawBody: body({ kind: "verified", ref }), headers: OK });
  if (r.kind !== "applied") throw new Error(`callback failed: ${r.kind}`);
  return { p, ref };
}

describe("student verification", () => {
  it("starts through the verifier, stores only the reference, and verifies by a signed callback", async () => {
    const w = await createFamilyWorld();
    const p = w.person(1);
    const s = await w.uc.startStudent.execute({ userId: p.userId, method: "university_email", universityEmail: "me@cu.edu.eg" });
    expect(s).toMatchObject({ kind: "started", clientAction: { type: "redirect" } });
    const row = [...w.studentStore.rows.values()][0];
    expect(row).toMatchObject({ status: "PENDING", verifier: "fake", ref: "fake-ref-1" });
    expect(JSON.stringify(row)).not.toContain("cu.edu.eg");
    expect((await w.uc.studentStatus.execute(p.userId)).priceApplies).toBe(false);
    const r = await w.uc.studentCallback.execute({ rawBody: body({ kind: "verified", ref: "fake-ref-1" }), headers: OK });
    expect(r).toEqual({ kind: "applied", status: "VERIFIED" });
    const st = await w.uc.studentStatus.execute(p.userId);
    expect(st.priceApplies).toBe(true);
    expect(st.validUntilMs).toBe(Date.UTC(2027, 3, 10, 9, 0, 0));
    expect(w.studentStore.events.map((e) => e.type)).toEqual(["student.verification_started", "student.verified"]);
  });

  it("a replayed callback is a no-op and an unsigned one is rejected", async () => {
    const w = await createFamilyWorld();
    await verified(w, 1);
    const again = await w.uc.studentCallback.execute({ rawBody: body({ kind: "verified", ref: "fake-ref-1" }), headers: OK });
    expect(again).toEqual({ kind: "ignored" });
    expect(w.studentStore.events.filter((e) => e.type === "student.verified")).toHaveLength(1);
    const forged = await w.uc.studentCallback.execute({ rawBody: body({ kind: "verified", ref: "fake-ref-1" }), headers: {} });
    expect(forged).toEqual({ kind: "rejected" });
    const unknown = await w.uc.studentCallback.execute({ rawBody: body({ kind: "verified", ref: "nope" }), headers: OK });
    expect(unknown).toEqual({ kind: "ignored" });
    // A late rejection cannot undo a verified status.
    const late = await w.uc.studentCallback.execute({ rawBody: body({ kind: "rejected", ref: "fake-ref-1" }), headers: OK });
    expect(late).toEqual({ kind: "ignored" });
  });

  it("a rejected verification never grants the price; a restart supersedes the pending one", async () => {
    const w = await createFamilyWorld();
    const p = w.person(1);
    await w.uc.startStudent.execute({ userId: p.userId, method: "verifier_session", universityEmail: null });
    await w.uc.startStudent.execute({ userId: p.userId, method: "verifier_session", universityEmail: null });
    const rows = [...w.studentStore.rows.values()].sort((a, b) => a.ref.localeCompare(b.ref));
    expect(rows.map((r) => r.status)).toEqual(["REJECTED", "PENDING"]);
    const r = await w.uc.studentCallback.execute({ rawBody: body({ kind: "rejected", ref: "fake-ref-2" }), headers: OK });
    expect(r).toEqual({ kind: "applied", status: "REJECTED" });
    expect((await w.uc.studentStatus.execute(p.userId)).priceApplies).toBe(false);
  });

  it("disallowed university domain, kill switch and an unconfigured verifier all fail closed", async () => {
    const w = await createFamilyWorld();
    const p = w.person(1);
    expect(await w.uc.startStudent.execute({ userId: p.userId, method: "university_email", universityEmail: "me@gmail.com" })).toEqual({
      kind: "domain_not_allowed",
    });
    w.flags.disable(w.FLAGS.student);
    expect((await w.uc.startStudent.execute({ userId: p.userId, method: "verifier_session", universityEmail: null })).kind).toBe("student_unavailable");
    w.flags.enable(w.FLAGS.student);
    const closed: FamilyDeps = { ...w.fd, verifier: new UnconfiguredStudentVerifier() };
    expect((await new StartStudentVerification(closed).execute({ userId: p.userId, method: "verifier_session", universityEmail: null })).kind).toBe(
      "student_unavailable",
    );
    const cb = await new HandleStudentCallback(closed).execute({ rawBody: body({ kind: "verified", ref: "x" }), headers: OK });
    expect(cb).toEqual({ kind: "rejected" });
    expect([...w.studentStore.rows.values()]).toHaveLength(0);
  });
});

describe("student plan", () => {
  it("subscribing needs a verified, unexpired status; then it bills the student price", async () => {
    const w = await createFamilyWorld();
    const p = w.person(1);
    expect(await w.uc.subscribe.execute(w.subscribeInput(p, { plan: "plus_student" }))).toEqual({ kind: "student_verification_required" });
    await w.uc.startStudent.execute({ userId: p.userId, method: "verifier_session", universityEmail: null });
    await w.uc.studentCallback.execute({ rawBody: body({ kind: "verified", ref: "fake-ref-1" }), headers: OK });
    const r = await w.uc.subscribe.execute(w.subscribeInput(p, { plan: "plus_student" }));
    expect(r.kind).toBe("subscribed");
    expect(w.charges.requests[0]?.amountMinor).toBe(60_000n);
    const e = await w.uc.entitlements.forUser(p.userId);
    expect(e.entitled).toBe(true);
    expect(e.groups.commerce_benefits).toContain("free_delivery");
  });

  it("an expired status cannot buy the student plan, and the kill switch blocks it", async () => {
    const w = await createFamilyWorld();
    const { p } = await verified(w, 1);
    w.clock.advanceDays(366);
    expect(await w.uc.subscribe.execute(w.subscribeInput(p, { plan: "plus_student" }))).toEqual({ kind: "student_verification_required" });
    const w2 = await createFamilyWorld();
    const { p: p2 } = await verified(w2, 1);
    w2.flags.disable(w2.FLAGS.student);
    expect(await w2.uc.subscribe.execute(w2.subscribeInput(p2, { plan: "plus_student" }))).toEqual({ kind: "unavailable" });
  });

  it("lapse: a 30 day notice goes out, then the price reverts at the next renewal with a notice", async () => {
    const w = await createFamilyWorld();
    const { p } = await verified(w, 1);
    await w.uc.subscribe.execute(w.subscribeInput(p, { plan: "plus_student" }));
    const sub = await w.store.getLiveByUser(p.userId);
    const end = sub?.periodEndMs ?? 0;
    w.clock.advance(end - 31 * DAY_MS - w.clock.nowMs());
    expect(await w.uc.studentSweep.execute()).toEqual({ noticed: 0, expired: 0 });
    w.clock.advanceDays(1);
    expect(await w.uc.studentSweep.execute()).toEqual({ noticed: 1, expired: 0 });
    expect(await w.uc.studentSweep.execute()).toEqual({ noticed: 0, expired: 0 });
    expect(w.notices.sent.filter((n) => n.template === "student_status_expiring")).toHaveLength(1);
    w.clock.advance(end - w.clock.nowMs());
    const summary = await w.uc.sweep.execute();
    expect(summary.renewed).toBe(1);
    expect(w.charges.requests[w.charges.requests.length - 1]?.amountMinor).toBe(80_000n);
    const after = await w.store.getLiveByUser(p.userId);
    expect(after).toMatchObject({ planCode: "plus_yearly" });
    expect(w.notices.sent.some((n) => n.template === "student_price_ended")).toBe(true);
    expect(await w.uc.studentSweep.execute()).toEqual({ noticed: 0, expired: 1 });
  });

  it("an unnoticed lapse is never a silent increase: notice now, student price kept one more renewal", async () => {
    const w = await createFamilyWorld();
    const { p } = await verified(w, 1);
    await w.uc.subscribe.execute(w.subscribeInput(p, { plan: "plus_student" }));
    const sub = await w.store.getLiveByUser(p.userId);
    w.clock.advance((sub?.periodEndMs ?? 0) - w.clock.nowMs());
    await w.uc.sweep.execute();
    expect(w.charges.requests[w.charges.requests.length - 1]?.amountMinor).toBe(60_000n);
    expect(w.notices.sent.filter((n) => n.template === "student_status_expiring")).toHaveLength(1);
    const next = await w.store.getLiveByUser(p.userId);
    expect(next?.planCode).toBe("plus_student");
    // A year later the notice is long out: the price reverts.
    w.clock.advance((next?.periodEndMs ?? 0) - w.clock.nowMs());
    await w.uc.sweep.execute();
    expect(w.charges.requests[w.charges.requests.length - 1]?.amountMinor).toBe(80_000n);
  });

  it("with no verification record at all a student plan renews at the individual price (fail closed)", async () => {
    const w = await createFamilyWorld();
    const { p } = await verified(w, 1);
    await w.uc.subscribe.execute(w.subscribeInput(p, { plan: "plus_student" }));
    w.studentStore.rows.clear();
    const sub = await w.store.getLiveByUser(p.userId);
    w.clock.advance((sub?.periodEndMs ?? 0) - w.clock.nowMs());
    await w.uc.sweep.execute();
    expect(w.charges.requests[w.charges.requests.length - 1]?.amountMinor).toBe(80_000n);
  });

  it("switching to the student plan needs a verified status and is scheduled for period end", async () => {
    const w = await createFamilyWorld();
    const p = w.person(1);
    await w.uc.rawSubscribe.execute(w.subscribeInput(p, { plan: "plus_yearly" }));
    w.clock.advanceDays(15);
    await w.uc.sweep.execute();
    expect(await w.uc.switchPlan.execute(p.userId, "plus_student")).toEqual({ kind: "student_verification_required" });
    await w.uc.startStudent.execute({ userId: p.userId, method: "verifier_session", universityEmail: null });
    await w.uc.studentCallback.execute({ rawBody: body({ kind: "verified", ref: "fake-ref-1" }), headers: OK });
    const r = await w.uc.switchPlan.execute(p.userId, "plus_student");
    expect(r.kind).toBe("ok");
    expect((await w.store.getLiveByUser(p.userId))?.pendingPlanCode).toBe("plus_student");
  });
});
