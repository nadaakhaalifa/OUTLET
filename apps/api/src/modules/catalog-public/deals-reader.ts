import { decodeCursor, encodeCursor } from "@outlet/catalog";
import { withDbContext } from "@outlet/db";
import type { RoleSqlClient } from "@outlet/db";
import { WINDOW_MS, computeWindow, displayDecision, vrpFromInternal } from "@outlet/pricing-integrity";
import type { PriceEventInput } from "@outlet/pricing-integrity";
import { CARD_TS } from "./discovery-reader.js";
import { DealCardPage } from "./dto.js";
import type { DealsQuery } from "./dto.js";

export interface DealsPort {
  list(q: Pick<DealsQuery, "band" | "cursor" | "limit">): Promise<DealCardPage>;
}

export interface DealsDeps {
  readonly client: RoleSqlClient<"outlet_app">;
  readonly marketId: string;
  readonly now: () => Date;
  /** True while the Price Watch kill switch is off, or when it cannot be read: fail closed, no deals. */
  readonly priceWatchKilled: () => Promise<boolean>;
  readonly mediaUrl?: (mediaId: string) => string;
}

/** Candidates examined per page request. A page may hold fewer than `limit` items and still carry a cursor (honest, bounded work). */
export const SCAN_MAX = 100;

/** Inclusive percent ranges. The top band is open-ended: a verified 85% discount is shown in 70_60, never hidden. */
const BAND_RANGE: Readonly<Record<NonNullable<DealsQuery["band"]>, readonly [number, number]>> = { "70_60": [60, 100], "59_50": [50, 59], "49_40": [40, 49] };
const ANY_BAND: readonly [number, number] = [40, 100];

interface CandidateRow {
  id: string;
  store_ref: string;
  store_slug: string;
  title_ar: string;
  title_en: string | null;
  main_media_id: string | null;
  main_media_alt_ar: string | null;
  condition_grade_code: string;
  defect_count: number;
  currency: string;
  sku_id: string | null;
  cur_t: string;
}

interface EventRow {
  sku_id: string;
  id: string;
  price_minor: string;
  valid_from: Date | string;
  first_seen: Date | string;
}

/**
 * Deals by verified-discount band. Percentages come only from @outlet/pricing-integrity (computeWindow, vrpFromInternal and
 * displayDecision, the same functions PriceEvidencePublic uses), evaluated in one batched read instead of one per SKU.
 * An item is listed only when displayDecision says showPercent with label "verified" for an anonymous viewer under a
 * store in `public` mode; plain, lowest-30d, launch and unverified items never appear. Until Price Watch has >= 30 days of
 * history nothing qualifies, so the bands are honestly empty. Statements: candidates, then events (1 or 2).
 */
export class DealsReader implements DealsPort {
  private readonly mediaUrl: (id: string) => string;
  constructor(private readonly deps: DealsDeps) {
    this.mediaUrl = deps.mediaUrl ?? ((id) => `/media/${id}`);
  }

