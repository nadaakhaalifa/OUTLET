import type { JournalEntry } from "@outlet/domain";
import type { CoinSub, EarnReason, Game, OddsTable, OutcomeKind, RewardsConfig, Tier } from "./bridge";

export interface IdPort {
  uuidV7(): string;
}
export interface Clock {
  nowMs(): number;
}

// ---- ports owned by other modules (fakes live in adapters/fakes.ts) ---------------------------

/**
 * Ledger module. Posts a balanced journal entry. Idempotent on `entry.idempotencyKey`: a replay
 * returns the original entry id with `duplicate: true` and posts nothing. May throw when the
 * ledger is unavailable; rewards then records the award as pending settlement.
 */
export interface LedgerPort {
  post(entry: JournalEntry): Promise<{ readonly entryId: string; readonly duplicate: boolean }>;
}

/** Store-credit module: the live cashback_coins sub-balance and the expiry write-off path. */
export interface StoreCreditPort {
  /** Spendable cashback_coins balance, in piastres. */
  cashbackBalance(userId: string): Promise<bigint>;
  /** Writes off expired coin credit through the store-credit history. Idempotent on the key. */
  expireCoins(input: { readonly userId: string; readonly piastres: bigint; readonly idempotencyKey: string }): Promise<{ readonly entryId: string }>;
}

/** Subscriptions module: entitlement `commerce_benefits.coins_plus_5pct`. */
export interface EntitlementPort {
  hasPlusCoinsBonus(userId: string, atMs: number): Promise<boolean>;
}

/** Promotions module: issues a single use voucher from a template. Idempotent on the key. */
export interface VoucherPort {
  grant(input: { readonly userId: string; readonly templateId: string; readonly idempotencyKey: string }): Promise<{ readonly voucherId: string }>;
}

/** Feature flags (packages/feature-flags). Both fail closed: provider trouble means OFF. */
export interface RewardsSwitchPort {
  /** `kill.games`. Default OFF until VR-09. */
  gamesEnabled(): Promise<boolean>;
  /** Coins earning. Default OFF in production until VR-P2-04 (rates live, tax and expiry verified). */
  coinsEnabled(): Promise<boolean>;
}

/** App Attest / Play Integrity verification of the `x-app-attest` token for this user. */
export interface AttestationPort {
  verify(input: { readonly userId: string; readonly token: string | null }): Promise<boolean>;
}

/** Admin module dual approval. True only for an approved request of this kind by two other admins. */
export interface ConfigApprovalPort {
  isApproved(input: { readonly approvalId: string; readonly kind: "rewards_config" | "game_odds"; readonly requesterId: string }): Promise<boolean>;
}

export interface HashPort {
  sha256Hex(input: string): string;
  /** HMAC-SHA256 with a hex key, returned as bytes. */
  hmacSha256(keyHex: string, message: string): Uint8Array;
}
export interface RandomPort {
  /** CSPRNG bytes as lowercase hex. */
  secureHex(bytes: number): string;
}

// ---- persistence ------------------------------------------------------------------------------

export const COIN_EVENT_KINDS = [
  "purchase",
  "photo_review",
  "profile_completion",
  "fit_feedback",
  "referral",
  "streak",
  "challenge",
  "game",
  "clawback",
  "expire",
] as const;
export type CoinEventKind = (typeof COIN_EVENT_KINDS)[number];
export type CoinSubKind = CoinSub["kind"];

export interface CoinEventRow {
  readonly id: string;
  readonly userId: string;
  readonly kind: CoinEventKind;
  readonly sub: CoinSubKind;
  /** Signed coins: earn > 0, clawback < 0, expire <= 0 (0 closes a fully spent lot). */
  readonly amount: bigint;
  /**
   * Earn: minus the coins used to pay down debt (<= 0). Clawback: plus the coins that became debt
   * because they were already spent (>= 0). Expire: 0.
   */
  readonly debtDelta: bigint;
  /** Clawback and expire point at the earn row they reduce. */
  readonly parentId: string | null;
  /** Idempotency partner of `kind`: order id, review id, refund id, play id... */
  readonly sourceRef: string;
  /** Ledger entry. null on an earn row means nothing to post (all netted) or pending settlement. */
  readonly journalEntryId: string | null;
  readonly expiresAtMs: number | null;
  readonly piastresPerCoin: bigint;
  readonly configVersion: number;
  readonly createdAtMs: number;
}

