import { describe, expect, it } from "vitest";
import { rerankByAffinity } from "./affinity";
import { migrate } from "./migrate";
import { watchAlert, addBagLine, emptyState, planMerge, purgeExpired, recordView, saveItem, bumpAffinity } from "./model";
import { GuestStateV1Schema, GuestStateV2Schema, GuestStateV4Schema, MAX_BAG_LINES, MAX_UNITS_PER_ITEM, TTL_MS, MAX_STATE_BYTES } from "./schema";
import { SqliteGuestStorage, type SqliteDb } from "./sqlite-storage";
import { InMemoryGuestStorage, type GuestStorageAdapter } from "./storage";
import { GuestStore } from "./store";

const seen = { unitPricePiastres: "10000", title: "Dress", sizeLabel: "M", storeName: "S", imageUrl: null };
const T0 = 1_700_000_000_000;
let n = 0;
const mk = (a: GuestStorageAdapter, now: () => number = () => T0) => new GuestStore(a, { now, newLineId: () => `l${++n}` });
const add = (s: GuestStore, sku: string, qty = 1, store = "st1") => s.addToBag({ skuId: sku, productId: `p-${sku}`, storeId: store, qty, seen });

describe("caps and dedupe", () => {
  it("dedupes by sku and refuses past 10 units", async () => {
    const s = mk(new InMemoryGuestStorage()); await s.hydrate();
    expect(add(s, "a", 4).ok).toBe(true);
    expect(add(s, "a", 6).ok).toBe(true);
    expect(s.getState().bag).toHaveLength(1);
    expect(s.getState().bag[0]?.qty).toBe(10);
    expect(add(s, "a", 1)).toEqual({ ok: false, error: "units_cap" });
  });
  it("refuses the 51st line", async () => {
    const s = mk(new InMemoryGuestStorage()); await s.hydrate();
    for (let i = 0; i < MAX_BAG_LINES; i++) expect(add(s, `s${i}`).ok).toBe(true);
    expect(add(s, "extra")).toEqual({ ok: false, error: "lines_cap" });
    expect(s.getState().bag).toHaveLength(MAX_BAG_LINES);
  });
  it("saved dedupes by (intent, product); viewed dedupes and orders newest first", () => {
    let st = emptyState(T0);
    st = saveItem(st, { productId: "p", skuId: null, intent: "need", seenPricePiastres: "1" }, T0);
    st = saveItem(st, { productId: "p", skuId: null, intent: "need", seenPricePiastres: "2" }, T0 + 1);
    st = saveItem(st, { productId: "p", skuId: null, intent: "want", seenPricePiastres: "2" }, T0 + 1);
    expect(st.saved).toHaveLength(2);
    st = recordView(recordView(recordView(st, "a", 1), "b", 2), "a", 3);
    expect(st.viewed.map((v) => v.productId)).toEqual(["a", "b"]);
  });
  it("affinity keeps at most 50 keys", () => {
    let st = emptyState(T0);
    for (let i = 0; i < 80; i++) st = bumpAffinity(st, "stores", `s${i}`, T0);
    expect(Object.keys(st.affinity.stores).length).toBe(50);
  });
});

