import { describe, expect, it } from "vitest";
import { ATTENTION_ORDER, attentionFor, cappedByLimit, FAILED_TILE, isBreaching, NOT_YET_TILE, ROLE_HOME_ORDER, summaryKey, tileSectionsFor, tileSpec, tilesFor, tileState, tileValue, type TileId, type TileValue } from "./dashboard";
import { activeNavId, NAV_GROUPS, navFor, navSectionsFor } from "./nav";
import { en } from "../i18n/en";
import { ar } from "../i18n/ar";
import type { Role } from "./common";

const ROLES: readonly Role[] = ["ops", "finance", "trust_safety", "support", "marketing", "dpo", "security", "super_admin"];

describe("dashboard tile visibility", () => {
  it("shows nothing and queries nothing for unknown roles (fail closed)", () => {
    expect(tilesFor(null)).toEqual([]);
    expect(tilesFor([])).toEqual([]);
    expect(tileSectionsFor(null)).toEqual([]);
  });
  it("only gives a role tiles whose area it can open", () => {
    expect(tilesFor(["dpo"]).map((t) => t.id)).toEqual(["approvals", "refundApprovals", "dsarOpen", "dsarOverdue"]);
    expect(tilesFor(["finance"]).map((t) => t.id)).toEqual(["approvals", "refundApprovals", "recon", "payoutsStuck", "taxRejected"]);
    expect(tilesFor(["marketing"]).map((t) => t.id)).toEqual(["approvals", "refundApprovals"]);
    expect(tilesFor(["support"]).map((t) => t.id)).toEqual(["approvals", "refundApprovals", "kyc"]);
    expect(tilesFor(["ops"]).map((t) => t.id)).toContain("brandLate");
  });
  it("groups tiles into non-empty sections", () => {
    expect(tileSectionsFor(["dpo"]).map((s) => s.id)).toEqual(["privacy", "approvals"]);
    for (const s of tileSectionsFor(ROLES)) expect(s.tiles.length).toBeGreaterThan(0);
  });
  it("formats counts honestly", () => {
    expect(tileValue(7, false)).toEqual({ text: "7", failed: false, capped: false, count: 7, notYet: false });
    expect(tileValue(50, true).text).toBe("50+");
    expect(cappedByLimit(99, 100).text).toBe("99");
    expect(cappedByLimit(100, 100)).toEqual({ text: "100+", failed: false, capped: true, count: 100, notYet: false });
    expect(FAILED_TILE).toEqual({ text: "—", failed: true, capped: false, count: null, notYet: false });
  });
  it("has copy in both locales for every tile", () => {
    for (const t of tilesFor(ROLES)) for (const k of [t.labelKey, t.noteKey]) {
      expect(en[k], k).toBeTruthy();
      expect(ar[k], k).toBeTruthy();
    }
  });
});

const v = (ids: Partial<Record<TileId, TileValue>>): Map<TileId, TileValue> => new Map(Object.entries(ids) as [TileId, TileValue][]);

describe("tile states and severity", () => {
  it("distinguishes zero, failed, not-yet, capped and counted", () => {
    expect(tileState(tileValue(0, false))).toBe("zero");
    expect(tileState(FAILED_TILE)).toBe("failed");
    expect(tileState(NOT_YET_TILE)).toBe("notYet");
    expect(tileState(tileValue(50, true))).toBe("capped");
    expect(tileState(tileValue(3, false))).toBe("count");
  });
  it("only breach tiles with a real count above zero are breaching", () => {
    const late = tileSpec("brandLate");
    const mine = tileSpec("brandMine");
    if (late === undefined || mine === undefined) throw new Error("missing tile");
    expect(isBreaching(late, tileValue(2, false))).toBe(true);
    expect(isBreaching(late, tileValue(0, false))).toBe(false);
    expect(isBreaching(late, FAILED_TILE)).toBe(false);
    expect(isBreaching(mine, tileValue(9, false))).toBe(false);
  });
  it("gives every breach tile a visible label key in both locales", () => {
    for (const t of tilesFor(ROLES).filter((x) => x.severity === "breach")) {
      expect(t.breachLabelKey, t.id).toBeDefined();
      if (t.breachLabelKey !== undefined) { expect(en[t.breachLabelKey]).toBeTruthy(); expect(ar[t.breachLabelKey]).toBeTruthy(); }
    }
  });
});

