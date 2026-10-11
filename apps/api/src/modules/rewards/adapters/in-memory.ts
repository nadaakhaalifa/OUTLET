import type { Game, RewardsConfig } from "../domain/bridge";
import type {
  ChallengeRow,
  CoinEventKind,
  CoinEventRow,
  OddsVersion,
  PlayRow,
  RewardEvent,
  RewardsStore,
  SpendRow,
  TierRow,
} from "../domain/ports";

/** Mirrors the CHECK constraints of coin_events so both adapters refuse the same rows. */
function assertShape(r: CoinEventRow): void {
  const ok =
    r.kind === "clawback"
      ? r.amount < 0n && r.debtDelta >= 0n && r.debtDelta <= -r.amount && r.parentId !== null
      : r.kind === "expire"
        ? r.amount <= 0n && r.debtDelta === 0n && r.parentId !== null
        : r.amount > 0n && r.debtDelta <= 0n && -r.debtDelta <= r.amount && r.expiresAtMs !== null && r.parentId === null;
  if (!ok) throw new Error(`coin event violates its shape (${r.kind})`);
}

/** Reference implementation of RewardsStore. The Kysely adapter must pass the same contract suite. */
export class InMemoryRewardsStore implements RewardsStore {
  readonly events: RewardEvent[] = [];
  private readonly configs: RewardsConfig[] = [];
  private readonly coinEvents: CoinEventRow[] = [];
  private readonly debts = new Map<string, bigint>();
  private readonly spend = new Map<string, SpendRow>();
  private readonly tiers = new Map<string, TierRow>();
  private readonly challenges: ChallengeRow[] = [];
  private readonly odds: OddsVersion[] = [];
  private readonly plays: PlayRow[] = [];
  private readonly entitlements: { userId: string; sourceRef: string; atMs: number }[] = [];

  private emit(e: readonly RewardEvent[]): void {
    this.events.push(...e);
  }

  async latestConfig(): Promise<RewardsConfig | null> {
    return this.configs[this.configs.length - 1] ?? null;
  }
  async putConfig(cfg: RewardsConfig, _m: { approvalId: string; actorId: string; atMs: number }, events: readonly RewardEvent[]): Promise<"ok" | "stale"> {
    const cur = this.configs[this.configs.length - 1]?.version ?? 1;
    if (cfg.version !== cur + 1) return "stale";
    this.configs.push(cfg);
    this.emit(events);
    return "ok";
  }

