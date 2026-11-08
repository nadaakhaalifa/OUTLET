import type { Queryable } from "@outlet/db";
import { z } from "zod";
import { CHECK_INTERVAL_MS } from "../domain/trust.js";
import { DomainRateLimiter } from "./politeness.js";
import type { DomainRateLimiterPort } from "./politeness.js";
import type { ChannelFetchPort, DnsPort, ExternalItem, RobotsPort } from "./ports.js";
import { safeFetch } from "./ssrf.js";
import type { FetchGate } from "./ssrf.js";
import { asWatchWorker, emit, WatchError } from "./watch-env.js";
import type { WatchEnv } from "./watch-env.js";

export const USER_AGENT = "OutletNK-PriceWatch/1.0 (+https://outletnk.example/price-watch)";
const DAY = 86_400_000;
export const FAILED_RUNS_BEFORE_FAILED = 3;
const itemSchema = z.object({
  externalRef: z.string().min(1), priceMinor: z.bigint().positive(), currency: z.string().regex(/^[A-Z]{3}$/), inStock: z.boolean(),
  compareAtMinor: z.bigint().positive().nullish(),
});

interface Due { id: string; store_id: string; type: string; domain: string; base_url: string; risk_tier: "trusted" | "normal" | "watched" }
export type SyncOutcome = "synced" | "not_modified" | "failed" | "skipped" | "unsafe";
export interface IngestDeps {
  readonly fetch: ChannelFetchPort;
  readonly dns: DnsPort;
  readonly robots: RobotsPort;
  readonly sleep: (ms: number) => Promise<void>;
  readonly random?: () => number;
  readonly limiter?: DomainRateLimiterPort;
}
const methodOf = (type: string): "api" | "feed" | "crawler" => (type === "feed" ? "feed" : type === "website" ? "crawler" : "api");

export class SnapshotIngestor {
  private readonly limiter: DomainRateLimiterPort;
  /** ETag / Last-Modified validators per connection (in memory; a restart only costs one full fetch, snapshots are deduped on price anyway). */
  private readonly validators = new Map<string, { etag?: string; lastModified?: string }>();
  constructor(private readonly env: WatchEnv, private readonly deps: IngestDeps) {
    this.limiter = deps.limiter ?? new DomainRateLimiter();
  }

  async runDue(limit = 50): Promise<Record<SyncOutcome, number>> {
    const due = await asWatchWorker(this.env, async (tx) =>
      (await tx.query<Due>("SELECT id, store_id, type, domain, base_url, risk_tier FROM channel_connections WHERE market_id = $1 AND status IN ('active', 'failed') AND next_check_at <= $2 ORDER BY next_check_at LIMIT $3", [this.env.marketId, this.env.now(), limit])).rows,
    );
    const out: Record<SyncOutcome, number> = { synced: 0, not_modified: 0, failed: 0, skipped: 0, unsafe: 0 };
    for (const c of due) out[await this.syncOne(c)]++;
    return out;
  }

