import type { ExternalEvidencePort } from "../../price-integrity";
import { beforeEach, describe, expect, it } from "vitest";
import {
  ChangeMatchingConfig,
  CrawlProduct,
  ExternalEvidenceReader,
  FindMatchCandidates,
  RefreshChannelToken,
  ConnectChannel,
  RegisterCrawlTarget,
  ScoreProductMatch,
  VerifyCrawlTarget,
  sha256Hex,
} from "../application/crawler";
import type { FetchResponse, MatchRecord } from "../domain/ports";
import { HOUR, START_MS, STORE_A, STORE_B, U, createFixture, offerBody, verifiedTarget, type Fixture } from "./fixtures";

const DOMAIN = "shop.example-brand.com";
const PAGE = `https://${DOMAIN}/p/1`;
const T_ID = U(2000);
const ok = (body: string, over: Partial<FetchResponse> = {}): FetchResponse => ({
  status: 200,
  headers: { etag: '"v1"' },
  body,
  connectedAddress: "93.184.216.34",
  truncated: false,
  ...over,
});

let f: Fixture;
let crawl: CrawlProduct;
beforeEach(async () => {
  f = createFixture();
  crawl = new CrawlProduct(f.deps);
  await f.store.insertTarget(verifiedTarget());
  f.dns.set(DOMAIN, ["93.184.216.34"]);
  f.fetcher.responses.set(`https://${DOMAIN}/robots.txt`, ok("User-agent: *\nDisallow: /private/\n", { headers: {} }));
  f.fetcher.responses.set(PAGE, ok(offerBody(150_000n)));
});
const run = (url = PAGE, sku = "sku-1") => crawl.execute({ targetId: T_ID, skuRef: sku, url });

describe("registration and verification", () => {
  it("stores only the token hash and verifies by the token found on the domain", async () => {
    const reg = new RegisterCrawlTarget(f.deps);
    const r = await reg.execute({ storeId: STORE_B, domain: "Brand-Shop.com", method: "dns_txt", consent: true });
    if (r.kind !== "created") throw new Error("expected created");
    expect(r.target.domain).toBe("brand-shop.com");
    expect(r.target.verificationTokenHash).toBe(sha256Hex(r.verificationToken));
    expect(JSON.stringify(r.target)).not.toContain(r.verificationToken);
    const v = new VerifyCrawlTarget(f.deps);
    expect((await v.execute(STORE_B, r.target.id)).kind).toBe("token_missing");
    f.verifier.tokens.set("dns_txt:brand-shop.com", "wrong");
    expect((await v.execute(STORE_B, r.target.id)).kind).toBe("token_mismatch");
    f.verifier.tokens.set("dns_txt:brand-shop.com", r.verificationToken);
    expect((await v.execute(STORE_A, r.target.id)).kind).toBe("not_found");
    expect((await v.execute(STORE_B, r.target.id)).kind).toBe("verified");
    expect(f.store.outbox.map((e) => e.type)).toContain("crawl_target.verified");
  });
  it("needs consent and a plausible public domain", async () => {
    const reg = new RegisterCrawlTarget(f.deps);
    expect((await reg.execute({ storeId: STORE_B, domain: "x.com", method: "file", consent: false })).kind).toBe("consent_required");
    for (const d of ["localhost", "10.0.0.1", "intranet.local", "2130706433", "a.b", "[::1]"]) {
      expect((await reg.execute({ storeId: STORE_B, domain: d, method: "file", consent: true })).kind).toBe("invalid_domain");
    }
  });
  it("is idempotent per store and domain", async () => {
    const reg = new RegisterCrawlTarget(f.deps);
    const a = await reg.execute({ storeId: STORE_B, domain: "same-shop.com", method: "file", consent: true });
    const b = await reg.execute({ storeId: STORE_B, domain: "same-shop.com", method: "file", consent: true });
    expect([a.kind, b.kind]).toEqual(["created", "exists"]);
  });
});

