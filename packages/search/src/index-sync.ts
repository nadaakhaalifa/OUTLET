import type { SqlClient, Queryable } from "@outlet/db";
import { InboxProcessor } from "@outlet/outbox";
import type { OutboxEvent } from "@outlet/outbox";
import { buildSearchText, analyzeQuery, normalizeArabic } from "@outlet/search-bakeoff";
import { z } from "zod";
import type { PriceDisplayLookup } from "./ports.js";

export const SEARCH_SYNC_CONSUMER = "search.index-sync";
export const SYNC_EVENT_TYPES = ["listing.activated", "listing.updated", "price.changed", "inventory.sold_out", "inventory.restocked"] as const;
export type SyncOutcome = "applied" | "stale" | "duplicate" | "ignored" | "missing";

const listingPayload = z.object({ listing_id: z.uuid() });
const pricePayload = z.object({ sku_id: z.uuid(), new_price_minor: z.string().regex(/^[1-9][0-9]{0,18}$/) });
const stockPayload = z.object({ listing_id: z.uuid() });

/** True when the payload of a sync event type has the shape the index sync reads (used to park malformed events instead of retrying them). */
export const isValidSyncPayload = (type: string, payload: unknown): boolean => {
  if (type === "price.changed") return pricePayload.safeParse(payload).success;
  if (type === "inventory.sold_out" || type === "inventory.restocked") return stockPayload.safeParse(payload).success;
  if (type === "listing.activated" || type === "listing.updated") return listingPayload.safeParse(payload).success;
  return false;
};

interface ListingRow {
  id: string;
  store_ref: string;
  store: { kind?: string } | null;
  status: string;
  title_ar: string;
  title_en: string | null;
  brand_name: string | null;
  primary_category_id: string;
  condition_grade_code: string;
  colour_code: string | null;
  min_price_minor: string;
  currency: string;
  attributes: Record<string, unknown>;
  variants: { sku_id: string; size_label: string | null; price_minor: string }[];
}

const LISTING_SQL = `SELECT id, store_ref, store, status, title_ar, title_en, brand_name, primary_category_id, condition_grade_code, colour_code,
  min_price_minor::text AS min_price_minor, currency, attributes, variants FROM catalog_public_listings WHERE id = $1 AND market_id = $2`;

/** Microseconds since epoch of the source event: the monotonic version of a document. */
export const seqOf = (occurredAt: string): bigint => BigInt(new Date(occurredAt).getTime()) * 1000n;

const sizesOf = (r: ListingRow): string[] => [...new Set(r.variants.flatMap((v) => (v.size_label === null ? [] : [v.size_label.trim().toLowerCase()])))].filter((s) => s.length > 0);

const searchTextOf = (r: ListingRow): string => {
  const titles = `${r.title_ar} ${r.title_en ?? ""} ${r.brand_name ?? ""} ${r.colour_code ?? ""}`;
  const concepts = analyzeQuery(titles, { fuzzy: false }).concepts;
  return buildSearchText(r.title_ar, [r.title_en ?? "", r.brand_name ?? "", r.colour_code ?? ""].join(" "), concepts);
};

/**
 * Inbox consumer that keeps search_documents in step with the catalog (listing.activated/updated), prices (price.changed),
 * stock flags (inventory.sold_out/restocked) and the pricing display decision. Idempotent twice over: the inbox row dedups a
 * redelivery, and the upsert is guarded by `seq` so an OLDER event never overwrites a NEWER one (out-of-order delivery).
 * Listing events always refresh content columns from the current catalog row even when stale for seq (they are state reads, never
 * regress anything); status, stock, price and the verified flags only move forward in seq.
 */
export class SearchIndexSync {
  private readonly inbox: InboxProcessor;
  constructor(
    private readonly client: SqlClient,
    private readonly display: PriceDisplayLookup,
  ) {
    this.inbox = new InboxProcessor(client);
  }

  async handle(event: OutboxEvent): Promise<SyncOutcome> {
    if (!(SYNC_EVENT_TYPES as readonly string[]).includes(event.type)) return "ignored";
    // Display lookups read other tables through their own client, so do them before the sync transaction.
    const prepared = await this.prepare(event);
    let outcome: SyncOutcome = "applied";
    const res = await this.inbox.process(SEARCH_SYNC_CONSUMER, event.id, async (tx) => {
      outcome = await this.apply(tx, event, prepared);
    });
    return res === "duplicate" ? "duplicate" : outcome;
  }

  private async prepare(event: OutboxEvent): Promise<{ display?: { verifiedDiscount: boolean; lowest30d: boolean } } | undefined> {
    if (event.type === "inventory.sold_out" || event.type === "inventory.restocked") return undefined;
    let skuId: string | undefined;
    if (event.type === "price.changed") skuId = pricePayload.parse(event.payload).sku_id;
    else {
      const id = listingPayload.parse(event.payload).listing_id;
      const r = await this.client.query<ListingRow>(LISTING_SQL, [id, event.marketId]);
      skuId = r.rows[0]?.variants[0]?.sku_id;
    }
    if (skuId === undefined) return { display: { verifiedDiscount: false, lowest30d: false } };
    return { display: await this.display.forSku(skuId) };
  }