describe("local alerts", () => {
  it("dedupes on (product, kind), caps at 100, expires at 180d, clears, and is PII-free", async () => {
    const s = mk(new InMemoryGuestStorage()); await s.hydrate();
    s.watch({ productId: "p", kind: "price_drop", seenPricePiastres: "100" });
    s.watch({ productId: "p", kind: "price_drop" });
    s.watch({ productId: "p", kind: "restock", skuId: "k" });
    expect(s.watches()).toHaveLength(2);
    s.unwatch("p", "restock");
    expect(s.watches().map((a) => a.kind)).toEqual(["price_drop"]);
    for (let i = 0; i < 130; i++) s.watch({ productId: `q${i}`, kind: "restock" });
    expect(s.watches()).toHaveLength(100);
    expect(s.watches().at(-1)?.productId).toBe("q129");
    const names: string[] = [];
    const walk = (o: unknown): void => { if (o !== null && typeof o === "object") for (const [k, v] of Object.entries(o)) { names.push(k); walk(v); } };
    walk(s.watches());
    expect(names.filter((k) => /phone|name$|email|address|dob|birth|measure|budget|iban|token|install/i.test(k))).toEqual([]);
    await s.clearAll();
    expect(s.watches()).toEqual([]);
  });
  it("TTL boundary: kept at exactly 180d, dropped at +1ms", () => {
    const st = emptyState(T0);
    const w = watchAlert(st, { productId: "p", kind: "restock" }, T0);
    expect(purgeExpired(w, T0 + TTL_MS.alerts).alerts).toHaveLength(1);
    expect(purgeExpired(w, T0 + TTL_MS.alerts + 1).alerts).toHaveLength(0);
  });
  it("v3 fixture migrates additively to v4 with empty alerts and no install id", async () => {
    const v3 = { v: 3, createdAt: 1, updatedAt: 2, bag: [], saved: [], viewed: [], affinity: { stores: {}, categories: {} }, merge: { pendingKey: null, startedAt: null }, consentBanner: "allowed" };
    const a = new InMemoryGuestStorage(JSON.stringify(v3));
    const s = mk(a); await s.hydrate(); await s.flush();
    expect(s.getState()).toMatchObject({ v: 4, alerts: [], consentBanner: "allowed" });
    const stored = await a.read();
    expect(stored).not.toMatch(/install/i);
    expect(JSON.parse(stored ?? "").v).toBe(4);
  });
});

describe("device settings", () => {
  it("persist across restart, default off, and paused history records nothing", async () => {
    const a = new InMemoryGuestStorage();
    const s = mk(a); await s.hydrate();
    expect(s.getState().settings).toEqual({ coolOff: false, historyPaused: false });
    s.setCoolOff(true); s.setHistoryPaused(true);
    s.view("p1"); s.like("stores", "st"); add(s, "a");
    expect(s.getState().viewed).toEqual([]);
    expect(s.getState().affinity.stores).toEqual({});
    expect(s.getState().bag).toHaveLength(1);
    await s.flush();
    const s2 = mk(a); await s2.hydrate();
    expect(s2.getState().settings).toEqual({ coolOff: true, historyPaused: true });
    s2.setHistoryPaused(false); s2.view("p1");
    expect(s2.getState().viewed).toHaveLength(1);
    await s2.clearAll();
    expect(s2.getState().settings).toEqual({ coolOff: false, historyPaused: false });
  });
  it("a v4 file without settings parses with defaults", async () => {
    const v4 = { v: 4, createdAt: 1, updatedAt: 2, bag: [], saved: [], viewed: [], affinity: { stores: {}, categories: {} }, merge: { pendingKey: null, startedAt: null }, consentBanner: "allowed", alerts: [] };
    const s = mk(new InMemoryGuestStorage(JSON.stringify(v4))); await s.hydrate();
    expect(s.getState().settings).toEqual({ coolOff: false, historyPaused: false });
    expect(s.consumeResetNotice()).toBeNull();
  });
  it("settings field names are not PII-like", () => {
    const names = Object.keys(emptyState(1).settings);
    expect(names.filter((k) => /phone|name$|email|address|dob|birth|measure|budget|iban|token|install/i.test(k))).toEqual([]);
  });
});

