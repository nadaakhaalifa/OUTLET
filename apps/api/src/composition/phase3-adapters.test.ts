import "reflect-metadata";
import { Global, Module } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { describe, expect, it } from "vitest";
import { ADDRESS_SERVICE } from "../modules/addresses";
import type { SkuFacts } from "../modules/catalog";
import { CHECKOUT_CAP_GUARD } from "../modules/budget";
import { INVENTORY_SYNC_STOCK } from "../modules/inventory";
import { PRICE_INTEGRITY_SERVICE } from "../modules/price-integrity";
import { PLUS_ENTITLEMENTS } from "../modules/subscriptions";
import { AddressBookDeliverability, CheckoutCapBudgetGate, LiveSkuQuote, PlusMemberEligibility } from "./auto-buy-adapters";
import { Phase3BridgeModule, createPhase3Lates, lazy } from "./phase3-wiring";

type Cap = ConstructorParameters<typeof CheckoutCapBudgetGate>[0];
type Decision = Awaited<ReturnType<Cap["authorize"]>>;

describe("PlusMemberEligibility", () => {
  const ent = (entitled: boolean) => ({ forUser: async () => ({ entitled }) });
  const ages = (age: number | null, min = 21) => ({ plusMinAge: async () => min, ageYears: async () => age });
  it("needs the Plus entitlement and a verified age at or above the Plus minimum", async () => {
    expect(await new PlusMemberEligibility(ent(true), ages(25)).eligibility("u")).toEqual({ plusActive: true, ageOk: true });
    expect(await new PlusMemberEligibility(ent(false), ages(25)).eligibility("u")).toEqual({ plusActive: false, ageOk: true });
    expect(await new PlusMemberEligibility(ent(true), ages(19)).eligibility("u")).toEqual({ plusActive: true, ageOk: false });
    expect((await new PlusMemberEligibility(ent(true), ages(null)).eligibility("u")).ageOk).toBe(false);
  });
  it("propagates a dependency error (the sweep turns it into a refusal)", async () => {
    const broken = { plusMinAge: async (): Promise<number> => { throw new Error("down"); }, ageYears: async () => 30 };
    await expect(new PlusMemberEligibility(ent(true), broken).eligibility("u")).rejects.toThrow("down");
  });
});

describe("AddressBookDeliverability", () => {
  const book = (rows: { isDefault: boolean; courierCoverage: "covered" | "not_covered" | "unknown" }[]) => ({ list: async () => rows });
  it("is true only when the default address is covered", async () => {
    expect(await new AddressBookDeliverability(book([{ isDefault: true, courierCoverage: "covered" }])).deliverable("u", "s")).toBe(true);
    expect(await new AddressBookDeliverability(book([{ isDefault: true, courierCoverage: "unknown" }])).deliverable("u", "s")).toBe(false);
    expect(await new AddressBookDeliverability(book([{ isDefault: true, courierCoverage: "not_covered" }])).deliverable("u", "s")).toBe(false);
    expect(
      await new AddressBookDeliverability(book([{ isDefault: false, courierCoverage: "covered" }])).deliverable("u", "s"),
    ).toBe(false);
    expect(await new AddressBookDeliverability(book([])).deliverable("u", "s")).toBe(false);
  });
});

describe("CheckoutCapBudgetGate", () => {
  const make = (decision: Decision | "throw") => {
    const calls: string[] = [];
    const cap: Cap = {
      authorize: async (i) => {
        calls.push(`authorize:${i.orderKey}`);
        if (decision === "throw") throw new Error("boom");
        return decision;
      },
      release: async (_u, k) => {
        calls.push(`release:${k}`);
      },
    };
    let n = 0;
    return { calls, gate: new CheckoutCapBudgetGate(cap, () => `k${(n += 1)}`) };
  };
  it("maps the three decisions and always releases the provisional spend", async () => {
    const a = make({ kind: "allow", reason: "within_budget" });
    expect(await a.gate.evaluate("u", 100n)).toBe("within");
    expect(a.calls).toEqual(["authorize:auto_buy_gate:k1", "release:auto_buy_gate:k1"]);
    expect(await make({ kind: "soft_hold", holdSeconds: 10, overBy: 5n }).gate.evaluate("u", 1n)).toBe("soft_cap_exceeded");
    expect(await make({ kind: "blocked", reason: "hard_cap", overBy: 1n, unlockAtMs: null, cycleEndMs: 1 }).gate.evaluate("u", 1n)).toBe("hard_cap_exceeded");
    expect(await make({ kind: "allow", reason: "cap_off" }).gate.evaluate("u", 1n)).toBe("within");
  });
  it("treats a budget outage as an error, not as permission", async () => {
    const out = make({ kind: "allow", reason: "service_unavailable" });
    await expect(out.gate.evaluate("u", 1n)).rejects.toThrow("budget_unavailable");
    expect(out.calls.some((c) => c.startsWith("release:"))).toBe(true);
    await expect(make("throw").gate.evaluate("u", 1n)).rejects.toThrow("boom");
  });
});

