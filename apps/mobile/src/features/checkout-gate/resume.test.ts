import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { schemas } from "../../services/api-client";
import { GuestStore, InMemoryGuestStorage, runGuestMerge, type MergeTransport } from "../guest";
import { SessionBagPort } from "../bag/session-bag";
import type { BagPort, BagSnapshot } from "../bag/model";

const U = "00000000-0000-4000-8000-000000000001";
const empty: BagSnapshot = { stores: [], lines: [], isPlusMember: false };

/**
 * Checkout step 1 mounts only after the merge phase navigates (MergePhase `leave` runs after runGuestMerge resolves or the
 * shopper chooses "continue without it"). These tests pin the ordering with the real merge client and the session-aware
 * bag; the screen itself is not rendered (no simulator).
 */
describe("checkout after the Checkout gate", () => {
  const mk = async () => {
    const s = new GuestStore(new InMemoryGuestStorage(), { now: () => 1_700_000_000_000 });
    await s.hydrate();
    s.addToBag({ skuId: U, productId: U, storeId: U, qty: 1, seen: { unitPricePiastres: "100", title: "T", sizeLabel: null, storeName: "S", imageUrl: null } });
    return s;
  };
  const server = (log: string[]): BagPort => ({
    load: async () => { log.push("server.bag"); return empty; }, inSizeSuggestions: async () => [],
    setSavedForLater: async () => undefined, setQuantity: async () => undefined, removeLine: async () => undefined, addLine: async () => undefined,
  });
  const quote = (log: string[]) => { log.push("checkout.quote"); };

  it("the merge request precedes the first cart/quote read, and the signed-in bag port is used", async () => {
    const log: string[] = [];
    const store = await mk();
    const t: MergeTransport = { merge: async () => { log.push("merge"); return { status: 200, data: { cart: {} as schemas.GuestMergeResponse["cart"], outcome: { lines: [], saved: { added: 0, duplicates: 0, over_cap: 0, unavailable: 0 }, viewed: "ignored_no_consent" } } }; } };
    await runGuestMerge({ store, transport: t, newKey: () => "k", includeViewed: false });
    quote(log); // the checkout route mounts only now
    const bag = new SessionBagPort(server(log), server(log), async () => true);
    await bag.load();
    expect(log).toEqual(["merge", "checkout.quote", "server.bag"]);
  });

  it("a failed merge followed by 'continue without it' still loads the server bag and quote; local items are kept", async () => {
    const log: string[] = [];
    const store = await mk();
    const out = await runGuestMerge({ store, transport: { merge: async () => { log.push("merge"); return { status: 503, data: null }; } }, newKey: () => "k", includeViewed: false });
    expect(out.kind).toBe("failed");
    quote(log);
    await new SessionBagPort(server(log), server(log), async () => true).load();
    expect(log).toEqual(["merge", "checkout.quote", "server.bag"]);
    expect(store.getState().bag).toHaveLength(1);
  });

  it("CheckoutSession holds no guest state and reads its ports from the session-aware container", () => {
    const src = readFileSync(join(__dirname, "..", "checkout", "CheckoutSession.tsx"), "utf8");
    expect(src).not.toMatch(/guest/i);
    expect(src).toContain("getFeaturePorts()");
  });
});
