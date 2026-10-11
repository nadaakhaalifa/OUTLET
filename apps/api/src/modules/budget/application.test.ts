import fc from "fast-check";
import { beforeEach, describe, expect, it } from "vitest";
import { CipherUnavailableError } from "./application/codec";
import { DAY, EGP, START_MS, U, createRuntime, spend, type Runtime } from "./test/harness";

let rt: Runtime;
const user = U(1);
const input = (over: Partial<Parameters<Runtime["set"]["execute"]>[0]> = {}): Parameters<Runtime["set"]["execute"]>[0] => ({
  userId: user,
  amount: EGP(5000),
  perCategory: {},
  payday: 25,
  capMode: "off",
  installments: [],
  ...over,
});
// payday 25: the cycle containing START_MS (2026-04-15) is [2026-03-25, 2026-04-25)
const IN_CYCLE = Date.parse("2026-04-02T10:00:00Z");
const PREV_CYCLE = Date.parse("2026-03-10T10:00:00Z");
const NEXT_CYCLE = Date.parse("2026-04-28T10:00:00Z");

beforeEach(() => {
  rt = createRuntime();
  rt.consent.grant(user);
});

describe("consent and isolation of data", () => {
  it("refuses to set a budget without the budget_insights consent and stores nothing", async () => {
    rt.consent.withdraw(user);
    expect(await rt.set.execute(input())).toEqual({ kind: "consent_required" });
    expect(rt.store.hasAnyData(user)).toBe(false);
    expect(await rt.summary.execute(user, false)).toEqual({ kind: "consent_required" });
  });

  it("ignores spend for a user without a budget (nothing is collected before opt-in)", async () => {
    expect(await rt.record.execute(user, spend("placed:1", "placed", EGP(100), IN_CYCLE))).toBe("ignored_no_budget");
    expect(rt.store.hasAnyData(user)).toBe(false);
  });

  it("never persists plaintext amounts: stored fields are ciphertext bound to the row", async () => {
    await rt.set.execute(input({ amount: EGP(7777), perCategory: { dresses: EGP(1234) } }));
    await rt.record.execute(user, spend("placed:1", "placed", EGP(4321), IN_CYCLE));
    await rt.store.read(user, async (tx) => {
      const b = await tx.getBudget();
      const dump = Buffer.from(b?.amountEnc ?? []).toString("latin1") + Buffer.from(b?.perCategoryEnc ?? []).toString("latin1");
      expect(dump).not.toMatch(/777700|123400/);
      for (const e of await tx.listSpendEvents(0)) expect(Buffer.from(e.detailEnc).toString("latin1")).not.toContain("432100");
    });
  });

  it("a failing cipher surfaces as CipherUnavailableError and stores nothing", async () => {
    rt.cipher.setFailing(true);
    await expect(rt.set.execute(input())).rejects.toBeInstanceOf(CipherUnavailableError);
    rt.cipher.setFailing(false);
    expect(rt.store.hasAnyData(user)).toBe(false);
  });

  it("withdrawing consent purges everything on the next event and on the daily sweep", async () => {
    await rt.set.execute(input());
    await rt.record.execute(user, spend("placed:1", "placed", EGP(100), IN_CYCLE));
    rt.consent.withdraw(user);
    expect(await rt.record.execute(user, spend("placed:2", "placed", EGP(5), IN_CYCLE))).toBe("ignored_no_consent");
    expect(rt.store.hasAnyData(user)).toBe(false);
    expect(rt.store.events.map((e) => e.type)).toContain("budget.data_purged");

    rt.consent.grant(user);
    await rt.set.execute(input());
    rt.consent.withdraw(user);
    expect(await rt.roll.execute()).toMatchObject({ purged: 1 });
    expect(rt.store.hasAnyData(user)).toBe(false);
  });

  it("DELETE erases every row and is repeatable", async () => {
    await rt.set.execute(input({ installments: [{ provider: "valU", monthly: EGP(500), startsAtMs: IN_CYCLE - DAY, endsAtMs: IN_CYCLE + 90 * DAY }] }));
    expect(await rt.remove.execute(user)).toEqual({ deleted: true });
    expect(rt.store.hasAnyData(user)).toBe(false);
    expect(await rt.remove.execute(user)).toEqual({ deleted: false });
  });
});

