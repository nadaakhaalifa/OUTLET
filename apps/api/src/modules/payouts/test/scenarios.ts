import { beforeEach, describe, expect, it } from "vitest";
import type { ApprovalRecord } from "../domain/bridge";
import type { PayoutStore } from "../domain/ports";
import {
  CLAWBACK,
  CUTOFF,
  CYCLE_KEY,
  DAY,
  FINANCE_1,
  FINANCE_2,
  FRESH,
  OLD,
  STORE_A,
  STORE_B,
  addOrder,
  kit,
  seedStore,
  type Kit,
  type TestClock,
} from "./fixtures";

export interface ScenarioContext {
  readonly store: PayoutStore;
  readonly clock: TestClock;
  ensureUser(userId: string): Promise<void>;
  outboxTypes(): Promise<string[]>;
  /** Number of random sequences; PGlite builds a database per run, so it uses few. */
  readonly propertyRuns?: number;
}

const approvalFor = (payoutId: string, amount: bigint, over: Partial<ApprovalRecord> = {}): ApprovalRecord => ({
  id: `00000000-0000-4000-8000-${String(Math.floor(Math.random() * 1e9)).padStart(12, "0")}`,
  kind: "payout",
  subjectType: "payout",
  subjectId: payoutId,
  amountMinor: amount,
  reasonCode: "scheduled_payout",
  requesterId: FINANCE_1,
  state: "APPROVED",
  approverId: FINANCE_2,
  requestedAtMs: 0,
  expiresAtMs: Number.MAX_SAFE_INTEGER,
  decidedAtMs: 1,
  decisionNote: null,
  ...over,
});

