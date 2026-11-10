import { createTranslator } from "@outlet/i18n";
import { DESCRIBERS } from "../src/components/home/tileModel";
import { fmtNumber } from "../src/lib/fmt";
import { describe, expect, it } from "vitest";
import { buildNeeds, queueOrder } from "../src/lib/attention";
import { bucketSeries, cardBySlug, CARDS, DashboardResponse, flattenTiles, parseRange, permille, tileState } from "../src/lib/dashboard";
import { uuidv7 } from "../src/lib/uuid7";
import { attentionItems, DASH_NOW, dashboardFixture, forbidden, unavailable } from "./fake-data";

describe("DashboardResponse contract", () => {
  it("accepts the fixture for every range, with ok, forbidden and unavailable tiles", () => {
    for (const r of ["7d", "30d", "90d"] as const) expect(DashboardResponse.safeParse(dashboardFixture({ gmv_today: forbidden("gmv_today"), payouts: unavailable("payouts", "read_failed") }, r)).success).toBe(true);
  });
  it("rejects a tile whose key does not match and unknown fields (strict)", () => {
    const bad = dashboardFixture({ orders_today: { key: "gmv_today", status: "forbidden" } });
    expect(DashboardResponse.safeParse(bad).success).toBe(false);
    expect(DashboardResponse.safeParse({ ...dashboardFixture(), extra: 1 }).success).toBe(false);
  });
  it("parseRange falls back to 30d", () => {
    expect(parseRange("7d")).toBe("7d");
    expect(parseRange("1y")).toBe("30d");
    expect(parseRange(undefined)).toBe("30d");
  });
});

describe("tileState", () => {
  const tiles = flattenTiles(dashboardFixture({ gmv_today: forbidden("gmv_today"), payouts: unavailable("payouts", "not_connected") }));
  it("forbidden is hidden, unavailable keeps its reason, ok carries data", () => {
    expect(tileState("gmv_today", tiles.gmv_today, DASH_NOW).kind).toBe("hidden");
    expect(tileState("payouts", tiles.payouts, DASH_NOW)).toEqual({ kind: "unavailable", reason: "not_connected" });
    const ok = tileState("kyc_queue", tiles.kyc_queue, DASH_NOW);
    expect(ok.kind === "ok" && ok.data.submitted).toBe(3);
  });
  it("marks a snapshot stale after 2 minutes and a sales figure after 10", () => {
    const later = new Date(DASH_NOW.getTime() + 3 * 60_000);
    const kyc = tileState("kyc_queue", tiles.kyc_queue, later);
    expect(kyc.kind === "ok" && kyc.staleSince).not.toBeNull();
    const orders = tileState("orders_today", tiles.orders_today, later);
    expect(orders.kind === "ok" && orders.staleSince).toBeNull();
    const much = new Date(DASH_NOW.getTime() + 11 * 60_000);
    const o2 = tileState("orders_today", tiles.orders_today, much);
    expect(o2.kind === "ok" && o2.staleSince).not.toBeNull();
  });
});

describe("cards", () => {
  it("maps slugs to tiles and rejects unknown ones", () => {
    expect(cardBySlug("kyc-queue")?.tile).toBe("kyc_queue");
    expect(cardBySlug("nope")).toBeUndefined();
    expect(new Set(CARDS.map((c) => c.slug)).size).toBe(CARDS.length);
  });
});

