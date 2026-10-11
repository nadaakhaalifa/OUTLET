import { createHash } from "node:crypto";
import {
  DEFAULT_TAU_BP,
  MAX_REDIRECTS,
  MAX_RESPONSE_BYTES,
  MIN_REQUEST_GAP_MS,
  MS_PER_DAY,
  ROBOTS_CACHE_MS,
  SNAPSHOT_WINDOW_DAYS,
  assertResolvedPublic,
  breakerCanAttempt,
  breakerOnFailure,
  chooseTau,
  connectedAddressMatches,
  deriveExternalEvidence,
  gateEvidence,
  isEvidenceStale,
  isPathAllowed,
  isPlausiblePublicDomain,
  labelledSetReady,
  robotsFromFetch,
  scoreMatch,
  shouldStoreSnapshot,
  snapshotDelta,
  validateEgressUrl,
  validateRedirect,
  type DomainPacer,
  type EgressTarget,
  type PriceSnapshot,
} from "../domain/matching";
import type {
  AttributeCheckPort,
  ChannelKind,
  ChannelRecord,
  CrawlEvent,
  CrawlFlagsPort,
  CrawlMetrics,
  CrawlStore,
  DnsResolverPort,
  DomainVerifierPort,
  EmbeddingIndexPort,
  FingerprintSource,
  HttpFetchPort,
  IncidentKind,
  MatchRecord,
  OfferParserPort,
  TargetRecord,
  TokenVaultPort,
  VerificationMethod,
} from "../domain/ports";

export const sha256Hex = (s: string): string => createHash("sha256").update(s).digest("hex");

export const USER_AGENT_TOKEN = "zoutletbot";
export const MODEL_VERSION = "match-v1";

export interface CrawlerDeps {
  readonly store: CrawlStore;
  readonly flags: CrawlFlagsPort;
  readonly fetcher: HttpFetchPort;
  readonly dns: DnsResolverPort;
  readonly parser: OfferParserPort;
  readonly verifier: DomainVerifierPort;
  readonly vault: TokenVaultPort;
  readonly embeddings: EmbeddingIndexPort;
  readonly attributes: AttributeCheckPort;
  readonly fingerprints: FingerprintSource;
  readonly metrics: CrawlMetrics;
  readonly clock: { nowMs(): number };
  readonly ids: { uuidV7(): string; hex(bytes: number): string };
  /** One pacer per worker process; the durable queue is outside this module. */
  readonly pacer: DomainPacer;
}

// ---- register / verify ----

export type RegisterTargetResult =
  | { readonly kind: "created"; readonly target: TargetRecord; readonly verificationToken: string }
  | { readonly kind: "exists"; readonly target: TargetRecord }
  | { readonly kind: "invalid_domain" | "consent_required" };

export class RegisterCrawlTarget {
  constructor(private readonly d: CrawlerDeps) {}
  async execute(i: {
    readonly storeId: string;
    readonly domain: string;
    readonly method: VerificationMethod;
    readonly kind?: "seller" | "brand_rrp";
    readonly consent: boolean;
  }): Promise<RegisterTargetResult> {
    if (!i.consent) return { kind: "consent_required" };
    const domain = i.domain.trim().toLowerCase();
    if (!isPlausiblePublicDomain(domain)) return { kind: "invalid_domain" };
    const token = `zo-verify-${this.d.ids.hex(16)}`;
    const now = this.d.clock.nowMs();
    const t: TargetRecord = {
      id: this.d.ids.uuidV7(),
      storeId: i.storeId,
      domain,
      kind: i.kind ?? "seller",
      status: "pending_verification",
      verificationMethod: i.method,
      verificationTokenHash: sha256Hex(token),
      consentAtMs: now,
      verifiedAtMs: null,
      robotsTxt: null,
      robotsStatus: null,
      robotsFetchedAtMs: null,
      breakerFailures: 0,
      breakerOpenedAtMs: null,
      lastEtag: null,
    };
    const r = await this.d.store.insertTarget(t);
    return r.kind === "created" ? { kind: "created", target: r.target, verificationToken: token } : { kind: "exists", target: r.target };
  }
}