export interface SpendRow {
  readonly id: string;
  readonly userId: string;
  /** Idempotency: `order:{id}` or `refund:{id}`. */
  readonly sourceRef: string;
  /** Signed piastres of net merchandise. */
  readonly amount: bigint;
  readonly occurredAtMs: number;
}

export interface TierRow {
  readonly userId: string;
  readonly tier: Tier;
  readonly netSpend12m: bigint;
  readonly evaluatedAtMs: number;
  readonly pendingTier: Tier | null;
  readonly pendingEffectiveAtMs: number | null;
}

export interface ChallengeRule {
  /** Closed, kept orders inside the window. */
  readonly kind: "orders_closed";
  readonly count: number;
}
export interface ChallengeRow {
  readonly id: string;
  readonly code: string;
  readonly rule: ChallengeRule;
  readonly windowStartMs: number;
  readonly windowEndMs: number;
  readonly rewardCoins: bigint;
  readonly active: boolean;
  readonly createdAtMs: number;
}

export interface OddsVersion {
  readonly id: string;
  readonly game: Game;
  readonly version: number;
  readonly table: OddsTable;
  readonly publishedAtMs: number;
  readonly effectiveFromMs: number;
  readonly approvalId: string;
}

export interface PlayRow {
  readonly id: string;
  readonly userId: string;
  readonly game: Game;
  readonly intentId: string;
  readonly dayKey: string;
  readonly seq: number;
  readonly oddsVersionId: string;
  readonly rollPpm: number;
  readonly outcomeId: string;
  readonly outcomeKind: OutcomeKind;
  readonly coins: bigint | null;
  readonly voucherTemplateId: string | null;
  readonly serverSeed: string;
  readonly serverSeedHash: string;
  /** Scratch card: the delivered order that earned the card. */
  readonly sourceRef: string | null;
  readonly rewardRef: string | null;
  readonly settledAtMs: number | null;
  readonly createdAtMs: number;
}

export type RewardEvent =
  | { readonly type: "coins.earned"; readonly userId: string; readonly kind: EarnReason; readonly coins: bigint; readonly sourceRef: string; readonly expiresAtMs: number }
  | { readonly type: "coins.clawed_back"; readonly userId: string; readonly coins: bigint; readonly debtAdded: bigint; readonly sourceRef: string }
  | { readonly type: "coins.expired"; readonly userId: string; readonly coins: bigint; readonly lotId: string }
  | { readonly type: "tier.changed"; readonly userId: string; readonly from: Tier; readonly to: Tier; readonly change: "upgraded" | "downgrade_announced" | "downgraded"; readonly effectiveAtMs: number | null }
  | { readonly type: "game.played"; readonly userId: string; readonly game: Game; readonly playId: string; readonly outcomeKind: OutcomeKind; readonly coins: bigint | null; readonly oddsVersionId: string }
  | { readonly type: "rewards.config_changed"; readonly version: number; readonly actorId: string; readonly approvalId: string }
  | { readonly type: "game.odds_published"; readonly game: Game; readonly oddsVersionId: string; readonly version: number; readonly effectiveFromMs: number; readonly actorId: string };

export interface ClawbackContext {
  readonly earn: CoinEventRow;
  readonly userEvents: readonly CoinEventRow[];
  /** Coins of this user's clawbacks that are reserved but whose ledger entry is not posted yet. */
  readonly pendingReversible: bigint;
}

export interface RewardsStore {
  // configuration
  latestConfig(): Promise<RewardsConfig | null>;
  /** Appends version `cfg.version`; "stale" when it is not the next version. */
  putConfig(cfg: RewardsConfig, meta: { readonly approvalId: string; readonly actorId: string; readonly atMs: number }, events: readonly RewardEvent[]): Promise<"ok" | "stale">;

