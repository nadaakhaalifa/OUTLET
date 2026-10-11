import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_REWARDS_CONFIG, type OddsTable } from "../domain/bridge";
import type { ChallengeRow, CoinEventRow, OddsVersion, PlayRow, RewardsStore } from "../domain/ports";

export interface RewardsStoreContext {
  readonly store: RewardsStore;
  /** Makes the user exist where the store enforces the FK (Postgres); no-op in memory. */
  ensureUser(userId: string): Promise<void>;
  /** Event types in the order they were written (outbox). */
  eventTypes(): Promise<string[]>;
}

export const U = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const T0 = 1_800_000_000_000;
const DAY = 86_400_000;
let seq = 0;
export const nid = (): string => `00000000-0000-7000-8000-${String(++seq + 700_000).padStart(12, "0")}`;

export const coin = (userId: string, over: Partial<CoinEventRow> = {}): CoinEventRow => {
  const id = nid();
  return {
    id,
    userId,
    kind: "purchase",
    sub: "cashback_coins",
    amount: 1_000n,
    debtDelta: 0n,
    parentId: null,
    sourceRef: `src-${id}`,
    journalEntryId: nid(),
    expiresAtMs: T0 + 365 * DAY,
    piastresPerCoin: 1n,
    configVersion: 1,
    createdAtMs: T0,
    ...over,
  };
};

export const TABLE: OddsTable = {
  outcomes: [
    { id: "nothing", kind: "nothing", ppm: 800_000, coins: null, voucherTemplateId: null },
    { id: "c100", kind: "coins", ppm: 195_000, coins: 100n, voucherTemplateId: null },
    { id: "v1", kind: "voucher", ppm: 5_000, coins: null, voucherTemplateId: "tpl-1" },
  ],
};

export const odds = (version: number, over: Partial<OddsVersion> = {}): OddsVersion => ({
  id: nid(),
  game: "daily_spin",
  version,
  table: TABLE,
  publishedAtMs: T0,
  effectiveFromMs: T0 + DAY,
  approvalId: "appr-1",
  ...over,
});

export const play = (userId: string, oddsVersionId: string, over: Partial<PlayRow> = {}): PlayRow => {
  const id = nid();
  return {
    id,
    userId,
    game: "daily_spin",
    intentId: `intent-${id}`,
    dayKey: "2027-01-15",
    seq: 1,
    oddsVersionId,
    rollPpm: 12_345,
    outcomeId: "nothing",
    outcomeKind: "nothing",
    coins: null,
    voucherTemplateId: null,
    serverSeed: "a".repeat(64),
    serverSeedHash: "b".repeat(64),
    sourceRef: null,
    rewardRef: null,
    settledAtMs: null,
    createdAtMs: T0,
    ...over,
  };
};

