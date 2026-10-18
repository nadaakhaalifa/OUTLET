import { describe, expect, it } from "vitest";
import type { schemas } from "../../services/api-client";
import { buildMergePayload, runGuestMerge, summarizeMerge, type MergeHttpResult, type MergeTransport } from "./merge";
import { InMemoryGuestStorage } from "./storage";
import { SessionBagPort } from "../bag/session-bag";
import type { BagPort, BagSnapshot } from "../bag/model";
import { GUEST_SIZE_PROFILE_KEY, onSignedOut, wipeGuestData } from "./session";
import { GuestStore } from "./store";

const T0 = 1_700_000_000_000;
const u = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const seen = (title: string) => ({ unitPricePiastres: "10000", title, sizeLabel: "M", storeName: "S", imageUrl: null });
let ids = 0;
const mkStore = () => new GuestStore(new InMemoryGuestStorage(), { now: () => T0, newLineId: () => `l${++ids}` });
const add = (s: GuestStore, sku: number, qty = 1) => s.addToBag({ skuId: u(sku), productId: u(sku + 100), storeId: u(900), qty, seen: seen(`Item ${sku}`) });

const emptyCart = {} as schemas.GuestMergeResponse["cart"];
const response = (lines: schemas.GuestMergeResponse["outcome"]["lines"], saved = { added: 0, duplicates: 0, over_cap: 0, unavailable: 0 }): schemas.GuestMergeResponse => ({
  cart: emptyCart, outcome: { lines, saved, viewed: "ignored_no_consent" },
});

class FakeTransport implements MergeTransport {
  readonly calls: { body: schemas.GuestMergeRequest; key: string }[] = [];
  constructor(private readonly results: MergeHttpResult[]) {}
  async merge(body: schemas.GuestMergeRequest, key: string): Promise<MergeHttpResult> {
    this.calls.push({ body, key });
    return this.results.shift() ?? { status: 0, data: null };
  }
}
let n = 0;
const deps = (store: GuestStore, transport: MergeTransport, includeViewed = false) => ({ store, transport, newKey: () => `key-${++n}`, includeViewed });

describe("buildMergePayload", () => {
  it("sends bag lines (incl. saved for later) and saved items, never viewed without consent", async () => {
    const s = mkStore(); await s.hydrate();
    add(s, 1, 2);
    s.save({ productId: u(5), skuId: null, intent: "want", seenPricePiastres: "100" });
    s.view(u(7));
    const p = buildMergePayload(s.getState(), false);
    expect(p.body.bag_lines).toEqual([{ sku_id: u(1), qty: 2, saved_for_later: false, added_at: new Date(T0).toISOString() }]);
    expect(p.body.saved).toEqual([{ product_id: u(5), intent: "want" }]);
    expect(p.body.recently_viewed).toBeUndefined();
    expect(buildMergePayload(s.getState(), true).body.recently_viewed).toHaveLength(1);
  });
  it("leaves non-UUID ids on the phone", async () => {
    const s = mkStore(); await s.hydrate();
    s.addToBag({ skuId: "sku-fixture", productId: "p", storeId: "st", qty: 1, seen: seen("x") });
    expect(buildMergePayload(s.getState(), false).lineIds).toEqual([]);
  });
});