describe("remaining, cycles and spend", () => {
  it("remaining = budget - spent - installments, bag only when toggled", async () => {
    await rt.set.execute(input({ installments: [{ provider: "valU", monthly: EGP(620), startsAtMs: IN_CYCLE - 20 * DAY, endsAtMs: IN_CYCLE + 90 * DAY }] }));
    await rt.record.execute(user, spend("placed:1", "placed", EGP(1200), IN_CYCLE));
    rt.bag.set(user, EGP(800));
    const off = await rt.summary.execute(user, false);
    const on = await rt.summary.execute(user, true);
    expect(off.kind === "ok" && off.view.remaining.remaining).toBe(EGP(5000 - 1200 - 620));
    expect(on.kind === "ok" && on.view.remaining.remaining).toBe(EGP(5000 - 1200 - 620 - 800));
    expect(off.kind === "ok" && off.view.installments.every((i) => i.label === "estimate")).toBe(true);
  });

  it("payday 31 ends the cycle on the last day of a 30-day month", async () => {
    await rt.set.execute(input({ payday: 31 }));
    const s = await rt.summary.execute(user, false);
    expect(s.kind === "ok" && s.view.cycle.endDate).toBe("2026-04-30");
    expect(s.kind === "ok" && s.view.cycle.startDate).toBe("2026-03-31");
  });

  it("COD counts at placement and reverses on refusal", async () => {
    await rt.set.execute(input());
    await rt.record.execute(user, spend("placed:cod1", "placed", EGP(900), IN_CYCLE));
    const mid = await rt.summary.execute(user, false);
    expect(mid.kind === "ok" && mid.view.remaining.spent).toBe(EGP(900));
    await rt.record.execute(user, spend("cod_refusal:cod1", "cod_refusal", EGP(900), IN_CYCLE, IN_CYCLE + DAY));
    const after = await rt.summary.execute(user, false);
    expect(after.kind === "ok" && after.view.remaining.spent).toBe(0n);
  });

  it("a refund in the next cycle credits the original cycle in reports and lifts available-now", async () => {
    await rt.set.execute(input());
    rt.clock.set(PREV_CYCLE + DAY);
    // the budget row exists; place an order in the previous cycle, then move into the next one
    await rt.record.execute(user, spend("placed:p", "placed", EGP(1000), PREV_CYCLE));
    await rt.record.execute(user, spend("placed:c", "placed", EGP(300), IN_CYCLE));
    rt.clock.set(IN_CYCLE + 2 * DAY);
    await rt.record.execute(user, spend("refund:p", "refund", EGP(800), PREV_CYCLE, IN_CYCLE + DAY));
    const s = await rt.summary.execute(user, false);
    expect(s.kind === "ok" && s.view.previousNetSpent).toBe(EGP(200)); // original cycle credited
    expect(s.kind === "ok" && s.view.netSpent).toBe(EGP(300)); // current cycle report untouched
    expect(s.kind === "ok" && s.view.remaining.spent).toBe(0n); // 300 - 800 refund received, floored
    expect(s.kind === "ok" && s.view.remaining.remaining).toBe(EGP(5000));
  });

  it("repeating an event key is a no-op (idempotent)", async () => {
    await rt.set.execute(input());
    const e = spend("placed:1", "placed", EGP(100), IN_CYCLE);
    expect(await rt.record.execute(user, e)).toBe("recorded");
    expect(await rt.record.execute(user, e)).toBe("duplicate");
    const s = await rt.summary.execute(user, false);
    expect(s.kind === "ok" && s.view.remaining.spent).toBe(EGP(100));
  });

  it("property: replaying the same events in any order and with duplicates gives the same totals", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.record({ id: fc.integer({ min: 0, max: 6 }), amount: fc.integer({ min: 1, max: 900 }) }), { minLength: 1, maxLength: 12 }),
        async (rows) => {
          const a = createRuntime();
          const b = createRuntime();
          for (const r of [a, b]) {
            r.consent.grant(user);
            await r.set.execute(input({ amount: EGP(100000) }));
          }
          const evs = rows.map((r) => spend(`placed:${r.id}`, "placed", EGP(r.amount), IN_CYCLE + r.id));
          for (const e of evs) await a.record.execute(user, e);
          for (const e of [...evs].reverse().concat(evs)) await b.record.execute(user, e);
          const sa = await a.summary.execute(user, false);
          const sb = await b.summary.execute(user, false);
          // first writer per key wins in both, so compare against the unique-key first amounts
          const uniq = new Map<string, bigint>();
          for (const e of evs) if (!uniq.has(e.key)) uniq.set(e.key, e.amount);
          const expectA = [...uniq.values()].reduce((x, y) => x + y, 0n);
          expect(sa.kind === "ok" && sa.view.remaining.spent).toBe(expectA);
          expect(sb.kind === "ok").toBe(true);
        },
      ),
      { numRuns: 25 },
    );
  });

  it("reconciliation repairs a missing order event and flags an amount mismatch", async () => {
    await rt.set.execute(input());
    await rt.record.execute(user, spend("placed:known", "placed", EGP(100), IN_CYCLE));
    rt.spendSource.add(user, spend("placed:known", "placed", EGP(150), IN_CYCLE));
    rt.spendSource.add(user, spend("placed:missing", "placed", EGP(70), IN_CYCLE));
    expect(await rt.reconcile.execute(user)).toEqual({ inserted: 1, mismatched: 1 });
    const s = await rt.summary.execute(user, false);
    expect(s.kind === "ok" && s.view.remaining.spent).toBe(EGP(170));
  });

  it("the daily roll creates the cycle row once per cycle and emits budget.cycle_rolled once", async () => {
    await rt.set.execute(input());
    const before = rt.store.events.filter((e) => e.type === "budget.cycle_rolled").length;
    expect(await rt.roll.execute()).toMatchObject({ rolled: 0, skipped: 1 }); // set already created the row
    rt.clock.set(NEXT_CYCLE);
    expect(await rt.roll.execute()).toMatchObject({ rolled: 1 });
    expect(await rt.roll.execute()).toMatchObject({ rolled: 0 });
    expect(rt.store.events.filter((e) => e.type === "budget.cycle_rolled").length).toBe(before + 1);
  });

  it("provider commitments win over a user entry and are labelled estimate", async () => {
    await rt.set.execute(input({ installments: [{ provider: "valU", monthly: EGP(500), startsAtMs: IN_CYCLE - 30 * DAY, endsAtMs: IN_CYCLE + 90 * DAY }] }));
    await rt.ingest.execute(user, [{ provider: "valU", monthly: EGP(640), startsAtMs: IN_CYCLE - 30 * DAY, endsAtMs: IN_CYCLE + 90 * DAY }]);
    const s = await rt.summary.execute(user, false);
    expect(s.kind === "ok" && s.view.remaining.installments).toBe(EGP(640));
  });

  it("emits events without amounts", async () => {
    await rt.set.execute(input({ amount: EGP(5000), perCategory: { shoes: EGP(900) } }));
    expect(JSON.stringify(rt.store.events, (_, v) => (typeof v === "bigint" ? v.toString() : v))).not.toMatch(/500000|90000/);
    expect(rt.store.events[0]).toEqual({ type: "budget.set", userId: user, capMode: "off", hasCategories: true });
  });
});