export function describeRewardsStoreContract(name: string, fresh: () => Promise<RewardsStoreContext>): void {
  describe(`RewardsStore contract: ${name}`, () => {
    let c: RewardsStoreContext;
    beforeEach(async () => {
      c = await fresh();
      for (const n of [1, 2, 3]) await c.ensureUser(U(n));
    });

    it("config: first version is null, next version appends, a stale version is refused", async () => {
      expect(await c.store.latestConfig()).toBeNull();
      const v2 = { ...DEFAULT_REWARDS_CONFIG, version: 2, purchaseBps: 150n };
      const meta = { approvalId: "a1", actorId: U(1), atMs: T0 };
      expect(await c.store.putConfig(v2, meta, [])).toBe("ok");
      expect(await c.store.putConfig(v2, meta, [])).toBe("stale");
      expect(await c.store.putConfig({ ...v2, version: 4 }, meta, [])).toBe("stale");
      const got = await c.store.latestConfig();
      expect(got?.version).toBe(2);
      expect(got?.purchaseBps).toBe(150n);
      expect(got?.streakMilestones[0]?.coins).toBe(5_000n);
    });

    it("coin events are idempotent on (kind, source_ref) and the outbox is written once", async () => {
      const e = coin(U(1), { sourceRef: "order-1" });
      const ev = [{ type: "coins.earned" as const, userId: U(1), kind: "purchase" as const, coins: 1_000n, sourceRef: "order-1", expiresAtMs: T0 }];
      expect(await c.store.appendCoinEvent(e, ev)).toBe("inserted");
      expect(await c.store.appendCoinEvent({ ...e, id: nid() }, ev)).toBe("duplicate");
      expect(await c.eventTypes()).toEqual(["coins.earned"]);
      const back = await c.store.coinEventBySource("purchase", "order-1");
      expect(back).toMatchObject({ id: e.id, amount: 1_000n, userId: U(1), sub: "cashback_coins" });
      expect(await c.store.coinEventBySource("photo_review", "order-1")).toBeNull();
      expect((await c.store.coinEventsOf(U(1))).length).toBe(1);
      expect(await c.store.coinEventsOf(U(2))).toEqual([]);
    });

    it("debt follows debt_delta of clawbacks and earn rows, never below zero", async () => {
      const earn = coin(U(1), { sourceRef: "o1", amount: 500n });
      await c.store.appendCoinEvent(earn, []);
      const claw = coin(U(1), { kind: "clawback", amount: -300n, debtDelta: 120n, parentId: earn.id, sourceRef: "r1", expiresAtMs: null });
      await c.store.appendCoinEvent(claw, []);
      expect(await c.store.debtOf(U(1))).toBe(120n);
      const next = coin(U(1), { sourceRef: "o2", amount: 200n, debtDelta: -120n });
      await c.store.appendCoinEvent(next, []);
      expect(await c.store.debtOf(U(1))).toBe(0n);
      expect(await c.store.debtOf(U(2))).toBe(0n);
      const over = coin(U(1), { sourceRef: "o3", amount: 50n, debtDelta: -50n });
      await expect(c.store.appendCoinEvent(over, [])).rejects.toThrow();
    });

    it("pending settlements list posted coins without a journal; setJournalEntry settles once", async () => {
      const pending = coin(U(1), { sourceRef: "p1", journalEntryId: null });
      await c.store.appendCoinEvent(pending, []);
      await c.store.appendCoinEvent(coin(U(1), { sourceRef: "p0", journalEntryId: nid() }), []);
      const clawLike = coin(U(2), { kind: "clawback", amount: -5n, debtDelta: 5n, parentId: null, sourceRef: "pc", journalEntryId: null, expiresAtMs: null });
      await expect(c.store.appendCoinEvent(clawLike, [])).rejects.toThrow(); // clawback needs a parent
      expect((await c.store.pendingSettlements(null, 10)).map((e) => e.sourceRef)).toEqual(["p1"]);
      expect(await c.store.pendingSettlements(U(2), 10)).toEqual([]);
      const j = nid();
      await c.store.setJournalEntry(pending.id, j);
      await c.store.setJournalEntry(pending.id, nid());
      expect(await c.store.pendingSettlements(null, 10)).toEqual([]);
      expect((await c.store.coinEventBySource("purchase", "p1"))?.journalEntryId).toBe(j);
    });

    it("due lots: users with an earn past expiry and no expire row", async () => {
      const lot = coin(U(1), { sourceRef: "d1", expiresAtMs: T0 + DAY });
      await c.store.appendCoinEvent(lot, []);
      await c.store.appendCoinEvent(coin(U(2), { sourceRef: "d2", expiresAtMs: T0 + 5 * DAY }), []);
      expect(await c.store.usersWithDueLots(T0, 10)).toEqual([]);
      expect(await c.store.usersWithDueLots(T0 + 2 * DAY, 10)).toEqual([U(1)]);
      await c.store.appendCoinEvent(
        coin(U(1), { kind: "expire", amount: 0n, parentId: lot.id, sourceRef: `expire:${lot.id}`, expiresAtMs: null, journalEntryId: null }),
        [],
      );
      expect(await c.store.usersWithDueLots(T0 + 2 * DAY, 10)).toEqual([]);
    });

    it("spend events are idempotent on source_ref and windowed", async () => {
      const row = { id: nid(), userId: U(1), sourceRef: "order:o1", amount: 250_000n, occurredAtMs: T0 };
      expect(await c.store.addSpend(row)).toBe("inserted");
      expect(await c.store.addSpend({ ...row, id: nid() })).toBe("duplicate");
      await c.store.addSpend({ id: nid(), userId: U(1), sourceRef: "refund:r1", amount: -50_000n, occurredAtMs: T0 + DAY });
      const rows = await c.store.spendSince(U(1), T0 - 1);
      expect(rows.map((r) => r.amount)).toEqual([250_000n, -50_000n]);
      expect(await c.store.spendSince(U(1), T0 + 1)).toHaveLength(1);
      expect(await c.store.spendSince(U(2), 0)).toEqual([]);
    });

    it("tier status upserts and users are listed for evaluation", async () => {
      await c.store.addSpend({ id: nid(), userId: U(1), sourceRef: "order:t1", amount: 1n, occurredAtMs: T0 });
      expect(await c.store.usersForTierEvaluation(T0 + DAY, 10)).toEqual([U(1)]);
      const row = { userId: U(1), tier: "silver" as const, netSpend12m: 600_000n, evaluatedAtMs: T0, pendingTier: null, pendingEffectiveAtMs: null };
      await c.store.saveTier(row, [{ type: "tier.changed", userId: U(1), from: "bronze", to: "silver", change: "upgraded", effectiveAtMs: null }]);
      expect(await c.store.getTier(U(1))).toEqual(row);
      expect(await c.store.usersForTierEvaluation(T0, 10)).toEqual([]);
      const dropped = { ...row, pendingTier: "bronze" as const, pendingEffectiveAtMs: T0 + 30 * DAY };
      await c.store.saveTier(dropped, []);
      expect(await c.store.getTier(U(1))).toEqual(dropped);
      expect(await c.store.getTier(U(3))).toBeNull();
    });

    it("challenges: unique code, active window filter, deactivate", async () => {
      const ch: ChallengeRow = {
        id: nid(),
        code: "three-orders",
        rule: { kind: "orders_closed", count: 3 },
        windowStartMs: T0,
        windowEndMs: T0 + 30 * DAY,
        rewardCoins: 5_000n,
        active: true,
        createdAtMs: T0,
      };
      expect(await c.store.insertChallenge(ch)).toBe("inserted");
      expect(await c.store.insertChallenge({ ...ch, id: nid() })).toBe("duplicate_code");
      expect((await c.store.listChallenges({ activeAtMs: T0 + DAY })).map((x) => x.code)).toEqual(["three-orders"]);
      expect(await c.store.listChallenges({ activeAtMs: T0 + 40 * DAY })).toEqual([]);
      expect(await c.store.listChallenges({ activeAtMs: T0 - 1 })).toEqual([]);
      expect(await c.store.deactivateChallenge(ch.id)).toBe(true);
      expect(await c.store.deactivateChallenge(ch.id)).toBe(false);
      expect(await c.store.listChallenges({ activeAtMs: T0 + DAY })).toEqual([]);
      expect(await c.store.listChallenges({ activeAtMs: null })).toHaveLength(1);
    });

    it("odds versions are numbered, immutable, and effective only after their date", async () => {
      expect(await c.store.latestOddsVersionNumber("daily_spin")).toBe(0);
      const v1 = odds(1, { effectiveFromMs: T0 });
      expect(await c.store.publishOdds(v1, [{ type: "game.odds_published", game: "daily_spin", oddsVersionId: v1.id, version: 1, effectiveFromMs: T0, actorId: U(1) }])).toBe("ok");
      expect(await c.store.publishOdds({ ...v1, id: nid() }, [])).toBe("stale");
      const v2 = odds(2, { effectiveFromMs: T0 + 10 * DAY });
      expect(await c.store.publishOdds(v2, [])).toBe("ok");
      expect((await c.store.effectiveOdds("daily_spin", T0 + DAY))?.version).toBe(1);
      expect((await c.store.effectiveOdds("daily_spin", T0 + 11 * DAY))?.version).toBe(2);
      expect(await c.store.effectiveOdds("daily_spin", T0 - 1)).toBeNull();
      expect((await c.store.upcomingOdds("daily_spin", T0 + DAY)).map((v) => v.version)).toEqual([2]);
      const back = await c.store.oddsById(v1.id);
      expect(back?.table.outcomes.map((o) => [o.id, o.ppm, o.coins])).toEqual([
        ["nothing", 800_000, null],
        ["c100", 195_000, 100n],
        ["v1", 5_000, null],
      ]);
      expect(await c.store.effectiveOdds("scratch_card", T0 + 99 * DAY)).toBeNull();
    });

    it("plays: intent is idempotent, the daily seq is the cap, a scratch source plays once, settle writes once", async () => {
      const o = odds(1, { effectiveFromMs: T0 });
      await c.store.publishOdds(o, []);
      const p1 = play(U(1), o.id, { intentId: "intent-aaaaaaaa", seq: 1 });
      expect(await c.store.insertPlay(p1)).toBe("inserted");
      expect(await c.store.insertPlay({ ...p1, id: nid(), seq: 2 })).toBe("duplicate");
      expect(await c.store.insertPlay(play(U(1), o.id, { intentId: "intent-bbbbbbbb", seq: 1 }))).toBe("cap");
      expect(await c.store.playsOnDay(U(1), "daily_spin", "2027-01-15")).toBe(1);
      expect(await c.store.playsOnDay(U(1), "daily_spin", "2027-01-16")).toBe(0);
      expect((await c.store.playByIntent(U(1), "daily_spin", "intent-aaaaaaaa"))?.id).toBe(p1.id);
      expect(await c.store.playByIntent(U(2), "daily_spin", "intent-aaaaaaaa")).toBeNull();

      const ev = [{ type: "game.played" as const, userId: U(1), game: "daily_spin" as const, playId: p1.id, outcomeKind: "nothing" as const, coins: null, oddsVersionId: o.id }];
      await c.store.settlePlay(p1.id, null, T0 + 5, ev);
      await c.store.settlePlay(p1.id, "ignored", T0 + 9, ev);
      expect((await c.store.playByIntent(U(1), "daily_spin", "intent-aaaaaaaa"))?.settledAtMs).toBe(T0 + 5);
      expect((await c.eventTypes()).filter((t) => t === "game.played")).toHaveLength(1);
      expect((await c.store.lastPlay(U(1), "daily_spin"))?.id).toBe(p1.id);
      expect(await c.store.lastPlay(U(2), "daily_spin")).toBeNull();
    });

    it("scratch entitlements: one per delivered order, consumed by a play with that source", async () => {
      const o = odds(1, { game: "scratch_card", effectiveFromMs: T0 });
      await c.store.publishOdds(o, []);
      expect(await c.store.addEntitlement(U(1), "order:o1", T0)).toBe("inserted");
      expect(await c.store.addEntitlement(U(1), "order:o1", T0)).toBe("duplicate");
      expect(await c.store.unusedEntitlement(U(1), "scratch_card")).toBe("order:o1");
      expect(await c.store.unusedEntitlement(U(2), "scratch_card")).toBeNull();
      const p = play(U(1), o.id, { game: "scratch_card", sourceRef: "order:o1" });
      expect(await c.store.insertPlay(p)).toBe("inserted");
      expect(await c.store.unusedEntitlement(U(1), "scratch_card")).toBeNull();
      expect(await c.store.insertPlay(play(U(1), o.id, { game: "scratch_card", sourceRef: "order:o1", seq: 2 }))).toBe("duplicate");
    });
  });
}