export type VerifyTargetResult = { readonly kind: "verified" | "already_verified" | "not_found" | "token_missing" | "token_mismatch" | "revoked" };

export class VerifyCrawlTarget {
  constructor(private readonly d: CrawlerDeps) {}
  async execute(storeId: string, targetId: string): Promise<VerifyTargetResult> {
    const t = await this.d.store.getTarget(targetId);
    if (t === null || t.storeId !== storeId) return { kind: "not_found" };
    if (t.status === "verified") return { kind: "already_verified" };
    if (t.status === "revoked" || t.status === "blocked") return { kind: "revoked" };
    const found = await this.d.verifier.findToken(t.domain, t.verificationMethod);
    if (found === null) return { kind: "token_missing" };
    if (sha256Hex(found) !== t.verificationTokenHash) return { kind: "token_mismatch" };
    await this.d.store.updateTarget({ ...t, status: "verified", verifiedAtMs: this.d.clock.nowMs() }, [
      { type: "crawl_target.verified", targetId: t.id, storeId: t.storeId },
    ]);
    return { kind: "verified" };
  }
}

// ---- channels ----

const TOKEN_REF = /^[A-Za-z0-9:/_.-]{8,256}$/;

export type ConnectChannelResult =
  | { readonly kind: "connected"; readonly channel: ChannelRecord }
  | { readonly kind: "invalid_ref" | "secret_missing" | "target_required" };

export class ConnectChannel {
  constructor(private readonly d: CrawlerDeps) {}
  async execute(i: {
    readonly storeId: string;
    readonly kind: ChannelKind;
    readonly tokenRef: string;
    readonly kmsKeyRef: string;
    readonly targetId: string | null;
  }): Promise<ConnectChannelResult> {
    if (!TOKEN_REF.test(i.tokenRef) || !TOKEN_REF.test(i.kmsKeyRef)) return { kind: "invalid_ref" };
    if (i.kind === "crawler") {
      const t = i.targetId === null ? null : await this.d.store.getTarget(i.targetId);
      if (t === null || t.storeId !== i.storeId || t.status !== "verified") return { kind: "target_required" };
    }
    if (!(await this.d.vault.exists(i.tokenRef, i.kmsKeyRef))) return { kind: "secret_missing" };
    const channel: ChannelRecord = {
      id: this.d.ids.uuidV7(),
      storeId: i.storeId,
      kind: i.kind,
      status: "active",
      tokenRef: i.tokenRef,
      kmsKeyRef: i.kmsKeyRef,
      targetId: i.kind === "crawler" ? i.targetId : null,
      createdAtMs: this.d.clock.nowMs(),
      revokedAtMs: null,
    };
    await this.d.store.insertChannel(channel);
    return { kind: "connected", channel };
  }
}

export class RefreshChannelToken {
  constructor(private readonly d: CrawlerDeps) {}
  async execute(channelId: string): Promise<{ readonly kind: "refreshed" | "revoked" | "not_found" | "inactive" }> {
    const c = await this.d.store.getChannel(channelId);
    if (c === null) return { kind: "not_found" };
    if (c.status !== "active") return { kind: "inactive" };
    const r = await this.d.vault.refresh(c.tokenRef, c.kmsKeyRef);
    if (r.kind === "refreshed") {
      await this.d.store.updateChannel({ ...c, tokenRef: r.tokenRef }, []);
      return { kind: "refreshed" };
    }
    await this.d.store.updateChannel({ ...c, status: "revoked", revokedAtMs: this.d.clock.nowMs() }, [
      { type: "channel.token_revoked", channelId: c.id, storeId: c.storeId },
    ]);
    return { kind: "revoked" };
  }
}

// ---- crawl one product page ----

