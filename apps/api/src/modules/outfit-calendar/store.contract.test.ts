import { afterAll, describe, expect, it } from "vitest";
import { KyselyStoreDeliveryEta } from "./adapters/eta";
import { InMemoryCalendarStore } from "./adapters/in-memory";
import { KyselyOutfitCalendarStore, type OutfitCalendarDb } from "./adapters/kysely-store";
import type { CalendarEvent, CalendarStore } from "./domain/ports";
import { createCalendarDatabase, type PgliteLike } from "./test/pglite-db";

const U = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const T0 = 1_800_000_000_000;
const HOUR = 3_600_000;

const event = (n: number, userId: string, over: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id: U(1000 + n),
  userId,
  kind: "date",
  startsAtMs: T0 + 10 * 24 * HOUR + n * HOUR,
  localDate: "2027-01-25",
  note: null,
  modesty: "standard",
  seasonBand: "all",
  budgetPiastres: null,
  ownedSlots: ["shoes", "bag"],
  source: "manual",
  remindersEnabled: true,
  status: "active",
  version: 1,
  createdAtMs: T0,
  updatedAtMs: T0,
  ...over,
});
const plan = (n: number, offsetDays: number, dueAtMs: number) => ({ id: U(2000 + n), offsetDays, dueAtMs });

interface Ctx {
  readonly store: CalendarStore;
  prepare(userIds: readonly string[]): Promise<void>;
  /** An outfit row the links can reference (FK in Postgres). */
  outfit(id: string, userId: string): Promise<void>;
  outboxTypes(): Promise<string[]>;
}

