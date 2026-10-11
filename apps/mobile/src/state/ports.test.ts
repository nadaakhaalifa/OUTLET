import { describe, expect, it } from "vitest";
import { FIXTURE_PRODUCT } from "../features/pdp/model";
import { createInMemoryPorts, getFeaturePorts, setFeaturePorts } from "./ports";

describe("feature ports container", () => {
  it("PDP add-to-bag lands in the same bag the Bag screen loads", async () => {
    const p = createInMemoryPorts();
    const before = (await p.bag.load()).lines.length;
    const size = FIXTURE_PRODUCT.sizes[0];
    expect(size).toBeDefined();
    await p.bag.addLine("sku-new", { storeId: "sNew", storeName: "New Store", title: "Tee", sizeLabel: "M", unitPrice: 10_000n });
    await p.bag.addLine("sku-new", { storeId: "sNew", storeName: "New Store", title: "Tee", sizeLabel: "M", unitPrice: 10_000n });
    const snap = await p.bag.load();
    expect(snap.lines.length).toBe(before + 1);
    expect(snap.lines.find((l) => l.id === "sku-sku-new")?.qty).toBe(2);
    expect(snap.stores.some((s) => s.id === "sNew")).toBe(true);
  });

  it("save-with-intent creates the list once and is idempotent per product", async () => {
    const p = createInMemoryPorts();
    await p.wishlists.saveItem("prod-1", "treat", { title: "Dress", price: 50_000n });
    await p.wishlists.saveItem("prod-1", "treat", { title: "Dress", price: 50_000n });
    const lists = (await p.wishlists.list()).filter((l) => l.intent === "treat");
    const items = lists.flatMap((l) => l.items).filter((i) => i.productId === "prod-1");
    expect(items).toHaveLength(1);
  });

  it("stylist add-outfit writes accepted items through the Bag port", async () => {
    const p = createInMemoryPorts();
    const res = await p.stylist.generate({ occasion: "work", vibe: "classic", modest: false, budget: null });
    const outfit = res.outfits[0];
    expect(outfit).toBeDefined();
    if (outfit === undefined) return;
    const before = (await p.bag.load()).lines.length;
    const r = await p.outfitBag.addOutfit(outfit.id, "k1");
    expect(r.added.length).toBe(outfit.items.length);
    const lines = (await p.bag.load()).lines;
    expect(lines.length).toBe(before + outfit.items.length);
  });

  it("can be swapped for a real client container", () => {
    const custom = createInMemoryPorts();
    setFeaturePorts(custom);
    expect(getFeaturePorts()).toBe(custom);
    setFeaturePorts(null);
    expect(getFeaturePorts()).not.toBe(custom);
  });
});
