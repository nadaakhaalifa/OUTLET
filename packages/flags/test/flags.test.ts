import { describe, expect, it } from "vitest";
import { OpenFeature } from "@openfeature/server-sdk";
import { withTestDb } from "@outlet/db/testing";
import { KillSwitchRulesError, FlagService, InMemoryFlagStore, KILL_SWITCHES, OutletFlagProvider, PostgresFlagStore, bucketOf, isKillSwitchName, matchesRules } from "../src/index.js";
import type { FlagAuditEntry, FlagStore } from "../src/index.js";

const mk = (store: FlagStore = new InMemoryFlagStore(), clock = { t: 1_000_000 }) => {
  const audit: FlagAuditEntry[] = [];
  const errors: unknown[] = [];
  const svc = new FlagService({
    store,
    audit: { record: (e) => (audit.push(e), Promise.resolve()) },
    now: () => clock.t,
    onError: (e) => errors.push(e),
  });
  return { svc, audit, errors, clock, store };
};
const eg = { marketId: "eg" } as const;

describe("rollout", () => {
  it("is deterministic and key-salted", () => {
    expect(bucketOf("f", "u1")).toBe(bucketOf("f", "u1"));
    expect(bucketOf("f", "u1")).not.toBe(bucketOf("g", "u1"));
    expect(bucketOf("f", "u1")).toBeLessThan(10_000);
  });
  it("splits 10k ids 50% +/- 2%", () => {
    let on = 0;
    for (let i = 0; i < 10_000; i++) if (matchesRules("new-ui", { rolloutPercent: 50 }, { marketId: "eg", userId: "user-" + String(i) })) on += 1;
    expect(on / 10_000).toBeGreaterThan(0.48);
    expect(on / 10_000).toBeLessThan(0.52);
  });
  it("uses deviceId when no userId, excludes anonymous, honours 0/100 and store allow-list", () => {
    expect(matchesRules("k", { rolloutPercent: 50 }, { marketId: "eg" })).toBe(false);
    expect(matchesRules("k", { rolloutPercent: 50 }, { marketId: "eg", deviceId: "d1" })).toBe(
      bucketOf("k", "d1") < 5000,
    );
    expect(matchesRules("k", { rolloutPercent: 0 }, { marketId: "eg", userId: "u" })).toBe(false);
    expect(matchesRules("k", {}, eg)).toBe(true);
    expect(matchesRules("k", { storeIds: ["s1"] }, eg)).toBe(false);
    expect(matchesRules("k", { storeIds: ["s1"] }, { marketId: "eg", storeId: "s1" })).toBe(true);
    expect(matchesRules("k", { storeIds: ["s1"] }, { marketId: "eg", storeId: "s2" })).toBe(false);
  });
});

