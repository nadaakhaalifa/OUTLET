import { describe, expect, it } from "vitest";
import { FIXTURE_PRODUCT, InMemoryPdpPort, buildCommunityFit, buildPdp, buildPriceBlock, buildRecommendation, discountPercent, pdpFailureState, sizeStock, type Product } from "./model";

const prod = (o: Partial<Product>): Product => ({ ...FIXTURE_PRODUCT, ...o });

describe("price block", () => {
  it("shows reference and percent only with a verified claim", () => {
    const v = buildPriceBlock(prod({ claim: { referencePrice: 200_000n, lowestIn30Days: false } , price: 150_000n }));
    expect(v.reference).toBe(200_000n);
    expect(v.discountPct).toBe(25);
  });
  it("never shows a reference without a claim", () => {
    const v = buildPriceBlock(prod({ claim: null }));
    expect(v.reference).toBeNull();
    expect(v.discountPct).toBeNull();
  });
  it("suppresses a claim below 5 percent or above the price", () => {
    expect(buildPriceBlock(prod({ price: 100_000n, claim: { referencePrice: 103_000n, lowestIn30Days: false } })).reference).toBeNull();
    expect(buildPriceBlock(prod({ price: 100_000n, claim: { referencePrice: 90_000n, lowestIn30Days: false } })).reference).toBeNull();
  });
  it("labels launch price only when there is no claim", () => {
    expect(buildPriceBlock(prod({ claim: null, isLaunchPrice: true })).launchPrice).toBe(true);
    expect(buildPriceBlock(prod({ isLaunchPrice: true })).launchPrice).toBe(false);
  });
  it("floors percent with integer math", () => {
    expect(discountPercent(300n, 200n)).toBe(33);
    expect(discountPercent(0n, 0n)).toBe(0);
  });
});

describe("size and stock", () => {
  it("shows stock only when 5 or fewer", () => {
    expect(sizeStock(6)).toEqual({ kind: "ok" });
    expect(sizeStock(5)).toEqual({ kind: "low", left: 5 });
    expect(sizeStock(0)).toEqual({ kind: "soldOut" });
  });
  it("reports confidence percent and not-sure below 0.6", () => {
    expect(buildRecommendation(FIXTURE_PRODUCT)).toMatchObject({ confidencePct: 91, sure: true, inStock: true });
    expect(buildRecommendation(prod({ recommendation: { sizeLabel: "M", confidence: 0.59 } }))?.sure).toBe(false);
    expect(buildRecommendation(prod({ recommendation: null }))).toBeNull();
  });
  it("hides community fit under 20 buyers", () => {
    expect(buildCommunityFit({ direction: "runsSmall", sampleCount: 19 })).toBeNull();
    expect(buildCommunityFit({ direction: "runsSmall", sampleCount: 20 })?.sampleCount).toBe(20);
  });
});

describe("add to bag gating", () => {
  it("needs an in-stock size", () => {
    expect(buildPdp(FIXTURE_PRODUCT, null).blocked).toBe("pickSize");
    expect(buildPdp(FIXTURE_PRODUCT, "p1-s").blocked).toBe("pickSize");
    expect(buildPdp(FIXTURE_PRODUCT, "p1-m").canAddToBag).toBe(true);
  });
  it("blocks and offers notify when paused or sold out", () => {
    const paused = buildPdp(prod({ status: "paused" }), "p1-m");
    expect(paused.blocked).toBe("paused");
    expect(paused.offerNotify).toBe(true);
    const out = buildPdp(prod({ sizes: [{ sku: "a", label: "M", stock: 0 }] }), "a");
    expect(out.blocked).toBe("soldOut");
  });
  it("hides delivery when the range is invalid", () => {
    expect(buildPdp(prod({ deliveryDaysMin: 5, deliveryDaysMax: 2 }), null).delivery).toBeNull();
    expect(buildPdp(FIXTURE_PRODUCT, null).delivery).toEqual({ min: 2, max: 4 });
  });
});

describe("port", () => {
  it("maps failures and records actions", async () => {
    const port = new InMemoryPdpPort();
    await port.addToBag("p1-m");
    await port.saveWithIntent("p1", "want");
    expect(port.added).toEqual(["p1-m"]);
    port.setFailure("offline");
    await expect(port.load()).rejects.toMatchObject({ kind: "offline" });
    expect(pdpFailureState(await port.load().catch((e: unknown) => e))).toEqual({ status: "error", offline: true });
  });
});