  private async apply(tx: Queryable, event: OutboxEvent, prep: { display?: { verifiedDiscount: boolean; lowest30d: boolean } } | undefined): Promise<SyncOutcome> {
    const seq = seqOf(event.occurredAt).toString();
    const at = new Date(event.occurredAt);
    const disp = prep?.display ?? { verifiedDiscount: false, lowest30d: false };
    if (event.type === "inventory.sold_out" || event.type === "inventory.restocked") {
      const p = stockPayload.parse(event.payload);
      const r = await tx.query(
        "UPDATE search_documents SET in_stock = $3, seq = $4, updated_at = $5 WHERE market_id = $1 AND product_id = $2 AND seq <= $4 RETURNING product_id",
        [event.marketId, p.listing_id, event.type === "inventory.restocked", seq, at],
      );
      return r.rows.length > 0 ? "applied" : (await this.exists(tx, event.marketId, p.listing_id)) ? "stale" : "missing";
    }
    if (event.type === "price.changed") {
      const p = pricePayload.parse(event.payload);
      const l = await tx.query<ListingRow>("SELECT id, variants FROM catalog_public_listings WHERE market_id = $1 AND variants @> $2::jsonb", [event.marketId, JSON.stringify([{ sku_id: p.sku_id }])]);
      const row = l.rows[0];
      if (row === undefined) return "missing";
      const prices = row.variants.map((v) => (v.sku_id === p.sku_id ? BigInt(p.new_price_minor) : BigInt(v.price_minor)));
      const min = prices.reduce((a, b) => (b < a ? b : a));
      const r = await tx.query(
        `UPDATE search_documents SET price_minor = $3, verified_discount = $4, lowest_30d = $5, seq = $6, updated_at = $7
          WHERE market_id = $1 AND product_id = $2 AND seq <= $6 RETURNING product_id`,
        [event.marketId, row.id, min.toString(), disp.verifiedDiscount, disp.lowest30d, seq, at],
      );
      return r.rows.length > 0 ? "applied" : (await this.exists(tx, event.marketId, row.id)) ? "stale" : "missing";
    }
    const id = listingPayload.parse(event.payload).listing_id;
    const l = await tx.query<ListingRow>(LISTING_SQL, [id, event.marketId]);
    const row = l.rows[0];
    if (row === undefined) {
      const r = await tx.query("UPDATE search_documents SET is_published = false, seq = $3, updated_at = $4 WHERE market_id = $1 AND product_id = $2 AND seq <= $3 RETURNING product_id", [event.marketId, id, seq, at]);
      return r.rows.length > 0 ? "applied" : "missing";
    }
    const text = searchTextOf(row);
    const published = row.status !== "PAUSED";
    const args = [
      row.id, event.marketId, row.store_ref, row.primary_category_id, row.store?.kind === "global" ? "global" : "local",
      normalizeArabic(row.title_ar), normalizeArabic(row.title_en ?? ""), text, JSON.stringify(row.attributes), row.min_price_minor, row.currency,
      row.condition_grade_code, sizesOf(row), disp.verifiedDiscount, disp.lowest30d, row.status !== "SOLD_OUT", published, at, seq,
    ];
    const up = await tx.query(
      `INSERT INTO search_documents (product_id, market_id, store_ref, category_id, world, title_ar, title_en, search_text, tsv, attributes, price_minor, currency,
         condition_grade, sizes, verified_discount, lowest_30d, in_stock, is_published, updated_at, seq)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,to_tsvector('arabic_simple',$8),$9::jsonb,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
       ON CONFLICT (market_id, product_id) DO UPDATE SET store_ref = EXCLUDED.store_ref, category_id = EXCLUDED.category_id, world = EXCLUDED.world,
         title_ar = EXCLUDED.title_ar, title_en = EXCLUDED.title_en, search_text = EXCLUDED.search_text, tsv = EXCLUDED.tsv, attributes = EXCLUDED.attributes,
         price_minor = EXCLUDED.price_minor, currency = EXCLUDED.currency, condition_grade = EXCLUDED.condition_grade, sizes = EXCLUDED.sizes,
         verified_discount = EXCLUDED.verified_discount, lowest_30d = EXCLUDED.lowest_30d, in_stock = EXCLUDED.in_stock, is_published = EXCLUDED.is_published,
         updated_at = EXCLUDED.updated_at, seq = EXCLUDED.seq
       WHERE search_documents.seq <= EXCLUDED.seq RETURNING product_id`,
      args,
    );
    if (up.rows.length > 0) return "applied";
    // Stale for seq: content only (state read of the current catalog row), never price, stock, publish state or flags.
    await tx.query(
      `UPDATE search_documents SET store_ref = $3, category_id = $4, world = $5, title_ar = $6, title_en = $7, search_text = $8, tsv = to_tsvector('arabic_simple',$8),
         attributes = $9::jsonb, condition_grade = $10, sizes = $11 WHERE market_id = $1 AND product_id = $2`,
      [event.marketId, row.id, row.store_ref, row.primary_category_id, args[4], args[5], args[6], text, args[8], row.condition_grade_code, args[12]],
    );
    return "stale";
  }

  private async exists(tx: Queryable, marketId: string, id: string): Promise<boolean> {
    return (await tx.query("SELECT 1 FROM search_documents WHERE market_id = $1 AND product_id = $2", [marketId, id])).rows.length > 0;
  }
}
