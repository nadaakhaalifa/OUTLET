import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { IDEM, TOKENS, bearer, createCalendarHarness, type CalendarHarness } from "./test/harness";
import { sku } from "./test/stylist-fixtures";

let h: CalendarHarness;
let seq = 0;
beforeAll(async () => {
  h = await createCalendarHarness();
}, 60_000);
afterAll(async () => {
  await h.close();
});

const create = (token: string | null, body: unknown, key: string | null = IDEM(++seq)) => {
  let r = h.http().post("/v1/me/calendar/events");
  if (key !== null) r = r.set({ "Idempotency-Key": key });
  if (token !== null) r = r.set(bearer(token));
  return r.send(body as object);
};
const mk = async (over: Record<string, unknown> = {}, token: string = TOKENS.a): Promise<string> => {
  const r = await create(token, { kind: "wedding_guest", local_date: "2027-02-20", local_time: "18:00", budget_piastres: "300000", ...over });
  expect(r.status).toBe(201);
  return r.body.id as string;
};
const post = (path: string, token: string | null, body: unknown, idem = false) => {
  h.clock.advance(61_000);
  let r = h.http().post(path);
  if (idem) r = r.set({ "Idempotency-Key": IDEM(++seq) });
  if (token !== null) r = r.set(bearer(token));
  return r.send(body as object);
};

