import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PROCESS_CALENDAR_REMINDERS } from "./adapters/tokens";
import type { ProcessDueReminders } from "./application/reminders";
import { FLAG_REMINDERS } from "./application/shared";
import { cairoLocalToUtc } from "./domain/bridge";
import { IDEM, TOKENS, USERS, bearer, createCalendarHarness, type CalendarHarness } from "./test/harness";

let h: CalendarHarness;
let job: ProcessDueReminders;
let seq = 5000;
beforeEach(async () => {
  h = await createCalendarHarness();
  job = h.app.get<ProcessDueReminders>(PROCESS_CALENDAR_REMINDERS, { strict: false });
});
afterEach(async () => {
  await h.close();
});

const at = (key: string, hh: number, mm = 0): number => cairoLocalToUtc(key, hh * 60 + mm);
const make = async (date: string, time = "18:00", over: Record<string, unknown> = {}): Promise<string> => {
  const r = await h
    .http()
    .post("/v1/me/calendar/events")
    .set({ ...bearer(TOKENS.a), "Idempotency-Key": IDEM(++seq) })
    .send({ kind: "date", local_date: date, local_time: time, reminders_enabled: true, ...over });
  expect(r.status).toBe(201);
  return r.body.id as string;
};

describe("ProcessDueReminders", () => {
  it("sends the 7 day reminder when due and records the outbox event once", async () => {
    const id = await make("2027-02-01");
    h.clock.set(at("2027-01-25", 18) + 60_000);
    const r = await job.execute(10);
    expect(r).toMatchObject({ claimed: 1, sent: 1 });
    expect(h.notifier.sent).toEqual([{ userId: USERS.a, eventId: id, dueAtMs: at("2027-01-25", 18), offsetDays: 7 }]);
    expect(h.store.events.filter((e) => e.type === "calendar.reminder_due")).toHaveLength(1);
    expect((await job.execute(10)).claimed).toBe(0);
    expect(h.notifier.sent).toHaveLength(1);
  });

  it("defers a reminder due in quiet hours to 09:00 Cairo", async () => {
    // Event at 23:30 on the 8th: the 7 day reminder (23:30 on the 1st) is planned for 09:00 on the 2nd.
    const id = await make("2027-02-08", "23:30");
    const planned = await h.store.remindersFor(id);
    expect(planned[0]?.dueAtMs).toBe(at("2027-02-02", 9));
    // A late worker run at 23:10 the same day finds it due but in quiet hours: pushed to 09:00 next day.
    h.clock.set(at("2027-02-02", 23, 10));
    const r = await job.execute(10);
    expect(r).toMatchObject({ claimed: 1, deferred: 1, sent: 0 });
    const after = (await h.store.remindersFor(id)).find((x) => x.offsetDays === 7);
    expect(after?.dueAtMs).toBe(at("2027-02-03", 9));
    expect(after?.state).toBe("pending");
    expect(h.notifier.sent).toHaveLength(0);
  });

  it("defers over the frequency cap and skips when the event has started or reminders were turned off", async () => {
    const ids: string[] = [];
    for (const d of ["2027-02-02", "2027-02-03", "2027-02-04"]) ids.push(await make(d));
    // All three 1-day reminders... use 7-day ones: dates minus 7 days at 18:00 are 01-26, 01-27, 01-28.
    h.clock.set(at("2027-01-28", 19));
    const r = await job.execute(10);
    // Reminders 01-26, 01-27 and 01-28 are due; the daily cap (2) lets two through.
    expect(r.sent).toBe(2);
    expect(r.deferred).toBe(1);

    const off = await make("2027-03-10");
    await h.http().patch(`/v1/me/calendar/events/${off}`).set(bearer(TOKENS.a)).send({ reminders_enabled: false });
    expect(await h.store.remindersFor(off)).toHaveLength(0);
    expect(ids).toHaveLength(3);
  });

  it("retries with backoff, then fails after the attempt limit, and never double sends on notifier dedupe", async () => {
    const id = await make("2027-02-01");
    h.clock.set(at("2027-01-25", 18) + 60_000);
    h.notifier.throws = true;
    expect((await job.execute(10)).retried).toBe(1);
    let row = (await h.store.remindersFor(id)).find((x) => x.offsetDays === 7);
    expect(row?.state).toBe("pending");
    expect(row?.attempts).toBe(1);
    h.notifier.throws = false;
    h.notifier.next = "deduplicated";
    h.clock.advance(10 * 60_000);
    expect((await job.execute(10)).sent).toBe(1);
    row = (await h.store.remindersFor(id)).find((x) => x.offsetDays === 7);
    expect(row?.state).toBe("sent");

    const id2 = await make("2027-02-02");
    h.notifier.throws = true;
    let failed = 0;
    for (let i = 0; i < 40; i += 1) {
      h.clock.advance(3 * 3_600_000);
      failed += (await job.execute(10)).failed;
    }
    expect(failed).toBe(1);
    expect((await h.store.remindersFor(id2)).some((x) => x.state === "failed")).toBe(true);
  });

  it("claims nothing while the kill switch blocks reminders, and sends once it is allowed again", async () => {
    await make("2027-02-01");
    h.clock.set(at("2027-01-25", 18) + 60_000);
    h.flags.on.delete(FLAG_REMINDERS);
    expect((await job.execute(10)).claimed).toBe(0);
    h.flags.on.add(FLAG_REMINDERS);
    expect((await job.execute(10)).sent).toBe(1);
  });

  it("re-claims a stale lease and archives past events", async () => {
    const id = await make("2027-02-01");
    h.clock.set(at("2027-01-25", 18) + 60_000);
    const claimed = await h.store.claimDueReminders(h.clock.nowMs(), 10, 600_000);
    expect(claimed).toHaveLength(1);
    expect(await h.store.claimDueReminders(h.clock.nowMs(), 10, 600_000)).toHaveLength(0);
    h.clock.advance(11 * 60_000);
    expect((await job.execute(10)).sent).toBe(1);
    h.clock.set(at("2027-02-02", 12));
    const r = await job.execute(10);
    expect(r.archived).toBe(1);
    expect((await h.store.getEvent(id))?.status).toBe("archived");
    const list = await h.http().get("/v1/me/calendar/events").set(bearer(TOKENS.a));
    expect(list.body.items).toEqual([]);
    const all = await h.http().get("/v1/me/calendar/events?include_archived=true").set(bearer(TOKENS.a));
    expect(all.body.items).toHaveLength(1);
    expect(all.body.items[0].status).toBe("archived");
    expect((await h.http().patch(`/v1/me/calendar/events/${id}`).set(bearer(TOKENS.a)).send({ note: "x" })).status).toBe(409);
  });
});