export type CrawlResult =
  | { readonly kind: "stored" | "unchanged"; readonly snapshotId: string | null }
  | { readonly kind: "disabled" | "target_unavailable" | "breaker_open" | "robots_disallowed" | "parse_failed" | "fetch_failed" }
  | { readonly kind: "refused"; readonly reason: string }
  | { readonly kind: "rate_limited"; readonly retryAtMs: number };

/**
 * Politeness and SSRF pipeline for one URL. Order: kill switch, target verified, breaker, robots
 * (24 h cache), URL validation against the store's verified domains, DNS resolve + public check
 * (pinned), pacing (>= 5 s per domain), fetch, redirects re-validated hop by hop, DNS and connected
 * address re-check (rebinding), size cap, parse, dedupe (ETag, DOM hash), store.
 */
export class CrawlProduct {
  constructor(private readonly d: CrawlerDeps) {}

  private async incident(t: TargetRecord, kind: IncidentKind, host: string, url: string, detail: string | null): Promise<void> {
    const id = this.d.ids.uuidV7();
    await this.d.store.addIncident({ id, targetId: t.id, storeId: t.storeId, kind, host, urlHash: sha256Hex(url), detail }, [
      { type: "crawl.incident", incidentId: id, kind },
    ]);
    this.d.metrics.increment("crawl_incident", { kind });
  }

  private async fail(t: TargetRecord, now: number): Promise<void> {
    const s = breakerOnFailure({ failures: t.breakerFailures, openedAtMs: t.breakerOpenedAtMs }, now);
    await this.d.store.updateTarget({ ...t, breakerFailures: s.failures, breakerOpenedAtMs: s.openedAtMs }, []);
  }

  private async robotsFor(t: TargetRecord, now: number): Promise<TargetRecord> {
    if (t.robotsFetchedAtMs !== null && now - t.robotsFetchedAtMs < ROBOTS_CACHE_MS) return t;
    let status: number | null = null;
    let body = "";
    try {
      const url = `https://${t.domain}/robots.txt`;
      const v = validateEgressUrl(url, new Set([t.domain]));
      if (v.ok) {
        const addrs = await this.d.dns.resolve(v.target.host);
        const res = assertResolvedPublic(addrs);
        if (res.ok) {
          const r = await this.d.fetcher.get({ url, host: v.target.host, pinnedAddress: res.pinned, ifNoneMatch: null, maxBytes: 512_000 });
          if (connectedAddressMatches(res.pinned, r.connectedAddress)) {
            status = r.status;
            body = r.body;
          }
        }
      }
    } catch {
      status = null;
    }
    const next: TargetRecord = { ...t, robotsTxt: body, robotsStatus: status, robotsFetchedAtMs: now };
    await this.d.store.updateTarget(next, []);
    return next;
  }