describe("attentionFor", () => {
  it("lists only real counts on breach/action tiles, in the defined order", () => {
    const a = attentionFor(v({
      approvals: tileValue(2, false), dsarOverdue: tileValue(1, false), recon: tileValue(4, false),
      brandMine: tileValue(9, false), dsarOpen: tileValue(5, false), brandLate: tileValue(0, false), suspensions: tileValue(3, false),
    }));
    expect(a.state).toBe("items");
    expect(a.rows.map((r) => r.id)).toEqual(["dsarOverdue", "recon", "suspensions", "approvals"]);
    expect(a.total).toBe(4);
    expect(a.capped).toBe(false);
  });
  it("orders the first five exactly as specified", () => {
    expect(ATTENTION_ORDER.slice(0, 5)).toEqual(["dsarOverdue", "recon", "brandLate", "suspensions", "approvals"]);
  });
  it("is all clear only when every readable tile is zero", () => {
    expect(attentionFor(v({ approvals: tileValue(0, false), recon: tileValue(0, false) })).state).toBe("clear");
  });
  it("never claims all clear when a read failed", () => {
    const a = attentionFor(v({ approvals: tileValue(0, false), recon: FAILED_TILE }));
    expect(a.state).toBe("partial");
    expect(a.failedCount).toBe(1);
  });
  it("keeps showing real rows even if another read failed, and ignores failed and dark tiles", () => {
    const a = attentionFor(v({ approvals: tileValue(1, false), recon: FAILED_TILE, payoutsStuck: NOT_YET_TILE }));
    expect(a.rows.map((r) => r.id)).toEqual(["approvals"]);
    expect(a.failedCount).toBe(1);
  });
  it("never counts or lists the kill-switch tile (informational)", () => {
    const a = attentionFor(v({ killSwitches: tileValue(40, false), approvals: tileValue(3, false) }));
    expect(a.rows.map((r) => r.id)).toEqual(["approvals"]);
    expect(a.total).toBe(1);
    expect(ATTENTION_ORDER).not.toContain("killSwitches");
    expect(tileSpec("killSwitches")?.severity).toBe("info");
    expect(attentionFor(v({ killSwitches: tileValue(40, false) })).state).toBe("clear");
  });
  it("marks a capped total", () => {
    const a = attentionFor(v({ approvals: tileValue(100, true) }));
    expect(a.capped).toBe(true);
    expect(a.rows[0]?.text).toBe("100+");
  });
  it("has no state when nothing was readable at all", () => {
    expect(attentionFor(v({ payoutsStuck: NOT_YET_TILE })).state).toBe("none");
    expect(attentionFor(new Map()).state).toBe("none");
  });
});

describe("role home order", () => {
  const first = (roles: readonly Role[]) => tileSectionsFor(roles)[0]?.id;
  it("puts each role's own area first", () => {
    expect(first(["finance"])).toBe("money");
    expect(first(["dpo"])).toBe("privacy");
    expect(first(["trust_safety"])).toBe("queues");
    expect(first(["ops"])).toBe("queues");
  });
  it("merges several roles without losing or duplicating sections", () => {
    const secs = tileSectionsFor(["finance", "dpo"]).map((s) => s.id);
    expect(new Set(secs).size).toBe(secs.length);
    expect(secs).toEqual(expect.arrayContaining(["money", "privacy", "approvals"]));
    expect(secs.indexOf("money")).toBeLessThan(secs.indexOf("approvals"));
  });
  it("covers every role with every section", () => {
    for (const r of ROLES) expect([...ROLE_HOME_ORDER[r]].sort()).toEqual(["approvals", "money", "platform", "privacy", "queues"]);
  });
  it("picks plural buckets and has copy for each", () => {
    expect([1, 2, 5, 11].map(summaryKey)).toEqual(["one", "two", "few", "many"]);
    for (const k of ["one", "two", "few", "many"] as const) { expect(en[`home.summary.${k}`]).toBeTruthy(); expect(ar[`home.summary.${k}`]).toBeTruthy(); }
  });
});

describe("nav grouping and active item", () => {
  it("assigns every item to a known group and keeps flat order stable", () => {
    const known = new Set(NAV_GROUPS.map((g) => g.id));
    for (const i of navFor(ROLES)) expect(known.has(i.group), i.id).toBe(true);
  });
  it("sections follow group order, drop empty groups and lose nothing", () => {
    const secs = navSectionsFor(["dpo"]);
    expect(secs.map((s) => s.id)).toEqual(["overview", "privacy"]);
    expect(secs.flatMap((s) => s.items.map((i) => i.id)).sort()).toEqual(navFor(["dpo"]).map((i) => i.id).sort());
    expect(navSectionsFor(null)).toEqual([]);
    expect(navSectionsFor(["bogus"] as unknown as Role[])).toEqual([]);
    expect(navSectionsFor(ROLES).flatMap((s) => s.items)).toHaveLength(navFor(ROLES).length);
  });
  it("longest matching href wins and / matches only itself", () => {
    const items = [{ id: "home", href: "/" }, { id: "b", href: "/brand-applications" }, { id: "m", href: "/brand-applications/mine" }];
    expect(activeNavId(items, "/")).toBe("home");
    expect(activeNavId(items, "/brand-applications")).toBe("b");
    expect(activeNavId(items, "/brand-applications/mine")).toBe("m");
    expect(activeNavId(items, "/brand-applications/abc")).toBe("b");
    expect(activeNavId(items, "/brand-applicationsX")).toBeNull();
    expect(activeNavId(items, "")).toBeNull();
  });
  it("has labels for each group in both locales", () => {
    for (const g of NAV_GROUPS) { expect(en[g.labelKey]).toBeTruthy(); expect(ar[g.labelKey]).toBeTruthy(); }
  });
});
