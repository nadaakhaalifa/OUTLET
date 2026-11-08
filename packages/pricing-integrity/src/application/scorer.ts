import type { Queryable } from "@outlet/db";
import { enforcementLadder } from "../domain/ladder.js";
import type { LadderParams } from "../domain/ladder.js";
import type { LadderAction, Violation, ViolationRule } from "../domain/ladder.js";
import { detectDuplicateReset, detectImageReuse, detectPingPong, detectPreDropSpike, detectSuddenDiscount } from "../domain/anomaly.js";
import type { MegaEvent } from "../domain/anomaly.js";
import { STALE_EVIDENCE_MS, TAU_BP, externalWindow, vrpWithExternal } from "../domain/external.js";
import type { VrpResult } from "../domain/external.js";
import { parityCheck } from "../domain/parity.js";
import { priceTrustScore, riskTierOf } from "../domain/trust.js";
import { claimAllowed, discountPct } from "../domain/vrp.js";
import { loadHistory, windowFor } from "./env.js";
import { effectiveConfidenceBp } from "./matching.js";
import type { ListingFingerprintPort } from "./ports.js";
import { asWatchWorker, emit } from "./watch-env.js";
import type { WatchEnv } from "./watch-env.js";

export const RULE_VERSION = "pw-1";
const DAY = 86_400_000;
const HIDING: readonly string[] = ["remove_badge", "remove_all_pct", "lose_verified", "suspend_store"];

export interface ScoreRequest {
  readonly storeId: string;
  readonly skuId: string;
  /**
   * The "was" price the seller entered (never shown blindly): above the VRP it is a fake reference. A bigint is persisted (sku_claimed_reference)
   * and used; `undefined` loads the persisted claim (price-event re-scores, appeals with no new value); `null` clears it (the seller dropped the claim).
   */
  readonly claimedReferenceMinor?: bigint | null;
  readonly megaEvents?: readonly MegaEvent[];
  readonly sellThroughPct?: number;
}
export interface ScoreOutcome {
  readonly status: "scored" | "killed" | "no_history";
  readonly displayAllowed: boolean;
  readonly vrpMinor: bigint | null;
  readonly reason: string;
  readonly trustScore: number;
  readonly claimChanged: boolean;
  readonly findings: readonly string[];
  readonly actions: readonly LadderAction[];
}
const NONE: ScoreOutcome = { status: "killed", displayAllowed: false, vrpMinor: null, reason: "killed", trustScore: 0, claimChanged: false, findings: [], actions: [] };

export class ClaimScorer {
  constructor(
    private readonly env: WatchEnv,
    private readonly tauBp = TAU_BP,
    private readonly fingerprints?: ListingFingerprintPort,
    private readonly ladder?: LadderParams,
  ) {}

  /** Worker job (A3): re-scores every active claim whose evidence validity (`valid_until`) has passed, so a dead channel degrades to the plain price within one sweep. */
  async resweepExpiredClaims(now: Date = this.env.now(), limit = 200): Promise<{ rescored: number }> {
    if (await this.env.killSwitch.isKilled().catch(() => true)) return { rescored: 0 };
    const due = await asWatchWorker(this.env, async (tx) =>
      (await tx.query<{ sku_id: string; store_id: string }>("SELECT sku_id, store_id FROM price_claims WHERE status = 'active' AND market_id = $1 AND valid_until IS NOT NULL AND valid_until <= $2 ORDER BY valid_until LIMIT $3", [this.env.marketId, now, limit])).rows);
    for (const d of due) await this.scoreSku({ storeId: d.store_id, skuId: d.sku_id }, now);
    return { rescored: due.length };
  }