  private async fetchWithRetry(c: Due, address: string, gate: FetchGate): Promise<Awaited<ReturnType<typeof safeFetch>>> {
    const v = this.validators.get(c.id) ?? {};
    let last: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await this.deps.sleep(1000 * 2 ** (attempt - 1) * (1 + (this.deps.random ?? Math.random)() * 0.25));
      try {
        const res = await safeFetch(this.deps.fetch, c.base_url, { dns: this.deps.dns, allowedDomains: [c.domain] }, { userAgent: USER_AGENT, timeoutMs: 10_000, ...v }, gate);
        if (res.status < 500) return res;
        last = new Error(`status ${String(res.status)}`);
      } catch (e) {
        if (e instanceof WatchError) throw e;
        last = e;
      }
    }
    throw last instanceof Error ? last : new Error(`fetch failed for ${address}`);
  }

  private async schedule(tx: Queryable, c: Due, synced: boolean): Promise<void> {
    const now = this.env.now();
    await tx.query("UPDATE channel_connections SET next_check_at = $2, last_sync_at = CASE WHEN $3 THEN $4 ELSE last_sync_at END, consecutive_failures = CASE WHEN $3 THEN 0 ELSE consecutive_failures END, status = CASE WHEN $3 AND status = 'failed' THEN 'active' ELSE status END, updated_at = $4 WHERE id = $1", [c.id, new Date(now.getTime() + CHECK_INTERVAL_MS[c.risk_tier]), synced, now]);
  }

  /** A run that failed after its 3 backed-off attempts: schedule the next one and count it; 3 failed runs in a row mark the connection `failed` (its evidence is then treated as stale by the scorer, A5). */
  private async fail(tx: Queryable, c: Due): Promise<void> {
    const now = this.env.now();
    await tx.query(
      "UPDATE channel_connections SET next_check_at = $2, consecutive_failures = consecutive_failures + 1, status = CASE WHEN consecutive_failures + 1 >= $3 AND status = 'active' THEN 'failed' ELSE status END, updated_at = $4 WHERE id = $1",
      [c.id, new Date(now.getTime() + CHECK_INTERVAL_MS[c.risk_tier]), FAILED_RUNS_BEFORE_FAILED, now]);
  }

  async syncOne(c: Due): Promise<SyncOutcome> {
    const crawler = methodOf(c.type) === "crawler";
    if (crawler && (await this.env.crawlerKilled().catch(() => true))) return "skipped";
    // Politeness + robots.txt run before EVERY HTTP call: each retry attempt and each redirect hop reserves a slot and re-checks robots for that exact path (A7).
    const gate: FetchGate = async (url) => {
      if (crawler && !(await this.deps.robots.allowed(url.hostname, url.pathname, USER_AGENT))) throw new WatchError("forbidden", "robots.txt disallows this path");
      const wait = await this.limiter.reserve(c.domain, this.env.now().getTime());
      if (wait > 0) await this.deps.sleep(wait);
    };
    let res: Awaited<ReturnType<typeof safeFetch>>;
    try {
      res = await this.fetchWithRetry(c, c.domain, gate);
    } catch (e) {
      if (e instanceof WatchError && e.code === "forbidden") {
        await asWatchWorker(this.env, (tx) => this.schedule(tx, c, false));
        return "skipped";
      }
      if (e instanceof WatchError) {
        await asWatchWorker(this.env, async (tx) => {
          await this.schedule(tx, c, false);
          await tx.query("UPDATE channel_connections SET status = 'failed', updated_at = $2 WHERE id = $1", [c.id, this.env.now()]);
        });
        return "unsafe";
      }
      await asWatchWorker(this.env, (tx) => this.fail(tx, c));
      return "failed";
    }
    if (res.status === 304) {
      await asWatchWorker(this.env, (tx) => this.schedule(tx, c, true));
      return "not_modified";
    }
    if (res.status >= 400) {
      await asWatchWorker(this.env, (tx) => this.fail(tx, c));
      return "failed";
    }
    this.validators.set(c.id, { ...(res.etag === undefined ? {} : { etag: res.etag }), ...(res.lastModified === undefined ? {} : { lastModified: res.lastModified }) });
    return asWatchWorker(this.env, async (tx) => {
      let n = 0;
      for (const it of res.items) if (await this.ingestItem(tx, c, it, methodOf(c.type), res.status)) n++;
      await this.schedule(tx, c, true);
      if (n > 0) await emit(this.env, tx, "channel_snapshot.ingested", "channel_connection", c.id, { store_id: c.store_id, snapshots: n });
      return "synced" as const;
    });
  }

  /** Upserts the external product; writes a snapshot only on change or when the last one is older than a day. Invalid items are dropped (API10). */
  private async ingestItem(tx: Queryable, c: Due, it: ExternalItem, method: "api" | "feed" | "crawler", status: number): Promise<boolean> {
    if (!itemSchema.safeParse(it).success) return false;
    if (!this.env.marketCurrencies.includes(it.currency)) return false; // A2: a snapshot in a foreign currency is never evidence for this market
    const now = this.env.now();
    const p = await tx.query<{ id: string }>(
      `INSERT INTO external_products (id, connection_id, store_id, market_id, external_ref, external_variant_ref, url, title, gtin, image_phash, last_price_minor, currency, last_seen_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       ON CONFLICT (connection_id, external_ref, COALESCE(external_variant_ref, '')) DO UPDATE SET url = EXCLUDED.url, title = EXCLUDED.title, gtin = EXCLUDED.gtin,
         image_phash = COALESCE(EXCLUDED.image_phash, external_products.image_phash), last_price_minor = EXCLUDED.last_price_minor, currency = EXCLUDED.currency, last_seen_at = EXCLUDED.last_seen_at
       RETURNING id`,
      [this.env.newId(), c.id, c.store_id, this.env.marketId, it.externalRef, it.variantRef ?? null, it.url ?? null, it.title ?? null, it.gtin ?? null, it.imagePhash === undefined ? null : Buffer.from(it.imagePhash), it.priceMinor.toString(), it.currency, now],
    );
    const pid = p.rows[0]?.id;
    if (pid === undefined) return false;
    const last = await tx.query<{ price_minor: string; compare_at_minor: string | null; in_stock: boolean; fetched_at: Date | string }>(
      "SELECT price_minor::text, compare_at_minor::text, in_stock, fetched_at FROM channel_snapshots WHERE external_product_id = $1 ORDER BY fetched_at DESC LIMIT 1", [pid]);
    const l = last.rows[0];
    const same = l !== undefined && BigInt(l.price_minor) === it.priceMinor && (l.compare_at_minor === null ? null : BigInt(l.compare_at_minor)) === (it.compareAtMinor ?? null) && l.in_stock === it.inStock && now.getTime() - new Date(l.fetched_at).getTime() < DAY;
    if (same) return false;
    await tx.query(
      `INSERT INTO channel_snapshots (id, fetched_at, connection_id, external_product_id, store_id, market_id, price_minor, compare_at_minor, currency, in_stock, method, http_status, dom_hash, parser_version)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'v1')`,
      [this.env.newId(), now, c.id, pid, c.store_id, this.env.marketId, it.priceMinor.toString(), it.compareAtMinor?.toString() ?? null, it.currency, it.inStock, method, status, it.domHash === undefined ? null : Buffer.from(it.domHash)],
    );
    return true;
  }
}
