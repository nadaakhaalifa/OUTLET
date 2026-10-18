import { END_EXPIRED_CAMPAIGNS, POST_CLICK_SPEND } from "../modules/ads";
import { RUN_AUTO_BUY_SWEEP } from "../modules/auto-buy";
import { AWB_WORKER } from "../modules/fulfillment";
import { EXPIRE_GIFT_CARDS, CLOSE_DUE_POTS, RESUME_PENDING_REDEMPTIONS } from "../modules/gift-cards";
import { PURGE_EXPIRED_EVENTS, REBUILD_FEATURES_BATCH, SWEEP_CLEAR_REQUESTS } from "../modules/history";
import { SWEEP_HUB_GROUPS } from "../modules/hub-consolidation";
import { INVENTORY_REPLENISH_POOLS, INVENTORY_SWEEP_EXPIRED } from "../modules/inventory";
import { ADVANCE_DROPS } from "../modules/drops";
import { CreatorTokens } from "../modules/creators";
import { INTEGRITY_RECORDER } from "../modules/ledger";
import { PROCESS_DUE_NOTIFICATIONS } from "../modules/notifications";
import { ORDER_COMMANDS } from "../modules/orders";
import { PROCESS_CALENDAR_REMINDERS } from "../modules/outfit-calendar";
import { PAYOUT_COMMANDS } from "../modules/payouts";
import { EXPIRE_EXPORTS, PROCESS_DELETIONS, PROCESS_EXPORT } from "../modules/privacy";
import { SCHEDULE_RECONCILIATION } from "../modules/reconciliation";
import { SWEEP_REFUNDS } from "../modules/refunds";
import { PROCESS_MODERATION_BACKLOG, SWEEP_QA_SLA } from "../modules/reviews";
import { SWEEP_REWARDS } from "../modules/rewards";
import { SELLER_ANALYTICS_CONSUMER, SELLER_ANALYTICS_PARTITIONS, SELLER_ANALYTICS_RECONCILER } from "../modules/seller-analytics";
import { CREDIT_HOLDS, SWEEP_EXPIRED_CREDIT } from "../modules/store-credit";
import { PLUS_FAMILY_SWEEP, PLUS_RECOGNIZE_REVENUE, PLUS_RENEWAL_SWEEP, PLUS_STUDENT_SWEEP } from "../modules/subscriptions";
import { POLL_SUBMISSION_STATUSES, PROCESS_SUBMISSION_QUEUE, RUN_DAILY_RECONCILIATION } from "../modules/tax-eta";
import { FORECAST_BATCH } from "../modules/forecasting";
import { ODOO_POLL_BATCH } from "../modules/channel-odoo";
import { SWEEP_VISUAL_SEARCH } from "../modules/visual-search";
import { ADMIT_FROM_QUEUE } from "../modules/waiting-room";
import { cairoParts } from "./cairo";
import { RETENTION_JOB_SPECS } from "./retention-jobs";
import type { JobSpec } from "./job-spec";
import type { Cadence, Job, JobResult } from "./scheduler";

export type { JobSpec } from "./job-spec";

const SEC = 1_000;
const MIN = 60_000;
const HOUR = 3_600_000;


const every = (everyMs: number): Cadence => ({ kind: "interval", everyMs });
const cairo = (hour: number, minute: number, weekday?: number): Cadence =>
  weekday === undefined ? { kind: "cairo", hour, minute } : { kind: "cairo", hour, minute, weekday };

