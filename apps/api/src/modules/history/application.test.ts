import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { FakeConsent, FakeFlags, FakeProductLookup, InMemoryHistoryStore } from "./adapters/in-memory";
import {
  BuildUserFeatures,
  ClearHistory,
  ListHistory,
  PurgeExpiredEvents,
  RebuildFeaturesBatch,
  RecordHistoryEvent,
  RecordProductView,
  SetHistoryPaused,
  SetPersonalization,
  SweepClearRequests,
  decodeCursor,
  encodeCursor,
} from "./application/history";

const U = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const H = 3_600_000;

function setup() {
  let now = 1_800_000_000_000;
  let seq = 0;
  const clock = { nowMs: () => now };
  const ids = { uuidV7: () => `00000000-0000-7000-8000-${String(++seq).padStart(12, "0")}` };
  const store = new InMemoryHistoryStore();
  const d = { store, clock, ids };
  const consent = new FakeConsent();
  const flags = new FakeFlags();
  const products = new FakeProductLookup();
  products.set({ productId: U(7001), storeId: U(9001), categoryId: "dress", priceMinor: 50_000n, storeActive: true });
  const record = new RecordHistoryEvent(d);
  return {
    d,
    store,
    consent,
    flags,
    products,
    record,
    advance: (ms: number) => void (now += ms),
    now: () => now,
    build: new BuildUserFeatures(d, consent, flags),
    sweep: new SweepClearRequests(d),
  };
}

describe("RecordHistoryEvent", () => {
  it("records, deduplicates on the source event id, validates shape", async () => {
    const s = setup();
    const a = await s.record.execute({ userId: U(1), type: "saved", itemId: U(7001), eventId: U(5000) });
    expect(a.kind).toBe("recorded");
    expect((await s.record.execute({ userId: U(1), type: "saved", itemId: U(7001), eventId: U(5000) })).kind).toBe("duplicate");
    expect((await s.record.execute({ userId: U(1), type: "viewed", itemId: null })).kind).toBe("invalid");
    expect((await s.record.execute({ userId: U(1), type: "viewed", itemId: "nope" })).kind).toBe("invalid");
    expect((await s.record.execute({ userId: U(1), type: "searched", itemId: null, detail: "   " })).kind).toBe("invalid");
    const q = await s.record.execute({ userId: U(1), type: "searched", itemId: U(7001), detail: "white  linen\u0000 dress" });
    expect(q.kind === "recorded" && q.event.detail).toBe("white linen dress");
    expect(q.kind === "recorded" && q.event.itemId).toBeNull();
  });

  it("pause: nothing is recorded, including recently viewed; resume records again", async () => {
    const s = setup();
    await new SetHistoryPaused(s.d).execute(U(1), true);
    const view = new RecordProductView(s.d, s.products, s.record);
    expect(await view.execute(U(1), U(7001))).toEqual({ kind: "ok", recorded: false });
    expect(await s.store.listEvents(U(1), null, null, 10)).toEqual([]);
    expect(await s.store.listRecentlyViewed(U(1), 10)).toEqual([]);
    await new SetHistoryPaused(s.d).execute(U(1), false);
    expect(await view.execute(U(1), U(7001))).toEqual({ kind: "ok", recorded: true });
    expect((await s.store.listRecentlyViewed(U(1), 10))[0]?.priceMinor).toBe(50_000n);
  });

  it("view of an unknown or suspended product is not found and records nothing", async () => {
    const s = setup();
    s.products.set({ productId: U(7002), storeId: U(9001), categoryId: "x", priceMinor: 1n, storeActive: false });
    const view = new RecordProductView(s.d, s.products, s.record);
    expect(await view.execute(U(1), U(7002))).toEqual({ kind: "not_found" });
    expect(await view.execute(U(1), U(7999))).toEqual({ kind: "not_found" });
    expect(s.store.events).toHaveLength(0);
  });
});

describe("cursor", () => {
  it("round trips and rejects junk", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 9_999_999_999_999 }), (ms) => {
        expect(decodeCursor(encodeCursor(ms, U(1)))).toEqual({ atMs: ms, id: U(1) });
      }),
    );
    for (const bad of ["", "@@@", Buffer.from("x|y").toString("base64url"), Buffer.from("12|zzz").toString("base64url")]) {
      expect(decodeCursor(bad)).toBeNull();
    }
    expect(Object.keys(new ListHistory(setup().d))).toBeDefined();
  });
});