  /** Worker job (A10): expires time-boxed sanctions (lose_verified, commission_surcharge, block_drops, penalties) and re-scores the claims they were hiding. */
  async liftExpiredActions(now: Date = this.env.now(), limit = 200): Promise<{ lifted: number; rescored: number }> {
    if (await this.env.killSwitch.isKilled().catch(() => true)) return { lifted: 0, rescored: 0 };
    const lifted = await asWatchWorker(this.env, async (tx) =>
      (await tx.query<{ store_id: string }>("UPDATE enforcement_actions SET status = 'expired' WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at <= $1 AND market_id = $2 RETURNING store_id", [now, this.env.marketId])).rows);
    const stores = [...new Set(lifted.map((r) => r.store_id))];
    if (stores.length === 0) return { lifted: 0, rescored: 0 };
    const claims = await asWatchWorker(this.env, async (tx) =>
      (await tx.query<{ sku_id: string; store_id: string }>("SELECT sku_id, store_id FROM price_claims WHERE status = 'active' AND market_id = $1 AND reason = 'enforcement' AND store_id = ANY($2) LIMIT $3", [this.env.marketId, stores, limit])).rows);
    for (const c of claims) await this.scoreSku({ storeId: c.store_id, skuId: c.sku_id }, now);
    return { lifted: lifted.length, rescored: claims.length };
  }

  /** Re-scores one SKU on new evidence. Idempotent: an unchanged result writes nothing and emits nothing. Fails closed (no % off) on any doubt. */
  async scoreSku(req: ScoreRequest, at?: Date): Promise<ScoreOutcome> {
    if (await this.env.killSwitch.isKilled().catch(() => true)) return NONE;
    const ext = !(await this.env.crawlerKilled().catch(() => true));
    return asWatchWorker(this.env, (tx) => this.score(tx, req, ext, at ?? this.env.now()));
  }

