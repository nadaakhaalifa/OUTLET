import { SourceEventSchema, type EventSourcePort, type ProductStoreLookup, type AnalyticsStore, type SourceEvent } from "../domain/ports";

export const CONSUMER_NAME = "seller-analytics";
const MAX_BATCH = 500;

/** The subset of the analytics EventEnvelope this module reads. It carries no user or device id. */
interface Envelope {
  readonly event_id: string;
  readonly name: string;
  readonly occurred_at: string;
  readonly pseudonymous_id: string;
  readonly properties: Readonly<Record<string, unknown>>;
}

const isEnvelope = (b: unknown): b is Envelope => {
  if (typeof b !== "object" || b === null) return false;
  const o = b as Record<string, unknown>;
  return typeof o["event_id"] === "string" && typeof o["name"] === "string" && typeof o["properties"] === "object" && o["properties"] !== null;
};

/**
 * Maps the pseudonymous client analytics events that carry a store to read-model events.
 * `checkout_started`, `order_placed` and others carry no store, so they are NOT mapped here: the
 * orders module publishes per-store `checkout` and `purchase` SourceEvents (see the spec, gaps).
 */
export async function mapAnalyticsEnvelope(env: Envelope, lookup: ProductStoreLookup): Promise<unknown | null> {
  const p = env.properties;
  const common = { messageId: env.event_id, occurredAtMs: Date.parse(env.occurred_at), shopperKey: env.pseudonymous_id };
  const str = (k: string): string | null => (typeof p[k] === "string" ? (p[k] as string) : null);
  switch (env.name) {
    case "store_viewed":
      return { ...common, kind: "store_view", storeId: str("store_id"), source: str("source") };
    case "product_viewed":
      return { ...common, kind: "view", storeId: str("store_id"), productId: str("product_id"), source: str("source") ?? undefined };
    case "add_to_bag":
      return { ...common, kind: "bag", storeId: str("store_id"), productId: str("product_id"), source: str("source") ?? undefined };
    case "wishlist_added": {
      const productId = str("product_id");
      const storeId = productId === null ? null : await lookup.storeOf(productId);
      return storeId === null ? null : { ...common, kind: "save", storeId, productId };
    }
    default:
      return null;
  }
}

export interface ConsumeResult {
  readonly polled: number;
  readonly applied: number;
  readonly duplicates: number;
  readonly ignored: number;
  readonly rejected: number;
}

/**
 * Pulls from the EventSourcePort, validates every message at the boundary (Zod, strict), writes
 * through the store's inbox (idempotent), then acks. Poison messages are acked and counted so one
 * bad payload cannot block the queue; the count is the alert signal.
 */
export class ConsumeSellerAnalytics {
  constructor(
    private readonly source: EventSourcePort,
    private readonly store: AnalyticsStore,
    private readonly lookup: ProductStoreLookup,
    private readonly clock: { nowMs(): number },
  ) {}

  async run(max = 100): Promise<ConsumeResult> {
    const batch = await this.source.poll(Math.min(Math.max(max, 1), MAX_BATCH));
    const valid: SourceEvent[] = [];
    let ignored = 0;
    let rejected = 0;
    for (const m of batch) {
      let candidate: unknown = m.body;
      if (isEnvelope(m.body)) {
        candidate = await mapAnalyticsEnvelope(m.body, this.lookup);
        if (candidate === null) {
          ignored += 1;
          continue;
        }
      }
      const parsed = SourceEventSchema.safeParse(candidate);
      if (parsed.success) valid.push(parsed.data);
      else rejected += 1;
    }
    const r = await this.store.ingest(CONSUMER_NAME, valid, this.clock.nowMs());
    await this.source.ack(batch.map((m) => m.messageId));
    return { polled: batch.length, applied: r.applied, duplicates: r.duplicates, ignored, rejected };
  }
}
