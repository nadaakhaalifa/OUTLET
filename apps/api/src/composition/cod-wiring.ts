import { createHash } from "node:crypto";
import { z } from "zod";
import { checkout, money, orderRecognised, buildEntry, type JournalEntry } from "./domain";
import type { BridgedEvent } from "./money-adapters";

/**
 * COD ledger recognition (review F-8 follow-up, ADR-0021 point 2). A cash-on-delivery order has no
 * receivable until the courier confirms delivery:
 *   shipment.delivered (cod)        -> order_cod_confirmed:{orderGroupId}  (cod_clearing receivable)
 *   cod_remittance.* (matched part) -> cod_collected:{courier}:{ref}        (bank in, fee, cod_clearing cleared)
 *   shipment.rto_* (refusal)        -> nothing in the ledger; COD spend counters are reversed.
 * Every post is idempotent under its ledger key, so a redelivered outbox message changes nothing.
 * Refunds fail closed until the recognition key exists (see orderRecognitionKeys).
 *
 * Multi-store groups: recognition is one entry per OrderGroup (the shared key), posted when the FIRST
 * seller order of the group is delivered; a later delivery replays to "duplicate". If a sibling is
 * later refused (RTO) its receivable stays in cod_clearing until the courier remits less: that gap
 * surfaces as a COD remittance mismatch for finance (VERIFY with owner, VR-F1-01).
 */

/** The slice of a checkout saga recognition needs. `SagaRepository.get` satisfies it structurally. */
export interface CodSagaReader {
  get(orderGroupId: string): Promise<{
    readonly userId: string;
    readonly stored: { readonly quote: checkout.CheckoutQuote; readonly commissionBps: Readonly<Record<string, number>> };
  } | null>;
}

export interface CodLedgerPort {
  post(entry: JournalEntry): Promise<{ readonly kind: "posted" | "duplicate" }>;
}

export interface SellerOrderGroupPort {
  /** Order group and shopper of a seller order, or null when unknown. */
  locate(sellerOrderId: string): Promise<{ readonly orderGroupId: string; readonly userId: string; readonly storeId: string } | null>;
}

export interface CodCountersPort {
  /** Reverses the COD spend the shopper accrued at placement. Idempotent by `ref`. */
  reverse(input: { readonly userId: string; readonly orderGroupId: string; readonly amount: bigint; readonly ref: string }): Promise<"reversed" | "duplicate">;
}

export class InMemoryCodCounters implements CodCountersPort {
  readonly reversals = new Map<string, { userId: string; orderGroupId: string; amount: bigint }>();
  async reverse(i: { userId: string; orderGroupId: string; amount: bigint; ref: string }): Promise<"reversed" | "duplicate"> {
    if (this.reversals.has(i.ref)) return "duplicate";
    this.reversals.set(i.ref, { userId: i.userId, orderGroupId: i.orderGroupId, amount: i.amount });
    return "reversed";
  }
}

export type CodOutcome = "recognised" | "duplicate" | "reversed" | "skipped" | "unknown_order";

const Shipment = z.object({ seller_order_id: z.string().min(1), courier: z.string().min(1), cod: z.boolean() }).loose();
const Remittance = z
  .object({
    courier: z.string().min(1),
    courier_ref: z.string().min(1),
    matched_amount: z.string().regex(/^\d+$/),
    matched_fee: z.string().regex(/^\d+$/),
  })
  .loose();