describe("buildNeeds", () => {
  it("keeps only counts above zero, urgent first, in the plan order, info row last", () => {
    const resp = dashboardFixture({
      dsar_queue: { key: "dsar_queue", status: "ok", as_of: "2026-11-10T08:59:30Z", data: { open: 3, due_7d: 1, overdue: 2 } },
      kill_switches: { key: "kill_switches", status: "ok", as_of: "2026-11-10T08:59:30Z", data: { engaged_money: ["card"], engaged_ui: [] } },
    });
    const needs = buildNeeds(resp, DASH_NOW);
    expect(needs.incomplete).toBe(false); // not-connected money tiles are not inputs to this list
    expect(needs.rows.map((r) => r.id)).toEqual(["dsar", "disputes", "attention", "approvals", "kyc", "sla", "cod", "killSwitches"]);
    expect(needs.rows.filter((r) => r.urgent).map((r) => r.id)).toEqual(["dsar", "disputes"]);
    expect(needs.rows.find((r) => r.id === "sla")?.count).toBe(3);
    expect(needs.rows.every((r) => r.count > 0)).toBe(true);
  });
  it("a breach due in under 24 hours is urgent; later is not", () => {
    const mk = (due: string) => dashboardFixture({ breaches_open: { key: "breaches_open", status: "ok", as_of: "2026-11-10T08:59:30Z", data: { open: 1, next_pdpc_deadline_at: due, next_subjects_deadline_at: null } } });
    expect(buildNeeds(mk("2026-11-10T20:00:00Z"), DASH_NOW).rows.find((r) => r.id === "breach")?.urgent).toBe(true);
    expect(buildNeeds(mk("2026-11-12T20:00:00Z"), DASH_NOW).rows.find((r) => r.id === "breach")?.urgent).toBe(false);
  });
  it("forbidden tiles are skipped without removing the all-clear; unavailable or stale ones remove it", () => {
    const zero = { late_accept: 0, late_dispatch: 0, oldest_at: null };
    const quiet: Record<string, unknown> = Object.fromEntries(
      Object.keys(flattenTiles(dashboardFixture())).map((k) => [k, forbidden(k)]),
    );
    quiet.seller_sla_breaches = { key: "seller_sla_breaches", status: "ok", as_of: "2026-11-10T08:59:30Z", data: zero };
    const clear = buildNeeds(dashboardFixture(quiet), DASH_NOW);
    expect(clear).toEqual({ rows: [], incomplete: false });
    const failed = buildNeeds(dashboardFixture({ ...quiet, kyc_queue: unavailable("kyc_queue", "read_failed") }), DASH_NOW);
    expect(failed).toEqual({ rows: [], incomplete: true });
    const stale = buildNeeds(dashboardFixture(quiet), new Date(DASH_NOW.getTime() + 5 * 60_000));
    expect(stale.incomplete).toBe(true);
  });
});

describe("series and ratios", () => {
  const pts = (n: number) => Array.from({ length: n }, (_, i) => ({ day: `2026-10-${String(i + 1).padStart(2, "0")}`, value: BigInt(i + 1) }));
  it("daily up to 14 days, weekly above, anchored at the newest day", () => {
    expect(bucketSeries(pts(14))).toHaveLength(14);
    const w = bucketSeries(pts(30));
    expect(w.map((b) => b.value)).toEqual([sum(1, 2), sum(3, 9), sum(10, 16), sum(17, 23), sum(24, 30)]);
    expect(w[w.length - 1]?.to).toBe("2026-10-30");
  });
  it("permille is integer maths and null without a denominator", () => {
    expect(permille(30, 120)).toBe(250);
    expect(permille(1, 3)).toBe(333);
    expect(permille(0, 0)).toBeNull();
  });
});
const sum = (a: number, b: number): bigint => { let s = 0n; for (let i = a; i <= b; i++) s += BigInt(i); return s; };

describe("uuidv7 and queue order", () => {
  it("is a v7 UUID with a time-ordered prefix", () => {
    const a = uuidv7(1_700_000_000_000);
    const b = uuidv7(1_700_000_001_000);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a < b).toBe(true);
  });
  it("shows OPEN before ACKED, newest first, never resolved", () => {
    const ids = queueOrder([...attentionItems.map((i) => ({ ...i, status: i.status as "OPEN" | "ACKED" })), { id: "a7700000-0000-4000-8000-000000000003", kind: "x", status: "RESOLVED" as const, created_at: "2026-11-10T00:00:00Z" }]).map((i) => i.status);
    expect(ids).toEqual(["OPEN", "ACKED"]);
  });
});

describe("late_dispatch null (dispatch deadlines not tracked yet)", () => {
  const ctx = (locale: "ar-EG" | "en-EG") => ({ t: createTranslator(locale), locale });
  it.each(["ar-EG", "en-EG"] as const)("never prints a zero for null and says it is not tracked (%s)", (locale) => {
    const c = ctx(locale);
    const b = DESCRIBERS.seller_sla_breaches?.({ late_accept: 2, late_dispatch: null, oldest_at: null }, c);
    expect(b?.value).toBe(fmtNumber(2, locale));
    expect(b?.notes[0]).toBe(c.t("admin.home.note.slaNoDispatch", { accept: fmtNumber(2, locale) }));
    expect(b?.notes[0]).not.toContain(fmtNumber(0, locale));
    expect(b?.alert).toBe(true);
  });
  it("a short orders_today series passes the contract schema; 15 points do not", () => {
    const f = dashboardFixture();
    const mk = (n: number) => ({ ...f, sections: { ...f.sections, today: { ...f.sections.today, orders_today: { key: "orders_today", status: "ok", as_of: f.generated_at, data: { count: 1, series_14d: Array.from({ length: n }, (_, i) => ({ day: `2026-11-${String(i + 1).padStart(2, "0")}`, value: i })) } } } } });
    expect(DashboardResponse.safeParse(mk(3)).success).toBe(true);
    expect(DashboardResponse.safeParse(mk(15)).success).toBe(false);
  });
});