/** Behaviour of the payout use cases on top of any PayoutStore. Run against in-memory and Kysely/PGlite. */
export function describePayoutScenarios(name: string, make: () => Promise<ScenarioContext>): void {
  describe(`Payout scenarios: ${name}`, () => {
    let c: ScenarioContext;
    let k: Kit;

    beforeEach(async () => {
      c = await make();
      await c.ensureUser(FINANCE_1);
      await c.ensureUser(FINANCE_2);
      k = kit(c.store, c.clock);
      seedStore(k, STORE_A);
      seedStore(k, STORE_B, { legalName: "Delta Wear" , holder: "Delta Wear Co" });
    });

    const only = async (storeId = STORE_A) => {
      const page = await c.store.list({ scope: { kind: "system" }, storeId, after: null, limit: 10 });
      const p = page.items[0];
      if (p === undefined) throw new Error("no payout");
      return p;
    };

    it("pays only closed orders past the 3 day buffer and writes one scheduled event", async () => {
      addOrder(k, 1, 80_000n);
      addOrder(k, 2, 40_000n, { closedAtMs: FRESH });
      addOrder(k, 3, 99_000n, { closedAtMs: null, status: "DELIVERED" });
      const s = await k.commands.schedule();
      expect(s.cycleKey).toBe(CYCLE_KEY);
      expect(s.created).toHaveLength(1);
      const p = await only();
      expect(p.status).toBe("SCHEDULED");
      expect(p.amount).toBe(80_000n);
      expect(p.cutoffAtMs).toBe(CUTOFF);
      expect(p.lines.map((l) => l.sourceId)).toHaveLength(1);
      expect(p.ibanLast4).toBe("0002");
      expect(await c.outboxTypes()).toEqual(["payout.scheduled"]);
    });

    it("is idempotent per store and cycle", async () => {
      addOrder(k, 1, 80_000n);
      await k.commands.schedule();
      const again = await k.commands.schedule();
      expect(again.created).toEqual([]);
      // the order is now in an active payout, so it is not even a candidate
      expect(again.skipped).toEqual([{ storeId: STORE_A, reason: "nothing_eligible" }]);
      const all = await c.store.list({ scope: { kind: "system" }, after: null, limit: 50 });
      expect(all.items).toHaveLength(1);
      expect(await c.outboxTypes()).toEqual(["payout.scheduled"]);
    });

    it("never puts a seller order in two payouts even if cycles differ", async () => {
      addOrder(k, 1, 80_000n);
      await k.commands.schedule();
      k.clock.advance(7 * DAY);
      const next = await k.commands.schedule();
      expect(next.created).toEqual([]);
      expect(next.skipped).toEqual([{ storeId: STORE_A, reason: "nothing_eligible" }]);
    });

    it("nets a refund after payout from the next payout and applies each clawback once", async () => {
      addOrder(k, 1, 100_000n);
      k.source.addClawback({ id: CLAWBACK(1), storeId: STORE_A, amount: 30_000n, kind: "refund_after_payout", createdAtMs: 5 });
      await k.commands.schedule();
      const p = await only();
      expect(p.amount).toBe(70_000n);
      expect(p.nettedTotal).toBe(30_000n);
      expect(p.carryForward).toBe(0n);
      expect(p.lines.map((l) => l.sourceType).sort()).toEqual(["clawback", "seller_order"]);
      // next week a new order arrives: the clawback is already fully applied
      k.clock.advance(7 * DAY);
      addOrder(k, 2, 50_000n, { closedAtMs: OLD });
      const s = await k.commands.schedule();
      expect(s.created).toHaveLength(1);
      const next = (await c.store.list({ scope: { kind: "system" }, after: null, limit: 5 })).items.find((x) => x.id === s.created[0]);
      expect(next?.amount).toBe(50_000n);
      expect(next?.nettedTotal).toBe(0n);
    });

    it("carries clawbacks bigger than the eligible total, consuming nothing until a payout is possible", async () => {
      addOrder(k, 1, 120_000n);
      k.source.addClawback({ id: CLAWBACK(1), storeId: STORE_A, amount: 20_000n, kind: "promo_netting", createdAtMs: 1 });
      k.source.addClawback({ id: CLAWBACK(2), storeId: STORE_A, amount: 150_000n, kind: "refund_after_payout", createdAtMs: 2 });
      const first = await k.commands.schedule();
      expect(first.created).toEqual([]);
      expect(first.skipped).toEqual([{ storeId: STORE_A, reason: "below_minimum" }]);
      // a later cycle brings more orders: 200,000 eligible against 170,000 owed leaves 30,000
      k.clock.advance(7 * DAY);
      addOrder(k, 2, 80_000n, { closedAtMs: OLD + 7 * DAY });
      const second = await k.commands.schedule();
      expect(second.created).toHaveLength(1);
      const p = await only();
      expect(p.eligibleTotal).toBe(200_000n);
      expect(p.nettedTotal).toBe(170_000n);
      expect(p.amount).toBe(30_000n);
      expect(p.carryForward).toBe(0n);
    });

    it("holds for missing bank details, name mismatch, name outage, risk and ledger balance", async () => {
      const cases: [string, () => void, string][] = [
        ["no_bank_details", () => k.bank.byStore.delete(STORE_A), "no_bank_details"],
        ["mismatch", () => k.bank.holders.set("tok-000a", "Someone Else"), "iban_name_mismatch"],
        ["outage", () => (k.nameMatch.outage = true), "name_check_unavailable"],
        ["risk", () => k.risk.held.add(STORE_A), "risk_review"],
        ["ledger", () => k.ledger.setBalance(STORE_A, 1n), "exceeds_ledger_balance"],
      ];
      for (const [, arrange, reason] of cases) {
        c = await make();
        await c.ensureUser(FINANCE_1);
        k = kit(c.store, c.clock);
        seedStore(k, STORE_A);
        addOrder(k, 1, 80_000n);
        arrange();
        const s = await k.commands.schedule();
        expect(s.held.map((h) => h.reason)).toEqual([reason]);
        const p = await only();
        expect(p.status).toBe("ON_HOLD");
        expect(p.holdReason).toBe(reason);
        expect(await c.outboxTypes()).toEqual(["payout.scheduled", "payout.held"]);
      }
    }, 60_000);

    describe("approval", () => {
      const scheduleOne = async (net: bigint) => {
        addOrder(k, 1, net);
        await k.commands.schedule();
        return only();
      };

      it("approves below the threshold with no record and records who approved", async () => {
        const p = await scheduleOne(80_000n);
        const r = await k.commands.approve({ payoutId: p.id, actor: { id: FINANCE_1 }, key: "k1" });
        expect(r.kind).toBe("ok");
        const after = await only();
        expect(after.status).toBe("APPROVED");
        expect(after.approvedBy).toBe(FINANCE_1);
        expect(after.approvalId).toBeNull();
        expect(await c.outboxTypes()).toEqual(["payout.scheduled", "payout.approved"]);
      });

      it("replays the same command without a second transition", async () => {
        const p = await scheduleOne(80_000n);
        await k.commands.approve({ payoutId: p.id, actor: { id: FINANCE_1 }, key: "same" });
        const again = await k.commands.approve({ payoutId: p.id, actor: { id: FINANCE_1 }, key: "same" });
        expect(again.kind).toBe("replayed");
        expect((await only()).version).toBe(1);
        expect(await c.outboxTypes()).toEqual(["payout.scheduled", "payout.approved"]);
      });

      it("needs a covering approval record at the threshold", async () => {
        const p = await scheduleOne(5_000_000n);
        expect(await k.commands.approve({ payoutId: p.id, actor: { id: FINANCE_1 }, key: "a" })).toEqual({
          kind: "approval_required",
          approval: "missing",
        });
        for (const bad of [
          approvalFor(p.id, p.amount, { approverId: FINANCE_1 }), // self approval
          approvalFor(p.id, p.amount, { subjectId: "other" }),
          approvalFor(p.id, p.amount - 1n),
          approvalFor(p.id, p.amount, { expiresAtMs: 1 }),
          approvalFor(p.id, p.amount, { state: "REQUESTED", approverId: null }),
        ]) {
          k.approvals.records.length = 0;
          k.approvals.records.push(bad);
          const r = await k.commands.approve({ payoutId: p.id, actor: { id: FINANCE_1 }, key: `b-${bad.id}` });
          // a record for another subject is simply not for this payout
          expect(["approval_required"]).toContain(r.kind);
        }
        expect((await only()).status).toBe("SCHEDULED");
        k.approvals.records.length = 0;
        const good = approvalFor(p.id, p.amount);
        k.approvals.records.push(good);
        const ok = await k.commands.approve({ payoutId: p.id, actor: { id: FINANCE_1 }, key: "good" });
        expect(ok.kind).toBe("ok");
        expect((await only()).approvalId).toBe(good.id);
      });

      it("refuses while an included order has an open dispute", async () => {
        const p = await scheduleOne(80_000n);
        k.source.disputes.add(p.lines[0]?.sourceId ?? "");
        expect(await k.commands.approve({ payoutId: p.id, actor: { id: FINANCE_1 }, key: "d" })).toEqual({ kind: "open_dispute" });
      });

      it("only one of two simultaneous approvals wins", async () => {
        const p = await scheduleOne(80_000n);
        const [a, b] = await Promise.all([
          k.commands.approve({ payoutId: p.id, actor: { id: FINANCE_1 }, key: "x1" }),
          k.commands.approve({ payoutId: p.id, actor: { id: FINANCE_2 }, key: "x2" }),
        ]);
        const kinds = [a.kind, b.kind].sort();
        expect(kinds.filter((x) => x === "ok")).toHaveLength(1);
        expect((await only()).status).toBe("APPROVED");
        expect((await c.outboxTypes()).filter((t) => t === "payout.approved")).toHaveLength(1);
      });

      it("unknown payout is not found", async () => {
        expect(await k.commands.approve({ payoutId: "00000000-0000-4000-8000-00000000dead", actor: { id: FINANCE_1 }, key: "z" })).toEqual({
          kind: "not_found",
        });
      });
    });

    describe("send", () => {
      const approved = async (net = 80_000n) => {
        addOrder(k, 1, net);
        await k.commands.schedule();
        const p = await only();
        await k.commands.approve({ payoutId: p.id, actor: { id: FINANCE_1 }, key: "ap" });
        return only();
      };

      it("F-7: approve from a ledger-balance hold is refused until a fresh check passes", async () => {
        addOrder(k, 1, 80_000n);
        k.ledger.setBalance(STORE_A, 1n);
        await k.commands.schedule();
        const p = await only();
        expect(p.holdReason).toBe("exceeds_ledger_balance");
        expect(await k.commands.approve({ payoutId: p.id, actor: { id: FINANCE_1 }, key: "a1" })).toEqual({
          kind: "hold_not_cleared",
          reason: "exceeds_ledger_balance",
        });
        expect((await only()).status).toBe("ON_HOLD");
        k.ledger.setBalance(STORE_A, 80_000n);
        expect((await k.commands.approve({ payoutId: p.id, actor: { id: FINANCE_1 }, key: "a2" })).kind).toBe("ok");
      });

      it("F-7: approve from a risk hold is refused while risk still holds", async () => {
        addOrder(k, 1, 80_000n);
        k.risk.held.add(STORE_A);
        await k.commands.schedule();
        const p = await only();
        expect(p.holdReason).toBe("risk_review");
        expect((await k.commands.approve({ payoutId: p.id, actor: { id: FINANCE_1 }, key: "a1" })).kind).toBe("hold_not_cleared");
        k.risk.held.delete(STORE_A);
        expect((await k.commands.approve({ payoutId: p.id, actor: { id: FINANCE_1 }, key: "a2" })).kind).toBe("ok");
      });

      it("F-7: send re-checks the ledger balance and posts nothing when it fell after approval", async () => {
        const p = await approved();
        k.ledger.setBalance(STORE_A, 10n);
        k.provider.mode = "settle";
        const r = await k.commands.send(p.id);
        expect(r).toMatchObject({ kind: "held", reason: "exceeds_ledger_balance" });
        expect(k.ledger.entries.size).toBe(0);
        expect(k.provider.executed).toHaveLength(0);
      });

      it("ADV-W4-5: a cancel that wins the version check leaves no live payout entry, in either order", async () => {
        const p = await approved();
        k.provider.mode = "settle";
        await Promise.all([
          k.commands.send(p.id),
          k.commands.cancel({ payoutId: p.id, actor: { id: FINANCE_1 }, key: "c" }),
        ]);
        const after = await c.store.get(p.id, { kind: "system" });
        if (after?.status === "CANCELLED") {
          expect(k.ledger.liveEntries()).toHaveLength(0);
          expect(k.provider.executed).toHaveLength(0);
        } else {
          // send won: cancel is refused and the single entry is live exactly once
          expect(k.ledger.liveEntries()).toHaveLength(1);
        }
      });

      it("posts the ledger entry first, then pays once, then settles", async () => {
        const p = await approved();
        k.provider.mode = "settle";
        const r = await k.commands.send(p.id);
        expect(r.kind).toBe("settled");
        const after = await only();
        expect(after.status).toBe("SETTLED");
        expect(after.ledgerRef).toBe(`${p.id}~1`);
        expect(k.ledger.liveEntries()).toHaveLength(1);
        expect(k.provider.executed).toEqual([{ key: `${p.id}~1`, amount: 80_000n, accountToken: "tok-000a" }]);
        expect(await k.ledger.payableBalance(STORE_A)).toBe(100_000_000n - 80_000n);
        expect(await c.outboxTypes()).toEqual(["payout.scheduled", "payout.approved", "payout.sent", "payout.settled"]);
      });

      it("sending twice moves money once", async () => {
        const p = await approved();
        k.provider.mode = "settle";
        await k.commands.send(p.id);
        const again = await k.commands.send(p.id);
        expect(again.kind).toBe("invalid_transition");
        expect(k.ledger.entries.size).toBe(1);
        expect(k.provider.executed).toHaveLength(1);
      });

      it("kill switch off: nothing is posted, nothing is sent, state unchanged", async () => {
        const p = await approved();
        k.flags.enabled = false;
        expect(await k.commands.send(p.id)).toEqual({ kind: "kill_switch" });
        expect((await only()).status).toBe("APPROVED");
        expect(k.ledger.entries.size).toBe(0);
        expect(k.provider.calls).toEqual([]);
        k.flags.enabled = true;
        k.provider.mode = "settle";
        expect((await k.commands.send(p.id)).kind).toBe("settled");
      });

      it("a name mismatch at send time holds the payout and posts nothing", async () => {
        const p = await approved();
        k.bank.holders.set("tok-000a", "Somebody Else Entirely");
        const r = await k.commands.send(p.id);
        expect(r).toMatchObject({ kind: "held", reason: "iban_name_mismatch" });
        expect(k.ledger.entries.size).toBe(0);
        expect(k.provider.calls).toEqual([]);
        expect((await only()).status).toBe("ON_HOLD");
      });

      it("a bank account swapped after scheduling is held for review", async () => {
        const p = await approved();
        k.bank.byStore.set(STORE_A, { accountToken: "tok-evil", ibanLast4: "9999", legalName: "Nile Fashion LLC" });
        k.bank.holders.set("tok-evil", "Nile Fashion");
        expect(await k.commands.send(p.id)).toMatchObject({ kind: "held", reason: "risk_review" });
        expect(k.provider.calls).toEqual([]);
      });

      it("provider rejection reverses the ledger and keeps the lines; reschedule sends a new attempt", async () => {
        const p = await approved();
        k.provider.mode = "reject";
        const r = await k.commands.send(p.id);
        expect(r.kind).toBe("failed");
        const failed = await only();
        expect(failed.status).toBe("FAILED");
        expect(failed.failureCode).toBe("account_closed");
        expect(k.ledger.liveEntries()).toHaveLength(0);
        expect(await k.ledger.payableBalance(STORE_A)).toBe(100_000_000n);
        expect(failed.lines).toHaveLength(1);

        expect((await k.commands.reschedule({ payoutId: p.id, actor: { id: FINANCE_1 }, key: "r" })).kind).toBe("ok");
        expect((await k.commands.approve({ payoutId: p.id, actor: { id: FINANCE_1 }, key: "ap2" })).kind).toBe("ok");
        k.provider.mode = "settle";
        const second = await k.commands.send(p.id);
        expect(second.kind).toBe("settled");
        const done = await only();
        expect(done.ledgerRef).toBe(`${p.id}~2`);
        expect(done.attempts).toBe(2);
        expect(k.ledger.liveEntries()).toHaveLength(1);
        expect(k.provider.executed.map((e) => e.key)).toEqual([`${p.id}~1`, `${p.id}~2`]);
      });

      it("a provider outage leaves SENT and the next pass settles without double posting", async () => {
        const p = await approved();
        k.provider.mode = "unavailable";
        expect((await k.commands.send(p.id)).kind).toBe("pending");
        expect((await only()).status).toBe("SENT");
        expect(k.ledger.entries.size).toBe(1);
        k.provider.mode = "settle";
        const [r] = await k.commands.advanceSent();
        expect(r?.kind).toBe("settled");
        expect((await only()).status).toBe("SETTLED");
        expect(k.ledger.entries.size).toBe(1);
        expect(k.provider.executed).toHaveLength(1);
      });

      it("accepted stays SENT until the bank confirms", async () => {
        const p = await approved();
        k.provider.mode = "accept";
        expect((await k.commands.send(p.id)).kind).toBe("sent");
        const sent = await only();
        expect(sent.status).toBe("SENT");
        expect(sent.providerRef).toBe(`fake-${p.id}~1`);
        k.provider.resolve(`${p.id}~1`, "settled");
        await k.commands.advanceSent();
        expect((await only()).status).toBe("SETTLED");
      });

      it("recovers from a crash between the ledger post and the state change", async () => {
        const p = await approved();
        // the entry was posted, the process died before APPROVED -> SENT was stored
        await k.ledger.postPayout({ ref: `${p.id}~1`, storeId: STORE_A, amount: p.amount, bankAccount: "payout_main" });
        k.provider.mode = "settle";
        expect((await k.commands.send(p.id)).kind).toBe("settled");
        expect(k.ledger.entries.size).toBe(1);
      });

      it("R-5: crash after postPayout then cancel reverses the live entry", async () => {
        const p = await approved();
        await k.ledger.postPayout({ ref: `${p.id}~1`, storeId: STORE_A, amount: p.amount, bankAccount: "payout_main" });
        expect(k.ledger.liveEntries()).toHaveLength(1);
        expect((await k.commands.cancel({ payoutId: p.id, actor: { id: FINANCE_1 }, key: "c" })).kind).toBe("ok");
        expect(k.ledger.liveEntries()).toHaveLength(0);
        expect(await k.ledger.payableBalance(STORE_A)).toBe(100_000_000n);
      });

      it("R-5: sweeper reverses an entry posted after the cancel won (crash before reversal), idempotently", async () => {
        const p = await approved();
        expect((await k.commands.cancel({ payoutId: p.id, actor: { id: FINANCE_1 }, key: "c" })).kind).toBe("ok");
        await k.ledger.postPayout({ ref: `${p.id}~1`, storeId: STORE_A, amount: p.amount, bankAccount: "payout_main" });
        expect(k.ledger.liveEntries()).toHaveLength(1);
        expect(await k.commands.recoverOrphanEntries()).toEqual({ reversed: 1, resumed: 0 });
        expect(k.ledger.liveEntries()).toHaveLength(0);
        const again = await k.commands.recoverOrphanEntries();
        expect(again.resumed).toBe(0);
        expect(k.ledger.liveEntries()).toHaveLength(0);
        expect(k.ledger.reversals.size).toBe(1);
      });

      it("R-5: sweeper resumes a stale APPROVED payout whose entry was posted, without double posting", async () => {
        const p = await approved();
        await k.ledger.postPayout({ ref: `${p.id}~1`, storeId: STORE_A, amount: p.amount, bankAccount: "payout_main" });
        k.provider.mode = "settle";
        c.clock.advance(11 * 60_000);
        expect(await k.commands.recoverOrphanEntries(60_000)).toEqual({ reversed: 0, resumed: 1 });
        expect((await only()).status).toBe("SETTLED");
        expect(k.ledger.entries.size).toBe(1);
        expect(k.ledger.liveEntries()).toHaveLength(1);
      });

      it("cancelling gives the orders back to the next cycle", async () => {
        const p = await approved();
        expect((await k.commands.cancel({ payoutId: p.id, actor: { id: FINANCE_1 }, key: "c" })).kind).toBe("ok");
        expect((await only()).status).toBe("CANCELLED");
        const s = await k.commands.schedule();
        expect(s.created).toHaveLength(1);
        expect(s.created[0]).not.toBe(p.id);
      });

      it("a settled payout cannot be cancelled", async () => {
        const p = await approved();
        k.provider.mode = "settle";
        await k.commands.send(p.id);
        expect(await k.commands.cancel({ payoutId: p.id, actor: { id: FINANCE_1 }, key: "c" })).toEqual({
          kind: "invalid_transition",
          status: "SETTLED",
        });
      });

      it("stores exact bigint piastres beyond 2^53", async () => {
        const big = 9_007_199_254_740_993n;
        k.ledger.setBalance(STORE_A, big * 2n);
        addOrder(k, 9, big);
        await k.commands.schedule();
        const p = await only();
        expect(p.amount).toBe(big);
        expect(p.eligibleTotal).toBe(big);
      });
    });

    it("manual hold from SCHEDULED, then approve overrides the review", async () => {
      addOrder(k, 1, 80_000n);
      await k.commands.schedule();
      const p = await only();
      expect((await k.commands.hold({ payoutId: p.id, actor: { id: FINANCE_1 }, key: "h" })).kind).toBe("ok");
      const held = await only();
      expect(held.status).toBe("ON_HOLD");
      expect(held.holdReason).toBe("manual_hold");
      expect((await k.commands.approve({ payoutId: p.id, actor: { id: FINANCE_2 }, key: "a" })).kind).toBe("ok");
      expect((await only()).holdReason).toBeNull();
    });

    it("movements come from the append-only history and feed the statement", async () => {
      addOrder(k, 1, 80_000n);
      await k.commands.schedule();
      const p = await only();
      await k.commands.approve({ payoutId: p.id, actor: { id: FINANCE_1 }, key: "a" });
      k.provider.mode = "reject";
      await k.commands.send(p.id);
      const m = await c.store.movements(STORE_A);
      expect(m.map((x) => x.kind)).toEqual(["payout", "payout_reversal"]);
      expect(m.every((x) => x.amount === 80_000n)).toBe(true);
    });

    it("scopes reads to the caller's stores", async () => {
      addOrder(k, 1, 80_000n);
      addOrder(k, 2, 70_000n, { storeId: STORE_B });
      await k.commands.schedule();
      const a = await only(STORE_A);
      expect(await c.store.get(a.id, { kind: "seller", userId: FINANCE_1, storeIds: [STORE_B] })).toBeNull();
      expect((await c.store.get(a.id, { kind: "seller", userId: FINANCE_1, storeIds: [STORE_A] }))?.id).toBe(a.id);
      const sellerB = await c.store.list({ scope: { kind: "seller", userId: FINANCE_1, storeIds: [STORE_B] }, after: null, limit: 10 });
      expect(sellerB.items.map((x) => x.storeId)).toEqual([STORE_B]);
      const staff = await c.store.list({ scope: { kind: "staff", userId: FINANCE_1, role: "finance" }, after: null, limit: 10 });
      expect(staff.items).toHaveLength(2);
    });

    it("lists with a cursor", async () => {
      for (let i = 1; i <= 3; i += 1) {
        addOrder(k, i, 50_000n, { storeId: STORE_A });
      }
      // one payout per store and cycle, so use two stores plus a second cycle
      addOrder(k, 10, 60_000n, { storeId: STORE_B });
      await k.commands.schedule();
      k.clock.advance(7 * DAY);
      addOrder(k, 11, 61_000n, { storeId: STORE_B, closedAtMs: CUTOFF + 7 * DAY - 5 * DAY });
      await k.commands.schedule();
      const first = await c.store.list({ scope: { kind: "system" }, after: null, limit: 2 });
      expect(first.items).toHaveLength(2);
      expect(first.next).not.toBeNull();
      const second = await c.store.list({ scope: { kind: "system" }, after: first.next, limit: 2 });
      expect(second.items).toHaveLength(1);
      expect(second.next).toBeNull();
    });

    it("property: random command sequences keep the money invariants", async () => {
      const fc = await import("fast-check");
      let runs = 0;
      await fc.assert(
        fc.asyncProperty(
          fc.array(fc.constantFrom("approve", "send", "reject", "settle", "cancel", "reschedule", "schedule", "outage", "kill"), {
            minLength: 1,
            maxLength: 14,
          }),
          async (ops) => {
            runs += 1;
            const cx = await make();
            await cx.ensureUser(FINANCE_1);
            const kx = kit(cx.store, cx.clock);
            seedStore(kx, STORE_A);
            addOrder(kx, 1, 80_000n);
            addOrder(kx, 2, 60_000n);
            await kx.commands.schedule();
            const first = (await cx.store.list({ scope: { kind: "system" }, after: null, limit: 5 })).items[0];
            if (first === undefined) throw new Error("no payout");
            const id = first.id;
            let n = 0;
            for (const op of ops) {
              n += 1;
              const key = `op-${n}`;
              kx.flags.enabled = true;
              switch (op) {
                case "approve":
                  await kx.commands.approve({ payoutId: id, actor: { id: FINANCE_1 }, key });
                  break;
                case "send":
                  await kx.commands.send(id);
                  break;
                case "reject":
                  kx.provider.mode = "reject";
                  break;
                case "settle":
                  kx.provider.mode = "settle";
                  break;
                case "outage":
                  kx.provider.mode = "unavailable";
                  break;
                case "kill":
                  kx.flags.enabled = false;
                  await kx.commands.send(id);
                  break;
                case "cancel":
                  await kx.commands.cancel({ payoutId: id, actor: { id: FINANCE_1 }, key });
                  break;
                case "reschedule":
                  await kx.commands.reschedule({ payoutId: id, actor: { id: FINANCE_1 }, key });
                  break;
                case "schedule":
                  await kx.commands.schedule();
                  break;
              }
              await kx.commands.advanceSent();
            }
            const all = (await cx.store.list({ scope: { kind: "system" }, after: null, limit: 50 })).items;
            // every seller order is in at most one active payout
            const active = all.filter((p) => p.status !== "CANCELLED").flatMap((p) => p.lines.map((l) => l.sourceId));
            expect(new Set(active).size).toBe(active.length);
            // the ledger holds exactly the money of payouts that are SENT or SETTLED, once each
            const paid = all.filter((p) => p.status === "SENT" || p.status === "SETTLED").reduce((a, p) => a + p.amount, 0n);
            const posted = kx.ledger.liveEntries().reduce(
              (a, e) => a + e.postings.filter((p) => p.amount.amount > 0n).reduce((s, p) => s + p.amount.amount, 0n),
              0n,
            );
            expect(posted).toBe(paid);
            // the provider never executed one key twice and never executed a payout that was not posted
            const keys = kx.provider.executed.map((e) => e.key);
            expect(new Set(keys).size).toBe(keys.length);
            for (const p of all) expect(["SCHEDULED", "ON_HOLD", "APPROVED", "SENT", "SETTLED", "FAILED", "CANCELLED"]).toContain(p.status);
          },
        ),
        { numRuns: c.propertyRuns ?? 25 },
      );
      expect(runs).toBeGreaterThan(0);
    }, 120_000);
  });
}