describe("TTL boundaries", () => {
  it.each([["bag", TTL_MS.bag], ["saved", TTL_MS.saved], ["viewed", TTL_MS.viewed]] as const)("%s: kept at exactly TTL, dropped at TTL+1ms", (kind, ttl) => {
    let st = emptyState(T0);
    if (kind === "bag") st = addBagLine(st, { id: "l", skuId: "a", productId: "p", storeId: "s", qty: 1, seen }, T0).state;
    if (kind === "saved") st = saveItem(st, { productId: "p", skuId: null, intent: "need", seenPricePiastres: "1" }, T0);
    if (kind === "viewed") st = recordView(st, "p", T0);
    expect(purgeExpired(st, T0 + ttl)[kind]).toHaveLength(1);
    expect(purgeExpired(st, T0 + ttl + 1)[kind]).toHaveLength(0);
  });
  it("too-large state is truncated in memory too and flagged", async () => {
    const a = new InMemoryGuestStorage();
    const s = mk(a); await s.hydrate();
    const big = "x".repeat(70);
    for (let i = 0; i < 100; i++) s.view(`v-${i}-${big}`);
    for (let i = 0; i < 200; i++) s.save({ productId: `p-${i}-${big}`, skuId: null, intent: "need", seenPricePiastres: "1" });
    await s.flush();
    expect(JSON.parse((await a.read()) ?? "")).toMatchObject({ v: 4 });
    expect(s.getState().saved.length).toBe(JSON.parse((await a.read()) ?? "").saved.length);
  });
  it("completeMerge clears pendingKey only on 200", async () => {
    const s = mk(new InMemoryGuestStorage()); await s.hydrate(); add(s, "a");
    const id = s.getState().bag[0]?.id ?? "";
    s.setMergePending("key-1");
    s.completeMerge(503, [id]);
    expect(s.getState().merge.pendingKey).toBe("key-1");
    expect(s.getState().bag).toHaveLength(1);
    s.completeMerge(200, [id]);
    expect(s.getState().merge).toEqual({ pendingKey: null, startedAt: null });
    expect(s.getState().bag).toHaveLength(0);
  });
  it("keeps an entry exactly at the TTL and drops it 1 ms later", () => {
    let st = emptyState(T0);
    st = addBagLine(st, { id: "l", skuId: "a", productId: "p", storeId: "s", qty: 1, seen }, T0).state;
    st = saveItem(st, { productId: "p", skuId: null, intent: "need", seenPricePiastres: "1" }, T0);
    st = recordView(st, "p", T0);
    const at = (d: number) => purgeExpired(st, T0 + d);
    expect(at(TTL_MS.bag).bag).toHaveLength(1);
    expect(at(TTL_MS.bag + 1).bag).toHaveLength(0);
    expect(at(TTL_MS.viewed + 1).viewed).toHaveLength(0);
    expect(at(TTL_MS.viewed + 1).saved).toHaveLength(1);
    expect(at(TTL_MS.saved).saved).toHaveLength(1);
    expect(at(TTL_MS.saved + 1).saved).toHaveLength(0);
  });
  it("purges on hydrate", async () => {
    const a = new InMemoryGuestStorage();
    const s1 = mk(a); await s1.hydrate(); add(s1, "a"); await s1.flush();
    const s2 = mk(a, () => T0 + TTL_MS.bag + 5); await s2.hydrate();
    expect(s2.getState().bag).toHaveLength(0);
  });
});

describe("persistence, install id, recovery", () => {
  it("round-trips across restarts", async () => {
    const a = new InMemoryGuestStorage();
    const s1 = mk(a); await s1.hydrate(); add(s1, "a", 2); await s1.flush();
    const s2 = mk(a); await s2.hydrate();
    expect(s2.getState().bag[0]?.qty).toBe(2);
    expect(await a.read()).not.toMatch(/install/i);
  });
  it.each([["not json{", "corrupt"], [JSON.stringify({ v: 2, bogus: 1 }), "corrupt"], ["x".repeat(MAX_STATE_BYTES + 1), "too_large"]])("recovers from bad data %#", async (raw, cause) => {
    const a = new InMemoryGuestStorage(raw);
    const s = mk(a); await s.hydrate();
    expect(s.getState().bag).toEqual([]);
    expect(s.consumeResetNotice()).toBe(cause);
    expect(s.consumeResetNotice()).toBeNull();
    expect(add(s, "a").ok).toBe(true);
    await s.flush();
    expect(JSON.parse((await a.read()) ?? "")).toMatchObject({ v: 4 });
  });
  it("a newer schema is a read-only empty view and the data is untouched", async () => {
    const raw = JSON.stringify({ v: 99, anything: true });
    const a = new InMemoryGuestStorage(raw);
    const s = mk(a); await s.hydrate();
    expect(add(s, "a")).toEqual({ ok: false, error: "read_only" });
    await s.flush();
    expect(await a.read()).toBe(raw);
  });
  it("never throws when storage fails", async () => {
    const bad: GuestStorageAdapter = { read: () => Promise.reject(new Error("x")), write: () => Promise.reject(new Error("x")), clear: () => Promise.reject(new Error("x")) };
    const s = mk(bad); await s.hydrate();
    expect(add(s, "a").ok).toBe(true);
    await s.flush();
    expect(s.isPersisting()).toBe(false);
    await s.clearAll();
    expect(s.getState().bag).toEqual([]);
  });
  it("clearAll empties the state", async () => {
    const s = mk(new InMemoryGuestStorage()); await s.hydrate(); add(s, "a");
    await s.clearAll();
    expect(s.getState().bag).toEqual([]);
  });
  it("removeMerged keeps lines added meanwhile", async () => {
    const s = mk(new InMemoryGuestStorage()); await s.hydrate(); add(s, "a"); add(s, "b");
    const first = s.getState().bag[0]?.id ?? "";
    add(s, "c");
    s.removeMerged([first]);
    expect(s.getState().bag.map((l) => l.skuId)).toEqual(["b", "c"]);
  });
});

