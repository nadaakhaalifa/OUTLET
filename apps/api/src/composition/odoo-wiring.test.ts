import { describe, expect, it } from "vitest";
import { createPriceIntegrityDevFixtures } from "../modules/price-integrity";
import { PriceIntegrityService } from "../modules/price-integrity";
import { InMemoryCrawlStore, type TargetRecord } from "../modules/price-crawler";
import { CrawlStoreChannelDirectory, InventoryStockSink, PriceIntegrityPriceSink } from "./odoo-adapters";

const STORE_A = "0192f3a4-5b6c-7d8e-9f01-000000009001";
const STORE_B = "0192f3a4-5b6c-7d8e-9f01-000000009002";
const SKU = "0192f3a4-5b6c-7d8e-9f01-000000007001";
const NOW = 1_800_000_000_000;

const target = (id: string, storeId: string, status: TargetRecord["status"]): TargetRecord => ({
  id,
  storeId,
  domain: "odoo.shop-a.com",
  kind: "seller",
  status,
  verificationMethod: "dns_txt",
  verificationTokenHash: "a".repeat(64),
  consentAtMs: NOW,
  verifiedAtMs: status === "verified" ? NOW : null,
  robotsTxt: null,
  robotsStatus: null,
  robotsFetchedAtMs: null,
  breakerFailures: 0,
  breakerOpenedAtMs: null,
  lastEtag: null,
});

describe("price ledger sink (real PriceIntegrityService, in-memory stores)", () => {
  const make = () => {
    const f = createPriceIntegrityDevFixtures();
    let n = 0;
    const service = new PriceIntegrityService({
      events: f.events,
      external: f.external,
      claims: f.claims,
      enforcement: f.enforcement,
      directory: f.directory,
      clock: { nowMs: () => NOW },
      ids: { uuidV7: () => `0192f3a4-5b6c-7d8e-9f01-${String(++n).padStart(12, "0")}` },
    });
    return { f, sink: new PriceIntegrityPriceSink(service) };
  };

  it("records source odoo in the immutable ledger, replays idempotently, and a single event yields no discount claim", async () => {
    const { f, sink } = make();
    const i = { skuId: SKU, storeId: STORE_A, priceAmount: 120_000n, validFromMs: NOW - 1_000, idempotencyKey: "odoo:c1:101:120000:v1" };
    expect(await sink.record(i)).toBe("recorded");
    expect(await sink.record(i)).toBe("replayed");
    const hist = await f.events.history(SKU);
    expect(hist).toHaveLength(1);
    expect(hist[0]).toMatchObject({ source: "odoo", priceAmount: 120_000n, actorId: null });
  });

  it("refuses another store's SKU, a back-dated event and a payload change under the same key", async () => {
    const { sink } = make();
    const base = { skuId: SKU, priceAmount: 100_000n, validFromMs: NOW - 1_000, idempotencyKey: "k1" };
    expect(await sink.record({ ...base, storeId: STORE_A })).toBe("recorded");
    expect(await sink.record({ ...base, storeId: STORE_B, idempotencyKey: "k2" })).toBe("rejected");
    expect(await sink.record({ ...base, storeId: STORE_A, validFromMs: NOW - 9_000, idempotencyKey: "k3" })).toBe("rejected");
    expect(await sink.record({ ...base, storeId: STORE_A, priceAmount: 90_000n })).toBe("rejected");
  });
});

describe("channel directory over the crawl store", () => {
  it("creates and revokes an odoo channel; only same-store verified seller targets resolve", async () => {
    const store = new InMemoryCrawlStore();
    const dir = new CrawlStoreChannelDirectory(store);
    await store.insertTarget(target("0192f3a4-5b6c-7d8e-9f01-0000000000a1", STORE_A, "verified"));
    await store.insertTarget({ ...target("0192f3a4-5b6c-7d8e-9f01-0000000000a2", STORE_A, "pending_verification"), domain: "pending.shop-a.com" });
    expect(await dir.verifiedTarget(STORE_A, "0192f3a4-5b6c-7d8e-9f01-0000000000a1")).toEqual({ domain: "odoo.shop-a.com" });
    expect(await dir.verifiedTarget(STORE_B, "0192f3a4-5b6c-7d8e-9f01-0000000000a1")).toBeNull();
    expect(await dir.verifiedTarget(STORE_A, "0192f3a4-5b6c-7d8e-9f01-0000000000a2")).toBeNull();
    expect(await dir.verifiedDomains(STORE_A)).toEqual(["odoo.shop-a.com"]);

    const id = "0192f3a4-5b6c-7d8e-9f01-0000000000c1";
    await dir.createChannel({ id, storeId: STORE_A, tokenRef: "vault://odoo/a1", kmsKeyRef: "kms://key/a1", nowMs: NOW });
    expect(await dir.channel(id)).toMatchObject({ kind: "odoo", status: "active", storeId: STORE_A });
    await dir.revokeChannel(id, NOW + 1);
    expect(await dir.channel(id)).toMatchObject({ status: "revoked" });
  });
});

describe("stock sink over the SyncSellerStock contract", () => {
  it("sends mode set, reason channel_sync, channel actor, the owning store grant and the source version", async () => {
    const seen: unknown[] = [];
    const sink = new InventoryStockSink({
      execute: async (raw) => {
        seen.push(raw);
        return { kind: "applied", replayed: false };
      },
    });
    expect(await sink.set({ skuId: SKU, storeId: STORE_A, quantity: 4, sourceVersion: 1_790_000_000, idempotencyKey: "k", actorId: "odoo:c1" })).toBe("applied");
    expect(seen[0]).toEqual({ skuId: SKU, actorStoreIds: [STORE_A], actorId: "odoo:c1", actorType: "channel", mode: "set", quantity: 4, reason: "channel_sync", idempotencyKey: "k", sourceVersion: 1_790_000_000 });
  });
});
