import { describe, expect, it } from "vitest";
import { createClient, type FetchLike } from "../../services/api-client";
import type { AdapterContext } from "../../services/wire";
import { ApiCalendarPort } from "./api";
import {
  InMemoryCalendarPort, MAX_FUTURE_EVENTS, addDays, canAddEvent, daysBetween, deliveryNotice, parseLocalDate, parseLocalTime, quickDates, splitEvents, todayCairo,
  validateDraft, worstDelivery, type CalendarEvent, type DraftInput,
} from "./model";

const EID = "0192f3a4-5b6c-7d8e-9f01-23456789abc1";
const OID = "0192f3a4-5b6c-7d8e-9f01-23456789abc2";
const IID = "0192f3a4-5b6c-7d8e-9f01-23456789abc3";
const STORE = "0192f3a4-5b6c-7d8e-9f01-23456789abc4";
const TS = "2026-10-11T10:00:00Z";
const TODAY = "2026-10-12";

const ev = (over: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id: "e", kind: "work", localDate: "2026-10-20", localTime: "10:00", note: null, modest: false, season: "all", budget: null, ownedSlots: [], remindersEnabled: true,
  archived: false, outfitStatus: "none", outfits: [], version: 1, ...over,
});

describe("dates", () => {
  it("computes Cairo-local today and day arithmetic across month and DST-free boundaries", () => {
    expect(todayCairo(Date.parse("2026-10-11T22:30:00Z"))).toBe("2026-10-12");
    expect(todayCairo(Date.parse("2026-10-11T12:00:00Z"))).toBe("2026-10-11");
    expect(addDays("2026-10-30", 3)).toBe("2026-11-02");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(daysBetween("2026-10-12", "2026-10-20")).toBe(8);
    expect(daysBetween("2026-10-12", "2026-10-11")).toBe(-1);
  });
  it("parses ISO, day-first and Eastern-digit dates and rejects past or impossible ones", () => {
    expect(parseLocalDate("2026-11-05", TODAY)).toEqual({ ok: true, value: "2026-11-05" });
    expect(parseLocalDate("5/11/2026", TODAY)).toEqual({ ok: true, value: "2026-11-05" });
    expect(parseLocalDate("٢٠٢٦-١١-٠٥", TODAY)).toEqual({ ok: true, value: "2026-11-05" });
    expect(parseLocalDate("2026-10-12", TODAY)).toEqual({ ok: true, value: "2026-10-12" });
    expect(parseLocalDate("2026-10-11", TODAY)).toEqual({ ok: false, reason: "past" });
    expect(parseLocalDate("2026-02-30", TODAY)).toEqual({ ok: false, reason: "invalid" });
    expect(parseLocalDate("tomorrow", TODAY)).toEqual({ ok: false, reason: "invalid" });
  });
  it("parses optional 24 hour times", () => {
    expect(parseLocalTime("")).toEqual({ ok: true, value: null });
    expect(parseLocalTime("7:05")).toEqual({ ok: true, value: "07:05" });
    expect(parseLocalTime("٠٧:٣٠")).toEqual({ ok: true, value: "07:30" });
    expect(parseLocalTime("24:00")).toEqual({ ok: false });
    expect(parseLocalTime("7pm")).toEqual({ ok: false });
  });
  it("offers quick dates relative to today", () => {
    expect(quickDates(TODAY).map((q) => q.date)).toEqual(["2026-10-15", "2026-10-19", "2026-10-26", "2026-11-11"]);
  });
});

describe("draft validation", () => {
  const input: DraftInput = { kind: "wedding_guest", date: "2026-11-05", time: "", note: " bring a wrap ", modest: true, season: "autumn", budgetEgp: "٣٠٠٠", remindersEnabled: true };
  it("builds a draft in piastres with a trimmed note", () => {
    const r = validateDraft(input, TODAY);
    expect(r.ok && r.draft).toMatchObject({ localDate: "2026-11-05", localTime: null, note: "bring a wrap", budget: 300_000n, modest: true });
  });
  it("reports every invalid field together", () => {
    const r = validateDraft({ ...input, date: "2026-01-01", time: "99:99", budgetEgp: "0", note: "x".repeat(201) }, TODAY);
    expect(r).toEqual({ ok: false, errors: { date: "past", time: "invalid", budget: "invalid", note: "long" } });
  });
});