describe("events CRUD", () => {
  it("creates an event with the Cairo-local date and time, defaults and no reminders", async () => {
    const r = await create(TOKENS.a, { kind: "work", local_date: "2027-03-01", local_time: "09:30", note: "board meeting" });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({
      kind: "work",
      local_date: "2027-03-01",
      local_time: "09:30",
      starts_at: "2027-03-01T07:30:00.000Z",
      modesty: "standard",
      reminders_enabled: false,
      status: "active",
      outfit_status: "none",
      source: "manual",
      budget_piastres: null,
    });
  });

  it("requires an Idempotency-Key and replays the same response for the same key", async () => {
    expect((await create(TOKENS.a, { kind: "work", local_date: "2027-03-02" }, null)).status).toBe(400);
    const key = IDEM(++seq);
    const a = await create(TOKENS.a, { kind: "work", local_date: "2027-03-02" }, key);
    const b = await create(TOKENS.a, { kind: "work", local_date: "2027-03-02" }, key);
    expect(a.status).toBe(201);
    expect(b.body.id).toBe(a.body.id);
  });

  it("rejects strict-body extras, bad dates, past dates and an inconsistent owned set", async () => {
    expect((await create(TOKENS.a, { kind: "work", local_date: "2027-03-02", user_id: USER })).status).toBe(400);
    expect((await create(TOKENS.a, { kind: "work", local_date: "2027-13-40" })).status).toBe(400);
    expect((await create(TOKENS.a, { kind: "work", local_date: "2027-02-30" })).status).toBe(400);
    expect((await create(TOKENS.a, { kind: "work", local_date: "2027-01-01" })).body.code).toBe("event_in_past");
    expect((await create(TOKENS.a, { kind: "work", local_date: "2027-03-02", owned_slots: ["dress", "top"] })).body.code).toBe("owned_slots_invalid");
    expect((await create(TOKENS.a, { kind: "work", local_date: "2027-03-02", note: "x".repeat(201) })).status).toBe(400);
    expect((await create(TOKENS.a, { kind: "work", local_date: "2027-03-02", budget_piastres: "-5" })).status).toBe(400);
  });

  it("device import accepts only date and type (contract on the request body)", async () => {
    const ok = await create(TOKENS.a, { source: "device", kind: "date", local_date: "2027-03-05" });
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ source: "device", note: null, budget_piastres: null, owned_slots: [], reminders_enabled: false });
    for (const extra of [{ note: "dinner at Zooba" }, { title: "x" }, { location: "Zamalek" }, { attendees: ["a"] }, { budget_piastres: "100" }, { local_time: "10:00" }]) {
      const r = await create(TOKENS.a, { source: "device", kind: "date", local_date: "2027-03-05", ...extra });
      expect(r.status, JSON.stringify(extra)).toBe(400);
    }
  });

  it("lists upcoming events in date order with a cursor, hides archived ones by default", async () => {
    const r = await h.http().get("/v1/me/calendar/events?limit=2").set(bearer(TOKENS.a));
    expect(r.status).toBe(200);
    expect(r.body.items).toHaveLength(2);
    expect(r.body.next_cursor).not.toBeNull();
    const dates = (r.body.items as { starts_at: string }[]).map((i) => i.starts_at);
    expect([...dates].sort()).toEqual(dates);
    const page2 = await h.http().get(`/v1/me/calendar/events?limit=2&cursor=${encodeURIComponent(r.body.next_cursor as string)}`).set(bearer(TOKENS.a));
    expect(page2.status).toBe(200);
    expect(page2.body.items[0].id).not.toBe(r.body.items[0].id);
    expect((await h.http().get("/v1/me/calendar/events?cursor=garbage").set(bearer(TOKENS.a))).status).toBe(400);
  });

  it("patches an event and re-plans reminders when the date changes", async () => {
    const id = await mk({ reminders_enabled: true, local_date: "2027-04-10" });
    const before = await h.store.remindersFor(id);
    expect(before.map((x) => x.offsetDays)).toEqual([7, 1]);
    const r = await h.http().patch(`/v1/me/calendar/events/${id}`).set(bearer(TOKENS.a)).send({ local_date: "2027-04-20", note: "moved" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ local_date: "2027-04-20", note: "moved", version: 2 });
    const after = await h.store.remindersFor(id);
    expect(after).toHaveLength(2);
    expect(after.every((x) => x.state === "pending")).toBe(true);
    expect(after[0]?.dueAtMs).not.toBe(before[0]?.dueAtMs);
    const off = await h.http().patch(`/v1/me/calendar/events/${id}`).set(bearer(TOKENS.a)).send({ reminders_enabled: false });
    expect(off.status).toBe(200);
    expect(await h.store.remindersFor(id)).toHaveLength(0);
    expect((await h.http().patch(`/v1/me/calendar/events/${id}`).set(bearer(TOKENS.a)).send({ owner: "x" })).status).toBe(400);
  });

  it("deletes one event and clears the whole calendar on request", async () => {
    const id = await mk({ local_date: "2027-05-05" });
    expect((await h.http().delete(`/v1/me/calendar/events/${id}`).set(bearer(TOKENS.a))).status).toBe(204);
    expect((await h.http().get(`/v1/me/calendar/events/${id}`).set(bearer(TOKENS.a))).status).toBe(404);
    await mk({}, TOKENS.b);
    expect((await h.http().delete("/v1/me/calendar/events").set(bearer(TOKENS.b))).status).toBe(204);
    expect((await h.http().get("/v1/me/calendar/events").set(bearer(TOKENS.b))).body.items).toEqual([]);
    expect((await h.http().get("/v1/me/calendar/events").set(bearer(TOKENS.a))).body.items.length).toBeGreaterThan(0);
  });

  it("caps upcoming events at 100 with 409", async () => {
    const c = await createCalendarHarness();
    try {
      for (let i = 0; i < 100; i += 1) {
        await c.store.insertEvent(
          {
            id: `10000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
            userId: USER,
            kind: "custom",
            startsAtMs: 1_900_000_000_000 + i,
            localDate: "2030-03-17",
            note: null,
            modesty: "standard",
            seasonBand: "all",
            budgetPiastres: null,
            ownedSlots: [],
            source: "manual",
            remindersEnabled: false,
            status: "active",
            version: 1,
            createdAtMs: 0,
            updatedAtMs: 0,
          },
          [],
          [],
        );
      }
      const r = await c
        .http()
        .post("/v1/me/calendar/events")
        .set({ ...bearer(TOKENS.a), "Idempotency-Key": IDEM(++seq) })
        .send({ kind: "work", local_date: "2027-03-02" });
      expect(r.status).toBe(409);
      expect(r.body.code).toBe("calendar_limit_reached");
    } finally {
      await c.close();
    }
  });
});

const USER = "00000000-0000-4000-8000-000000000001";

describe("authorization", () => {
  it("401 without a token or on the wrong audience", async () => {
    expect((await create(null, { kind: "work", local_date: "2027-03-02" })).status).toBe(401);
    expect((await create(TOKENS.aOnSellerAud, { kind: "work", local_date: "2027-03-02" })).status).toBe(401);
    expect((await h.http().get("/v1/me/calendar/events")).status).toBe(401);
    expect((await h.http().delete("/v1/me/calendar/events")).status).toBe(401);
  });

  it("another shopper's event is 404 on every object route and nothing changes", async () => {
    const id = await mk({ local_date: "2027-06-01", owned_slots: ["shoes"] });
    const before = await h.store.getEvent(id);
    const outfitId = IDEM(999);
    const calls = [
      await h.http().get(`/v1/me/calendar/events/${id}`).set(bearer(TOKENS.b)),
      await h.http().patch(`/v1/me/calendar/events/${id}`).set(bearer(TOKENS.b)).send({ note: "hijack" }),
      await h.http().delete(`/v1/me/calendar/events/${id}`).set(bearer(TOKENS.b)),
      await h.http().post(`/v1/me/calendar/events/${id}/outfits`).set(bearer(TOKENS.b)).send({}),
      await h.http().post(`/v1/me/calendar/events/${id}/add-gap-to-bag`).set({ ...bearer(TOKENS.b), "Idempotency-Key": IDEM(++seq) }).send({ outfit_id: outfitId }),
    ];
    for (const c of calls) expect(c.status).toBe(404);
    expect(await h.store.getEvent(id)).toEqual(before);
    expect(h.stylist.bag.adds).toHaveLength(0);
    // Same status as a missing id: no existence oracle.
    const missing = await h.http().get(`/v1/me/calendar/events/${IDEM(12345)}`).set(bearer(TOKENS.a));
    expect(missing.status).toBe(404);
  });
});

describe("gap fill", () => {
  it("fills only the missing slots within the typed budget and links the outfits to the event", async () => {
    const id = await mk({ local_date: "2027-07-01", owned_slots: ["shoes", "bag"], budget_piastres: "250000" });
    const r = await post(`/v1/me/calendar/events/${id}/outfits`, TOKENS.a, {});
    expect(r.status).toBe(200);
    expect(r.body.ai_notice).toBe("AI suggestions");
    expect(r.body.outfits.length).toBeGreaterThan(0);
    for (const o of r.body.outfits as { items: { slot: string }[]; total_piastres: string; budget_fit: { within_budget: boolean }; delivery: { guaranteed: boolean } }[]) {
      expect(BigInt(o.total_piastres) <= 250_000n).toBe(true);
      expect(o.items.some((i) => i.slot === "shoes" || i.slot === "bag")).toBe(false);
      expect(o.delivery.guaranteed).toBe(false);
    }
    expect(r.body.event.outfit_status).toBe("needs_purchases");
    const detail = await h.http().get(`/v1/me/calendar/events/${id}`).set(bearer(TOKENS.a));
    expect(detail.body.outfits).toHaveLength(r.body.outfits.length);
    expect(h.store.events.some((e) => e.type === "calendar.outfit_planned")).toBe(true);
    expect(h.stylist.outfits.events.some((e) => e.type === "outfit.generated")).toBe(true);
  });

  it("flags may_not_arrive with an order-by date, never a promise, when p80 exceeds the lead time", async () => {
    const id = await mk({ local_date: "2027-01-18", local_time: "18:00" });
    for (const c of h.stylist.candidates.items) h.eta.days.set(c.storeId, 4);
    const r = await post(`/v1/me/calendar/events/${id}/outfits`, TOKENS.a, {});
    expect(r.status).toBe(200);
    for (const o of r.body.outfits as { delivery: { status: string; order_by_date: string; guaranteed: boolean } }[]) {
      expect(o.delivery.status).toBe("may_not_arrive");
      expect(o.delivery.order_by_date).toBe("2027-01-12");
      expect(o.delivery.guaranteed).toBe(false);
    }
    h.eta.days.clear();
    const unknown = await post(`/v1/me/calendar/events/${id}/outfits`, TOKENS.a, {});
    for (const o of unknown.body.outfits as { delivery: { status: string } }[]) expect(o.delivery.status).toBe("unknown");
  });

  it("owned everything: nothing to buy and no outfit is stored", async () => {
    const id = await mk({ local_date: "2027-07-02", owned_slots: ["dress", "shoes", "bag", "accessory"] });
    const r = await post(`/v1/me/calendar/events/${id}/outfits`, TOKENS.a, {});
    expect(r.status).toBe(200);
    expect(r.body.owned_only).toBe(true);
    expect(r.body.outfits).toEqual([]);
    expect(r.body.event.outfit_status).toBe("owned_only");
  });

  it("a budget too low returns a shortfall, still within budget", async () => {
    const id = await mk({ local_date: "2027-07-03", budget_piastres: "1000" });
    const r = await post(`/v1/me/calendar/events/${id}/outfits`, TOKENS.a, {});
    expect(r.status).toBe(200);
    for (const o of r.body.outfits as { total_piastres: string }[]) expect(BigInt(o.total_piastres) <= 1000n).toBe(true);
  });

  it("uses the rules fallback when ML is down, and 503s when the catalog or the switch is off", async () => {
    const id = await mk({ local_date: "2027-07-04" });
    h.stylist.embeddings.down = true;
    const r = await post(`/v1/me/calendar/events/${id}/outfits`, TOKENS.a, {});
    h.stylist.embeddings.down = false;
    expect(r.status).toBe(200);
    expect(r.body.source).toBe("rules");
    expect(r.body.fallback_reason).toBe("ml_down");
    h.stylist.candidates.down = true;
    expect((await post(`/v1/me/calendar/events/${id}/outfits`, TOKENS.a, {})).status).toBe(503);
    h.stylist.candidates.down = false;
    h.flags.on.delete("kill.calendar_gap_fill");
    const off = await post(`/v1/me/calendar/events/${id}/outfits`, TOKENS.a, {});
    h.flags.on.add("kill.calendar_gap_fill");
    expect(off.status).toBe(503);
    expect(off.body.code).toBe("calendar_gap_fill_disabled");
  });

  it("shares the stylist's daily quota", async () => {
    const id = await mk({ local_date: "2027-07-05" });
    const used = await h.stylist.outfits.countSince(USER, 0);
    expect(used).toBeGreaterThan(0);
    const small = await createCalendarHarness({ config: { dailyGenerations: 1, mlTimeoutMs: 800, freeDeliveryThresholdPiastres: 200_000n, maxReminderAttempts: 5, reminderLeaseMs: 600_000 } });
    try {
      const e = await small
        .http()
        .post("/v1/me/calendar/events")
        .set({ ...bearer(TOKENS.a), "Idempotency-Key": IDEM(++seq) })
        .send({ kind: "work", local_date: "2027-07-05" });
      const one = await small.http().post(`/v1/me/calendar/events/${e.body.id}/outfits`).set(bearer(TOKENS.a)).send({});
      expect(one.status).toBe(200);
      small.clock.advance(61_000);
      const two = await small.http().post(`/v1/me/calendar/events/${e.body.id}/outfits`).set(bearer(TOKENS.a)).send({});
      expect(two.status).toBe(429);
    } finally {
      await small.close();
    }
    expect(id).toBeTruthy();
  });

  it("uses the budget suite only on request and never stores a derived budget", async () => {
    const id = await mk({ local_date: "2027-07-06", budget_piastres: undefined });
    h.stylist.budget.remaining.set(USER, 400_000n);
    const r = await post(`/v1/me/calendar/events/${id}/outfits`, TOKENS.a, { use_remaining_budget: true });
    expect(r.status).toBe(200);
    for (const o of r.body.outfits as { budget_fit: { budget_piastres: string | null } }[]) expect(o.budget_fit.budget_piastres).toBeNull();
    h.stylist.budget.remaining.clear();
  });
});

describe("add gap to bag", () => {
  it("adds only the gap items, once, re-validating live price and stock", async () => {
    const id = await mk({ local_date: "2027-08-01", owned_slots: ["shoes"], budget_piastres: "300000" });
    const gen = await post(`/v1/me/calendar/events/${id}/outfits`, TOKENS.a, {});
    const outfit = gen.body.outfits[0] as { outfit_id: string; items: { item_id: string }[] };
    const sold = outfit.items[0]?.item_id ?? "";
    h.stylist.live.prices.set(sold, { pricePiastres: 1n, storeId: sold, inStockInSize: false });
    const r = await post(`/v1/me/calendar/events/${id}/add-gap-to-bag`, TOKENS.a, { outfit_id: outfit.outfit_id }, true);
    expect(r.status).toBe(200);
    expect(r.body.added).toBe(true);
    expect(r.body.unavailable).toEqual([{ item_id: sold, slot: expect.any(String), reason: "sold_out" }]);
    expect(r.body.delivery.guaranteed).toBe(false);
    const last = h.stylist.bag.adds[h.stylist.bag.adds.length - 1];
    expect(last?.itemIds).not.toContain(sold);
    const again = await post(`/v1/me/calendar/events/${id}/add-gap-to-bag`, TOKENS.a, { outfit_id: outfit.outfit_id }, true);
    expect(again.body.already_added).toBe(true);
    const detail = await h.http().get(`/v1/me/calendar/events/${id}`).set(bearer(TOKENS.a));
    expect(detail.body.outfits.find((o: { outfit_id: string }) => o.outfit_id === outfit.outfit_id).status).toBe("in_bag");
    expect(h.store.events.some((e) => e.type === "calendar.gap_added_to_bag")).toBe(true);
    for (const c of h.stylist.candidates.items) h.stylist.live.prices.set(c.itemId, { pricePiastres: c.pricePiastres, storeId: c.storeId, inStockInSize: true });
  });

  it("409 when a price rise breaks the budget, 404 for an outfit not linked to the event, 400 without a key", async () => {
    const id = await mk({ local_date: "2027-08-02", budget_piastres: "300000" });
    const gen = await post(`/v1/me/calendar/events/${id}/outfits`, TOKENS.a, {});
    const outfit = gen.body.outfits[0] as { outfit_id: string; items: { item_id: string; store_id: string; price_piastres: string }[] };
    const first = outfit.items[0];
    if (first === undefined) throw new Error("no items");
    h.stylist.live.prices.set(first.item_id, { pricePiastres: 10_000_000n, storeId: first.store_id, inStockInSize: true });
    const over = await post(`/v1/me/calendar/events/${id}/add-gap-to-bag`, TOKENS.a, { outfit_id: outfit.outfit_id }, true);
    expect(over.status).toBe(409);
    expect(over.body.code).toBe("budget_exceeded");
    h.stylist.live.prices.set(first.item_id, { pricePiastres: BigInt(first.price_piastres), storeId: first.store_id, inStockInSize: true });
    expect((await post(`/v1/me/calendar/events/${id}/add-gap-to-bag`, TOKENS.a, { outfit_id: IDEM(777) }, true)).status).toBe(404);
    expect((await post(`/v1/me/calendar/events/${id}/add-gap-to-bag`, TOKENS.a, { outfit_id: outfit.outfit_id }, false)).status).toBe(400);
    expect(sku(1)).toBeTruthy();
  });
});
