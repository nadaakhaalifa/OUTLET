import { describe, expect, it } from "vitest";
import {
  ALL_KILL_SWITCHES,
  COURIERS,
  DROP_TYPES,
  FLAG_REGISTRY,
  FlagClient,
  InMemoryFlagProvider,
  KILL_SWITCHES,
  PHASE2_KILL_SWITCHES,
  PLUS_RECURRING_METHODS,
  courierKillSwitch,
  describeFlagState,
  dropTypeKillSwitch,
  isKnownFlag,
  plusRecurringKillSwitch,
  type FlagKey,
  type FlagProvider,
} from "./index";

/** Every switch string read by apps/api/src/modules (grepped in the Phase 2 integration wave). */
const USED_BY_MODULES = [
  "kill.plus.sales",
  "kill.plus.recurring.card",
  "kill.plus.recurring.mobile_wallet",
  "kill.plus.recurring.apple_pay",
  "kill.gift_card_sales",
  "kill.gift_card_redemption",
  "kill.rewards_coins",
  "kill.games",
  "kill.budget_caps",
  "release.budget_suite",
  "kill.stylist_llm",
  "kill.stylist_ml",
  "kill.llm_search_parse",
  "kill.ml_ranking",
  "kill.crawlers",
  "kill.sponsored_products",
  "kill.hub_consolidation",
  "kill.resale_lane",
  "kill.drops",
  "kill.waiting_room",
  "kill.mystery_box",
  "kill.search_engine",
  "kill.courier.bosta",
  "kill.courier.aramex",
] as const;

describe("phase 2 kill switches", () => {
  it("registers every switch the modules read", () => {
    for (const k of USED_BY_MODULES) expect(isKnownFlag(k), k).toBe(true);
  });

  it("keeps the A2.12 core set separate and never overlaps it", () => {
    expect(Object.keys(KILL_SWITCHES)).toHaveLength(14);
    for (const k of Object.keys(PHASE2_KILL_SWITCHES)) expect(k in KILL_SWITCHES, k).toBe(false);
    expect(Object.keys(ALL_KILL_SWITCHES)).toHaveLength(14 + Object.keys(PHASE2_KILL_SWITCHES).length);
  });

  it("every Phase 2 flag is default-off, fail-closed, documented and states its blocked behaviour", () => {
    for (const key of Object.keys(PHASE2_KILL_SWITCHES)) {
      const def = FLAG_REGISTRY.find((d) => d.key === key);
      expect(def, key).toBeDefined();
      expect(def?.kind).toBe("kill_switch");
      expect(def?.defaultValue).toBe(false);
      expect(def?.failClosed).toBe(true);
      expect(def?.description.length ?? 0).toBeGreaterThan(20);
      expect(def?.description, key).toMatch(/Blocked:/);
    }
  });

  it("key builders match the registry for every courier, plus method and drop type", () => {
    for (const c of COURIERS) expect(isKnownFlag(courierKillSwitch(c))).toBe(true);
    for (const m of PLUS_RECURRING_METHODS) expect(isKnownFlag(plusRecurringKillSwitch(m))).toBe(true);
    for (const t of DROP_TYPES) expect(isKnownFlag(dropTypeKillSwitch(t))).toBe(true);
    expect(courierKillSwitch("bosta")).toBe("kill.courier.bosta");
    expect(plusRecurringKillSwitch("mobile_wallet")).toBe("kill.plus.recurring.mobile_wallet");
    expect(dropTypeKillSwitch("flash_hour")).toBe("kill.drop_type.flash_hour");
  });

  it("every registered key fails closed to blocked with no value, an error, or a throw", async () => {
    const keys = FLAG_REGISTRY.map((d) => d.key);
    const empty = new FlagClient({ provider: new InMemoryFlagProvider() });
    const throwing: FlagProvider = {
      metadata: { name: "throws" },
      resolveBooleanEvaluation: () => {
        throw new Error("boom");
      },
    } as unknown as FlagProvider;
    const bad = new FlagClient({ provider: throwing });
    for (const k of keys) {
      expect(await empty.describeState(k)).toBe("blocked");
      expect(await bad.describeState(k)).toBe("blocked");
    }
  });
});

describe("describeState: allowed when true", () => {
  it("maps true to allowed and everything else to blocked", async () => {
    const p = new InMemoryFlagProvider({ "kill.plus.sales": true, "kill.resale_lane": false, "kill.games": "yes" });
    const c = new FlagClient({ provider: p });
    expect(await c.describeState("kill.plus.sales")).toBe("allowed");
    expect(await c.describeState("kill.resale_lane")).toBe("blocked");
    expect(await c.describeState("kill.games")).toBe("blocked");
    expect(await c.describeState("kill.hub_consolidation")).toBe("blocked");
    p.set("kill.hub_consolidation", true);
    expect(await c.describeState("kill.hub_consolidation" satisfies FlagKey)).toBe("allowed");
  });

  it("describeFlagState is a pure boolean mapping", () => {
    expect(describeFlagState(true)).toBe("allowed");
    expect(describeFlagState(false)).toBe("blocked");
  });
});