describe("runGuestMerge", () => {
  it("does nothing, and sends nothing, with an empty store", async () => {
    const s = mkStore(); await s.hydrate();
    const t = new FakeTransport([]);
    expect(await runGuestMerge(deps(s, t))).toEqual({ kind: "nothing" });
    expect(t.calls).toHaveLength(0);
  });

  it("stores the key before the request, clears sent items and the key on 200", async () => {
    const s = mkStore(); await s.hydrate();
    add(s, 1, 2);
    let keyAtRequest: string | null = "unset";
    const t: MergeTransport = { merge: async (_b, k) => { keyAtRequest = s.getState().merge.pendingKey; expect(k).toBe(keyAtRequest); add(s, 2); return { status: 200, data: response([{ sku_id: u(1), result: "added", reason: null, qty: 2, previous_qty: null }]) }; } };
    const out = await runGuestMerge(deps(s, t));
    expect(keyAtRequest).toMatch(/^key-/);
    expect(out.kind).toBe("done");
    // the line added while the request was in flight survives
    expect(s.getState().bag.map((l) => l.skuId)).toEqual([u(2)]);
    expect(s.getState().merge.pendingKey).toBeNull();
  });

  it("keeps local data and the SAME key after a non-200, and reuses it on retry", async () => {
    const s = mkStore(); await s.hydrate();
    add(s, 1, 2);
    const t = new FakeTransport([{ status: 503, data: null }, { status: 0, data: null }, { status: 200, data: response([{ sku_id: u(1), result: "added", reason: null, qty: 2, previous_qty: null }]) }]);
    expect(await runGuestMerge(deps(s, t))).toEqual({ kind: "failed", status: 503 });
    expect(s.getState().bag).toHaveLength(1);
    expect(await runGuestMerge(deps(s, t))).toEqual({ kind: "failed", status: 0 });
    expect((await runGuestMerge(deps(s, t))).kind).toBe("done");
    expect(new Set(t.calls.map((c) => c.key)).size).toBe(1);
    expect(s.getState().bag).toHaveLength(0);
    expect(s.getState().merge.pendingKey).toBeNull();
  });

  it("401 and 5xx never clear anything", async () => {
    const s = mkStore(); await s.hydrate();
    add(s, 1);
    for (const status of [401, 429, 500]) {
      expect(await runGuestMerge(deps(s, new FakeTransport([{ status, data: null }])))).toEqual({ kind: "failed", status });
    }
    expect(s.getState().bag).toHaveLength(1);
    expect(s.getState().merge.pendingKey).not.toBeNull();
  });

  it("422 (same key, changed bag) gets one fresh key; the merge rule is idempotent", async () => {
    const s = mkStore(); await s.hydrate();
    add(s, 1);
    const t = new FakeTransport([{ status: 500, data: null }, { status: 422, data: null }, { status: 200, data: response([]) }]);
    await runGuestMerge(deps(s, t));
    add(s, 2);
    const out = await runGuestMerge(deps(s, t));
    expect(out.kind).toBe("done");
    expect(t.calls).toHaveLength(3);
    expect(t.calls[1]?.key).not.toBe(t.calls[2]?.key);
  });

  it("a second 422 is reported, not looped", async () => {
    const s = mkStore(); await s.hydrate();
    add(s, 1);
    const t = new FakeTransport([{ status: 422, data: null }, { status: 422, data: null }]);
    expect(await runGuestMerge(deps(s, t))).toEqual({ kind: "failed", status: 422 });
    expect(t.calls).toHaveLength(2);
  });

  it("concurrent callers share one request", async () => {
    const s = mkStore(); await s.hydrate();
    add(s, 1);
    const t = new FakeTransport([{ status: 200, data: response([]) }]);
    const [a, b] = await Promise.all([runGuestMerge(deps(s, t)), runGuestMerge(deps(s, t))]);
    expect(a).toBe(b);
    expect(t.calls).toHaveLength(1);
  });
});