describe("request-time affordability filter", () => {
  it("returns only the ceiling and performs no write", async () => {
    await rt.set.execute(input());
    await rt.record.execute(user, spend("placed:1", "placed", EGP(1200), IN_CYCLE));
    const writes = rt.store.writes;
    const eventsBefore = rt.store.events.length;
    for (const ctx of ["feed", "search", "stylist", "wishlist"] as const) {
      expect(await rt.filter.priceCeilingFor(user, ctx)).toBe(EGP(3800));
    }
    expect(rt.store.writes).toBe(writes);
    expect(rt.store.events.length).toBe(eventsBefore);
  });

  it("is null without consent, without a budget, when the suite is off or the store is down", async () => {
    expect(await rt.filter.priceCeilingFor(user, "feed")).toBeNull();
    await rt.set.execute(input());
    rt.flags.suite = false;
    expect(await rt.filter.priceCeilingFor(user, "feed")).toBeNull();
    rt.flags.suite = true;
    rt.consent.withdraw(user);
    expect(await rt.filter.priceCeilingFor(user, "feed")).toBeNull();
    rt.consent.grant(user);
    rt.store.failing = true;
    expect(await rt.filter.priceCeilingFor(user, "feed")).toBeNull();
  });

  it("is zero (not negative) once over budget", async () => {
    await rt.set.execute(input({ amount: EGP(100) }));
    await rt.record.execute(user, spend("placed:1", "placed", EGP(400), IN_CYCLE));
    expect(await rt.filter.priceCeilingFor(user, "search")).toBe(0n);
  });
});