describe("channels", () => {
  it("holds opaque references only and handles revoked tokens", async () => {
    f.vault.refs.add("vault://shopify/store-a");
    const c = new ConnectChannel(f.deps);
    expect((await c.execute({ storeId: STORE_A, kind: "shopify", tokenRef: "has space", kmsKeyRef: "kms://key/1", targetId: null })).kind).toBe("invalid_ref");
    expect((await c.execute({ storeId: STORE_A, kind: "shopify", tokenRef: "vault://missing/ref", kmsKeyRef: "kms://key/1", targetId: null })).kind).toBe("secret_missing");
    expect((await c.execute({ storeId: STORE_A, kind: "crawler", tokenRef: "vault://shopify/store-a", kmsKeyRef: "kms://key/1", targetId: null })).kind).toBe("target_required");
    const r = await c.execute({ storeId: STORE_A, kind: "shopify", tokenRef: "vault://shopify/store-a", kmsKeyRef: "kms://key/1", targetId: null });
    if (r.kind !== "connected") throw new Error("expected connected");
    const refresh = new RefreshChannelToken(f.deps);
    expect((await refresh.execute(r.channel.id)).kind).toBe("refreshed");
    expect((await f.store.getChannel(r.channel.id))?.tokenRef).toBe("vault://shopify/store-a.r");
    f.vault.revoked.add("vault://shopify/store-a.r");
    expect((await refresh.execute(r.channel.id)).kind).toBe("revoked");
    expect((await f.store.getChannel(r.channel.id))?.status).toBe("revoked");
    expect(f.store.outbox.map((e) => e.type)).toContain("channel.token_revoked");
    expect((await refresh.execute(r.channel.id)).kind).toBe("inactive");
  });
  it("a crawler channel cannot attach another store's target", async () => {
    f.vault.refs.add("vault://crawler/x");
    const c = new ConnectChannel(f.deps);
    const r = await c.execute({ storeId: STORE_B, kind: "crawler", tokenRef: "vault://crawler/x", kmsKeyRef: "kms://key/1", targetId: T_ID });
    expect(r.kind).toBe("target_required");
  });
});