describe("LiveSkuQuote", () => {
  const facts: SkuFacts = {
    skuId: "s1",
    productId: "p1",
    storeId: "st1",
    currency: "EGP",
    sizeLabel: "M",
    titleAr: "فستان",
    titleEn: null,
    priceAmount: 90_000n,
    skuStatus: "active",
    productStatus: "active",
  };
  const src = (o: {
    f?: SkuFacts | null;
    snap?: { priceAmount: bigint | null; claimType: string } | null;
    available?: number;
    dropId?: string | null | "unknown";
  }) => ({
    skus: { skuFacts: async () => (o.f === undefined ? facts : o.f) },
    prices: { snapshotFor: async () => (o.snap === undefined ? { priceAmount: 90_000n, claimType: "verified_discount" } : o.snap) },
    stock: { levels: async () => new Map([["s1", { available: o.available ?? 3 }]]) },
    directory: { lookup: async () => (o.dropId === "unknown" ? null : { dropId: o.dropId ?? null }) },
  });
  it("quotes a verified, in-stock, non-drop SKU", async () => {
    const q = await new LiveSkuQuote(src({})).quote("s1", " m ");
    expect(q).toMatchObject({ listed: true, price: 90_000n, priceVerified: true, priceAnomaly: false, sizeKnown: true, sizeInStock: true, dropSku: false, itemLabelEn: "فستان" });
  });
  it("is restrictive when evidence is missing or inconsistent", async () => {
    expect((await new LiveSkuQuote(src({ snap: null })).quote("s1", "M"))?.priceVerified).toBe(false);
    expect((await new LiveSkuQuote(src({ snap: { priceAmount: 80_000n, claimType: "verified_discount" } })).quote("s1", "M"))).toMatchObject({ priceVerified: false, priceAnomaly: true });
    expect((await new LiveSkuQuote(src({ snap: { priceAmount: 90_000n, claimType: "lowest_30d" } })).quote("s1", "M"))?.priceVerified).toBe(false);
    expect(await new LiveSkuQuote(src({ f: null })).quote("s1", "M")).toBeNull();
    expect((await new LiveSkuQuote(src({})).quote("s1", "L"))).toMatchObject({ sizeKnown: false, sizeInStock: false });
    expect((await new LiveSkuQuote(src({ available: 0 })).quote("s1", "M"))?.sizeInStock).toBe(false);
    expect((await new LiveSkuQuote(src({ dropId: "d1" })).quote("s1", "M"))?.dropSku).toBe(true);
    expect((await new LiveSkuQuote(src({ dropId: "unknown" })).quote("s1", "M"))?.dropSku).toBe(true);
    expect((await new LiveSkuQuote(src({ f: { ...facts, skuStatus: "paused" } })).quote("s1", "M"))?.listed).toBe(false);
  });
});

describe("Phase3BridgeModule", () => {
  it("binds each late from the owning module's token at bootstrap, and an unbound late throws", async () => {
    const lates = createPhase3Lates();
    const provided = {
      [INVENTORY_SYNC_STOCK as symbol]: { execute: async () => ({ kind: "applied", replayed: false }) },
      [PRICE_INTEGRITY_SERVICE as symbol]: { snapshotFor: async () => null },
      [PLUS_ENTITLEMENTS as symbol]: { forUser: async () => ({ entitled: true }) },
      [ADDRESS_SERVICE as symbol]: { list: async () => [] },
    };
    @Global()
    @Module({
      providers: Object.getOwnPropertySymbols(provided).map((s) => ({ provide: s, useValue: (provided as Record<symbol, unknown>)[s] })),
      exports: Object.getOwnPropertySymbols(provided),
    })
    class Owners {}
    const ref = await Test.createTestingModule({ imports: [Owners, Phase3BridgeModule.forRoot(lates)] }).compile();
    await ref.init();
    expect(await lazy(lates.entitlements).forUser("u")).toEqual({ entitled: true });
    expect(await lazy(lates.stockSync).execute({})).toEqual({ kind: "applied", replayed: false });
    // CHECKOUT_CAP_GUARD was not provided: the late stays unbound and fails closed on use.
    void CHECKOUT_CAP_GUARD;
    expect(() => lates.capGuard.get()).toThrow(/not bound/);
    await ref.close();
  });
});