  private async score(tx: Queryable, req: ScoreRequest, useExternal: boolean, now: Date): Promise<ScoreOutcome> {
    const { env } = this;
    const h = await loadHistory(tx, req.skuId, env.marketId, now);
    const w = windowFor(h, now);
    if (w.currentPrice === null || h.currency === undefined) return { ...NONE, status: "no_history", reason: "no_history" };
    const price = w.currentPrice;

    // Seller-entered "was" price: persisted, so a re-score that was not handed it (price event, appeal) still sees it (A1).
    const claimed = await this.claimedReference(tx, req, now);

    // External evidence per matched product (only AUTO or seller-confirmed matches count), joined to the connection that produced it.
    const matches = await tx.query<{ status: string; confidence_bp: number; external_product_id: string; conn_status: string }>(
      `SELECT m.status, m.confidence_bp, m.external_product_id, c.status AS conn_status FROM product_matches m
         JOIN external_products p ON p.id = m.external_product_id JOIN channel_connections c ON c.id = p.connection_id
        WHERE m.sku_id = $1 AND m.store_id = $2 AND m.status IN ('auto', 'seller_confirmed')`, [req.skuId, req.storeId]);
    let vrp: VrpResult = vrpWithExternal(w, null, 0, this.tauBp, { now });
    const considered: VrpResult[] = [];
    let parityBreach: ReturnType<typeof parityCheck> | null = null;
    let parityEvaluated = false;
    let earliestExpiry: number | null = null;
    let matchedChannelDown = false;
    const open = await tx.query<{ id: string; rule: string; detected_at: Date | string; sku_id: string | null }>("SELECT id, rule, detected_at, sku_id FROM price_findings WHERE store_id = $1 AND (sku_id = $2 OR sku_id IS NULL) AND status IN ('open', 'appealed')", [req.storeId, req.skuId]);
    const openParity = open.rows.find((f) => f.rule === "parity_breach");
    const breachSince = openParity === undefined ? null : new Date(openParity.detected_at);
    const evidence: string[] = [...w.referenceEvidenceIds];
    let staleExternal = false;
    const STALE: VrpResult = { vrp: null, referenceClass: "none", reason: "stale_external", brandRrp: null };
    for (const m of matches.rows) {
      // Per connection (A5): a disconnected or revoked channel that fed a match is a disconnection even when the store has another active one.
      if (m.conn_status === "disconnected" || m.conn_status === "revoked") {
        matchedChannelDown = true;
        continue;
      }
      if (!useExternal) continue;
      // A failed channel (unsafe target, or 3 failed runs in a row) is stale evidence now, not after 72 h.
      if (m.conn_status === "failed") {
        staleExternal = true;
        considered.push(STALE);
        continue;
      }
      // Same currency only (A2): a USD snapshot is never evidence against an EGP price.
      const snaps = await tx.query<{ id: string; price_minor: string; fetched_at: Date | string }>(
        "SELECT id, price_minor::text, fetched_at FROM channel_snapshots WHERE external_product_id = $1 AND currency = $2 AND fetched_at >= $3 AND fetched_at <= $4 ORDER BY fetched_at", [m.external_product_id, h.currency, new Date(now.getTime() - 62 * DAY), now]);
      const ew = externalWindow(snaps.rows.map((s) => ({ id: s.id, priceMinor: BigInt(s.price_minor), fetchedAt: new Date(s.fetched_at) })), now);
      const conf = effectiveConfidenceBp(m.status, m.confidence_bp);
      const r = vrpWithExternal(w, ew, conf, this.tauBp, { now });
      if (r.reason === "stale_external") staleExternal = true;
      if (conf >= this.tauBp) {
        const exp = ew.lastFetchedAt === null ? now.getTime() : ew.lastFetchedAt.getTime() + STALE_EVIDENCE_MS;
        earliestExpiry = earliestExpiry === null ? exp : Math.min(earliestExpiry, exp);
      }
      considered.push(r);
      const last = snaps.rows[snaps.rows.length - 1];
      if (last !== undefined) evidence.push(last.id);
      const par = parityCheck({ ourPrice: price, externalCurrent: ew.window.currentPrice, externalFetchedAt: ew.lastFetchedAt, matchConfBp: conf, tauBp: this.tauBp, now, breachSince });
      if (par.status === "ok" || par.status === "breach") parityEvaluated = true;
      if (par.status === "breach" && (parityBreach === null || par.action === "pause_sku")) parityBreach = par;
    }
    // Strictest wins: any withdrawn (null) reference beats a number, otherwise the lowest.
    const strictest = considered.reduce<VrpResult | null>((m, r) => (m === null || r.vrp === null || (m.vrp !== null && r.vrp < m.vrp) ? r : m), null);
    if (strictest !== null) vrp = strictest;

    // Store channel state: disconnecting to hide prices removes every % (fail closed).
    const conns = await tx.query<{ status: string }>("SELECT status FROM channel_connections WHERE store_id = $1", [req.storeId]);
    const hasActive = conns.rows.some((c) => c.status === "active");
    const disconnected = (!hasActive && conns.rows.some((c) => c.status === "disconnected" || c.status === "revoked")) || matchedChannelDown;

    // Rule detections for this SKU. `evaluated` is the set of rules whose inputs were actually available this pass: only those may
    // resolve an open finding (a re-score that could not look at a rule's input must never absolve it, A1).
    const series = h.rows.map((r) => ({ at: r.validFrom, priceMinor: r.priceMinor }));
    const triggered = new Map<ViolationRule, "info" | "violation">();
    const evaluated = new Set<ViolationRule>(["pre_discount_inflation", "ping_pong", "channel_disconnected"]);
    // A claim cannot be judged against a reference that was withdrawn for staleness (stale evidence is not an accusation).
    if (vrp.reason !== "stale_external") {
      evaluated.add("fake_reference");
      if (claimed !== null && (vrp.vrp === null || claimed > vrp.vrp)) triggered.set("fake_reference", "violation");
    }
    if (detectPreDropSpike(series, now) !== null) triggered.set("pre_discount_inflation", "violation");
    if (parityEvaluated) evaluated.add("parity_breach");
    if (parityBreach !== null) triggered.set("parity_breach", "violation");
    if (disconnected) triggered.set("channel_disconnected", "violation");
    if (detectPingPong(series) !== null) triggered.set("ping_pong", "info");
    if (req.megaEvents !== undefined) {
      evaluated.add("sudden_discount");
      if (detectSuddenDiscount(series, req.megaEvents, req.sellThroughPct ?? 100) !== null) triggered.set("sudden_discount", "info");
    }
    if (this.fingerprints !== undefined) {
      const fp = await this.fingerprints.forSku(req.skuId, req.storeId).catch(() => null);
      if (fp !== null) {
        evaluated.add("duplicate_reset");
        evaluated.add("image_reuse");
        if (detectDuplicateReset(fp.listing, fp.sameStore) !== null) triggered.set("duplicate_reset", "info");
        if (detectImageReuse(fp.listing, fp.otherStores) !== null) triggered.set("image_reuse", "info");
      }
    }

    const findings: string[] = [];
    const actions: LadderAction[] = [];
    for (const [rule, severity] of triggered) {
      const storeLevel = rule === "channel_disconnected";
      const ins = await tx.query<{ id: string }>(
        `INSERT INTO price_findings (id, store_id, market_id, sku_id, rule, severity, evidence_ids, status, detected_at) VALUES ($1, $2, $3, $4, $5, $6, $7, 'open', $8)
         ON CONFLICT DO NOTHING RETURNING id`,
        [env.newId(), req.storeId, env.marketId, storeLevel ? null : req.skuId, rule, severity, evidence.filter((e) => /^[0-9a-f-]{36}$/.test(e)), now]);
      const fid = ins.rows[0]?.id ?? open.rows.find((f) => f.rule === rule)?.id;
      if (ins.rows[0] !== undefined) findings.push(rule);
      if (fid === undefined || severity === "info") continue;
      const unfixed = rule === "parity_breach" && parityBreach?.action === "pause_sku";
      if (ins.rows[0] === undefined && !unfixed) continue;
      actions.push(...(await this.enforce(tx, req.storeId, req.skuId, fid, unfixed ? "parity_unfixed" : rule, now)));
    }
    // Conditions that no longer hold resolve their findings and lift the reversible actions, but only when the rule was actually evaluated.
    for (const f of open.rows) {
      if (evaluated.has(f.rule as ViolationRule) && !triggered.has(f.rule as ViolationRule)) {
        await tx.query("UPDATE price_findings SET status = 'resolved', resolved_at = $2 WHERE id = $1", [f.id, now]);
        await tx.query("UPDATE enforcement_actions SET status = 'lifted' WHERE finding_id = $1 AND status = 'active' AND action IN ('demote', 'pause_sku', 'remove_all_pct', 'autocorrect_display')", [f.id]);
      }
    }

    const trust = await this.trust(tx, req.storeId, hasActive, staleExternal, now);
    // Check cadence follows the trust tier (spec 4): the scorer, not the ingestor, owns risk_tier.
    await tx.query("UPDATE channel_connections SET risk_tier = $2, updated_at = $3 WHERE store_id = $1 AND risk_tier <> $2", [req.storeId, riskTierOf(trust), now]);
    const hiding = (await tx.query<{ n: string }>("SELECT count(*)::text AS n FROM enforcement_actions WHERE store_id = $1 AND (sku_id IS NULL OR sku_id = $2) AND status IN ('active', 'pending_review') AND action = ANY($3) AND (expires_at IS NULL OR expires_at > $4)", [req.storeId, req.skuId, [...HIDING], now])).rows[0]?.n !== "0";
    const allowed = vrp.vrp !== null && claimAllowed(vrp.vrp, price) && !disconnected && !hiding && !w.launchPrice;
    const pct = vrp.vrp === null ? 0 : discountPct(vrp.vrp, price);
    const claimType = w.launchPrice ? "launch_price" : allowed ? "verified_discount" : w.isLowest30d ? "lowest_30d" : "plain";
    const reason = disconnected ? "channel_disconnected" : hiding ? "enforcement" : vrp.reason;
    const changed = await this.writeClaim(tx, req, { price, vrp: vrp.vrp, currency: h.currency, cls: vrp.referenceClass, pct, claimType, allowed, trust, reason, evidence, validUntil: staleExternal || earliestExpiry === null ? null : new Date(earliestExpiry), now });
    return { status: "scored", displayAllowed: allowed, vrpMinor: vrp.vrp, reason, trustScore: trust, claimChanged: changed, findings, actions };
  }