  async appendCoinEvent(row: CoinEventRow, events: readonly RewardEvent[]): Promise<"inserted" | "duplicate"> {
    assertShape(row);
    if (this.coinEvents.some((e) => e.kind === row.kind && e.sourceRef === row.sourceRef)) return "duplicate";
    const debt = this.debts.get(row.userId) ?? 0n;
    const next = debt + row.debtDelta;
    if (next < 0n) throw new Error("debt would become negative");
    this.coinEvents.push(row);
    this.debts.set(row.userId, next);
    this.emit(events);
    return "inserted";
  }
  async reserveClawback(input: Parameters<RewardsStore["reserveClawback"]>[0]): ReturnType<RewardsStore["reserveClawback"]> {
    // Synchronous between the read and the append, so concurrent callers serialise on the event loop.
    const earn = this.coinEvents.find((e) => e.kind === "purchase" && e.sourceRef === input.orderRef);
    if (earn === undefined || earn.userId !== input.userId) return { kind: "no_earn" };
    const dup = this.coinEvents.find((e) => e.kind === "clawback" && e.sourceRef === input.refundRef);
    if (dup !== undefined) return { kind: "duplicate", row: dup };
    const userEvents = this.coinEvents.filter((e) => e.userId === input.userId);
    const pendingReversible = userEvents
      .filter((e) => e.kind === "clawback" && e.journalEntryId === null)
      .reduce((a, e) => a + (-e.amount - e.debtDelta), 0n);
    const decision = input.decide({ earn, userEvents, pendingReversible });
    if (decision === null) return { kind: "none" };
    assertShape(decision.row);
    const next = (this.debts.get(input.userId) ?? 0n) + decision.row.debtDelta;
    if (next < 0n) throw new Error("debt would become negative");
    this.coinEvents.push(decision.row);
    this.debts.set(input.userId, next);
    this.emit(decision.events);
    return { kind: "reserved", row: decision.row };
  }
  async coinEventBySource(kind: CoinEventKind, sourceRef: string): Promise<CoinEventRow | null> {
    return this.coinEvents.find((e) => e.kind === kind && e.sourceRef === sourceRef) ?? null;
  }
  async coinEventsOf(userId: string): Promise<readonly CoinEventRow[]> {
    return this.coinEvents.filter((e) => e.userId === userId);
  }
  async debtOf(userId: string): Promise<bigint> {
    return this.debts.get(userId) ?? 0n;
  }
  async pendingSettlements(userId: string | null, limit: number): Promise<readonly CoinEventRow[]> {
    return this.coinEvents
      .filter(
        (e) =>
          (userId === null || e.userId === userId) &&
          e.parentId === null &&
          e.kind !== "clawback" &&
          e.kind !== "expire" &&
          e.amount + e.debtDelta > 0n &&
          e.journalEntryId === null,
      )
      .slice(0, limit);
  }
  async setJournalEntry(eventId: string, journalEntryId: string): Promise<void> {
    const i = this.coinEvents.findIndex((e) => e.id === eventId && e.journalEntryId === null);
    const cur = this.coinEvents[i];
    if (i >= 0 && cur !== undefined) this.coinEvents[i] = { ...cur, journalEntryId };
  }
  async usersWithDueLots(nowMs: number, limit: number): Promise<readonly string[]> {
    const closed = new Set(this.coinEvents.filter((e) => e.kind === "expire").map((e) => e.parentId));
    const users = new Set<string>();
    for (const e of this.coinEvents) {
      if (e.parentId === null && e.kind !== "clawback" && e.kind !== "expire" && e.expiresAtMs !== null && e.expiresAtMs <= nowMs && !closed.has(e.id)) {
        users.add(e.userId);
      }
    }
    return [...users].sort().slice(0, limit);
  }

  async addSpend(row: SpendRow): Promise<"inserted" | "duplicate"> {
    if (this.spend.has(row.sourceRef)) return "duplicate";
    this.spend.set(row.sourceRef, row);
    return "inserted";
  }
  async spendSince(userId: string, sinceMs: number): Promise<readonly SpendRow[]> {
    return [...this.spend.values()].filter((s) => s.userId === userId && s.occurredAtMs > sinceMs).sort((a, b) => a.occurredAtMs - b.occurredAtMs);
  }
  async getTier(userId: string): Promise<TierRow | null> {
    return this.tiers.get(userId) ?? null;
  }
  async saveTier(row: TierRow, events: readonly RewardEvent[]): Promise<void> {
    this.tiers.set(row.userId, row);
    this.emit(events);
  }
  async usersForTierEvaluation(before: number, limit: number): Promise<readonly string[]> {
    const users = new Set<string>();
    for (const s of this.spend.values()) users.add(s.userId);
    return [...users]
      .filter((u) => (this.tiers.get(u)?.evaluatedAtMs ?? -1) < before)
      .sort()
      .slice(0, limit);
  }