describe("schema migration", () => {
  const v1 = { v: 1, createdAt: 1, updatedAt: 2, bag: [], saved: [{ productId: "p", skuId: null, intent: "need", addedAt: 1, seenPricePiastres: "5" }], viewed: [], affinity: { stores: { s: 2 }, categories: {} }, merge: { pendingKey: null, startedAt: null } };
  const v2 = { ...v1, v: 2, installId: "old-install-id", consentBanner: "allowed" };
  it("v1 fixture migrates to v3 keeping data", () => {
    expect(GuestStateV1Schema.safeParse(v1).success).toBe(true);
    const r = migrate(v1);
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") {
      expect(r.migrated).toBe(true);
      expect(r.state).toMatchObject({ v: 4, consentBanner: "unanswered" });
      expect(JSON.stringify(r.state)).not.toMatch(/install/i);
      expect(r.state.saved).toHaveLength(1);
      expect(GuestStateV4Schema.safeParse(r.state).success).toBe(true);
    }
  });
  it("v2 fixture with installId migrates to v3 and drops it", async () => {
    expect(GuestStateV2Schema.safeParse(v2).success).toBe(true);
    const r = migrate(v2);
    expect(r.kind === "ok" && r.state).toMatchObject({ v: 4, consentBanner: "allowed" });
    expect(JSON.stringify(r)).not.toMatch(/install/i);
    const a = new InMemoryGuestStorage(JSON.stringify(v2));
    const s = mk(a); await s.hydrate(); await s.flush();
    expect(await a.read()).not.toMatch(/install/i);
  });
  it("hydrate persists the migrated v2", async () => {
    const a = new InMemoryGuestStorage(JSON.stringify(v1));
    const s = mk(a); await s.hydrate(); await s.flush();
    expect(JSON.parse((await a.read()) ?? "").v).toBe(4);
  });
  it("schema has no PII-like field names", () => {
    const names: string[] = [];
    const walk = (o: unknown): void => { if (o !== null && typeof o === "object") for (const [k, v] of Object.entries(o)) { names.push(k); walk(v); } };
    walk(emptyState(1)); walk({ ...emptyState(1), bag: [{ id: "", skuId: "", productId: "", storeId: "", qty: 1, savedForLater: false, addedAt: 1, touchedAt: 1, seen }], saved: [{ productId: "", skuId: null, intent: "need", addedAt: 1, seenPricePiastres: "1" }] });
    expect(names.filter((k) => /phone|name$|email|address|dob|birth|measure|budget|iban|token|install/i.test(k) && k !== "storeName")).toEqual([]);
  });
});