describe("list logic", () => {
  it("splits upcoming (soonest first) from past and archived (latest first)", () => {
    const events = [ev({ id: "b", localDate: "2026-10-25" }), ev({ id: "a", localDate: "2026-10-20" }), ev({ id: "old", localDate: "2026-09-01" }), ev({ id: "arch", localDate: "2026-12-01", archived: true })];
    const s = splitEvents(events, TODAY);
    expect(s.upcoming.map((e) => e.id)).toEqual(["a", "b"]);
    expect(s.past.map((e) => e.id)).toEqual(["arch", "old"]);
  });
  it("caps upcoming events", () => {
    const many = Array.from({ length: MAX_FUTURE_EVENTS }, (_, i) => ev({ id: String(i) }));
    expect(canAddEvent(many, TODAY)).toBe(false);
    expect(canAddEvent(many.slice(1), TODAY)).toBe(true);
  });
});

describe("delivery notice", () => {
  it("never promises delivery: ok is an estimate and late items surface first", () => {
    expect(deliveryNotice({ status: "ok", orderByDate: null })).toEqual({ kind: "estimate" });
    expect(deliveryNotice({ status: "may_not_arrive", orderByDate: "2026-10-16" })).toEqual({ kind: "mayNotArrive", orderBy: "2026-10-16" });
    expect(deliveryNotice({ status: "unknown", orderByDate: null })).toEqual({ kind: "unknown" });
    expect(worstDelivery([{ status: "ok", orderByDate: null }, { status: "may_not_arrive", orderByDate: "2026-10-16" }]).status).toBe("may_not_arrive");
    expect(worstDelivery([])).toEqual({ status: "unknown", orderByDate: null });
  });
});

describe("in-memory calendar port", () => {
  const now = () => Date.parse(TS);
  it("creates, updates, generates with a late notice, adds the gap once, and clears", async () => {
    const port = new InMemoryCalendarPort(now);
    const e = await port.create({ kind: "work", localDate: "2026-10-13", localTime: null, note: null, modest: false, season: "all", budget: null, remindersEnabled: true });
    const g = await port.generate(e.id, false);
    expect(g.outfits[0]?.delivery.status).toBe("may_not_arrive");
    const first = await port.addGap(e.id, g.outfits[0]?.outfit.id ?? "");
    const again = await port.addGap(e.id, g.outfits[0]?.outfit.id ?? "");
    expect([first.added, again.alreadyAdded]).toEqual([true, true]);
    expect((await port.update(e.id, { remindersEnabled: false })).remindersEnabled).toBe(false);
    await port.clear();
    expect(await port.list(true)).toEqual([]);
  });
});

interface Req { method: string; path: string; query: URLSearchParams; body: unknown }
function harness(routes: Record<string, (r: Req) => { status?: number; body?: unknown }>) {
  const calls: Req[] = [];
  const fetch: FetchLike = async (url, init) => {
    const u = new URL(url);
    const req: Req = { method: init?.method ?? "GET", path: u.pathname, query: u.searchParams, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined };
    calls.push(req);
    const h = routes[`${req.method} ${req.path}`];
    if (h === undefined) return new Response(JSON.stringify({ type: "/p/nf", title: "nf", status: 404 }), { status: 404, headers: { "Content-Type": "application/problem+json" } });
    const r = h(req);
    return new Response(r.status === 204 ? null : JSON.stringify(r.body ?? {}), { status: r.status ?? 200, headers: { "Content-Type": "application/json" } });
  };
  const client = createClient({ baseUrl: "https://api.test", fetch, getToken: () => "tok", sleep: async () => undefined, randomBytes: (n) => new Uint8Array(n).fill(3), maxRetries: 0 });
  const ctx: AdapterContext = { client, locale: () => "ar", nowMs: () => Date.parse(TS), deviceId: () => "install-device-1" };
  return { ctx, calls };
}