/** Cairo calendar day before `nowMs`, as YYYY-MM-DD. */
export function previousCairoDay(nowMs: number): string {
  const p = cairoParts(nowMs - 24 * HOUR);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

export const JOB_SPECS: readonly JobSpec[] = [
  ...RETENTION_JOB_SPECS,
  { name: "inventory.sweep-reservations", token: INVENTORY_SWEEP_EXPIRED, method: "execute", ownerModule: "inventory", cadence: every(30 * SEC), timeoutMs: 25 * SEC, criticality: "critical", idempotency: "FOR UPDATE SKIP LOCKED batches; expired rows return to available once" },
  { name: "inventory.replenish-pools", token: INVENTORY_REPLENISH_POOLS, method: "execute", ownerModule: "inventory", cadence: every(MIN), timeoutMs: 50 * SEC, criticality: "important", idempotency: "tops pools up to the cap under an advisory lock" },
  { name: "orders.close-delivered", token: ORDER_COMMANDS, method: "closeDelivered", args: () => [100], ownerModule: "orders", cadence: every(10 * MIN), timeoutMs: 8 * MIN, criticality: "important", idempotency: "state machine CAS per order, command key close:<order id>; order_line.closed rows are written in the transition transaction" },
  { name: "orders.expire-unaccepted", token: ORDER_COMMANDS, method: "expireUnaccepted", args: () => [100], ownerModule: "orders", cadence: every(MIN), timeoutMs: 50 * SEC, criticality: "critical", idempotency: "state machine CAS per order plus refund intent keys" },
  { name: "store-credit.sweep-holds", token: CREDIT_HOLDS, method: "sweepExpired", args: () => [100], ownerModule: "store-credit", cadence: every(MIN), timeoutMs: 50 * SEC, criticality: "critical", idempotency: "hold state CAS; release entry keyed by hold id" },
  { name: "store-credit.expire-lots", token: SWEEP_EXPIRED_CREDIT, method: "execute", args: () => [200], ownerModule: "store-credit", cadence: every(HOUR), timeoutMs: 5 * MIN, criticality: "important", idempotency: "ledger entry idempotency key per lot expiry" },
  { name: "ledger.integrity.nightly", token: INTEGRITY_RECORDER, method: "run", args: () => ["nightly"], ownerModule: "ledger", cadence: cairo(2, 30), timeoutMs: 30 * MIN, criticality: "critical", idempotency: "check is read-only (REPEATABLE READ snapshot); the recorder appends one started row and one outcome row per attempt; the completed row, its drift sample and its hash-chained audit row commit in ONE transaction (ADR-0046); a replay appends another attempt, never edits one" },
  { name: "ledger.integrity.intraday", token: INTEGRITY_RECORDER, method: "run", args: () => ["intraday"], ownerModule: "ledger", cadence: every(30 * MIN), timeoutMs: 15 * MIN, criticality: "critical", eventModeOnly: true, idempotency: "same recorder as nightly; append-only attempt rows" },
  { name: "reconciliation.tick", token: SCHEDULE_RECONCILIATION, method: "tick", ownerModule: "reconciliation", cadence: every(5 * MIN), timeoutMs: 30 * MIN, criticality: "critical", idempotency: "reconciliationDue consults lastNightlyKey (Cairo day) and lastIntradayAt; findings dedupe by key" },
  { name: "payouts.weekly-cycle", token: PAYOUT_COMMANDS, method: "schedule", ownerModule: "payouts", cadence: cairo(4, 0), timeoutMs: 10 * MIN, criticality: "critical", idempotency: "unique (store, cycle) while not CANCELLED; daily trigger so a missed day self-heals" },
  { name: "payouts.recover-orphans", token: PAYOUT_COMMANDS, method: "recoverOrphanEntries", ownerModule: "payouts", cadence: every(5 * MIN), timeoutMs: 4 * MIN, criticality: "critical", idempotency: "reversal or resume keyed by payout id" },
  { name: "payouts.advance-sent", token: PAYOUT_COMMANDS, method: "advanceSent", args: () => [100], ownerModule: "payouts", cadence: every(5 * MIN), timeoutMs: 4 * MIN, criticality: "critical", idempotency: "provider idempotent by payout id; state CAS" },
  { name: "refunds.sweep", token: SWEEP_REFUNDS, method: "execute", args: () => [50], ownerModule: "refunds", cadence: every(30 * SEC), timeoutMs: 25 * SEC, criticality: "critical", idempotency: "ProcessRefund is a state machine with provider idempotency keys" },
  { name: "tax-eta.process-queue", token: PROCESS_SUBMISSION_QUEUE, method: "execute", args: () => [50], ownerModule: "tax-eta", cadence: every(MIN), timeoutMs: 50 * SEC, criticality: "important", idempotency: "internal submission id; CAS to ACCEPTED/RETRY/DEAD_LETTER" },
  { name: "tax-eta.poll-statuses", token: POLL_SUBMISSION_STATUSES, method: "execute", args: () => [{ minAgeMs: MIN, limit: 50 }], ownerModule: "tax-eta", cadence: every(MIN), timeoutMs: 50 * SEC, criticality: "important", idempotency: "status read then CAS" },
  { name: "tax-eta.daily-reconciliation", token: RUN_DAILY_RECONCILIATION, method: "execute", args: (now) => [previousCairoDay(now)], ownerModule: "tax-eta", cadence: cairo(1, 30), timeoutMs: 15 * MIN, criticality: "important", idempotency: "report for a Cairo day is a pure function of stored documents" },
  { name: "subscriptions.renewal-sweep", token: PLUS_RENEWAL_SWEEP, method: "execute", args: () => [100], ownerModule: "subscriptions", cadence: every(5 * MIN), timeoutMs: 4 * MIN, criticality: "critical", idempotency: "renewal charge idempotency key = subscription + period; dunning attempt counter CAS" },
  { name: "subscriptions.recognize-revenue", token: PLUS_RECOGNIZE_REVENUE, method: "execute", args: () => [200], ownerModule: "subscriptions", cadence: cairo(2, 0), timeoutMs: 10 * MIN, criticality: "important", idempotency: "ledger entry key per invoice and day" },
  { name: "subscriptions.family-sweep", token: PLUS_FAMILY_SWEEP, method: "execute", args: () => [100], ownerModule: "subscriptions", cadence: every(15 * MIN), timeoutMs: 10 * MIN, criticality: "important", idempotency: "group row lock; member and group state machines; ending notice recorded once per group" },
  { name: "subscriptions.student-sweep", token: PLUS_STUDENT_SWEEP, method: "execute", args: () => [200], ownerModule: "subscriptions", cadence: every(HOUR), timeoutMs: 5 * MIN, criticality: "routine", idempotency: "verification version CAS; 30 day notice recorded once per verification" },
  { name: "gift-cards.resume-redemptions", token: RESUME_PENDING_REDEMPTIONS, method: "execute", args: () => [{ minAgeMs: MIN, limit: 100 }], ownerModule: "gift-cards", cadence: every(MIN), timeoutMs: 50 * SEC, criticality: "critical", idempotency: "redemption saga keyed by redemption id; completes or reverses once" },
  { name: "gift-cards.close-due-pots", token: CLOSE_DUE_POTS, method: "execute", args: () => [100], ownerModule: "gift-cards", cadence: every(5 * MIN), timeoutMs: 4 * MIN, criticality: "important", idempotency: "pot state CAS; unfunded refunds keyed by contribution" },
  { name: "gift-cards.expire", token: EXPIRE_GIFT_CARDS, method: "execute", args: () => [200], ownerModule: "gift-cards", cadence: every(HOUR), timeoutMs: 5 * MIN, criticality: "routine", idempotency: "card state CAS to EXPIRED" },
  { name: "rewards.expire-coins", token: SWEEP_REWARDS, method: "expiry", args: () => [200], ownerModule: "rewards", cadence: every(HOUR), timeoutMs: 5 * MIN, criticality: "routine", idempotency: "per-lot expiry entries keyed by lot id" },
  { name: "rewards.settle-pending", token: SWEEP_REWARDS, method: "settle", args: () => [200], ownerModule: "rewards", cadence: every(5 * MIN), timeoutMs: 4 * MIN, criticality: "important", idempotency: "pending coin rows move to settled once (CAS)" },
  { name: "privacy.process-exports", token: PROCESS_EXPORT, method: "runDue", args: () => [20], ownerModule: "privacy", cadence: every(MIN), timeoutMs: 50 * SEC, criticality: "important", idempotency: "request state machine; artifact key is the request id" },
  { name: "privacy.expire-exports", token: EXPIRE_EXPORTS, method: "run", args: () => [50], ownerModule: "privacy", cadence: every(HOUR), timeoutMs: 5 * MIN, criticality: "routine", idempotency: "object delete is idempotent; state CAS to EXPIRED" },
  { name: "privacy.process-deletions", token: PROCESS_DELETIONS, method: "runDue", args: () => [20], ownerModule: "privacy", cadence: every(10 * MIN), timeoutMs: 9 * MIN, criticality: "critical", idempotency: "request state machine; erasure executors are idempotent per user" },
  { name: "reviews.sweep-qa-sla", token: SWEEP_QA_SLA, method: "execute", args: () => [200], ownerModule: "reviews", cadence: every(15 * MIN), timeoutMs: 10 * MIN, criticality: "routine", idempotency: "question state CAS" },
  { name: "reviews.moderation-backlog", token: PROCESS_MODERATION_BACKLOG, method: "execute", args: () => [100, MIN], ownerModule: "reviews", cadence: every(MIN), timeoutMs: 50 * SEC, criticality: "important", idempotency: "moderation status CAS from PENDING" },
  { name: "drops.advance", token: ADVANCE_DROPS, method: "run", ownerModule: "drops", cadence: every(10 * SEC), timeoutMs: 9 * SEC, criticality: "critical", capability: "drops", idempotency: "drop state machine, event-per-state CAS" },
  { name: "waiting-room.admit", token: ADMIT_FROM_QUEUE, method: "runAll", ownerModule: "waiting-room", cadence: every(5 * SEC), timeoutMs: 4 * SEC, criticality: "critical", capability: "drops", idempotency: "admission tokens issued once per queue position" },
  { name: "notifications.process-due", token: PROCESS_DUE_NOTIFICATIONS, method: "execute", args: () => [100], ownerModule: "notifications", cadence: every(30 * SEC), timeoutMs: 25 * SEC, criticality: "important", idempotency: "request row CAS plus delivery log dedupe key" },
  { name: "history.sweep-clear-requests", token: SWEEP_CLEAR_REQUESTS, method: "execute", args: () => [200], ownerModule: "history", cadence: every(15 * MIN), timeoutMs: 10 * MIN, criticality: "important", idempotency: "request completes once; overdue requests reported (24h derived-feature SLA)" },
  { name: "history.rebuild-features", token: REBUILD_FEATURES_BATCH, method: "execute", args: () => [500], ownerModule: "history", cadence: every(HOUR), timeoutMs: 10 * MIN, criticality: "routine", idempotency: "feature rows are a pure function of events and consent" },
  { name: "history.purge-expired-events", token: PURGE_EXPIRED_EVENTS, method: "execute", args: () => [10_000], ownerModule: "history", cadence: cairo(4, 30), timeoutMs: 20 * MIN, criticality: "important", idempotency: "delete before cutoff (25 months)" },
  { name: "fulfillment.awb-worker", token: AWB_WORKER, method: "runDue", args: () => [25], ownerModule: "fulfillment", cadence: every(30 * SEC), timeoutMs: 25 * SEC, criticality: "important", idempotency: "AWB creation idempotent by shipment id" },
  { name: "ads.post-click-spend", token: POST_CLICK_SPEND, method: "execute", args: () => [200], ownerModule: "ads", cadence: every(5 * MIN), timeoutMs: 4 * MIN, criticality: "important", idempotency: "ledger posting keyed by click id" },
  { name: "ads.end-expired-campaigns", token: END_EXPIRED_CAMPAIGNS, method: "execute", args: () => [200], ownerModule: "ads", cadence: every(15 * MIN), timeoutMs: 10 * MIN, criticality: "routine", idempotency: "campaign state CAS to ENDED" },
  { name: "calendar.process-reminders", token: PROCESS_CALENDAR_REMINDERS, method: "execute", args: () => [100], ownerModule: "outfit-calendar", cadence: every(5 * MIN), timeoutMs: 4 * MIN, criticality: "routine", idempotency: "unique (event, due_at) row claimed with SKIP LOCKED and a lease; notification ref repeats (event, due_at)" },
  { name: "auto-buy.sweep", token: RUN_AUTO_BUY_SWEEP, method: "execute", args: () => [100], ownerModule: "auto-buy", cadence: every(MIN), timeoutMs: 50 * SEC, criticality: "critical", idempotency: "attempt row lock + state CAS; MIT charge idempotency key auto_buy:{mandate}:{price_event}; unresolved outcomes reconciled by key, never re-charged; kill.auto_buy.charge re-read after the claim" },
  { name: "hub.sweep-groups", token: SWEEP_HUB_GROUPS, method: "execute", args: () => [200], ownerModule: "hub-consolidation", cadence: every(5 * MIN), timeoutMs: 4 * MIN, criticality: "routine", idempotency: "group evaluation is a CAS on open legs" },
  { name: "forecasting.nightly-batch", token: FORECAST_BATCH, method: "execute", args: (now) => [previousCairoDay(now), 25], ownerModule: "forecasting", cadence: cairo(3, 15), timeoutMs: 20 * MIN, criticality: "routine", capability: "forecasting", idempotency: "unique (store, as-of Cairo day) completed run; forecast rows unique by (store, scope, key, horizon, as-of); a failed store is recorded and retried next tick" },
  { name: "channel-odoo.poll-batch", token: ODOO_POLL_BATCH, method: "execute", args: () => [20], ownerModule: "channel-odoo", cadence: every(5 * MIN), timeoutMs: 4 * MIN, criticality: "routine", idempotency: "only channels whose own poll interval is due are synced; price and stock writes carry idempotency keys per (channel, product, price, version); a rerun finds nothing due" },
  { name: "visual-search.sweep", token: SWEEP_VISUAL_SEARCH, method: "execute", args: () => [500], ownerModule: "visual-search", cadence: every(5 * MIN), timeoutMs: 4 * MIN, criticality: "important", idempotency: "object delete is idempotent and the row is marked deleted only after it succeeds; telemetry purge is a delete before a cutoff (48 hours)" },
  { name: "creators.sweep-commission-postings", token: CreatorTokens.POST_COMMISSION_INTENTS, method: "sweep", args: () => [200], ownerModule: "creators", cadence: every(MIN), timeoutMs: 50 * SEC, criticality: "important", idempotency: "claim-then-post repair: ledger entry keyed creator_commission:{commission}:{seq}; posted_at stamped once" },
  { name: "creators.release-held-commissions", token: CreatorTokens.RELEASE_HELD, method: "execute", args: () => [200], ownerModule: "creators", cadence: every(15 * MIN), timeoutMs: 10 * MIN, criticality: "routine", idempotency: "accrual sweep: held row locked, monthly counter taken by the same conditional upsert as accrual; null means still held" },
  { name: "creators.payouts-recover-orphans", token: CreatorTokens.CREATOR_PAYOUT_COMMANDS, method: "recoverOrphans", ownerModule: "creators", cadence: every(5 * MIN), timeoutMs: 4 * MIN, criticality: "important", idempotency: "re-post under the attempt key (replay is a no-op) and reversal under the reversal key; provider idempotent by the same key; no-op while the provider is unconfigured" },
  { name: "creators.maintain-click-partitions", token: CreatorTokens.MAINTAIN_CLICK_PARTITIONS, method: "execute", ownerModule: "creators", cadence: cairo(3, 50), timeoutMs: 10 * MIN, criticality: "routine", idempotency: "create-if-missing monthly partitions; drops partitions older than 13 months and deletes older rows; a rerun finds nothing left" },
  // Analytics rollups (dashboard foundations track 6, ADR-0045). Blocked together by the `analytics-consumers` capability (kill.analytics.consumers).
  // The 25 month purge of seller_analytics_facts is the retention job `retention.purge.analytics_events` (target seller_analytics.facts).
  { name: "analytics.consume-seller-events", token: SELLER_ANALYTICS_CONSUMER, method: "run", args: () => [200], ownerModule: "seller-analytics", cadence: every(MIN), timeoutMs: 50 * SEC, criticality: "routine", capability: "analytics-consumers", idempotency: "inbox row (consumer, message id) and the facts insert and the rollup upserts commit in ONE transaction; a duplicate message is rejected by the inbox before any increment; advisory lock per rollup key, keys sorted" },
  { name: "analytics.reconcile-rollups-hourly", token: SELLER_ANALYTICS_RECONCILER, method: "hourly", ownerModule: "seller-analytics", cadence: every(HOUR), timeoutMs: 10 * MIN, criticality: "routine", capability: "analytics-consumers", idempotency: "recomputes the last 48 hours from facts in one REPEATABLE READ snapshot; existing keys by version compare-and-set (a touched row is skipped and rechecked), new keys under the key's advisory lock with ON CONFLICT DO NOTHING; a rerun finds no mismatch" },
  { name: "analytics.reconcile-rollups-nightly", token: SELLER_ANALYTICS_RECONCILER, method: "nightly", ownerModule: "seller-analytics", cadence: cairo(4, 0), timeoutMs: 30 * MIN, criticality: "routine", capability: "analytics-consumers", idempotency: "same compare-and-set repair over the last 35 days; a rerun finds no mismatch" },
  { name: "analytics.maintain-rollup-partitions", token: SELLER_ANALYTICS_PARTITIONS, method: "execute", ownerModule: "seller-analytics", cadence: cairo(3, 40), timeoutMs: 10 * MIN, criticality: "important", idempotency: "create-if-missing monthly partitions (six months ahead), moves DEFAULT rows into a new month in one transaction, drops months older than 25 months; a rerun finds nothing left" },
  { name: "analytics.rollup-partition-gauge", token: SELLER_ANALYTICS_PARTITIONS, method: "exportGauge", ownerModule: "seller-analytics", cadence: every(5 * MIN), timeoutMs: MIN, criticality: "routine", idempotency: "read-only count of the DEFAULT partitions, exported as outlet.analytics.rollup_default_partition_rows" },
];

/** Relay-style jobs that are not Nest providers (they need a transaction store). Supplied by the entrypoint. */
export interface RelayRunner {
  runOnce(): Promise<object>;
}
export interface WorkerExtras {
  readonly outboxRelay?: RelayRunner;
  readonly paymentEventsRelay?: RelayRunner;
}

export interface BuildOptions {
  readonly resolve: (token: symbol) => unknown;
  readonly extras?: WorkerExtras;
  readonly eventMode: () => boolean;
  readonly nowMs: () => number;
}

/** Counters only: numbers and bigints at the top level, array lengths. Everything else is dropped. */
export function summarize(result: unknown): JobResult {
  if (typeof result === "number") return { value: result };
  if (Array.isArray(result)) return { count: result.length };
  if (typeof result !== "object" || result === null) return undefined;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(result)) {
    if (typeof v === "number") out[k] = v;
    else if (typeof v === "bigint") out[k] = Number(v);
    else if (Array.isArray(v)) out[k] = v.length;
  }
  return out;
}