describe("FlagService", () => {
  it("returns the default for unknown flags and the per-market override over global", async () => {
    const { svc } = mk();
    expect(await svc.isEnabled("x", eg)).toBe(false);
    expect(await svc.isEnabled("x", eg, true)).toBe(true);
    await svc.setFlag({ key: "x", enabled: true, actor: "a" });
    expect(await svc.isEnabled("x", eg)).toBe(true);
    await svc.setFlag({ key: "x", marketId: "sa", enabled: false, actor: "a" });
    expect(await svc.isEnabled("x", { marketId: "sa" })).toBe(false);
    expect(await svc.isEnabled("x", eg)).toBe(true);
  });

  it("audits every change with before/after and bumps version", async () => {
    const { svc, audit } = mk();
    await svc.setFlag({ key: "x", enabled: true, rules: { rolloutPercent: 10 }, actor: "alice" });
    await svc.engageKillSwitch("payments.cod.enabled", "bob");
    await svc.releaseKillSwitch("payments.cod.enabled", "bob", null);
    expect(audit.map((a) => a.action)).toEqual(["flag.set", "kill_switch.engaged", "kill_switch.released"]);
    expect(audit[0]).toMatchObject({ actor: "alice", before: null, after: { version: 1 } });
    expect(audit[2]).toMatchObject({ before: { enabled: false, version: 1 }, after: { enabled: true, version: 2 } });
  });

  it("keeps the change applied when audit throws", async () => {
    const store = new InMemoryFlagStore();
    const svc = new FlagService({ store, audit: { record: () => Promise.reject(new Error("audit down")) } });
    await expect(svc.engageKillSwitch("drops.enabled", "a")).rejects.toThrow("audit down");
    expect(await svc.isKilled("drops.enabled", eg)).toBe(true);
  });

  it("caches within ttl, serves stale while revalidating, then refreshes", async () => {
    const { svc, clock, store } = mk();
    const mem = store as InMemoryFlagStore;
    await svc.setFlag({ key: "x", enabled: true, actor: "a" });
    expect(await svc.isEnabled("x", eg)).toBe(true);
    const base = mem.calls;
    await mem.put({ key: "x", marketId: null, enabled: false, updatedBy: "o", updatedAt: new Date() }); // out-of-band change
    clock.t += 4_000;
    expect(await svc.isEnabled("x", eg)).toBe(true); // fresh cache
    expect(mem.calls).toBe(base);
    clock.t += 2_000; // 6 s: stale
    expect(await svc.isEnabled("x", eg)).toBe(true); // stale served
    await new Promise((r) => setTimeout(r, 5));
    expect(mem.calls).toBe(base + 1); // background refresh ran
    expect(await svc.isEnabled("x", eg)).toBe(false); // refreshed
  });

  it("rejects rules on a kill switch (service and store), but allows them on ordinary flags", async () => {
    const { svc, store } = mk();
    await expect(svc.setFlag({ key: "payments.cod.enabled", enabled: true, rules: { rolloutPercent: 10 }, actor: "a" })).rejects.toBeInstanceOf(KillSwitchRulesError);
    await expect(store.put({ key: "drops.enabled", marketId: null, enabled: true, rules: { storeIds: ["s"] }, updatedBy: "a", updatedAt: new Date() })).rejects.toBeInstanceOf(KillSwitchRulesError);
    await expect(svc.setFlag({ key: "payments.cod.enabled", enabled: false, actor: "a" })).resolves.toBeDefined();
    await expect(svc.setFlag({ key: "ordinary", enabled: true, rules: { rolloutPercent: 10 }, actor: "a" })).resolves.toBeDefined();
  });

  it("store down and cache older than 60 s: money switch killed, UI switch allowed", async () => {
    const { svc, clock, store } = mk();
    await svc.isKilled("payments.cod.enabled", eg);
    await svc.isKilled("drops.enabled", eg); // both cached as "allowed"
    (store as InMemoryFlagStore).failWith = new Error("db down");
    clock.t += 61_000;
    expect(await svc.isKilled("payments.cod.enabled", eg)).toBe(true);
    expect(await svc.isKilled("drops.enabled", eg)).toBe(false);
  });

  it("dedups concurrent refreshes and swallows background errors", async () => {
    const { svc, clock, store, errors } = mk();
    const mem = store as InMemoryFlagStore;
    await svc.isEnabled("x", eg);
    clock.t += 6_000;
    mem.failWith = new Error("db");
    expect(await svc.isEnabled("x", eg, true)).toBe(true); // stale default path
    await new Promise((r) => setTimeout(r, 5));
    expect(errors.length).toBe(1);
  });

  it("isKilled is false by default and true after engage, per market", async () => {
    const { svc } = mk();
    expect(await svc.isKilled("payments.card.enabled", eg)).toBe(false);
    await svc.engageKillSwitch("payments.card.enabled", "a", "eg");
    expect(await svc.isKilled("payments.card.enabled", eg)).toBe(true);
    expect(await svc.isKilled("payments.card.enabled", { marketId: "sa" })).toBe(false);
  });

  it("fails CLOSED for money switches and OPEN for ui switches when the store errors", async () => {
    const { svc, store, errors } = mk();
    (store as InMemoryFlagStore).failWith = new Error("store unreachable");
    for (const [name, def] of Object.entries(KILL_SWITCHES)) {
      if (!isKillSwitchName(name)) throw new Error("registry");
      expect(await svc.isKilled(name, eg), name).toBe(def.failMode === "closed");
    }
    expect(await svc.isKilled("payments.cod.enabled", eg)).toBe(true);
    expect(await svc.isKilled("drops.enabled", eg)).toBe(false);
    expect(errors.length).toBeGreaterThan(0);
    expect(await svc.isEnabled("plain", eg)).toBe(false);
  });

  it("registry: money classes fail closed, ui classes fail open, covers the spec list", () => {
    for (const d of Object.values(KILL_SWITCHES)) expect(d.failMode).toBe(d.class === "money" ? "closed" : "open");
    expect(isKillSwitchName("nope")).toBe(false);
    for (const n of ["payments.cod", "payments.bnpl", "drops", "games", "stylist.llm", "ranking.ml", "crawlers", "referrals.payouts", "gift_cards.sales"]) {
      expect(Object.keys(KILL_SWITCHES)).toContain(`${n}.enabled`);
    }
  });
});