describe("summarizeMerge", () => {
  const local = new Map([[u(1), { qty: 2, title: "Dress" }], [u(2), { qty: 1, title: "Shoe" }], [u(3), { qty: 4, title: "Bag" }], [u(4), { qty: 1, title: "Hat" }]]);
  it("reports the larger-quantity rule with both quantities", () => {
    const sm = summarizeMerge(response([{ sku_id: u(1), result: "unchanged", reason: null, qty: 3, previous_qty: 3 }]), local);
    expect(sm.changed).toBe(true);
    expect(sm.notes[0]).toMatchObject({ kind: "kept_larger", title: "Dress", localQty: 2, accountQty: 3, qty: 3 });
  });
  it("tells the shopper a Saved line was moved into the bag", () => {
    const sm = summarizeMerge(response([{ sku_id: u(1), result: "moved_to_bag", reason: null, qty: 2, previous_qty: 2 }]), local);
    expect(sm.notes[0]).toMatchObject({ kind: "moved_to_bag", title: "Dress" });
    expect(sm.changed).toBe(true);
  });
  it("says nothing when quantities agree or the line was simply added", () => {
    const sm = summarizeMerge(response([
      { sku_id: u(1), result: "unchanged", reason: null, qty: 2, previous_qty: 2 },
      { sku_id: u(2), result: "added", reason: null, qty: 1, previous_qty: null },
    ]), local);
    expect(sm.changed).toBe(false);
  });
  it("reports moved to Saved with its reason, unavailable, suspended store, clamp and Saved overflow", () => {
    const sm = summarizeMerge(response([
      { sku_id: u(1), result: "moved_to_saved", reason: "over_cap", qty: null, previous_qty: null },
      { sku_id: u(2), result: "moved_to_saved", reason: "unavailable", qty: null, previous_qty: null },
      { sku_id: u(3), result: "limit_clamped", reason: null, qty: 4, previous_qty: null },
      { sku_id: u(4), result: "store_suspended", reason: null, qty: null, previous_qty: null },
    ], { added: 0, duplicates: 0, over_cap: 2, unavailable: 1 }), local);
    expect(sm.notes.map((x) => [x.kind, x.reason])).toEqual([["moved_to_saved", "over_cap"], ["moved_to_saved", "unavailable"], ["clamped", null], ["store_suspended", null]]);
    expect(sm.savedOverCap).toBe(2);
    expect(sm.savedUnavailable).toBe(1);
  });
});

describe("robustness and session helpers", () => {
  it("200 then a rejecting flush is still a successful merge", async () => {
    const s = mkStore(); await s.hydrate();
    add(s, 1);
    const real = s.flush.bind(s);
    let calls = 0;
    s.flush = async () => { calls++; if (calls >= 2) throw new Error("disk full"); return real(); };
    const out = await runGuestMerge(deps(s, new FakeTransport([{ status: 200, data: response([]) }])));
    expect(out.kind).toBe("done");
    expect(s.getState().bag).toHaveLength(0);
  });

  it("422 rotation holds with concurrent SessionBagPort.load calls", async () => {
    const s = mkStore(); await s.hydrate();
    add(s, 1);
    const t = new FakeTransport([{ status: 500, data: null }]);
    await runGuestMerge(deps(s, t)); // leaves a pending key
    add(s, 2); // body now differs from the pending key's first attempt
    t.calls.length = 0;
    const t2 = new FakeTransport([{ status: 422, data: null }, { status: 200, data: response([]) }]);
    const empty: BagSnapshot = { stores: [], lines: [], isPlusMember: false };
    const bag: BagPort = { load: async () => empty, inSizeSuggestions: async () => [], setSavedForLater: async () => undefined, setQuantity: async () => undefined, removeLine: async () => undefined, addLine: async () => undefined };
    const p = new SessionBagPort(bag, bag, async () => true, async () => { await runGuestMerge(deps(s, t2)); });
    await Promise.all([p.load(), p.load()]);
    expect(t2.calls).toHaveLength(2);
    expect(t2.calls[0]?.key).not.toBe(t2.calls[1]?.key);
    expect(s.getState().bag).toHaveLength(0);
    expect(s.getState().merge.pendingKey).toBeNull();
  });

  it("wipeGuestData clears the store and the size profile key; onSignedOut drops the pending key", async () => {
    const s = mkStore(); await s.hydrate();
    add(s, 1);
    const removed: string[] = [];
    await wipeGuestData(s, { remove: async (k) => { removed.push(k); } });
    expect(s.getState().bag).toHaveLength(0);
    expect(removed).toEqual([GUEST_SIZE_PROFILE_KEY]);
    s.setMergePending("k1");
    onSignedOut(s);
    expect(s.getState().merge.pendingKey).toBeNull();
  });
});