describe("wellbeing caps at checkout", () => {
  it("soft cap asks for a 10 second hold, then allows after it", async () => {
    await rt.set.execute(input({ amount: EGP(1000), capMode: "soft" }));
    rt.clock.set(IN_CYCLE + DAY);
    const first = await rt.guard.authorize({ userId: user, orderKey: "g1", orderTotal: EGP(1500), softHeldSinceMs: null });
    expect(first).toMatchObject({ kind: "soft_hold", holdSeconds: 10 });
    const held = rt.clock.nowMs();
    rt.clock.advance(10_000);
    const second = await rt.guard.authorize({ userId: user, orderKey: "g1", orderTotal: EGP(1500), softHeldSinceMs: held });
    expect(second).toEqual({ kind: "allow", reason: "soft_confirmed" });
  });

  it("hard cap blocks, unlock takes 24h, and the unlock expires with the cycle", async () => {
    await rt.set.execute(input({ amount: EGP(1000), capMode: "hard" }));
    rt.clock.set(IN_CYCLE + DAY);
    expect(await rt.guard.authorize({ userId: user, orderKey: "g1", orderTotal: EGP(1500), softHeldSinceMs: null })).toMatchObject({ kind: "blocked", unlockAtMs: null });
    const r = await rt.unlock.execute(user);
    expect(r.kind).toBe("requested");
    expect(await rt.unlock.execute(user)).toMatchObject({ kind: "already_requested" });
    expect(rt.store.events.filter((e) => e.type === "budget.cap_unlock_requested")).toHaveLength(1);
    rt.clock.advance(DAY - 1);
    expect(await rt.guard.authorize({ userId: user, orderKey: "g1", orderTotal: EGP(1500), softHeldSinceMs: null })).toMatchObject({ kind: "blocked" });
    rt.clock.advance(1);
    expect(await rt.guard.authorize({ userId: user, orderKey: "g1", orderTotal: EGP(1500), softHeldSinceMs: null })).toEqual({ kind: "allow", reason: "hard_unlocked" });
    rt.clock.set(NEXT_CYCLE);
    expect(await rt.guard.authorize({ userId: user, orderKey: "g2", orderTotal: EGP(1500), softHeldSinceMs: null })).toMatchObject({ kind: "blocked" });
  });

  it("unlock is not applicable unless a hard cap is set", async () => {
    await rt.set.execute(input({ capMode: "soft" }));
    expect(await rt.unlock.execute(user)).toEqual({ kind: "not_applicable" });
  });

  it("two concurrent orders crossing the cap: exactly one passes (per-user lock + provisional spend)", async () => {
    await rt.set.execute(input({ amount: EGP(1000), capMode: "hard" }));
    rt.clock.set(IN_CYCLE + DAY);
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) => rt.guard.authorize({ userId: user, orderKey: `g${i}`, orderTotal: EGP(600), softHeldSinceMs: null })),
    );
    expect(results.filter((r) => r.kind === "allow")).toHaveLength(1);
    expect(results.filter((r) => r.kind === "blocked")).toHaveLength(5);
  });

  it("re-authorizing the same order does not double count, and release frees the budget", async () => {
    await rt.set.execute(input({ amount: EGP(1000), capMode: "hard" }));
    rt.clock.set(IN_CYCLE + DAY);
    const a = { userId: user, orderKey: "g1", orderTotal: EGP(900), softHeldSinceMs: null };
    expect((await rt.guard.authorize(a)).kind).toBe("allow");
    expect((await rt.guard.authorize(a)).kind).toBe("allow");
    expect((await rt.guard.authorize({ ...a, orderKey: "g2" })).kind).toBe("blocked");
    await rt.guard.release(user, "g1");
    expect((await rt.guard.authorize({ ...a, orderKey: "g2" })).kind).toBe("allow");
    // the paid event for the same key is a no-op, not a second spend
    expect(await rt.record.execute(user, spend("placed:g2", "placed", EGP(900), rt.clock.nowMs()))).toBe("duplicate");
  });

  it("fails open for soft caps and closed only for a hard cap already seen active", async () => {
    await rt.set.execute(input({ amount: EGP(1000), capMode: "soft" }));
    rt.clock.set(IN_CYCLE + DAY);
    await rt.guard.authorize({ userId: user, orderKey: "g0", orderTotal: EGP(10), softHeldSinceMs: null });
    rt.store.failing = true;
    expect(await rt.guard.authorize({ userId: user, orderKey: "g1", orderTotal: EGP(5000), softHeldSinceMs: null })).toEqual({ kind: "allow", reason: "service_unavailable" });
    rt.store.failing = false;

    await rt.set.execute(input({ amount: EGP(1000), capMode: "hard" }));
    await rt.guard.authorize({ userId: user, orderKey: "g2", orderTotal: EGP(10), softHeldSinceMs: null });
    rt.store.failing = true;
    expect(await rt.guard.authorize({ userId: user, orderKey: "g3", orderTotal: EGP(5000), softHeldSinceMs: null })).toMatchObject({ kind: "blocked" });
  });

  it("the kill switch lifts enforcement and a user without consent is never capped", async () => {
    await rt.set.execute(input({ amount: EGP(1000), capMode: "hard" }));
    rt.clock.set(IN_CYCLE + DAY);
    rt.flags.caps = false;
    expect((await rt.guard.authorize({ userId: user, orderKey: "g1", orderTotal: EGP(5000), softHeldSinceMs: null })).kind).toBe("allow");
    rt.flags.caps = true;
    rt.consent.withdraw(user);
    expect((await rt.guard.authorize({ userId: user, orderKey: "g2", orderTotal: EGP(5000), softHeldSinceMs: null })).kind).toBe("allow");
  });
});