  async execute(i: { readonly targetId: string; readonly skuRef: string; readonly url: string }): Promise<CrawlResult> {
    const now = this.d.clock.nowMs();
    if (!(await this.d.flags.crawlingEnabled())) return { kind: "disabled" };
    let t = await this.d.store.getTarget(i.targetId);
    if (t === null || t.status !== "verified") return { kind: "target_unavailable" };
    if (!breakerCanAttempt({ failures: t.breakerFailures, openedAtMs: t.breakerOpenedAtMs }, now)) return { kind: "breaker_open" };

    const verified = new Set(await this.d.store.verifiedDomains(t.storeId));
    const first = validateEgressUrl(i.url, verified);
    if (!first.ok) {
      await this.incident(t, "ssrf_refused", t.domain, i.url, first.reason);
      return { kind: "refused", reason: first.reason };
    }
    t = await this.robotsFor(t, now);
    const policy = robotsFromFetch(t.robotsStatus, t.robotsTxt ?? "", USER_AGENT_TOKEN);
    if (!isPathAllowed(policy, first.target.pathAndQuery)) {
      await this.incident(t, "robots_disallowed", first.target.host, i.url, null);
      return { kind: "robots_disallowed" };
    }
    const gap = Math.max(MIN_REQUEST_GAP_MS, policy.crawlDelaySeconds === null ? 0 : policy.crawlDelaySeconds * 1_000);
    const slot = this.d.pacer.reserve(t.domain, now, gap);
    if (slot > now) return { kind: "rate_limited", retryAtMs: slot };

    const prev = await this.d.store.latestSnapshot(t.id, i.skuRef);
    let target: EgressTarget = first.target;
    try {
      for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
        const addrs = await this.d.dns.resolve(target.host);
        const res = assertResolvedPublic(addrs);
        if (!res.ok) {
          await this.incident(t, "dns_rebinding", target.host, target.url, res.reason);
          return { kind: "refused", reason: res.reason };
        }
        const r = await this.d.fetcher.get({
          url: target.url,
          host: target.host,
          pinnedAddress: res.pinned,
          ifNoneMatch: hop === 0 ? (prev?.etag ?? null) : null,
          maxBytes: MAX_RESPONSE_BYTES,
        });
        const again = assertResolvedPublic(await this.d.dns.resolve(target.host));
        if (!connectedAddressMatches(res.pinned, r.connectedAddress) || !again.ok || again.pinned !== res.pinned) {
          await this.incident(t, "dns_rebinding", target.host, target.url, "connected_address_mismatch");
          return { kind: "refused", reason: "dns_rebinding" };
        }
        if (r.status === 304 && prev !== null) {
          await this.d.store.updateTarget({ ...t, ...CLOSED }, []);
          return { kind: "unchanged", snapshotId: prev.id };
        }
        if (r.status >= 300 && r.status < 400) {
          const loc = r.headers["location"];
          const next = loc === undefined ? null : validateRedirect(target, loc, hop + 1, verified);
          if (next === null || !next.ok) {
            await this.incident(t, "redirect_refused", target.host, target.url, next === null ? "no_location" : next.reason);
            return { kind: "refused", reason: next === null ? "no_location" : next.reason };
          }
          target = next.target;
          continue;
        }
        if (r.status === 403 || r.status === 429) {
          await this.incident(t, "blocked", target.host, target.url, String(r.status));
          await this.fail(t, now);
          return { kind: "fetch_failed" };
        }
        if (r.status < 200 || r.status >= 300) {
          await this.fail(t, now);
          return { kind: "fetch_failed" };
        }
        if (r.truncated) {
          await this.incident(t, "size_exceeded", target.host, target.url, null);
          return { kind: "refused", reason: "size_exceeded" };
        }
        const offer = this.d.parser.parse(r.body, target.url);
        if (offer === null || offer.priceAmount <= 0n) {
          await this.incident(t, "parser_error", target.host, target.url, null);
          return { kind: "parse_failed" };
        }
        const snap: PriceSnapshot | null =
          prev === null ? null : { id: prev.id, fetchedAtMs: prev.fetchedAtMs, priceAmount: prev.priceAmount, available: prev.available, domHash: prev.domHash };
        const delta = snapshotDelta(snap, offer);
        const etag = r.headers["etag"] ?? null;
        await this.d.store.updateTarget({ ...t, ...CLOSED, lastEtag: etag }, []);
        if (!shouldStoreSnapshot(snap, now, delta)) return { kind: "unchanged", snapshotId: prev?.id ?? null };
        const id = this.d.ids.uuidV7();
        await this.d.store.insertSnapshot(
          { id, targetId: t.id, storeId: t.storeId, skuRef: i.skuRef, priceAmount: offer.priceAmount, available: offer.available, domHash: offer.domHash, etag, fetchedAtMs: now },
          [{ type: "channel_snapshot.ingested", targetId: t.id, storeId: t.storeId, snapshotId: id }],
        );
        return { kind: "stored", snapshotId: id };
      }
      await this.incident(t, "redirect_refused", target.host, target.url, "too_many_redirects");
      return { kind: "refused", reason: "too_many_redirects" };
    } catch {
      await this.fail(t, now);
      this.d.metrics.increment("crawl_fetch_error");
      return { kind: "fetch_failed" };
    }
  }
}