describe("polite crawl pipeline", () => {
  it("stores a snapshot, then dedupes the same-day unchanged page and honours ETag 304", async () => {
    expect(await run()).toMatchObject({ kind: "stored" });
    f.clock.advance(6_000);
    expect(await run()).toMatchObject({ kind: "unchanged" });
    expect(f.store.snapshots).toHaveLength(1);
    f.clock.advance(6_000);
    f.fetcher.responses.set(PAGE, { ...ok(""), status: 304 });
    expect(await run()).toMatchObject({ kind: "unchanged" });
    expect(f.fetcher.calls.at(-1)?.ifNoneMatch).toBe('"v1"');
    f.clock.advance(6_000);
    f.fetcher.responses.set(PAGE, ok(offerBody(120_000n)));
    expect(await run()).toMatchObject({ kind: "stored" });
    expect(f.store.snapshots.map((s) => s.priceAmount)).toEqual([150_000n, 120_000n]);
    expect(f.store.outbox.filter((e) => e.type === "channel_snapshot.ingested")).toHaveLength(2);
  });
  it("never sends more than one request per domain per 5 seconds", async () => {
    expect((await run()).kind).toBe("stored");
    f.clock.advance(1_000);
    const r = await run();
    expect(r.kind).toBe("rate_limited");
    if (r.kind === "rate_limited") expect(r.retryAtMs).toBeGreaterThanOrEqual(START_MS + 5_000);
  });
  it("robots.txt disallow is honoured and logged", async () => {
    f.fetcher.responses.set(`https://${DOMAIN}/private/x`, ok(offerBody(100n)));
    expect((await run(`https://${DOMAIN}/private/x`)).kind).toBe("robots_disallowed");
    expect(f.store.incidents.map((i) => i.kind)).toContain("robots_disallowed");
    expect(f.fetcher.calls.every((c) => c.url !== `https://${DOMAIN}/private/x`)).toBe(true);
  });
  it("a 5xx robots.txt is a full disallow", async () => {
    f.fetcher.responses.set(`https://${DOMAIN}/robots.txt`, ok("", { status: 503, headers: {} }));
    expect((await run()).kind).toBe("robots_disallowed");
  });
  it("refuses every non-verified or internal destination before any socket", async () => {
    const urls = [
      "https://evil.example.org/p/1",
      "http://shop.example-brand.com/p/1",
      "https://169.254.169.254/latest/meta-data/",
      "https://2130706433/",
      "https://0x7f000001/",
      "https://0177.0.0.1/",
      "https://[::1]/",
      "https://[::ffff:127.0.0.1]/",
      "https://user:pw@shop.example-brand.com/p/1",
      "https://metadata.google.internal/",
      "https://localhost/",
    ];
    for (const u of urls) {
      const before = f.fetcher.calls.length;
      const r = await run(u);
      expect(r.kind, u).toBe("refused");
      expect(f.fetcher.calls.length, u).toBe(before);
    }
    expect(f.store.incidents.filter((i) => i.kind === "ssrf_refused").length).toBe(urls.length);
    expect(f.store.incidents.every((i) => i.urlHash.length === 64)).toBe(true);
  });
  it("refuses a verified name that resolves to a private address (any answer)", async () => {
    expect((await run()).kind).toBe("stored");
    const pageCalls = f.fetcher.calls.filter((c) => c.url === PAGE).length;
    f.clock.advance(6_000);
    f.dns.set(DOMAIN, ["93.184.216.34", "10.0.0.5"]);
    expect(await run()).toMatchObject({ kind: "refused", reason: "non_public_address" });
    f.clock.advance(6_000);
    f.dns.set(DOMAIN, ["fd00::1"]);
    expect(await run()).toMatchObject({ kind: "refused" });
    expect(f.fetcher.calls.filter((c) => c.url === PAGE)).toHaveLength(pageCalls);
    // a fresh target whose robots.txt cannot be fetched safely fails closed
    const g = createFixture();
    await g.store.insertTarget(verifiedTarget());
    g.dns.set(DOMAIN, ["10.0.0.5"]);
    expect((await new CrawlProduct(g.deps).execute({ targetId: T_ID, skuRef: "s", url: PAGE })).kind).toBe("robots_disallowed");
    expect(g.fetcher.calls).toHaveLength(0);
  });
  it("catches DNS rebinding after the fetch (second answer private, or connected address differs)", async () => {
    f.dns.set(DOMAIN, ["93.184.216.34"], ["93.184.216.34"], ["127.0.0.1"]);
    f.fetcher.responses.delete(`https://${DOMAIN}/robots.txt`);
    const r = await run();
    expect(r).toMatchObject({ kind: "refused", reason: "dns_rebinding" });
    expect(f.store.snapshots).toHaveLength(0);
    f.dns.set(DOMAIN, ["93.184.216.34"]);
    f.fetcher.responses.set(PAGE, ok(offerBody(1n), { connectedAddress: "169.254.169.254" }));
    f.clock.advance(10_000);
    expect(await run()).toMatchObject({ kind: "refused", reason: "dns_rebinding" });
    expect(f.store.incidents.map((i) => i.kind)).toContain("dns_rebinding");
  });
  it("re-validates redirects and refuses a hop to an unverified host", async () => {
    f.fetcher.responses.set(PAGE, ok("", { status: 302, headers: { location: "https://evil.example.org/x" } }));
    expect((await run()).kind).toBe("refused");
    expect(f.store.incidents.map((i) => i.kind)).toContain("redirect_refused");
    f.clock.advance(10_000);
    f.fetcher.responses.set(PAGE, ok("", { status: 302, headers: { location: `https://${DOMAIN}/p/1-moved` } }));
    f.fetcher.responses.set(`https://${DOMAIN}/p/1-moved`, ok(offerBody(99_000n)));
    expect((await run()).kind).toBe("stored");
  });
  it("opens the circuit breaker after repeated failures and stops fetching", async () => {
    f.fetcher.responses.set(PAGE, ok("", { status: 500, headers: {} }));
    for (let i = 0; i < 5; i += 1) {
      f.clock.advance(6_000);
      expect((await run()).kind).toBe("fetch_failed");
    }
    f.clock.advance(6_000);
    const calls = f.fetcher.calls.length;
    expect((await run()).kind).toBe("breaker_open");
    expect(f.fetcher.calls.length).toBe(calls);
    f.clock.advance(7 * HOUR);
    f.fetcher.responses.set(PAGE, ok(offerBody(150_000n)));
    expect((await run()).kind).toBe("stored");
    expect((await f.store.getTarget(T_ID))?.breakerFailures).toBe(0);
  });
  it("a 403/429 is recorded as blocked, a parser miss as parser_error, a truncated body as size_exceeded", async () => {
    f.fetcher.responses.set(PAGE, ok("", { status: 429, headers: {} }));
    expect((await run()).kind).toBe("fetch_failed");
    f.clock.advance(6_000);
    f.fetcher.responses.set(PAGE, ok("<html>no offer</html>"));
    expect((await run()).kind).toBe("parse_failed");
    f.clock.advance(6_000);
    f.fetcher.responses.set(PAGE, ok(offerBody(5n), { truncated: true }));
    expect(await run()).toMatchObject({ kind: "refused", reason: "size_exceeded" });
    expect(f.store.incidents.map((i) => i.kind)).toEqual(expect.arrayContaining(["blocked", "parser_error", "size_exceeded"]));
  });
  it("the kill switch and unverified targets stop everything", async () => {
    f.flags.enabled = false;
    expect((await run()).kind).toBe("disabled");
    f.flags.enabled = true;
    await f.store.updateTarget(verifiedTarget({ status: "revoked" }), []);
    expect((await run()).kind).toBe("target_unavailable");
    expect((await crawl.execute({ targetId: U(9999), skuRef: "x", url: PAGE })).kind).toBe("target_unavailable");
  });
});