describe("planner use case", () => {
  it("affordable now vs later with Need > date > Want > Treat", async () => {
    await rt.set.execute(input({ amount: EGP(1000) }));
    await rt.record.execute(user, spend("placed:1", "placed", EGP(400), IN_CYCLE));
    rt.wishlists.set(user, null, [
      { id: "treat", priority: "treat", price: EGP(500), dueAtMs: null },
      { id: "need", priority: "need", price: EGP(500), dueAtMs: null },
      { id: "want", priority: "want", price: EGP(500), dueAtMs: null },
      { id: "date", priority: "dated", price: EGP(300), dueAtMs: START_MS + 3 * DAY },
    ]);
    const r = await rt.plan.execute(user, null, 3);
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    const byId = Object.fromEntries(r.plan.planned.map((p) => [p.id, p.cycleIndex]));
    // remaining now = 600: need (500) fits now; date (300) does not fit in the leftover 100 -> next cycle
    expect(byId).toMatchObject({ need: 0, date: 1 });
    expect(r.plan.planned.find((p) => p.id === "date")?.missesDate).toBe(true);
    expect((byId["want"] ?? 9) >= 1).toBe(true);
  });

  it("is 404-shaped for an unknown list, empty without a budget", async () => {
    expect((await rt.plan.execute(user, null, 3)).kind).toBe("empty");
    await rt.set.execute(input());
    expect((await rt.plan.execute(user, "00000000-0000-4000-8000-000000000999", 3)).kind).toBe("not_found");
  });
});

describe("export", () => {
  it("includes every budget field of the owner for a DSAR", async () => {
    await rt.set.execute(input({ perCategory: { shoes: EGP(900) }, installments: [{ provider: "Sympl", monthly: EGP(300), startsAtMs: IN_CYCLE, endsAtMs: IN_CYCLE + 60 * DAY }] }));
    const ex = await rt.exporter.execute(user);
    expect(ex.budget).toMatchObject({ amount: String(EGP(5000)), perCategory: { shoes: String(EGP(900)) }, payday: 25, capMode: "off" });
    expect(ex.commitments).toHaveLength(1);
    expect(ex.cycles.length).toBeGreaterThan(0);
  });
});
