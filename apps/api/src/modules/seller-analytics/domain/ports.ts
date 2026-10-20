import { z } from "zod";
import type { FunnelCounts, KCell, SalesTotals } from "./bridge";

/** Half-open interval [fromMs, toMs). */
export interface Range {
  readonly fromMs: number;
  readonly toMs: number;
}

const code = z.string().min(1).max(32).regex(/^[a-z0-9_.-]+$/);
const sizeLabel = z.string().min(1).max(16);
const minor = z
  .union([z.bigint(), z.string().regex(/^\d{1,18}$/)])
  .transform((v) => (typeof v === "bigint" ? v : BigInt(v)))
  .refine((v) => v >= 0n, "amount must not be negative");

/**
 * A search term is free text typed by a shopper. It is normalised and rejected when it could carry
 * a phone number, an email or a URL; k-anonymity (>= 50 shoppers) is applied again on the way out.
 */
const DIGITS = /[0-9٠-٩۰-۹]{6,}/;
const term = z
  .string()
  .transform((s) => s.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " "))
  .pipe(
    z
      .string()
      .min(2)
      .max(60)
      .refine((s) => !DIGITS.test(s) && !/[@/\\]|https?:|www\./.test(s), "term may contain personal data"),
  );

const base = {
  messageId: z.uuid(),
  occurredAtMs: z.number().int().positive(),
  storeId: z.uuid(),
  /** Pseudonymous shopper key: used to count DISTINCT shoppers only, never returned. */
  shopperKey: z.string().min(8).max(128).nullable(),
};

const stage = <K extends "impression" | "view" | "save" | "bag" | "checkout">(kind: K) =>
  z.strictObject({ ...base, kind: z.literal(kind), productId: z.uuid(), source: code.optional() });

/** Strict objects: a `measurements`, `budget` or `user_id` property fails validation at ingest. */
export const SourceEventSchema = z.discriminatedUnion("kind", [
  z.strictObject({ ...base, kind: z.literal("store_view"), source: code }),
  stage("impression"),
  stage("view"),
  stage("save"),
  stage("bag"),
  stage("checkout"),
  z.strictObject({
    ...base,
    kind: z.literal("purchase"),
    productId: z.uuid(),
    skuId: z.uuid(),
    sellerOrderId: z.uuid(),
    qty: z.number().int().min(1).max(1000),
    grossMinor: minor,
    commissionMinor: minor,
    sizeLabel,
    governorate: z.string().min(2).max(40).optional(),
  }),
  z.strictObject({
    ...base,
    kind: z.literal("return"),
    productId: z.uuid(),
    skuId: z.uuid(),
    qty: z.number().int().min(1).max(1000),
    reason: z.enum(["too_small", "too_large", "not_as_described", "defective", "changed_mind", "late", "wrong_item"]),
  }),
  z.strictObject({ ...base, kind: z.literal("search_click"), term }),
  z.strictObject({
    ...base,
    kind: z.literal("stock_snapshot"),
    productId: z.uuid(),
    skuId: z.uuid(),
    sizeLabel,
    onHand: z.number().int().min(0).max(1_000_000),
    priceMinor: minor.refine((v) => v > 0n, "price must be positive"),
    listedAtMs: z.number().int().positive(),
  }),
]);
export type SourceEvent = z.output<typeof SourceEventSchema>;

export interface IngestResult {
  readonly applied: number;
  readonly duplicates: number;
}

export interface StockRow {
  readonly skuId: string;
  readonly productId: string;
  readonly sizeLabel: string;
  readonly onHand: number;
  readonly priceMinor: bigint;
  readonly listedAtMs: number;
}

export interface FreshnessRow {
  readonly lastIngestMs: number;
  readonly lastEventMs: number;
}

export interface SkuSalesRow {
  readonly skuId: string;
  readonly productId: string;
  readonly soldUnits: number;
  readonly returnedUnits: number;
}

export interface ReturnReasonRow {
  readonly skuId: string;
  readonly productId: string;
  readonly reason: string;
  readonly units: number;
}

export interface ProductSalesRow {
  readonly productId: string;
  readonly units: number;
  readonly grossMinor: bigint;
}

/** One Africa/Cairo calendar day of purchases (`day` is YYYY-MM-DD in Cairo time). */
export interface DailySalesRow {
  readonly day: string;
  readonly grossMinor: bigint;
  readonly orders: number;
  readonly units: number;
}

export interface GeoValue {
  readonly orders: number;
  readonly gmvMinor: bigint;
}

/**
 * Every method is scoped by `storeId`. Adapters add the predicate themselves AND run under RLS, so
 * a caller bug cannot widen the scope. Nothing here returns a shopper key or per-shopper row.
 */
export interface AnalyticsStore {
  /** Idempotent by message id (inbox). One transaction. */
  ingest(consumer: string, events: readonly SourceEvent[], nowMs: number): Promise<IngestResult>;
  trafficTotals(storeId: string, r: Range): Promise<{ storeViews: number; productViews: number; uniqueVisitors: number }>;
  trafficBySource(storeId: string, r: Range): Promise<readonly KCell<number>[]>;
  funnelByProduct(storeId: string, r: Range): Promise<readonly { productId: string; counts: FunnelCounts }[]>;
  salesTotals(storeId: string, r: Range): Promise<SalesTotals>;
  skuSales(storeId: string, r: Range): Promise<readonly SkuSalesRow[]>;
  returnReasons(storeId: string, r: Range): Promise<readonly ReturnReasonRow[]>;
  stockLevels(storeId: string): Promise<readonly StockRow[]>;
  searchTerms(storeId: string, r: Range): Promise<readonly KCell<number>[]>;
  geography(storeId: string, r: Range): Promise<readonly KCell<GeoValue>[]>;
  freshness(storeId: string): Promise<FreshnessRow | null>;
  /** Units and gross per product from purchase facts (no shopper data). */
  productSales(storeId: string, r: Range): Promise<readonly ProductSalesRow[]>;
  /** Purchases bucketed by Africa/Cairo calendar day (ADR-0047). Days without purchases are absent. */
  dailySales(storeId: string, r: Range): Promise<readonly DailySalesRow[]>;
}

/** A message from the analytics/outbox transport. `body` is untrusted until parsed. */
export interface SourceMessage {
  readonly messageId: string;
  readonly body: unknown;
}

/** Port: where analytics events come from (queue, relay, replay). At-least-once. */
export interface EventSourcePort {
  poll(max: number): Promise<readonly SourceMessage[]>;
  ack(messageIds: readonly string[]): Promise<void>;
}

/** Port: product to owning store, for analytics events that do not carry store_id (wishlist_added). */
export interface ProductStoreLookup {
  storeOf(productId: string): Promise<string | null>;
}

export interface ExportAuditEntry {
  readonly action: "seller_analytics.export";
  readonly actorId: string;
  readonly storeId: string;
  readonly report: string;
  readonly rowCount: number;
  readonly watermark: string;
  readonly fromMs: number;
  readonly toMs: number;
  readonly atMs: number;
}

/** Port: append-only audit (hash-chained audit_log in production). Must not fail silently. */
export interface AuditPort {
  record(entry: ExportAuditEntry): Promise<void>;
}

export class AnalyticsDependencyUnavailableError extends Error {
  constructor(what: string) {
    super(`seller analytics dependency unavailable: ${what}`);
    this.name = "AnalyticsDependencyUnavailableError";
  }
}