describe("planMerge", () => {
  it("keeps the larger quantity, never the sum", () => {
    const r = planMerge([{ skuId: "x", qty: 2 }], [{ skuId: "x", qty: 3 }]);
    expect(r.lines).toEqual([{ skuId: "x", qty: 3, result: "unchanged" }]);
    expect(planMerge([{ skuId: "x", qty: 5 }], [{ skuId: "x", qty: 3 }]).lines[0]).toMatchObject({ qty: 5, result: "qty_raised" });
  });
  it("properties over seeded random inputs", () => {
    let seed = 12345;
    const rnd = (m: number): number => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % m; };
    const gen = (max: number) => Array.from({ length: rnd(max) }, () => ({ skuId: `k${rnd(80)}`, qty: 1 + rnd(14) }));
    for (let i = 0; i < 500; i++) {
      const local = gen(70), server = gen(60);
      const r = planMerge(local, server);
      expect(r.lines.length).toBeLessThanOrEqual(Math.max(MAX_BAG_LINES, new Set(server.map((x) => x.skuId)).size));
      for (const l of r.lines) {
        expect(l.qty).toBeLessThanOrEqual(MAX_UNITS_PER_ITEM);
        const maxOf = (xs: typeof local) => Math.min(10, Math.max(0, ...xs.filter((x) => x.skuId === l.skuId).map((x) => x.qty)));
        expect(l.qty).toBe(Math.max(maxOf(local), maxOf(server)));
      }
      const again = planMerge(local, r.lines.map((l) => ({ skuId: l.skuId, qty: l.qty })));
      expect(again.lines.map((l) => [l.skuId, l.qty])).toEqual(r.lines.map((l) => [l.skuId, l.qty]));
      expect(again.lines.every((l) => l.result === "unchanged")).toBe(true);
      // max is commutative: swapping sides gives the same quantities
      const swapped = planMerge(server, local);
      const q = (x: typeof r) => new Map(x.lines.map((l) => [l.skuId, l.qty]));
      for (const [k, v] of q(r)) if (!r.overCap.includes(k) && !swapped.overCap.includes(k)) expect(q(swapped).get(k)).toBe(v);
    }
  });
  it("server lines win the 50 cap; overflow goes to overCap", () => {
    const server = Array.from({ length: 50 }, (_, i) => ({ skuId: `s${i}`, qty: 1 }));
    const r = planMerge([{ skuId: "new", qty: 1 }, { skuId: "s1", qty: 4 }], server);
    expect(r.overCap).toEqual(["new"]);
    expect(r.lines).toHaveLength(50);
    expect(r.lines.find((l) => l.skuId === "s1")?.qty).toBe(4);
  });
});

describe("affinity", () => {
  it("is deterministic and stable on ties", () => {
    const a = { stores: { b: 3 }, categories: { c: 1 } };
    const items = [{ id: 1, s: "a", c: "c" }, { id: 2, s: "b", c: null }, { id: 3, s: "a", c: null }];
    expect(rerankByAffinity(items, a, (t) => ({ storeId: t.s, categoryId: t.c })).map((t) => t.id)).toEqual([2, 1, 3]);
  });
});

// ---- adapter contract: run against the in-memory adapter and the sqlite adapter over a fake DB ----
function fakeDb(): { db: SqliteDb; destroyed: string[] } {
  const rows = new Map<string, string>();
  const destroyed: string[] = [];
  const db: SqliteDb = {
    execAsync: async () => undefined,
    runAsync: async (_q, ...p) => { rows.set(String(p[0]), String(p[1])); },
    getFirstAsync: async <T,>(_q: string, ...p: (string | number)[]) => { const v = rows.get(String(p[0])); return (v === undefined ? null : ({ v } as unknown as T)); },
    withTransactionAsync: async (t) => { await t(); },
    closeAsync: async () => undefined,
  };
  return { db, destroyed };
}
const factories: [string, () => GuestStorageAdapter][] = [
  ["in-memory", () => new InMemoryGuestStorage()],
  ["sqlite (fake db; real expo-sqlite cannot run in vitest)", () => {
    const f = fakeDb();
    const store = { db: f.db };
    const adapter = new SqliteGuestStorage({
      open: async () => store.db,
      destroy: async () => { f.destroyed.push("x"); store.db = fakeDb().db; },
    });
    return adapter;
  }],
];
describe.each(factories)("GuestStorageAdapter contract: %s", (_n, make) => {
  it("reads null when empty, returns the last write, and clear empties", async () => {
    const a = make();
    expect(await a.read()).toBeNull();
    await a.write("one"); await a.write("two");
    expect(await a.read()).toBe("two");
    await a.clear();
    expect(await a.read()).toBeNull();
    await a.write("three");
    expect(await a.read()).toBe("three");
  });
});
