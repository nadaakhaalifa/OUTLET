import { describe, expect, it } from "vitest";
import { GuestStore } from "../guest";
import { InMemoryGuestStorage } from "../guest/storage";
import { GUEST_WATCH_KIND, buildPdp, guestWatchInput, FIXTURE_PRODUCT } from "./model";

describe("guest Notify me", () => {
  it("is a restock watch, offered only when the item is paused or sold out", () => {
    expect(GUEST_WATCH_KIND).toBe("restock");
    expect(buildPdp({ ...FIXTURE_PRODUCT, status: "paused" }, null).offerNotify).toBe(true);
    expect(buildPdp(FIXTURE_PRODUCT, null).offerNotify).toBe(false);
  });
  it("stores only product, sku and kind on the phone, and unwatch removes it", async () => {
    const store = new GuestStore(new InMemoryGuestStorage());
    await store.hydrate();
    expect(store.watch(guestWatchInput("p1", "s1")).ok).toBe(true);
    const [a] = store.watches();
    expect(a?.productId).toBe("p1");
    expect(a?.skuId).toBe("s1");
    expect(a?.kind).toBe("restock");
    expect(Object.keys(a ?? {}).sort()).toEqual(["addedAt", "kind", "productId", "seenPricePiastres", "skuId"]);
    expect(a?.seenPricePiastres).toBeNull();
    store.unwatch("p1", "restock");
    expect(store.watches()).toEqual([]);
  });
  it("signed-in path is unchanged: the view still offers the same button", () => {
    expect(buildPdp({ ...FIXTURE_PRODUCT, status: "paused" }, null).blocked).toBe("paused");
  });
});

describe("PDP uses the session-aware ports", () => {
  it("never reads the server-only pdp port for save or add-to-bag", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(`${__dirname}/PdpScreen.tsx`, "utf8");
    expect(src).toMatch(/getFeaturePorts\(\)\.bag/);
    expect(src).toMatch(/getFeaturePorts\(\)\.wishlists/);
    expect(src).not.toMatch(/port\.(addToBag|saveWithIntent)/);
  });
});
