import { beforeEach, describe, expect, it } from "vitest";
import type { ChannelRecord, CrawlEvent, CrawlStore, MatchRecord, SnapshotRecord, TargetRecord } from "../domain/ports";
import { START_MS, STORE_A, STORE_B, U, verifiedTarget } from "./fixtures";

export interface CrawlContract {
  readonly store: CrawlStore;
  eventTypes(): Promise<readonly string[]>;
}

const pending = (over: Partial<TargetRecord> = {}): TargetRecord =>
  verifiedTarget({ id: U(2100), domain: "pending-shop.com", status: "pending_verification", verifiedAtMs: null, ...over });
const snap = (n: number, over: Partial<SnapshotRecord> = {}): SnapshotRecord => ({
  id: U(4000 + n),
  targetId: U(2000),
  storeId: STORE_A,
  skuRef: "sku-1",
  priceAmount: 150_000n,
  available: true,
  domHash: "domhash0001",
  etag: '"v1"',
  fetchedAtMs: START_MS + n * 3_600_000,
  ...over,
});
const match = (over: Partial<MatchRecord> = {}): MatchRecord => ({
  id: U(5000),
  skuId: U(3000),
  storeId: STORE_A,
  targetId: U(2000),
  externalRef: "sku-1",
  method: "gtin",
  rawBp: 9_900,
  confBp: 9_900,
  capReason: null,
  modelVersion: "match-v1",
  gate: "shadow",
  scoredAtMs: START_MS,
  ...over,
});
const ev = (type: CrawlEvent["type"]): CrawlEvent => {
  switch (type) {
    case "crawl_target.verified":
      return { type, targetId: U(2000), storeId: STORE_A };
    default:
      throw new Error("unused");
  }
};