function contract(name: string, fresh: () => Promise<Ctx>): void {
  describe(`CalendarStore contract: ${name}`, () => {
    it("round trips an event with owned slots, budget and bigint money", async () => {
      const c = await fresh();
      await c.prepare([U(1)]);
      const e = event(1, U(1), { budgetPiastres: 123_456_789_012n, note: "n" });
      await c.store.insertEvent(e, [plan(1, 7, e.startsAtMs - 7 * 24 * HOUR), plan(2, 1, e.startsAtMs - 24 * HOUR)], [
        { type: "calendar.event_created", eventId: e.id, userId: U(1), kind: "date", source: "manual" },
      ]);
      expect(await c.store.getEvent(e.id)).toEqual(e);
      expect(await c.store.getEvent(U(999))).toBeNull();
      expect((await c.store.remindersFor(e.id)).map((r) => r.offsetDays)).toEqual([7, 1]);
      expect(await c.outboxTypes()).toEqual(["calendar.event_created"]);
      expect(await c.store.countFuture(U(1), T0)).toBe(1);
    });

    it("lists by owner in order with a keyset cursor and an archived filter", async () => {
      const c = await fresh();
      await c.prepare([U(1), U(2)]);
      for (const n of [3, 1, 2]) await c.store.insertEvent(event(n, U(1)), [], []);
      await c.store.insertEvent(event(9, U(2)), [], []);
      const first = await c.store.list({ userId: U(1), fromMs: 0, includeArchived: false, limit: 2, after: null });
      expect(first.map((e) => e.id)).toEqual([U(1001), U(1002)]);
      const last = first[1];
      const rest = await c.store.list({ userId: U(1), fromMs: 0, includeArchived: false, limit: 5, after: last === undefined ? null : { startsAtMs: last.startsAtMs, id: last.id } });
      expect(rest.map((e) => e.id)).toEqual([U(1003)]);
      expect(await c.store.archivePast(T0 + 10 * 24 * HOUR + 150 * 60_000)).toBe(2);
      expect(await c.store.list({ userId: U(1), fromMs: 0, includeArchived: false, limit: 5, after: null })).toHaveLength(1);
      expect(await c.store.list({ userId: U(1), fromMs: 0, includeArchived: true, limit: 5, after: null })).toHaveLength(3);
    });

    it("update replaces only pending reminders and is owner scoped", async () => {
      const c = await fresh();
      await c.prepare([U(1), U(2)]);
      const e = event(1, U(1));
      await c.store.insertEvent(e, [plan(1, 7, T0 + 1000), plan(2, 1, T0 + 2000)], []);
      await c.store.finishReminder(U(2001), "sent", null, T0 + 1500, []);
      const upd = { ...e, note: "changed", ownedSlots: [] as CalendarEvent["ownedSlots"], version: 2 };
      expect(await c.store.updateEvent(upd, [plan(3, 1, T0 + 5000)])).toBe("updated");
      const rows = await c.store.remindersFor(e.id);
      expect(rows.map((r) => [r.id, r.state])).toEqual([[U(2001), "sent"], [U(2003), "pending"]]);
      expect((await c.store.getEvent(e.id))?.note).toBe("changed");
      expect(await c.store.updateEvent({ ...upd, userId: U(2) }, null)).toBe("not_found");
      expect(await c.store.deleteEvent(e.id, U(2))).toBe(false);
      expect(await c.store.deleteEvent(e.id, U(1))).toBe(true);
      expect(await c.store.remindersFor(e.id)).toEqual([]);
    });

    it("links: replace planned keeps in_bag, transition is a compare-and-set", async () => {
      const c = await fresh();
      await c.prepare([U(1)]);
      const e = event(1, U(1));
      await c.store.insertEvent(e, [], []);
      for (const n of [1, 2, 3]) await c.outfit(U(3000 + n), U(1));
      await c.store.replacePlannedLinks(e.id, U(1), [{ id: U(4001), outfitId: U(3001) }, { id: U(4002), outfitId: U(3002) }], T0, [
        { type: "calendar.outfit_planned", eventId: e.id, userId: U(1), count: 2 },
      ]);
      expect(await c.store.transitionLink(e.id, U(3001), "planned", "in_bag", T0 + 1, [])).toBe(true);
      expect(await c.store.transitionLink(e.id, U(3001), "planned", "in_bag", T0 + 2, [])).toBe(false);
      await c.store.replacePlannedLinks(e.id, U(1), [{ id: U(4003), outfitId: U(3003) }], T0 + 3, []);
      const links = (await c.store.linksFor([e.id])).get(e.id) ?? [];
      expect(links.map((l) => [l.outfitId, l.status])).toEqual([[U(3001), "in_bag"], [U(3003), "planned"]]);
      expect((await c.store.linksFor([])).size).toBe(0);
    });

    it("claims due reminders once, dedupes on (event, due_at), re-claims stale leases", async () => {
      const c = await fresh();
      await c.prepare([U(1)]);
      const e = event(1, U(1));
      await c.store.insertEvent(e, [plan(1, 7, T0 + 1000), plan(2, 7, T0 + 1000), plan(3, 1, T0 + 9_000_000)], []);
      expect(await c.store.remindersFor(e.id)).toHaveLength(2);
      const got = await c.store.claimDueReminders(T0 + 2000, 10, 60_000);
      expect(got.map((r) => r.id)).toEqual([U(2001)]);
      expect(got[0]).toMatchObject({ startsAtMs: e.startsAtMs, eventStatus: "active", remindersEnabled: true, state: "sending" });
      expect(await c.store.claimDueReminders(T0 + 3000, 10, 60_000)).toHaveLength(0);
      expect((await c.store.claimDueReminders(T0 + 100_000, 10, 60_000)).map((r) => r.id)).toEqual([U(2001)]);
      expect(await c.store.rescheduleReminder(U(2001), T0 + 9_000_000)).toBe(false);
      expect(await c.store.rescheduleReminder(U(2001), T0 + 7_000_000)).toBe(true);
      await c.store.retryReminder(U(2001), T0 + 8_000_000, 2);
      expect((await c.store.remindersFor(e.id))[0]).toMatchObject({ state: "pending", attempts: 2, dueAtMs: T0 + 8_000_000 });
      await c.store.finishReminder(U(2001), "sent", null, T0 + 8_000_001, [{ type: "calendar.reminder_due", eventId: e.id, userId: U(1), offsetDays: 7, dueAtMs: T0 + 8_000_000 }]);
      expect(await c.store.sentTimesSince(U(1), T0)).toEqual([T0 + 8_000_001]);
      expect(await c.store.sentTimesSince(U(1), T0 + 9_000_000)).toEqual([]);
    });

    it("clears every event of one user and nothing else", async () => {
      const c = await fresh();
      await c.prepare([U(1), U(2)]);
      await c.store.insertEvent(event(1, U(1)), [plan(1, 7, T0 + 1)], []);
      await c.store.insertEvent(event(2, U(1)), [], []);
      await c.store.insertEvent(event(3, U(2)), [], []);
      expect(await c.store.deleteAllForUser(U(1))).toBe(2);
      expect(await c.store.countFuture(U(1), 0)).toBe(0);
      expect(await c.store.countFuture(U(2), 0)).toBe(1);
    });
  });
}

contract("in-memory", async () => {
  const store = new InMemoryCalendarStore();
  return {
    store,
    prepare: async () => undefined,
    outfit: async () => undefined,
    outboxTypes: async () => store.events.map((e) => e.type),
  };
});

const open: OutfitCalendarDb[] = [];
let seq = 0;
const ids = { uuidV7: (): string => `00000000-0000-7000-8000-${String(++seq).padStart(12, "0")}` };
afterAll(async () => {
  await Promise.all(open.map((d) => d.destroy()));
});

async function pgFresh(): Promise<Ctx & { pg: PgliteLike; db: OutfitCalendarDb }> {
  const { pg, db } = await createCalendarDatabase();
  open.push(db);
  return {
    pg,
    db,
    store: new KyselyOutfitCalendarStore(db, ids),
    prepare: async (users) => {
      for (const u of users) await pg.query(`insert into users (id, status) values ($1, 'active') on conflict do nothing`, [u]);
    },
    outfit: async (id, userId) => {
      await pg.query(
        `insert into outfits (id, generation_id, user_id, request, items, scores, source, complete, total_piastres, kind)
         values ($1, $1, $2, '{}', '[{"itemId":"a"}]', '{}', 'rules', true, 0, 'outfit')`,
        [id, userId],
      );
    },
    outboxTypes: async () => (await pg.query<{ event_type: string }>(`select event_type from outbox_events order by id`)).rows.map((r) => r.event_type),
  };
}
contract("kysely/pglite", pgFresh);