const SKU = U(3000);
const fp = (over: Record<string, unknown> = {}) => ({ fp: { gtin: "4006381333931", ...over }, facts: { title: "t", brand: "b", colour: "red", material: null, sizes: ["M"] } });
describe("matching and external evidence", () => {
  beforeEach(() => {
    f.fingerprints.skus.set(SKU, { storeId: STORE_A, ...fp() });
    f.fingerprints.externals.set(`${T_ID}:sku-1`, fp());
  });
  const score = () => new ScoreProductMatch(f.deps).execute({ skuId: SKU, targetId: T_ID, externalRef: "sku-1" });

  it("scores in SHADOW by default: recorded, never evidence", async () => {
    const r = await score();
    if (r.kind !== "scored") throw new Error(r.kind);
    expect(r.match.gate).toBe("shadow");
    expect(r.match.confBp).toBeGreaterThanOrEqual(9_200);
    expect(f.store.outbox.map((e) => e.type)).toContain("product_match.scored");
    await run();
    const ev = await new ExternalEvidenceReader(f.deps).lookup([SKU]);
    expect(ev.size).toBe(0);
  });
  it("a GTIN conflict is never a match and a missing LLM verdict caps below tau", async () => {
    f.fingerprints.externals.set(`${T_ID}:sku-1`, fp({ gtin: "5901234123457" }));
    expect((await score()).kind).toBe("gtin_conflict");
    f.fingerprints.externals.set(`${T_ID}:sku-1`, fp({ gtin: undefined, pHash: "0".repeat(16) }));
    f.fingerprints.skus.set(SKU, { storeId: STORE_A, ...fp({ gtin: undefined, pHash: "0".repeat(16) }) });
    f.attributes.verdict = null;
    const r = await score();
    if (r.kind !== "scored") throw new Error(r.kind);
    expect(r.match.confBp).toBeLessThan(9_200);
    expect(r.match.gate).toBe("rejected");
  });
  it("attribute conflict (brand) rejects; a foreign store's target is not found", async () => {
    f.fingerprints.externals.set(`${T_ID}:sku-1`, fp({ gtin: undefined, pHash: "0".repeat(16) }));
    f.fingerprints.skus.set(SKU, { storeId: STORE_A, ...fp({ gtin: undefined, pHash: "0".repeat(16) }) });
    f.attributes.verdict = { brand: "conflict", colour: "match", material: "match", sizeRun: "overlap" };
    const r = await score();
    expect(r).toMatchObject({ kind: "scored", match: { gate: "rejected", capReason: "attribute_conflict" } });
    f.fingerprints.skus.set(SKU, { storeId: STORE_B, ...fp() });
    expect((await score()).kind).toBe("external_not_found");
  });
  it("ANN candidates are limited to the seller's own verified targets", async () => {
    f.fingerprints.skus.set(SKU, { storeId: STORE_A, fp: { gtin: "4006381333931", embedding: [1, 0] }, facts: fp().facts });
    f.embeddings.candidates = [
      { externalRef: "sku-1", targetId: T_ID, similarity: 0.99 },
      { externalRef: "sku-9", targetId: U(7777), similarity: 0.99 },
    ];
    const out = await new FindMatchCandidates(f.deps, new ScoreProductMatch(f.deps)).execute(SKU);
    expect(out).toHaveLength(1);
  });

  const goLive = async (): Promise<void> => {
    f.store.labels = { pairs: 2_000, kappaMilli: 850 };
    const change = new ChangeMatchingConfig(f.deps, async () => [
      { confBp: 9_900, same: true },
      { confBp: 9_200, same: true },
      { confBp: 3_000, same: false },
    ]);
    const r = await change.execute({ tauBp: 9_200, shadowOnly: false, proposedBy: U(1), approvedBy: U(2), reason: "labelled set validated" });
    expect(r.kind).toBe("applied");
  };

  it("live evidence feeds the VRP only while fresh; stale (>72h) evidence disappears (plain price)", async () => {
    await goLive();
    expect((await score()).kind).toBe("scored");
    expect((await f.store.matchesForSkus([SKU], "live")).length).toBe(1);
    await run();
    const reader = new ExternalEvidenceReader(f.deps);
    const fresh = (await reader.lookup([SKU])).get(SKU);
    expect(fresh).toMatchObject({ lowPriceAmount: 150_000n, currentPriceAmount: 150_000n });
    expect(fresh?.matchConfBp).toBeGreaterThanOrEqual(9_200);
    f.clock.advance(71 * HOUR);
    expect((await reader.lookup([SKU])).has(SKU)).toBe(true);
    f.clock.advance(2 * HOUR);
    expect((await reader.lookup([SKU])).has(SKU)).toBe(false);
    f.flags.enabled = false;
    f.clock.advance(-2 * HOUR);
    expect((await reader.lookup([SKU])).size).toBe(0);
  });
  it("the strictest (lowest) reference wins across matches", async () => {
    await goLive();
    await score();
    f.fingerprints.externals.set(`${T_ID}:sku-2`, fp());
    f.fetcher.responses.set(`https://${DOMAIN}/p/2`, ok(offerBody(90_000n)));
    await new ScoreProductMatch(f.deps).execute({ skuId: SKU, targetId: T_ID, externalRef: "sku-2" });
    await run();
    f.clock.advance(6_000);
    await run(`https://${DOMAIN}/p/2`, "sku-2");
    const ev = (await new ExternalEvidenceReader(f.deps).lookup([SKU])).get(SKU);
    expect(ev?.lowPriceAmount).toBe(90_000n);
  });
});