  // coins
  /** One insert, the debt change and the events in one transaction. Unique on (kind, sourceRef). */
  appendCoinEvent(row: CoinEventRow, events: readonly RewardEvent[]): Promise<"inserted" | "duplicate">;
  /**
   * B-6: decides and appends a clawback under a row lock on the order's earn row (FOR UPDATE in
   * SQL), so concurrent refunds of one order serialise and each sees the other's row. `decide` is
   * pure and synchronous; it receives the user's events and the coins already reserved by
   * clawbacks whose ledger entry is not posted yet. Duplicate on (clawback, refundRef).
   */
  reserveClawback(input: {
    readonly userId: string;
    readonly orderRef: string;
    readonly refundRef: string;
    readonly decide: (ctx: ClawbackContext) => { readonly row: CoinEventRow; readonly events: readonly RewardEvent[] } | null;
  }): Promise<
    | { readonly kind: "reserved"; readonly row: CoinEventRow }
    | { readonly kind: "duplicate"; readonly row: CoinEventRow }
    | { readonly kind: "no_earn" }
    | { readonly kind: "none" }
  >;
  coinEventBySource(kind: CoinEventKind, sourceRef: string): Promise<CoinEventRow | null>;
  coinEventsOf(userId: string): Promise<readonly CoinEventRow[]>;
  debtOf(userId: string): Promise<bigint>;
  /** Earn rows with a ledger entry owed (posted > 0, no journal) older than `beforeMs`. */
  pendingSettlements(userId: string | null, limit: number): Promise<readonly CoinEventRow[]>;
  setJournalEntry(eventId: string, journalEntryId: string): Promise<void>;
  /** Users with an earn row past expiry that has no expire row yet. FOR UPDATE SKIP LOCKED in SQL. */
  usersWithDueLots(nowMs: number, limit: number): Promise<readonly string[]>;

  // spend and tiers
  addSpend(row: SpendRow): Promise<"inserted" | "duplicate">;
  spendSince(userId: string, sinceMs: number): Promise<readonly SpendRow[]>;
  getTier(userId: string): Promise<TierRow | null>;
  saveTier(row: TierRow, events: readonly RewardEvent[]): Promise<void>;
  usersForTierEvaluation(evaluatedBeforeMs: number, limit: number): Promise<readonly string[]>;

  // challenges
  insertChallenge(c: ChallengeRow): Promise<"inserted" | "duplicate_code">;
  listChallenges(filter: { readonly activeAtMs: number | null }): Promise<readonly ChallengeRow[]>;
  deactivateChallenge(id: string): Promise<boolean>;

  // games
  publishOdds(v: OddsVersion, events: readonly RewardEvent[]): Promise<"ok" | "stale">;
  latestOddsVersionNumber(game: Game): Promise<number>;
  /** Highest version already effective at `nowMs`. */
  effectiveOdds(game: Game, nowMs: number): Promise<OddsVersion | null>;
  upcomingOdds(game: Game, nowMs: number): Promise<readonly OddsVersion[]>;
  oddsById(id: string): Promise<OddsVersion | null>;
  playByIntent(userId: string, game: Game, intentId: string): Promise<PlayRow | null>;
  playsOnDay(userId: string, game: Game, dayKey: string): Promise<number>;
  /** "cap" when (user, game, day, seq) is taken by a concurrent play; "duplicate" on intent or source reuse. */
  insertPlay(p: PlayRow): Promise<"inserted" | "duplicate" | "cap">;
  settlePlay(playId: string, rewardRef: string | null, settledAtMs: number, events: readonly RewardEvent[]): Promise<void>;
  lastPlay(userId: string, game: Game): Promise<PlayRow | null>;
  addEntitlement(userId: string, sourceRef: string, atMs: number): Promise<"inserted" | "duplicate">;
  unusedEntitlement(userId: string, game: Game): Promise<string | null>;
}