  async insertChallenge(c: ChallengeRow): Promise<"inserted" | "duplicate_code"> {
    if (this.challenges.some((x) => x.code === c.code)) return "duplicate_code";
    this.challenges.push(c);
    return "inserted";
  }
  async listChallenges(f: { activeAtMs: number | null }): Promise<readonly ChallengeRow[]> {
    return this.challenges.filter((c) => f.activeAtMs === null || (c.active && c.windowStartMs <= f.activeAtMs && f.activeAtMs < c.windowEndMs));
  }
  async deactivateChallenge(id: string): Promise<boolean> {
    const i = this.challenges.findIndex((c) => c.id === id && c.active);
    const cur = this.challenges[i];
    if (i < 0 || cur === undefined) return false;
    this.challenges[i] = { ...cur, active: false };
    return true;
  }

  async publishOdds(v: OddsVersion, events: readonly RewardEvent[]): Promise<"ok" | "stale"> {
    const last = Math.max(0, ...this.odds.filter((o) => o.game === v.game).map((o) => o.version));
    if (v.version !== last + 1) return "stale";
    this.odds.push(v);
    this.emit(events);
    return "ok";
  }
  async latestOddsVersionNumber(game: Game): Promise<number> {
    return Math.max(0, ...this.odds.filter((o) => o.game === game).map((o) => o.version));
  }
  async effectiveOdds(game: Game, nowMs: number): Promise<OddsVersion | null> {
    const c = this.odds.filter((o) => o.game === game && o.effectiveFromMs <= nowMs).sort((a, b) => b.version - a.version);
    return c[0] ?? null;
  }
  async upcomingOdds(game: Game, nowMs: number): Promise<readonly OddsVersion[]> {
    return this.odds.filter((o) => o.game === game && o.effectiveFromMs > nowMs).sort((a, b) => a.version - b.version);
  }
  async oddsById(id: string): Promise<OddsVersion | null> {
    return this.odds.find((o) => o.id === id) ?? null;
  }
  async playByIntent(userId: string, game: Game, intentId: string): Promise<PlayRow | null> {
    return this.plays.find((p) => p.userId === userId && p.game === game && p.intentId === intentId) ?? null;
  }
  async playsOnDay(userId: string, game: Game, dayKey: string): Promise<number> {
    return this.plays.filter((p) => p.userId === userId && p.game === game && p.dayKey === dayKey).length;
  }
  async insertPlay(p: PlayRow): Promise<"inserted" | "duplicate" | "cap"> {
    if (this.plays.some((x) => x.userId === p.userId && x.game === p.game && x.intentId === p.intentId)) return "duplicate";
    if (p.sourceRef !== null && this.plays.some((x) => x.game === p.game && x.sourceRef === p.sourceRef)) return "duplicate";
    if (this.plays.some((x) => x.userId === p.userId && x.game === p.game && x.dayKey === p.dayKey && x.seq === p.seq)) return "cap";
    this.plays.push(p);
    return "inserted";
  }
  async settlePlay(playId: string, rewardRef: string | null, settledAtMs: number, events: readonly RewardEvent[]): Promise<void> {
    const i = this.plays.findIndex((p) => p.id === playId && p.settledAtMs === null);
    const cur = this.plays[i];
    if (i < 0 || cur === undefined) return;
    this.plays[i] = { ...cur, rewardRef, settledAtMs };
    this.emit(events);
  }
  async lastPlay(userId: string, game: Game): Promise<PlayRow | null> {
    return [...this.plays].filter((p) => p.userId === userId && p.game === game).sort((a, b) => b.createdAtMs - a.createdAtMs)[0] ?? null;
  }
  async addEntitlement(userId: string, sourceRef: string, atMs: number): Promise<"inserted" | "duplicate"> {
    if (this.entitlements.some((e) => e.sourceRef === sourceRef)) return "duplicate";
    this.entitlements.push({ userId, sourceRef, atMs });
    return "inserted";
  }
  async unusedEntitlement(userId: string, game: Game): Promise<string | null> {
    const used = new Set(this.plays.filter((p) => p.game === game && p.sourceRef !== null).map((p) => p.sourceRef));
    return this.entitlements.find((e) => e.userId === userId && !used.has(e.sourceRef))?.sourceRef ?? null;
  }
}
