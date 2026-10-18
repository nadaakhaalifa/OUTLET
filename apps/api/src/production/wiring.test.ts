import "reflect-metadata";
import { beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../config/env";
import { CartAdapter, DevCommerceTerms, Late } from "../composition";
import type { BagView } from "../modules/cart";
import { PriceIntegrityParityAdapter } from "../modules/price-crawler";
import { createPriceIntegrityDevFixtures } from "../modules/price-integrity";
import type { EnforcementRecord } from "../modules/price-integrity";
import { composeProduction } from "./compose";
import { AdminStoreVoidApprovals, UnmeasuredWhenUnavailableQueue } from "./adapters";
import { PRODUCTION_PORTS } from "./ports";
import { newTestDb, PROD_ENV } from "./test/test-support";
import { ProviderNotConfiguredError, unconfigured } from "./unconfigured";
import type { QueuePort } from "../modules/waiting-room";

const STORE = "0192f3a4-5b6c-7d8e-9f01-23456789a001";
const DROP = "0192f3a4-5b6c-7d8e-9f01-23456789d001";
const uuidFor = (n: number): string => `0192f3a4-5b6c-7d8e-9f01-${String(n).padStart(12, "0")}`;

type Ports = ReturnType<typeof PRODUCTION_PORTS>;
let ports: Ports;

beforeAll(async () => {
  const db = await newTestDb();
  const config = loadConfig({ ...PROD_ENV });
  const c = composeProduction(config, { db });
  ports = PRODUCTION_PORTS(config, c.pg, c.flags, c.money);
}, 120_000);

describe("production wiring: drop admission", () => {
  it("checkout gets a real admission port, not nothing", () => {
    expect(ports.checkout.dropAdmission).toBeDefined();
  });
  it("no token or no device is 'required'; a malformed token is 'invalid'; nothing is admitted", async () => {
    const a = ports.checkout.dropAdmission;
    if (a === undefined) throw new Error("dropAdmission missing");
    expect(await a.redeem({ userId: "u", deviceId: "d", token: null, dropIds: [DROP] })).toBe("required");
    expect(await a.redeem({ userId: "u", deviceId: null, token: "x", dropIds: [DROP] })).toBe("required");
    expect(await a.redeem({ userId: "u", deviceId: "d", token: "not-a-token", dropIds: [DROP] })).toBe("invalid");
  });
});

describe("production wiring: drops ops counters", () => {
  it("queue depth is unmeasured (null) while Redis is unconfigured; window counts come from the stored audit", async () => {
    const ops = ports.drops.ops;
    if (ops === undefined) throw new Error("ops missing");
    expect(await ops.queueDepth(DROP)).toBeNull();
    expect(await ops.windowCounts(DROP, 3_600_000)).toEqual({ admitted: 0, rejected: 0, abandoned: 0 });
  });
  it("the unmeasured wrapper only converts the unconfigured-provider error, never other failures", async () => {
    const boom = new Error("boom");
    const q = new UnmeasuredWhenUnavailableQueue({ size: async () => Promise.reject(boom) } as unknown as QueuePort);
    await expect(q.size("d")).rejects.toBe(boom);
    const u = new UnmeasuredWhenUnavailableQueue(unconfigured<QueuePort>("queue.redis"));
    await expect(u.size("d")).rejects.not.toBeInstanceOf(ProviderNotConfiguredError);
    expect(() => u.join("d", "t", "u", "h", 0)).toThrow(ProviderNotConfiguredError);
  });
});

describe("production wiring: cart marks drop lines for checkout admission", () => {
  it("BagLine.dropId is set for drop SKUs only", async () => {
    const bag = {
      groups: [
        {
          store: { id: STORE },
          status: "open",
          freeDelivery: { threshold: { amount: 200_000n, currency: "EGP" } },
          deliveryFee: { amount: 5000n, currency: "EGP" },
          lines: ["drop-sku", "plain-sku"].map((skuId, i) => ({
            id: uuidFor(i + 1), skuId, productId: uuidFor(i + 10), qty: 1, unitPrice: { amount: 1000n, currency: "EGP" },
            savedForLater: false, counted: true, available: true, title: { ar: "x" },
          })),
        },
      ],
    } as unknown as BagView;
    const late = <T,>(name: string, v: unknown): Late<T> => { const l = new Late<T>(name); l.bind(v as T); return l; };
    const adapter = new CartAdapter({
      quote: late("quote", { execute: async () => bag }),
      catalog: late("catalog", { stores: async () => new Map() }),
      membership: late("membership", { isPlusMember: async () => false }),
      repo: late("repo", {}),
      directory: late("directory", { lookup: async (sku: string) => ({ dropId: sku === "drop-sku" ? DROP : null }) }),
      terms: new DevCommerceTerms(),
      nowMs: () => 0,
      newId: () => uuidFor(99),
    });
    const snap = await adapter.snapshot("u");
    const byId = new Map(snap.lines.map((l) => [l.skuId, l]));
    expect(byId.get("drop-sku")).toMatchObject({ isDrop: true, dropId: DROP });
    expect(byId.get("plain-sku")?.isDrop).toBe(false);
    expect(byId.get("plain-sku")?.dropId).toBeUndefined();
  });
});

describe("production wiring: seller parity", () => {
  it("pages past 100 and 20 records and returns every open cross-channel finding", async () => {
    const store = createPriceIntegrityDevFixtures().enforcement;
    for (let i = 1; i <= 250; i += 1) {
      const rec: EnforcementRecord = {
        id: uuidFor(i), storeId: STORE, skuId: uuidFor(1000 + i), kind: "cross_channel_cheaper", actions: [],
        violationsInWindow: 1, dedupeKey: `k${i}`, openedAtMs: 1_000 + i, resolvedAtMs: null,
      };
      await store.record(rec);
    }
    const out = await new PriceIntegrityParityAdapter(store).openFor(STORE);
    expect(out).toHaveLength(250);
    expect(new Set(out.map((w) => w.skuId)).size).toBe(250);
  });
  it("is wired to the Postgres enforcement store in production", async () => {
    expect(ports.priceCrawler.parity).toBeInstanceOf(PriceIntegrityParityAdapter);
    expect(await ports.priceCrawler.parity?.openFor(STORE)).toEqual([]);
  });
});

describe("production wiring: gift-card void approvals", () => {
  it("are backed by the admin approvals store, single use per process", async () => {
    const approvals = ports.giftCards.approvals;
    expect(approvals).toBeInstanceOf(AdminStoreVoidApprovals);
    expect(await approvals?.find(uuidFor(404))).toBeNull();
  });
  it("find returns the stored record and consume succeeds once", async () => {
    const rec = { id: uuidFor(7) } as unknown as NonNullable<Awaited<ReturnType<AdminStoreVoidApprovals["find"]>>>;
    const a = new AdminStoreVoidApprovals({ getApproval: async (id: string) => (id === rec.id ? rec : null) });
    expect(await a.find(rec.id)).toBe(rec);
    expect(await a.consume(rec.id)).toBe(true);
    expect(await a.consume(rec.id)).toBe(false);
  });
});