  async list(q: Pick<DealsQuery, "band" | "cursor" | "limit">): Promise<DealCardPage> {
    const empty = DealCardPage.parse({ items: [], next_cursor: null });
    if (await this.deps.priceWatchKilled()) return empty;
    const cur = decodeCursor(q.cursor);
    const [lo, hi] = q.band === undefined ? ANY_BAND : BAND_RANGE[q.band];
    const now = this.deps.now();
    const market = this.deps.marketId.toLowerCase();
    return await withDbContext(this.deps.client, { kind: "user", marketId: this.deps.marketId }, async (tx) => {
      const params: unknown[] = [this.deps.marketId];
      if (cur !== undefined) params.push(cur.t, cur.id);
      params.push(SCAN_MAX + 1);
      const cursorSql = cur === undefined ? "" : " AND (l.published_at, l.id) < ($2::timestamptz, $3::uuid)";
      const limitParam = cur === undefined ? "$2" : "$4";
      const cands = (
        await tx.query<CandidateRow>(
          `SELECT l.id, l.store_ref, l.store ->> 'slug' AS store_slug, l.title_ar, l.title_en, l.main_media_id, l.main_media_alt_ar, l.condition_grade_code,
                  l.defect_count, l.currency,
                  (SELECT v ->> 'sku_id' FROM jsonb_array_elements(l.variants) v ORDER BY (v ->> 'price_minor')::bigint, v ->> 'sku_id' LIMIT 1) AS sku_id,
                  ${CARD_TS} AS cur_t
             FROM catalog_public_listings l
             JOIN catalog_public_stores s ON s.id = l.store_ref AND s.market_id = l.market_id
            WHERE l.market_id = $1 AND l.status = 'PUBLISHED' AND s.status = 'ACTIVE' AND s.discount_display_mode = 'public'${cursorSql}
            ORDER BY l.published_at DESC, l.id DESC LIMIT ${limitParam}`,
          params,
        )
      ).rows;
      const scanned = cands.slice(0, SCAN_MAX);
      const skuIds = [...new Set(scanned.flatMap((c) => (c.sku_id === null ? [] : [c.sku_id])))];
      if (skuIds.length === 0) return empty;
      const since = new Date(now.getTime() - 2 * WINDOW_MS - 86_400_000);
      const events = (
        await tx.query<EventRow>(
          `SELECT e.sku_id, e.id, e.price_minor::text AS price_minor, e.valid_from,
                  (SELECT min(f.valid_from) FROM price_events f WHERE f.sku_id = e.sku_id AND f.market_id = e.market_id AND f.source = 'internal') AS first_seen
             FROM price_events e
            WHERE e.sku_id = ANY($1::uuid[]) AND e.market_id = $2 AND e.source = 'internal' AND (e.valid_to IS NULL OR e.valid_to >= $3)
            ORDER BY e.sku_id, e.valid_from ASC, e.id ASC`,
          [skuIds, this.deps.marketId, since],
        )
      ).rows;
      const bySku = new Map<string, { events: PriceEventInput[]; firstSeen: Date }>();
      for (const e of events) {
        const g = bySku.get(e.sku_id) ?? { events: [], firstSeen: new Date(e.first_seen) };
        g.events.push({ id: e.id, priceMinor: BigInt(e.price_minor), validFrom: new Date(e.valid_from) });
        bySku.set(e.sku_id, g);
      }

      const items: unknown[] = [];
      let consumed = 0;
      for (const c of scanned) {
        consumed++;
        const g = c.sku_id === null ? undefined : bySku.get(c.sku_id);
        if (g === undefined || c.sku_id === null) continue;
        const w = computeWindow(g.events, now, { firstSeenAt: g.firstSeen });
        if (w.currentPrice === null) continue;
        const vrp = vrpFromInternal(w, now);
        const d = displayDecision({ vrp, price: w.currentPrice, launch: w.launchPrice, brandMode: "public", viewer: "anonymous", isLowest30d: w.isLowest30d });
        if (!d.showPercent || d.label !== "verified" || d.pct === undefined || vrp === null || d.pct < lo || d.pct > hi) continue;
        items.push({
          product_id: c.id,
          sku_id: c.sku_id,
          store_id: c.store_ref,
          store_slug: c.store_slug,
          title_ar: c.title_ar,
          title_en: c.title_en,
          image: c.main_media_id === null ? null : { media_id: c.main_media_id, url: this.mediaUrl(c.main_media_id), alt_ar: c.main_media_alt_ar },
          condition_grade_code: c.condition_grade_code,
          defect_count: c.defect_count,
          price: {
            current_price: { amount_minor: w.currentPrice.toString(), currency: c.currency },
            claim_type: "verified_discount",
            reference_price: { amount_minor: vrp.toString(), currency: c.currency },
            display_discount_bp: d.pct * 100,
            evidence_checked_at: now.toISOString(),
            price_proof_path: `/${market}/products/${c.id}/price-evidence`,
          },
          canonical_path: `/${market}/products/${c.id}`,
        });
        if (items.length === q.limit) break;
      }
      // Resume after the last candidate examined, so the next page never rescans what was already judged.
      const lastSeen = scanned[consumed - 1];
      const more = consumed < scanned.length || cands.length > SCAN_MAX;
      return DealCardPage.parse({ items, next_cursor: more && lastSeen !== undefined ? encodeCursor({ t: lastSeen.cur_t, id: lastSeen.id }) : null });
    });
  }
}