const wireEvent = {
  id: EID, kind: "wedding_guest", starts_at: "2026-11-05T17:00:00Z", local_date: "2026-11-05", local_time: "19:00", note: null, modesty: "modest", season_band: "autumn",
  budget_piastres: "300000", owned_slots: ["shoes"], source: "manual", reminders_enabled: true, status: "active", outfit_status: "planned",
  outfits: [{ outfit_id: OID, status: "planned" }], version: 2, created_at: TS,
};

describe("ApiCalendarPort", () => {
  it("lists events with the cursor loop and maps them", async () => {
    const { ctx, calls } = harness({ "GET /v1/me/calendar/events": () => ({ body: { items: [wireEvent], next_cursor: null } }) });
    const list = await new ApiCalendarPort(ctx).list(true);
    expect(list[0]).toMatchObject({ id: EID, modest: true, budget: 300_000n, ownedSlots: ["shoes"], archived: false, outfitStatus: "planned" });
    expect(calls[0]?.query.get("include_archived")).toBe("true");
  });
  it("creates an event with only the fields the shopper set", async () => {
    const { ctx, calls } = harness({ "POST /v1/me/calendar/events": () => ({ status: 201, body: wireEvent }) });
    await new ApiCalendarPort(ctx).create({ kind: "wedding_guest", localDate: "2026-11-05", localTime: null, note: null, modest: true, season: "autumn", budget: 300_000n, remindersEnabled: true });
    expect(calls[0]?.body).toEqual({
      source: "manual", kind: "wedding_guest", local_date: "2026-11-05", modesty: "modest", season_band: "autumn", budget_piastres: "300000", reminders_enabled: true,
    });
  });
  it("maps the gap-fill response including the delivery notice and AI source", async () => {
    const { ctx } = harness({
      [`POST /v1/me/calendar/events/${EID}/outfits`]: () => ({
        body: {
          ai_notice: "AI suggestions", event: wireEvent, owned_only: false, shortfall: [], source: "ml", fallback_reason: "none", quota: { remaining_today: 3 },
          outfits: [{
            outfit_id: OID, source: "ml", complete: false, ai_suggestion: true, currency: "EGP", total_piastres: "150000", owned_slots: ["shoes"],
            items: [{ item_id: IID, store_id: STORE, slot: "dress", price_piastres: "150000", verified_discount_pct: 20 }],
            per_store: [{ store_id: STORE, subtotal_piastres: "150000" }], missing: [{ slot: "bag", reason: "budget", add_piastres: "20000" }],
            budget_fit: { budget_piastres: "300000", remaining_piastres: "150000", within_budget: true },
            delivery: { status: "may_not_arrive", order_by_date: "2026-11-01", guaranteed: false },
          }],
        },
      }),
    });
    const g = await new ApiCalendarPort(ctx).generate(EID, false);
    expect(g.source).toBe("ai");
    expect(g.remainingToday).toBe(3);
    expect(g.outfits[0]).toMatchObject({ total: 150_000n, ownedSlots: ["shoes"], missing: [{ slot: "bag", shortfall: 20_000n }], delivery: { status: "may_not_arrive", orderByDate: "2026-11-01" } });
  });
  it("adds the gap to the bag and reports unavailable items", async () => {
    const { ctx, calls } = harness({
      [`POST /v1/me/calendar/events/${EID}/add-gap-to-bag`]: () => ({
        body: { added: true, already_added: false, item_ids: [IID], unavailable: [{ item_id: STORE, slot: "bag", reason: "sold_out" }], price_changes: [] },
      }),
    });
    const r = await new ApiCalendarPort(ctx).addGap(EID, OID);
    expect(r).toEqual({ added: true, alreadyAdded: false, unavailable: 1, priceChanges: 0, delivery: null });
    expect(calls[0]?.body).toEqual({ outfit_id: OID });
  });
  it("deletes one event and clears all", async () => {
    const { ctx, calls } = harness({
      [`DELETE /v1/me/calendar/events/${EID}`]: () => ({ status: 204 }),
      "DELETE /v1/me/calendar/events": () => ({ status: 204 }),
    });
    const port = new ApiCalendarPort(ctx);
    await port.remove(EID);
    await port.clear();
    expect(calls.map((c) => c.path)).toEqual([`/v1/me/calendar/events/${EID}`, "/v1/me/calendar/events"]);
  });
});
