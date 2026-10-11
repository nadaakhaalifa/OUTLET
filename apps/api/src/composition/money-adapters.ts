import { z } from "zod";
import type { HandlePaymentWebhook } from "../modules/checkout";
import type { IntegritySnapshots, ProjectionSource } from "../modules/ledger";
import type { AdminStore } from "../modules/admin";
import type { PayoutApprovalsPort } from "../modules/payouts";
import type { IntegrityPort } from "../modules/reconciliation";
import type { StoreCreditStore } from "../modules/store-credit";
import { money } from "./domain";
import type { Late } from "./late";

// ------------------------------------------------------------------ payments -> checkout

/** The slice of an outbox row the bridges read. The relay supplies `id` as the message id. */
export interface BridgedEvent {
  readonly id: string;
  readonly type: string;
  readonly occurredAtMs: number;
  readonly payload: Readonly<Record<string, unknown>>;
}

const Digits = z.string().regex(/^\d+$/);
const Succeeded = z
  .object({
    intent_id: z.string().min(1),
    order_group_id: z.string().min(1),
    amount: Digits,
    currency: z.literal("EGP"),
    provider: z.string().min(1),
  })
  .loose();
const Failed = z.object({ intent_id: z.string().min(1), order_group_id: z.string().min(1) }).loose();

export type BridgeOutcome = "applied" | "duplicate" | "unknown_group" | "ignored" | "rejected" | "skipped";

/**
 * Feeds checkout with `payment.succeeded` and `payment.failed` from the payments module. Payments
 * has already verified the signature, stored the raw body and deduplicated by PSP event id, so the
 * saga applies the event without a second verification. At-least-once delivery is safe: checkout
 * records the message id and a replay changes nothing. A malformed payload throws (retry, DLQ),
 * it is never silently dropped.
 */
export class PaymentEventsToCheckout {
  constructor(private readonly webhook: Late<HandlePaymentWebhook>) {}

  async handle(e: BridgedEvent): Promise<BridgeOutcome> {
    if (e.type === "payment.succeeded") {
      const p = Succeeded.parse(e.payload);
      const r = await this.webhook.get().applyVerified({
        provider: p.provider,
        body: JSON.stringify({ outbox_event_id: e.id, intent_id: p.intent_id, order_group_id: p.order_group_id, amount: p.amount }),
        event: {
          eventId: e.id,
          provider: p.provider,
          intentId: p.intent_id,
          orderGroupId: p.order_group_id,
          kind: "succeeded",
          amount: money(BigInt(p.amount)),
          occurredAtMs: e.occurredAtMs,
        },
      });
      return r.kind;
    }
    if (e.type === "payment.failed") {
      const p = Failed.parse(e.payload);
      const provider = typeof e.payload["provider"] === "string" ? e.payload["provider"] : "payments_module";
      const r = await this.webhook.get().applyVerified({
        provider,
        body: JSON.stringify({ outbox_event_id: e.id, intent_id: p.intent_id, order_group_id: p.order_group_id }),
        event: {
          eventId: e.id,
          provider,
          intentId: p.intent_id,
          orderGroupId: p.order_group_id,
          kind: "failed",
          amount: money(0n),
          occurredAtMs: e.occurredAtMs,
        },
      });
      return r.kind;
    }
    return "skipped";
  }
}

// ------------------------------------------------------------------ admin approvals -> payouts

const APPROVAL_SCAN_LIMIT = 200;

/** Payout approvals are admin approval records bound to the payout id (subjectType "payout"). */
export class AdminPayoutApprovals implements PayoutApprovalsPort {
  constructor(private readonly store: Late<AdminStore>) {}

  async forPayout(payoutId: string): ReturnType<PayoutApprovalsPort["forPayout"]> {
    const rows = await this.store.get().listApprovals({ kinds: ["payout"], limit: APPROVAL_SCAN_LIMIT });
    return rows.filter((r) => r.subjectType === "payout" && r.subjectId === payoutId);
  }
}

// ------------------------------------------------------------------ store credit -> ledger job

const PAGE = 200;

/** Cached wallet projection (natural sign): the unspent remainder of every lot, per user and sub-balance. */
export class StoreCreditProjection implements ProjectionSource {
  constructor(private readonly store: Late<StoreCreditStore>) {}

  async rows(): ReturnType<ProjectionSource["rows"]> {
    const out: { userId: string; sub: string; balance: bigint }[] = [];
    let after: string | null = null;
    for (;;) {
      const ids: readonly string[] = await this.store.get().listUserIds(after, PAGE);
      for (const userId of ids) {
        const by = new Map<string, bigint>();
        for (const lot of await this.store.get().listLots(userId)) {
          const key = lot.sub.kind === "gift_card" ? `gift_card:${lot.sub.cardId}` : lot.sub.kind;
          by.set(key, (by.get(key) ?? 0n) + lot.remaining);
        }
        for (const [sub, balance] of by) out.push({ userId, sub, balance });
      }
      if (ids.length < PAGE) break;
      after = ids[ids.length - 1] ?? null;
    }
    return out;
  }
}

// ------------------------------------------------------------------ ledger -> reconciliation

/** Reconciliation's integrity suite reads one consistent snapshot of the ledger plus the wallet projection. */
export class LedgerIntegrityPort implements IntegrityPort {
  constructor(
    private readonly snapshots: Late<IntegritySnapshots>,
    private readonly wallets: Late<ProjectionSource>,
  ) {}

  totals(): ReturnType<IntegrityPort["totals"]> {
    return this.snapshots.get().withSnapshot((s) => s.trialBalance());
  }

  projection(): ReturnType<IntegrityPort["projection"]> {
    return this.wallets.get().rows();
  }

  balances(): ReturnType<IntegrityPort["balances"]> {
    return this.snapshots.get().withSnapshot((s) => s.storeCreditBalances());
  }
}