  /** Persists a claim handed to the scorer (bigint upserts, null clears) and returns the claim in force; undefined loads what is stored. */
  private async claimedReference(tx: Queryable, req: ScoreRequest, now: Date): Promise<bigint | null> {
    if (typeof req.claimedReferenceMinor === "bigint") {
      await tx.query(
        `INSERT INTO sku_claimed_reference (sku_id, store_id, market_id, claimed_minor, set_at) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (sku_id, market_id) DO UPDATE SET claimed_minor = EXCLUDED.claimed_minor, set_at = EXCLUDED.set_at WHERE sku_claimed_reference.store_id = EXCLUDED.store_id`,
        [req.skuId, req.storeId, this.env.marketId, req.claimedReferenceMinor.toString(), now]);
      return req.claimedReferenceMinor;
    }
    if (req.claimedReferenceMinor === null) {
      await tx.query("DELETE FROM sku_claimed_reference WHERE sku_id = $1 AND market_id = $2 AND store_id = $3", [req.skuId, this.env.marketId, req.storeId]);
      return null;
    }
    const r = await tx.query<{ claimed_minor: string }>("SELECT claimed_minor::text FROM sku_claimed_reference WHERE sku_id = $1 AND market_id = $2 AND store_id = $3", [req.skuId, this.env.marketId, req.storeId]);
    return r.rows[0] === undefined ? null : BigInt(r.rows[0].claimed_minor);
  }