const CLOSED = { breakerFailures: 0, breakerOpenedAtMs: null } as const;

// ---- match scoring ----

export type ScoreMatchResult =
  | { readonly kind: "scored"; readonly match: MatchRecord }
  | { readonly kind: "no_signal" | "sku_not_found" | "external_not_found" | "gtin_conflict" };

export class ScoreProductMatch {
  constructor(private readonly d: CrawlerDeps) {}
  async execute(i: { readonly skuId: string; readonly targetId: string; readonly externalRef: string }): Promise<ScoreMatchResult> {
    const own = await this.d.fingerprints.haulSku(i.skuId);
    if (own === null) return { kind: "sku_not_found" };
    const target = await this.d.store.getTarget(i.targetId);
    if (target === null || target.storeId !== own.storeId) return { kind: "external_not_found" };
    const ext = await this.d.fingerprints.externalProduct(i.targetId, i.externalRef);
    if (ext === null) return { kind: "external_not_found" };
    // The (costly) attribute check runs only when a cheap signal already exists.
    const probe = scoreMatch({ haul: own.fp, external: ext.fp, sameSeller: true, attributes: null });
    if (probe.method === "none") return { kind: probe.cap === "gtin_conflict" ? "gtin_conflict" : "no_signal" };
    const verdict = await this.d.attributes.check(own.facts, ext.facts).catch(() => null);
    const s = scoreMatch({ haul: own.fp, external: ext.fp, sameSeller: true, attributes: verdict });
    if (s.method === "none") return { kind: "no_signal" };
    const cfg = await this.d.store.getConfig();
    const gate = gateEvidence({ confBp: s.confBp, tauBp: cfg.tauBp, shadowOnly: cfg.shadowOnly });
    const match: MatchRecord = {
      id: this.d.ids.uuidV7(),
      skuId: i.skuId,
      storeId: own.storeId,
      targetId: i.targetId,
      externalRef: i.externalRef,
      method: s.method,
      rawBp: s.rawBp,
      confBp: s.confBp,
      capReason: s.cap,
      modelVersion: MODEL_VERSION,
      gate,
      scoredAtMs: this.d.clock.nowMs(),
    };
    await this.d.store.upsertMatch(match, [{ type: "product_match.scored", matchId: match.id, skuId: match.skuId, storeId: match.storeId, gate }]);
    this.d.metrics.increment("product_match_scored", { gate });
    return { kind: "scored", match };
  }
}

export class FindMatchCandidates {
  constructor(
    private readonly d: CrawlerDeps,
    private readonly score: ScoreProductMatch,
  ) {}
  /** ANN retrieval over the seller's own verified targets, then the waterfall for each candidate (k <= 10). */
  async execute(skuId: string, k = 5): Promise<readonly ScoreMatchResult[]> {
    const own = await this.d.fingerprints.haulSku(skuId);
    const emb = own?.fp.embedding;
    if (own === null || emb === undefined || emb === null) return [];
    const mine = new Set((await this.d.store.listTargets(own.storeId)).filter((t) => t.status === "verified").map((t) => t.id));
    const cands = await this.d.embeddings.nearest(emb, Math.min(Math.max(k, 1), 10));
    const out: ScoreMatchResult[] = [];
    for (const c of cands) {
      if (!mine.has(c.targetId)) continue;
      out.push(await this.score.execute({ skuId, targetId: c.targetId, externalRef: c.externalRef }));
    }
    return out;
  }
}

// ---- evidence for price-integrity ----

export interface ExternalEvidenceShape {
  readonly id: string;
  readonly lowPriceAmount: bigint;
  readonly currentPriceAmount: bigint | null;
  readonly matchConfBp: number;
  readonly historyDays: number;
  readonly observedAtMs: number;
}

/**
 * Evidence for the VRP: only `live` matches, only with a fresh snapshot. Anything older than 72 h is
 * simply absent, so the claim degrades to a plain price (fail closed). Shadow matches never leave.
 */
