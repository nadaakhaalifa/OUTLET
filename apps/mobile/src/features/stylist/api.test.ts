import { describe, expect, it, vi } from "vitest";
import type { OutletClient } from "../../services/api-client";
import type { AdapterContext } from "../../services/wire";
import { ApiStylistPort } from "./api";

type Call = (...a: unknown[]) => Promise<unknown>;
const ok = (data: unknown) => Promise.resolve({ data, etag: null, notModified: false });
const port = (client: Record<string, Call>) =>
  new ApiStylistPort({ client: client as unknown as OutletClient, locale: () => "ar", nowMs: () => 0, deviceId: () => "device-12345" } as AdapterContext);

const outfit = {
  id: "o1",
  items: [
    { slot: "top", item_id: "sku1", store_id: "s1", price_piastres: "90000" },
    { slot: "not-a-slot", item_id: "sku2", store_id: "s1", price_piastres: "1" },
  ],
  per_store: [{ store_id: "s1" }],
  missing: [{ slot: "shoes", add_piastres: "30000" }, { slot: "bag", add_piastres: null }, { slot: "bogus", add_piastres: "1" }],
};

describe("ApiStylistPort.generate", () => {
  it("sends the occasion, modesty and budget as wire strings, and never invents titles or fees", async () => {
    const generateStylistOutfits = vi.fn(() => ok({ outfits: [outfit], source: "ai", fallback_reason: null }));
    const r = await port({ generateStylistOutfits }).generate({ occasion: "weddingGuest", modest: true, budget: 300000n } as never);
    expect(generateStylistOutfits).toHaveBeenCalledWith({ body: { occasion: "wedding_guest", modest: true, budget_piastres: "300000" } });
    expect(r.source).toBe("ai");
    const o = r.outfits[0];
    expect(o?.items).toEqual([{ skuId: "sku1", slot: "top", title: "", storeId: "s1", storeName: "", sizeLabel: "", unitPrice: 90000n }]);
    expect(o?.deliveries).toEqual([{ storeId: "s1", storeName: "", fee: 0n }]);
    expect(o?.missing.map((m) => [m.slot, m.shortfall])).toEqual([["shoes", 30000n], ["bag", 0n]]);
  });

  it("omits the budget when there is none and labels rule-based results as rules", async () => {
    const generateStylistOutfits = vi.fn(() => ok({ outfits: [], source: "rule_based", fallback_reason: null }));
    const r = await port({ generateStylistOutfits }).generate({ occasion: "gym", modest: false, budget: null } as never);
    expect(generateStylistOutfits).toHaveBeenCalledWith({ body: { occasion: "gym", modest: false } });
    expect(r.source).toBe("rules");
    const fallback = await port({ generateStylistOutfits: () => ok({ outfits: [], source: "llm", fallback_reason: "llm_down" }) }).generate({ occasion: "eid", modest: false, budget: null } as never);
    expect(fallback.source).toBe("rules");
  });
});

describe("ApiStylistPort bag and feedback", () => {
  it("swap is unsupported", async () => {
    await expect(port({}).swap("o", "s")).rejects.toMatchObject({ kind: "failed" });
  });

  it("feedback posts the signal", async () => {
    const submitStylistFeedback = vi.fn(() => ok({}));
    await port({ submitStylistFeedback }).feedback("o1", "sku1", "like" as never);
    expect(submitStylistFeedback).toHaveBeenCalledWith({ body: { outfit_id: "o1", item_id: "sku1", signal: "like" } });
  });

  it("addOutfit reports accepted items, price changes and unavailable items separately", async () => {
    const addStylistOutfitToBag = vi.fn(() => ok({
      added: true, already_added: false, item_ids: ["a", "b", "c"],
      price_changes: [{ item_id: "b", to_piastres: "5000" }],
      unavailable: [{ item_id: "c", reason: "paused_by_seller" }, { item_id: "d", reason: "price_moved" }, { item_id: "e", reason: "gone" }],
    }));
    const r = await port({ addStylistOutfitToBag }).addOutfit("o1", "k");
    expect(addStylistOutfitToBag).toHaveBeenCalledWith({ path: { outfitId: "o1" } }, { idempotencyKey: "k" });
    expect(r.added).toEqual(["a", "c"]);
    expect(r.rejected).toEqual([
      { skuId: "c", reason: "paused", currentPrice: null },
      { skuId: "d", reason: "priceChanged", currentPrice: null },
      { skuId: "e", reason: "soldOut", currentPrice: null },
      { skuId: "b", reason: "priceChanged", currentPrice: 5000n },
    ]);
  });

  it("adds nothing when the server added nothing, and treats an already added outfit as added", async () => {
    const base = { item_ids: ["a"], price_changes: [], unavailable: [] };
    expect((await port({ addStylistOutfitToBag: () => ok({ ...base, added: false, already_added: false }) }).addOutfit("o", "k")).added).toEqual([]);
    expect((await port({ addStylistOutfitToBag: () => ok({ ...base, added: false, already_added: true }) }).addOutfit("o", "k")).added).toEqual(["a"]);
  });
});