describe("matching config (dual approval, VR-13)", () => {
  const change = (v: { confBp: number; same: boolean }[] = []) => new ChangeMatchingConfig(f.deps, async () => v);
  it("rejects a single approver, a bad tau and leaving shadow without a labelled set", async () => {
    const c = change();
    expect((await c.execute({ tauBp: 9_200, shadowOnly: false, proposedBy: U(1), approvedBy: U(1), reason: "same person" })).kind).toBe("same_approver");
    expect((await c.execute({ tauBp: 100, shadowOnly: true, proposedBy: U(1), approvedBy: U(2), reason: "bad tau value" })).kind).toBe("invalid_tau");
    expect((await c.execute({ tauBp: 9_200, shadowOnly: false, proposedBy: U(1), approvedBy: U(2), reason: "go live now" })).kind).toBe("labelled_set_not_ready");
    f.store.labels = { pairs: 1_999, kappaMilli: 900 };
    expect((await c.execute({ tauBp: 9_200, shadowOnly: false, proposedBy: U(1), approvedBy: U(2), reason: "go live now" })).kind).toBe("labelled_set_not_ready");
    f.store.labels = { pairs: 2_000, kappaMilli: 700 };
    expect((await c.execute({ tauBp: 9_200, shadowOnly: false, proposedBy: U(1), approvedBy: U(2), reason: "go live now" })).kind).toBe("labelled_set_not_ready");
    expect((await f.store.getConfig()).shadowOnly).toBe(true);
  });
  it("refuses a tau below what validation justifies, accepts one at or above it", async () => {
    f.store.labels = { pairs: 2_500, kappaMilli: 820 };
    const v = [
      { confBp: 9_500, same: true },
      { confBp: 9_500, same: true },
      { confBp: 9_000, same: false },
    ];
    expect((await change(v).execute({ tauBp: 8_000, shadowOnly: false, proposedBy: U(1), approvedBy: U(2), reason: "too low a tau" })).kind).toBe("tau_below_validated");
    expect((await change(v).execute({ tauBp: 9_500, shadowOnly: false, proposedBy: U(1), approvedBy: U(2), reason: "validated tau" })).kind).toBe("applied");
    expect(await f.store.getConfig()).toMatchObject({ tauBp: 9_500, shadowOnly: false, version: 2 });
    const m: MatchRecord[] = [...f.store.matches.values()];
    expect(m).toHaveLength(0);
  });
});

describe("price-integrity seam", () => {
  it("the evidence reader satisfies price-integrity's public ExternalEvidencePort", async () => {
    const port: ExternalEvidencePort = new ExternalEvidenceReader(f.deps);
    expect((await port.lookup([])).size).toBe(0);
  });
});