function derivedUuid(seed: string): string {
  const h = createHash("sha256").update(seed).digest("hex");
  const variant = ((Number.parseInt(h.slice(16, 17), 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export interface CodRecognitionDeps {
  readonly ledger: CodLedgerPort;
  readonly sagas: CodSagaReader;
  readonly groups: SellerOrderGroupPort;
  readonly counters: CodCountersPort;
  readonly bankAccount?: string;
}

export class CodLedgerRecognition {
  constructor(private readonly d: CodRecognitionDeps) {}

  async handle(e: BridgedEvent): Promise<CodOutcome> {
    switch (e.type) {
      case "shipment.delivered":
        return this.delivered(e);
      case "shipment.rto_initiated":
      case "shipment.rto_received":
        return this.refused(e);
      case "cod_remittance.matched":
      case "cod_remittance.mismatch":
        return this.remitted(e);
      default:
        return "skipped";
    }
  }

  private async delivered(e: BridgedEvent): Promise<CodOutcome> {
    const p = Shipment.parse(e.payload);
    if (!p.cod) return "skipped";
    const order = await this.d.groups.locate(p.seller_order_id);
    if (order === null) return "unknown_order";
    const rec = await this.d.sagas.get(order.orderGroupId);
    if (rec === null || rec.stored.quote.method !== "cod") return "unknown_order";
    const q = rec.stored.quote;
    const key = checkout.orderRecognitionKey(order.orderGroupId, "cod");
    const entry = orderRecognised(
      {
        sellerOrders: q.stores.map((s) => {
          const bps = rec.stored.commissionBps[s.storeId];
          if (bps === undefined) throw new Error(`commission snapshot missing for store ${s.storeId}`);
          return {
            storeId: s.storeId,
            merchandise: s.merchandise,
            commissionBps: BigInt(bps),
            platformFundedDiscount: s.platformFundedDiscount,
            sellerFundedDiscount: s.sellerFundedDiscount,
          };
        }),
        shippingGross: q.shipping,
        vatBps: q.vatBps,
        tenders: [
          ...q.tender.storeCredit.map((c) => ({ kind: "store_credit" as const, userId: rec.userId, sub: c.sub, amount: c.amount })),
          { kind: "cod" as const, courier: p.courier, amount: q.tender.externalDue },
        ],
      },
      { id: derivedUuid(key), idempotencyKey: key, occurredAt: new Date(e.occurredAtMs), ref: { type: "order_group", id: order.orderGroupId } },
    );
    const r = await this.d.ledger.post(entry);
    return r.kind === "posted" ? "recognised" : "duplicate";
  }

  /** Refusal: the order was never recognised for this parcel, so there is nothing to reverse in the ledger. */
  private async refused(e: BridgedEvent): Promise<CodOutcome> {
    const p = Shipment.parse(e.payload);
    if (!p.cod) return "skipped";
    const order = await this.d.groups.locate(p.seller_order_id);
    if (order === null) return "unknown_order";
    const rec = await this.d.sagas.get(order.orderGroupId);
    if (rec === null || rec.stored.quote.method !== "cod") return "unknown_order";
    // The seller order's own share of what was due at the door.
    const amount = rec.stored.quote.stores.find((s) => s.storeId === order.storeId)?.total.amount ?? 0n;
    // Reversal is keyed per seller order so rto_initiated then rto_received counts once.
    const r = await this.d.counters.reverse({
      userId: order.userId,
      orderGroupId: order.orderGroupId,
      amount,
      ref: `cod_refused:${p.seller_order_id}`,
    });
    return r === "reversed" ? "reversed" : "duplicate";
  }

  private async remitted(e: BridgedEvent): Promise<CodOutcome> {
    const p = Remittance.parse(e.payload);
    const gross = BigInt(p.matched_amount);
    if (gross === 0n) return "skipped";
    const remittanceId = `${p.courier}:${p.courier_ref}`;
    const entry = buildEntry(
      { type: "cod_collected", remittanceId, courier: p.courier, gross: money(gross), fee: money(BigInt(p.matched_fee)), bankAccount: this.d.bankAccount ?? "main" },
      { id: derivedUuid(`cod_collected:${remittanceId}`), occurredAt: new Date(e.occurredAtMs) },
    );
    const r = await this.d.ledger.post(entry);
    return r.kind === "posted" ? "recognised" : "duplicate";
  }
}