  private async enforce(tx: Queryable, storeId: string, skuId: string, findingId: string, rule: ViolationRule, now: Date): Promise<LadderAction[]> {
    const hist = await tx.query<{ rule: ViolationRule; detected_at: Date | string; severity: string }>(
      "SELECT rule, detected_at, severity FROM price_findings WHERE store_id = $1 AND severity IN ('violation', 'severe') AND id <> $2 AND detected_at >= $3", [storeId, findingId, new Date(now.getTime() - 90 * DAY)]);
    const history: Violation[] = hist.rows.map((r) => ({ rule: r.rule, at: new Date(r.detected_at), severe: r.severity === "severe" }));
    const d = enforcementLadder({ rule, at: now }, history, now, this.ladder);
    const done: LadderAction[] = [];
    for (const a of d.acts) {
      const sku = a.action === "lose_verified" || a.action === "commission_surcharge" || a.action === "block_drops" || a.action === "suspend_store" || a.action === "remove_all_pct" ? null : skuId;
      const review = a.action === "suspend_store";
      const r = await tx.query<{ id: string }>(
        `INSERT INTO enforcement_actions (id, store_id, market_id, finding_id, sku_id, action, starts_at, expires_at, status, human_review_required)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT (finding_id, action) DO NOTHING RETURNING id`,
        [this.env.newId(), storeId, this.env.marketId, findingId, sku, a.action, now, a.expiresAt, review ? "pending_review" : "active", review]);
      if (r.rows[0] === undefined) continue;
      done.push(a.action);
      await emit(this.env, tx, "price_enforcement.applied", "enforcement_action", r.rows[0].id, { store_id: storeId, finding_id: findingId, action: a.action, human_review_required: review, review_due_by: review ? (d.reviewDueBy?.toISOString() ?? null) : null });
      // Ladder step "payouts held per Seller Agreement" (master 9.5): a request for the payouts module to consume; this package never touches payouts.
      if (a.action === "suspend_store") await emit(this.env, tx, "payouts.hold_requested", "store", storeId, { store_id: storeId, reason: "price_enforcement_suspension", finding_id: findingId, enforcement_action_id: r.rows[0].id, review_due_by: d.reviewDueBy?.toISOString() ?? null });
    }
    return done;
  }