function invoke(svc: unknown, method: string, args: readonly unknown[]): Promise<unknown> {
  const fn = (svc as Record<string, unknown> | null)?.[method];
  if (typeof fn !== "function") throw new Error(`worker: ${method} missing on resolved provider`);
  return Promise.resolve(Reflect.apply(fn, svc, [...args]));
}

export function buildJobs(o: BuildOptions): readonly Job[] {
  const jobs: Job[] = JOB_SPECS.map((s) => ({
    name: s.name,
    cadence: s.cadence,
    lockKey: `job:${s.name}`,
    timeoutMs: s.timeoutMs,
    criticality: s.criticality,
    ...(s.capability !== undefined ? { capability: s.capability } : {}),
    ...(s.eventModeOnly === true ? { enabled: o.eventMode } : {}),
    run: async () => summarize(await invoke(o.resolve(s.token), s.method, s.args?.(o.nowMs()) ?? [])),
  }));
  const relays: readonly [string, RelayRunner | undefined][] = [
    ["outbox.relay", o.extras?.outboxRelay],
    ["payments.events-relay", o.extras?.paymentEventsRelay],
  ];
  for (const [name, relay] of relays) {
    if (relay === undefined) continue;
    jobs.push({
      name,
      cadence: every(2 * SEC),
      lockKey: `job:${name}`,
      timeoutMs: 20 * SEC,
      criticality: "critical",
      run: async () => summarize(await relay.runOnce()),
    });
  }
  return jobs;
}