describe("OpenFeature provider", () => {
  it("resolves booleans via the OpenFeature client and rejects bad context / other types", async () => {
    const { svc } = mk();
    await svc.setFlag({ key: "x", enabled: true, rules: { rolloutPercent: 100, storeIds: ["s1"] }, actor: "a" });
    await OpenFeature.setProviderAndWait(new OutletFlagProvider(svc));
    const c = OpenFeature.getClient();
    expect(await c.getBooleanValue("x", false, { targetingKey: "u1", marketId: "eg", storeId: "s1", deviceId: "d" })).toBe(true);
    expect(await c.getBooleanValue("x", false, { marketId: "eg", storeId: "zz" })).toBe(false);
    expect(await c.getBooleanValue("x", true, {})).toBe(true); // no marketId -> default
    expect(await c.getStringValue("x", "d", { marketId: "eg" })).toBe("d");
    expect(await c.getNumberValue("x", 7, { marketId: "eg" })).toBe(7);
    expect(await c.getObjectValue("x", { a: 1 }, { marketId: "eg" })).toEqual({ a: 1 });
    await OpenFeature.clearProviders();
  });
});

describe("PostgresFlagStore (PGlite)", () => {
  it("round-trips, upserts with version bump, separates market rows, validates rules", async () => {
    await withTestDb(async (db) => {
      const store = new PostgresFlagStore(db);
      const { svc, audit } = mk(store);
      const a = await svc.setFlag({ key: "k", enabled: true, rules: { rolloutPercent: 25, storeIds: ["s1"] }, actor: "alice" });
      expect(a).toMatchObject({ key: "k", marketId: null, version: 1, updatedBy: "alice", rules: { rolloutPercent: 25 } });
      const b = await svc.setFlag({ key: "k", enabled: false, actor: "bob" });
      expect(b).toMatchObject({ version: 2, enabled: false, rules: {} });
      await svc.setFlag({ key: "k", marketId: "eg", enabled: true, actor: "bob" });
      expect((await store.get("k", "eg")).length).toBe(2);
      expect((await store.get("k", "sa")).length).toBe(1);
      expect((await store.list()).map((r) => r.marketId)).toEqual([null, "eg"]);
      expect(await svc.isEnabled("k", eg)).toBe(true);
      expect(await svc.isEnabled("k", { marketId: "sa" })).toBe(false);
      expect(audit[1]).toMatchObject({ before: { version: 1 }, after: { version: 2 } });
      await svc.engageKillSwitch("payments.cod.enabled", "ops");
      expect(await svc.isKilled("payments.cod.enabled", eg)).toBe(true);
      await expect(store.put({ key: "k", marketId: null, enabled: true, rules: { rolloutPercent: 500 }, updatedBy: "x", updatedAt: new Date() })).rejects.toThrow();
    });
  });
});