  private async trust(tx: Queryable, storeId: string, hasActive: boolean, stale: boolean, now: Date): Promise<number> {
    const r = await tx.query<{ rule: string; status: string; severity: string }>("SELECT rule, status, severity FROM price_findings WHERE store_id = $1 AND detected_at >= $2", [storeId, new Date(now.getTime() - 90 * DAY)]);
    const n = (f: (x: { rule: string; status: string; severity: string }) => boolean): number => r.rows.filter(f).length;
    return priceTrustScore({
      fakeReferences90d: n((x) => x.rule === "fake_reference"), inflations90d: n((x) => x.rule === "pre_discount_inflation"),
      openParityBreach: n((x) => x.rule === "parity_breach" && (x.status === "open" || x.status === "appealed")) > 0,
      resolvedParityBreaches90d: n((x) => x.rule === "parity_breach" && x.status === "resolved"),
      anomalySignals: n((x) => x.severity === "info" && x.status === "open"), hasVerifiedChannel: hasActive, staleEvidence: stale, upheldAppeals90d: n((x) => x.status === "upheld"),
    });
  }

  private async writeClaim(tx: Queryable, req: ScoreRequest, c: { price: bigint; vrp: bigint | null; currency: string; cls: string; pct: number; claimType: string; allowed: boolean; trust: number; reason: string; evidence: readonly string[]; validUntil: Date | null; now: Date }): Promise<boolean> {
    const cur = await tx.query<{ id: string; price_minor: string; vrp_minor: string | null; reference_class: string; claim_type: string; display_allowed: boolean; trust_score: number; reason: string }>(
      "SELECT id, price_minor::text, vrp_minor::text, reference_class, claim_type, display_allowed, trust_score, reason FROM price_claims WHERE sku_id = $1 AND market_id = $2 AND status = 'active'", [req.skuId, this.env.marketId]);
    const o = cur.rows[0];
    if (o !== undefined && BigInt(o.price_minor) === c.price && (o.vrp_minor === null ? null : BigInt(o.vrp_minor)) === c.vrp && o.reference_class === c.cls && o.claim_type === c.claimType && o.display_allowed === c.allowed && o.trust_score === c.trust && o.reason === c.reason) return false;
    if (o !== undefined) await tx.query("UPDATE price_claims SET status = 'superseded' WHERE id = $1", [o.id]);
    const id = this.env.newId();
    await tx.query(
      `INSERT INTO price_claims (id, sku_id, store_id, market_id, price_minor, vrp_minor, currency, reference_class, discount_bp, claim_type, display_allowed, trust_score, status, rule_version, reason, evidence_ids, scored_at, valid_until)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'active', $13, $14, $15, $16, $17)`,
      [id, req.skuId, req.storeId, this.env.marketId, c.price.toString(), c.vrp?.toString() ?? null, c.currency, c.cls, c.pct * 100, c.claimType, c.allowed, c.trust, RULE_VERSION, c.reason, c.evidence.filter((e) => /^[0-9a-f-]{36}$/.test(e)), c.now, c.validUntil]);
    await emit(this.env, tx, "price_claim.scored", "price_claim", id, { store_id: req.storeId, sku_id: req.skuId, display_allowed: c.allowed, reference_class: c.cls, trust_score: c.trust, reason: c.reason });
    return true;
  }
}