describe("migrations 0062 and 0063 (pglite)", () => {
  it("enforces checks: bad kind, long note, bad slot, negative budget, duplicate (event, due_at)", async () => {
    const c = await pgFresh();
    await c.prepare([U(1)]);
    const base = (over: string) =>
      c.pg.query(
        `insert into calendar_events (id, user_id, kind, starts_at, local_date ${over.split("|")[0]}) values ('${U(7000 + Math.floor(Math.random() * 999))}', '${U(1)}', 'date', now(), current_date ${over.split("|")[1]})`,
      );
    await expect(c.pg.query(`insert into calendar_events (id, user_id, kind, starts_at, local_date) values ('${U(7001)}', '${U(1)}', 'party', now(), current_date)`)).rejects.toThrow();
    await expect(base(", note|, '" + "x".repeat(201) + "'")).rejects.toThrow();
    await expect(base(", owned_slots|, '{cape}'")).rejects.toThrow();
    await expect(base(", budget_piastres|, -1")).rejects.toThrow();
    await expect(base(", modesty|, 'loose'")).rejects.toThrow();
    const e = event(1, U(1));
    await c.store.insertEvent(e, [plan(1, 7, T0)], []);
    await expect(c.pg.query(`insert into calendar_reminders (id, event_id, user_id, offset_days, due_at) values ('${U(8001)}', '${e.id}', '${U(1)}', 1, to_timestamp(${T0}/1000.0))`)).rejects.toThrow();
  });

  it("row level security: events, links and reminders are owner only", async () => {
    const c = await pgFresh();
    await c.prepare([U(1), U(2)]);
    const e = event(1, U(1));
    await c.store.insertEvent(e, [plan(1, 7, T0)], []);
    await c.outfit(U(3001), U(1));
    await c.store.replacePlannedLinks(e.id, U(1), [{ id: U(4001), outfitId: U(3001) }], T0, []);
    const asUser = async (userId: string, stmt: string): Promise<{ rows: unknown[] }> => {
      await c.pg.exec(`set role app_user; select set_config('app.user_id', '${userId}', false); select set_config('app.role', 'user', false);`);
      try {
        return await c.pg.query(stmt);
      } finally {
        await c.pg.exec(`reset role`);
      }
    };
    for (const t of ["calendar_events", "calendar_outfits", "calendar_reminders"]) {
      expect((await asUser(U(1), `select 1 from ${t}`)).rows).toHaveLength(1);
      expect((await asUser(U(2), `select 1 from ${t}`)).rows).toHaveLength(0);
    }
    expect((await asUser(U(2), `update calendar_events set note = 'x' returning id`)).rows).toHaveLength(0);
    expect((await asUser(U(2), `delete from calendar_events returning id`)).rows).toHaveLength(0);
  });

  it("the outbox payload carries ids and enums only, never the note or the budget", async () => {
    const c = await pgFresh();
    await c.prepare([U(1)]);
    const e = event(1, U(1), { note: "secret dinner", budgetPiastres: 99_999n });
    await c.store.insertEvent(e, [], [{ type: "calendar.event_created", eventId: e.id, userId: U(1), kind: "date", source: "manual" }]);
    const rows = await c.pg.query<{ payload: unknown }>(`select payload from outbox_events`);
    expect(JSON.stringify(rows.rows)).not.toMatch(/secret|99999|budget|note/);
  });

  it("deleting an outfit (stylist history clear) drops the link, not the event", async () => {
    const c = await pgFresh();
    await c.prepare([U(1)]);
    const e = event(1, U(1));
    await c.store.insertEvent(e, [], []);
    await c.outfit(U(3001), U(1));
    await c.store.replacePlannedLinks(e.id, U(1), [{ id: U(4001), outfitId: U(3001) }], T0, []);
    await c.pg.exec(`delete from outfits`);
    expect((await c.store.linksFor([e.id])).get(e.id) ?? []).toEqual([]);
    expect(await c.store.getEvent(e.id)).not.toBeNull();
  });
});

describe("KyselyStoreDeliveryEta", () => {
  it("rounds p80 hours up to days and answers null for unknown stores", async () => {
    const c = await pgFresh();
    const store = U(5001);
    await c.pg.exec(`set session_replication_role = replica`);
    await c.pg.query(`insert into stores (id, seller_id, kind, slug, name_ar, status) values ($1, $1, 'local', 'acme', 'اكمي', 'ACTIVE')`, [store]);
    await c.pg.query(`insert into store_directory_stats (store_id, p80_delivery_hours) values ($1, 49)`, [store]);
    const eta = new KyselyStoreDeliveryEta(c.db);
    const r = await eta.p80Days(U(1), [store, U(5002), "not-a-uuid"]);
    expect(r.get(store)).toBe(3);
    expect(r.get(U(5002))).toBeNull();
    expect(r.get("not-a-uuid")).toBeNull();
  });
});