export class ExternalEvidenceReader {
  constructor(private readonly d: Pick<CrawlerDeps, "store" | "clock" | "flags">) {}
  async lookup(skuIds: readonly string[]): Promise<ReadonlyMap<string, ExternalEvidenceShape>> {
    const out = new Map<string, ExternalEvidenceShape>();
    if (skuIds.length === 0 || !(await this.d.flags.crawlingEnabled())) return out;
    const now = this.d.clock.nowMs();
    const matches = await this.d.store.matchesForSkus(skuIds, "live");
    for (const m of matches) {
      const snaps = await this.d.store.snapshotsSince(m.targetId, m.externalRef, now - SNAPSHOT_WINDOW_DAYS * MS_PER_DAY);
      const ev = deriveExternalEvidence(
        snaps.map((s) => ({ id: s.id, fetchedAtMs: s.fetchedAtMs, priceAmount: s.priceAmount, available: s.available, domHash: s.domHash })),
        now,
        `match:${m.id}`,
      );
      if (ev === null || isEvidenceStale(ev.observedAtMs, now)) continue;
      const shape: ExternalEvidenceShape = { id: ev.id, lowPriceAmount: ev.lowPriceAmount, currentPriceAmount: ev.currentPriceAmount, matchConfBp: m.confBp, historyDays: ev.historyDays, observedAtMs: ev.observedAtMs };
      const prev = out.get(m.skuId);
      // Strictest wins: the lower reference is the safer claim.
      if (prev === undefined || shape.lowPriceAmount < prev.lowPriceAmount) out.set(m.skuId, shape);
    }
    return out;
  }
}

// ---- config (dual approval) ----

export type ConfigChangeResult =
  | { readonly kind: "applied"; readonly tauBp: number; readonly shadowOnly: boolean }
  | { readonly kind: "same_approver" | "invalid_tau" | "labelled_set_not_ready" | "tau_below_validated" | "no_change" };

/**
 * Called by the platform dual-approval flow with two distinct admins. Leaving shadow mode needs a
 * labelled set (>= 2,000 pairs, kappa >= 0.8) AND a tau that is at least the one the validation
 * split justifies (spec 9.2, VR-13).
 */
export class ChangeMatchingConfig {
  constructor(
    private readonly d: CrawlerDeps,
    private readonly validation: () => Promise<readonly { readonly confBp: number; readonly same: boolean }[]>,
  ) {}
  async execute(i: { readonly tauBp: number; readonly shadowOnly: boolean; readonly proposedBy: string; readonly approvedBy: string; readonly reason: string }): Promise<ConfigChangeResult> {
    if (i.proposedBy === i.approvedBy) return { kind: "same_approver" };
    if (!Number.isInteger(i.tauBp) || i.tauBp < 5_000 || i.tauBp > 10_000) return { kind: "invalid_tau" };
    const cur = await this.d.store.getConfig();
    if (cur.tauBp === i.tauBp && cur.shadowOnly === i.shadowOnly) return { kind: "no_change" };
    if (cur.shadowOnly && !i.shadowOnly) {
      if (!labelledSetReady(await this.d.store.labelStats())) return { kind: "labelled_set_not_ready" };
      const choice = chooseTau(await this.validation());
      if (!choice.ok || i.tauBp < choice.tauBp) return { kind: "tau_below_validated" };
    }
    const id = this.d.ids.uuidV7();
    const next = await this.d.store.applyConfigChange(
      { id, oldTauBp: cur.tauBp, newTauBp: i.tauBp, oldShadow: cur.shadowOnly, newShadow: i.shadowOnly, proposedBy: i.proposedBy, approvedBy: i.approvedBy, reason: i.reason },
      [{ type: "matching_config.changed", changeId: id, shadowOnly: i.shadowOnly }],
    );
    return { kind: "applied", tauBp: next.tauBp, shadowOnly: next.shadowOnly };
  }
}

export const DEFAULT_CONFIG = { tauBp: DEFAULT_TAU_BP, shadowOnly: true, version: 1 } as const;
export type { CrawlEvent };
