import type { Queryable } from "@outlet/db";
import { InboxProcessor } from "@outlet/outbox";
import type { OutboxEvent } from "@outlet/outbox";
import { z } from "zod";
import { loadHistory, windowFor } from "./env.js";
import type { Env } from "./env.js";

export const PRICE_CHANGED_CONSUMER = "pricing-integrity.price-events";

/** Mirrors the payload @outlet/catalog emits for price.changed (amounts are decimal strings). */
export const priceChangedPayload = z.object({
  sku_id: z.uuid(),
  store_id: z.uuid().optional(),
  new_price_minor: z.string().regex(/^[1-9][0-9]{0,18}$/),
  currency: z.string().regex(/^[A-Z]{3}$/),
  changed_at: z.iso.datetime({ offset: true }),
});

/** "stale" now only means two different prices at the exact same instant; out-of-order events are applied. */
export type IngestOutcome = "applied" | "duplicate" | "unchanged" | "stale" | "ignored";

export class PriceEventIngestor {
  private readonly inbox: InboxProcessor;
  constructor(private readonly env: Env) {
    this.inbox = new InboxProcessor(env.client);
  }

  /** Idempotent: a redelivered event is a no-op (inbox row commits with the price rows). A malformed payload throws (relay retries, then DLQ). */
  async ingest(event: OutboxEvent): Promise<IngestOutcome> {
    if (event.type !== "price.changed") return "ignored";
    const p = priceChangedPayload.parse(event.payload);
    let outcome: IngestOutcome = "applied";
    const res = await this.inbox.process(PRICE_CHANGED_CONSUMER, event.id, async (tx) => {
      outcome = await this.apply(tx, event, p);
    });
    return res === "duplicate" ? "duplicate" : outcome;
  }

  private async apply(tx: Queryable, event: OutboxEvent, p: z.infer<typeof priceChangedPayload>): Promise<IngestOutcome> {
    const { env } = this;
    const changedAt = new Date(p.changed_at);
    const price = BigInt(p.new_price_minor);
    const open = await tx.query<{ id: string; price_minor: string; valid_from: Date | string; currency: string }>(
      "SELECT id, price_minor::text AS price_minor, valid_from, currency FROM price_events WHERE sku_id = $1 AND market_id = $2 AND source = 'internal' AND valid_to IS NULL FOR UPDATE",
      [p.sku_id, event.marketId],
    );
    const cur = open.rows[0];
    if (cur !== undefined && cur.currency !== p.currency) throw new Error("price.changed currency differs from the open price row");
    // Row in effect at changedAt (latest valid_from <= changedAt) and the first row after it, by start time (rows are append-only).
    const before = await tx.query<{ price_minor: string; valid_from: Date | string }>(
      "SELECT price_minor::text AS price_minor, valid_from FROM price_events WHERE sku_id = $1 AND market_id = $2 AND source = 'internal' AND valid_from <= $3 ORDER BY valid_from DESC LIMIT 1",
      [p.sku_id, event.marketId, changedAt],
    );
    const after = await tx.query<{ valid_from: Date | string }>(
      "SELECT valid_from FROM price_events WHERE sku_id = $1 AND market_id = $2 AND source = 'internal' AND valid_from > $3 ORDER BY valid_from ASC LIMIT 1",
      [p.sku_id, event.marketId, changedAt],
    );
    const prev = before.rows[0];
    const next = after.rows[0];
    if (prev !== undefined) {
      // Two different prices at the same instant cannot be ordered: keep the first, drop the second.
      if (new Date(prev.valid_from).getTime() === changedAt.getTime() && BigInt(prev.price_minor) !== price) return "stale";
      if (BigInt(prev.price_minor) === price) return "unchanged";
    }
    // A late (out of order) event becomes a closed row [changedAt, next.valid_from): redelivery must never lose a low price.
    const validTo = next === undefined ? null : new Date(next.valid_from);
    if (validTo === null && cur !== undefined) await tx.query("UPDATE price_events SET valid_to = $2 WHERE id = $1", [cur.id, changedAt]);
    await tx.query(
      `INSERT INTO price_events (id, sku_id, store_ref, market_id, currency, price_minor, valid_from, valid_to, source, actor_type, source_event_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'internal', 'system', $9)`,
      [env.newId(), p.sku_id, p.store_id ?? null, event.marketId, p.currency, price.toString(), changedAt, validTo, event.id],
    );
    await this.refreshWindow(tx, p.sku_id, event.marketId, p.currency);
    return "applied";
  }

  /** Recomputes the maintained sku_price_windows row from the events (exact as of now). */
  async refreshWindow(tx: Queryable, skuId: string, marketId: string, currency: string): Promise<void> {
    const now = this.env.now();
    const w = windowFor(await loadHistory(tx, skuId, marketId, now), now);
    if (w.currentPrice === null || w.low30d === null || w.low30dFrom === null || w.firstSeenAt === null) return;
    await tx.query(
      `INSERT INTO sku_price_windows (sku_id, market_id, currency, current_price_minor, low_30d_minor, low_30d_from, first_seen_at, last_increase_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (sku_id, market_id) DO UPDATE SET currency = EXCLUDED.currency, current_price_minor = EXCLUDED.current_price_minor,
         low_30d_minor = EXCLUDED.low_30d_minor, low_30d_from = EXCLUDED.low_30d_from, first_seen_at = EXCLUDED.first_seen_at,
         last_increase_at = EXCLUDED.last_increase_at, updated_at = EXCLUDED.updated_at`,
      [skuId, marketId, currency, w.currentPrice.toString(), w.low30d.toString(), w.low30dFrom, w.firstSeenAt, w.lastIncreaseAt, now],
    );
  }
}