/** One suite, two adapters: the in-memory fake and the Postgres store must agree. */
export function runCrawlStoreContract(name: string, make: () => Promise<CrawlContract>): void {
  describe(`CrawlStore contract: ${name}`, () => {
    let c: CrawlContract;
    beforeEach(async () => {
      c = await make();
    });

    it("targets are unique per (store, domain) and round-trip", async () => {
      expect((await c.store.insertTarget(verifiedTarget())).kind).toBe("created");
      const again = await c.store.insertTarget(verifiedTarget({ id: U(2999) }));
      expect(again.kind).toBe("exists");
      expect(again.target.id).toBe(U(2000));
      expect(await c.store.getTarget(U(2000))).toEqual(verifiedTarget());
      expect(await c.store.getTarget("not-a-uuid")).toBeNull();
      expect(await c.store.verifiedDomains(STORE_A)).toEqual(["shop.example-brand.com"]);
      expect(await c.store.verifiedDomains(STORE_B)).toEqual([]);
    });

    it("updateTarget persists robots and breaker state with the outbox event", async () => {
      await c.store.insertTarget(pending());
      const t = pending({ status: "verified", verifiedAtMs: START_MS + 5, robotsTxt: "User-agent: *", robotsStatus: 200, robotsFetchedAtMs: START_MS + 9, breakerFailures: 2, breakerOpenedAtMs: START_MS + 11, lastEtag: '"x"' });
      await c.store.updateTarget(t, [{ type: "crawl_target.verified", targetId: t.id, storeId: t.storeId }]);
      expect(await c.store.getTarget(t.id)).toEqual(t);
      expect(await c.eventTypes()).toEqual(["crawl_target.verified"]);
      expect((await c.store.listVerifiedTargets(10)).map((x) => x.id)).toEqual([t.id]);
      expect((await c.store.listTargets(STORE_A)).map((x) => x.id)).toEqual([t.id]);
    });

    it("channels keep a reference, never a secret, and can be revoked", async () => {
      await c.store.insertTarget(verifiedTarget());
      const ch: ChannelRecord = { id: U(2200), storeId: STORE_A, kind: "crawler", status: "active", tokenRef: "vault://crawler/1", kmsKeyRef: "kms://key/1", targetId: U(2000), createdAtMs: START_MS, revokedAtMs: null };
      await c.store.insertChannel(ch);
      expect(await c.store.getChannel(ch.id)).toEqual(ch);
      expect((await c.store.listChannels(STORE_B)).length).toBe(0);
      const revoked = { ...ch, status: "revoked" as const, revokedAtMs: START_MS + 1 };
      await c.store.updateChannel(revoked, [{ type: "channel.token_revoked", channelId: ch.id, storeId: STORE_A }]);
      expect(await c.store.getChannel(ch.id)).toEqual(revoked);
      expect(await c.eventTypes()).toEqual(["channel.token_revoked"]);
    });

    it("snapshots are append-only per day and queried latest-first", async () => {
      await c.store.insertTarget(verifiedTarget());
      await c.store.insertSnapshot(snap(1), [{ type: "channel_snapshot.ingested", targetId: U(2000), storeId: STORE_A, snapshotId: U(4001) }]);
      await c.store.insertSnapshot(snap(30, { priceAmount: 120_000n }), []);
      await c.store.insertSnapshot(snap(60, { priceAmount: 99_000n, available: false }), []);
      expect((await c.store.latestSnapshot(U(2000), "sku-1"))?.priceAmount).toBe(99_000n);
      expect(await c.store.latestSnapshot(U(2000), "other")).toBeNull();
      const since = await c.store.snapshotsSince(U(2000), "sku-1", START_MS + 2 * 3_600_000);
      expect(since.map((s) => s.priceAmount)).toEqual([120_000n, 99_000n]);
      expect(await c.eventTypes()).toEqual(["channel_snapshot.ingested"]);
    });

    it("matches upsert by (sku, target, external ref) and filter by gate", async () => {
      await c.store.insertTarget(verifiedTarget());
      await c.store.upsertMatch(match(), [{ type: "product_match.scored", matchId: U(5000), skuId: U(3000), storeId: STORE_A, gate: "shadow" }]);
      await c.store.upsertMatch(match({ id: U(5001), gate: "live", scoredAtMs: START_MS + 9 }), []);
      expect(await c.store.matchesForSkus([U(3000)], "shadow")).toEqual([]);
      const live = await c.store.matchesForSkus([U(3000)], "live");
      expect(live).toHaveLength(1);
      expect(live[0]?.confBp).toBe(9_900);
      expect(await c.store.matchesForSkus([], "live")).toEqual([]);
      expect((await c.store.matchesForStore(STORE_A, 10)).length).toBe(1);
      expect((await c.store.matchesForStore(STORE_B, 10)).length).toBe(0);
    });

    it("config changes are dual-approved and applied atomically", async () => {
      expect(await c.store.getConfig()).toEqual({ tauBp: 9_200, shadowOnly: true, version: 1 });
      const next = await c.store.applyConfigChange(
        { id: U(6000), oldTauBp: 9_200, newTauBp: 9_400, oldShadow: true, newShadow: false, proposedBy: U(1), approvedBy: U(2), reason: "validated on labelled set" },
        [{ type: "matching_config.changed", changeId: U(6000), shadowOnly: false }],
      );
      expect(next).toEqual({ tauBp: 9_400, shadowOnly: false, version: 2 });
      await expect(
        c.store.applyConfigChange(
          { id: U(6001), oldTauBp: 9_400, newTauBp: 9_000, oldShadow: false, newShadow: false, proposedBy: U(1), approvedBy: U(1), reason: "one person only" },
          [],
        ),
      ).rejects.toThrow();
      expect((await c.store.getConfig()).tauBp).toBe(9_400);
      expect(await c.eventTypes()).toEqual(["matching_config.changed"]);
      expect((await c.store.labelStats()).pairs).toBe(0);
    });

    it("incidents store a hash and host only", async () => {
      await c.store.insertTarget(verifiedTarget());
      await c.store.addIncident({ id: U(7000), targetId: U(2000), storeId: STORE_A, kind: "ssrf_refused", host: "169.254.169.254", urlHash: "a".repeat(64), detail: "reserved_host" }, [
        { type: "crawl.incident", incidentId: U(7000), kind: "ssrf_refused" },
      ]);
      expect(await c.eventTypes()).toEqual(["crawl.incident"]);
    });
    it("lists incidents newest first with a keyset cursor and a store filter", async () => {
      const SA = U(1777);
      const SB = U(1778);
      const mk = (n: number, storeId: string, at: number) => ({
        id: U(7100 + n),
        targetId: null,
        storeId,
        kind: "robots_disallowed" as const,
        host: "shop.example",
        urlHash: "b".repeat(64),
        detail: null,
        createdAtMs: at,
      });
      await c.store.addIncident(mk(1, SA, START_MS + 1_000), []);
      await c.store.addIncident(mk(2, SA, START_MS + 3_000), []);
      await c.store.addIncident(mk(3, SB, START_MS + 2_000), []);
      await c.store.addIncident(mk(4, SA, START_MS + 3_000), []);
      const all = await c.store.listIncidents({ storeId: SA, kind: null, limit: 10, after: null });
      expect(all.map((r) => r.id)).toEqual([U(7104), U(7102), U(7101)]);
      const first = await c.store.listIncidents({ storeId: SA, kind: null, limit: 2, after: null });
      expect(first.map((r) => r.id)).toEqual([U(7104), U(7102)]);
      const last = first[1];
      const next = await c.store.listIncidents({ storeId: SA, kind: null, limit: 2, after: { atMs: last?.createdAtMs ?? 0, id: last?.id ?? "" } });
      expect(next.map((r) => r.id)).toEqual([U(7101)]);
      expect(await c.store.listIncidents({ storeId: SA, kind: "ssrf_refused", limit: 5, after: null })).toEqual([]);
    });
    void ev;
  });
}