describe("clear history", () => {
  it("wipes events, features and recently viewed at once and completes through the job within 24h", async () => {
    const s = setup();
    s.consent.grant(U(1));
    await s.record.execute({ userId: U(1), type: "bought", itemId: U(7001), categoryId: "dress", storeId: U(9001) });
    expect(await s.build.execute(U(1))).toBe("built");
    const c = await new ClearHistory(s.d).execute(U(1));
    expect(c.counts).toEqual({ events: 1, features: 1, recentlyViewed: 0 });
    expect(c.deadlineMs - s.now()).toBe(24 * H);
    expect(await s.store.getFeatures(U(1))).toBeNull();
    // a batch job racing the clear cannot rebuild while the request is pending
    expect(await s.build.execute(U(1))).toBe("clear_pending");
    expect(await s.store.getFeatures(U(1))).toBeNull();
    s.advance(H);
    const rep = await s.sweep.execute();
    expect(rep).toMatchObject({ completed: 1, overdue: 0, metric: "privacy_history_clear_overdue_total" });
    expect(await s.store.pendingClearRequests(10)).toEqual([]);
    expect(await s.build.execute(U(1))).toBe("built");
  });

  it("reports a request that missed its deadline as overdue", async () => {
    const s = setup();
    await new ClearHistory(s.d).execute(U(1));
    s.advance(25 * H);
    expect((await s.sweep.execute()).overdue).toBe(1);
  });

  it("property: after clear + sweep nothing older than the request survives for that user", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(fc.integer({ min: 0, max: 5 }), { maxLength: 12 }), async (offsets) => {
        const s = setup();
        s.consent.grant(U(1));
        for (const [i, o] of offsets.entries()) {
          await s.record.execute({ userId: U(1), type: "viewed", itemId: U(7001), eventId: U(6000 + i), atMs: s.now() - o * H });
          await s.record.execute({ userId: U(2), type: "viewed", itemId: U(7001), eventId: U(8000 + i) });
        }
        await s.build.execute(U(1));
        await new ClearHistory(s.d).execute(U(1));
        await s.sweep.execute();
        expect(await s.store.listEvents(U(1), null, null, 100)).toEqual([]);
        expect(await s.store.getFeatures(U(1))).toBeNull();
        expect((await s.store.listEvents(U(2), null, null, 100)).length).toBe(offsets.length);
      }),
      { numRuns: 25 },
    );
  });
});

describe("features and personalization", () => {
  it("consent withdrawn or setting off deletes derived features; kill switch only skips", async () => {
    const s = setup();
    s.consent.grant(U(1));
    await s.record.execute({ userId: U(1), type: "saved", itemId: U(7001), categoryId: "dress" });
    expect(await s.build.execute(U(1))).toBe("built");
    s.flags.mlRanking = false;
    expect(await s.build.execute(U(1))).toBe("kill_switch");
    expect(await s.store.getFeatures(U(1))).not.toBeNull();
    s.flags.mlRanking = true;
    s.consent.withdraw(U(1));
    expect(await s.build.execute(U(1))).toBe("no_consent");
    expect(await s.store.getFeatures(U(1))).toBeNull();
    s.consent.grant(U(1));
    expect(await s.build.execute(U(1))).toBe("built");
    await new SetPersonalization(s.d).execute(U(1), false);
    expect(await s.store.getFeatures(U(1))).toBeNull();
    expect(await s.build.execute(U(1))).toBe("setting_off");
  });

  it("built features contain no budget keys whatever the events carry", async () => {
    const s = setup();
    s.consent.grant(U(1));
    await s.record.execute({ userId: U(1), type: "bought", itemId: U(7001), categoryId: "budget_category_name_ok", detail: "afford" });
    await s.build.execute(U(1));
    const f = await s.store.getFeatures(U(1));
    // a category whose id merely contains a forbidden word is refused rather than persisted
    expect(f === null || JSON.stringify(f).match(/budget|afford/i) === null).toBe(true);
  });

  it("batch rebuild covers only users with personalization on", async () => {
    const s = setup();
    s.consent.grant(U(1));
    s.consent.grant(U(2));
    await s.record.execute({ userId: U(1), type: "viewed", itemId: U(7001), categoryId: "a" });
    await s.record.execute({ userId: U(2), type: "viewed", itemId: U(7001), categoryId: "a" });
    await new SetPersonalization(s.d).execute(U(2), false);
    const r = await new RebuildFeaturesBatch(s.d, s.build).execute();
    expect(r.built).toBe(1);
  });

  it("retention purge deletes events older than 25 months only", async () => {
    const s = setup();
    const old = s.now() - 26 * 31 * 24 * H;
    await s.record.execute({ userId: U(1), type: "viewed", itemId: U(7001), atMs: old });
    await s.record.execute({ userId: U(1), type: "viewed", itemId: U(7001) });
    expect(await new PurgeExpiredEvents(s.d).execute()).toBe(1);
    expect(s.store.events).toHaveLength(1);
  });
});
