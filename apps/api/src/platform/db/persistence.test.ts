import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { InboxConsumer } from "@outlet/outbox";
import { InvalidSessionError } from "./deps";
import { KyselyConsentStore } from "./reference/consent-store";
import { RecordConsentChange } from "./reference/record-consent-change";
import { PLATFORM_COLUMNS, toBigInt } from "./schema";
import { createPersistenceFixture, type PersistenceFixture } from "./test-support";

const USER_A = "0192f3a4-5b6c-7d8e-9f01-aaaaaaaaaaa1";
const USER_B = "0192f3a4-5b6c-7d8e-9f01-bbbbbbbbbbb2";
const REQ_1 = "0192f3a4-5b6c-7d8e-9f01-0000000000a1";
const REQ_2 = "0192f3a4-5b6c-7d8e-9f01-0000000000a2";

let f: PersistenceFixture;
let useCase: RecordConsentChange;
const store = new KyselyConsentStore();

const counts = async (): Promise<{ consent: number; outbox: number }> => {
  const c = await f.raw.query<{ n: number }>("SELECT count(*)::int AS n FROM consent_records");
  const o = await f.raw.query<{ n: number }>("SELECT count(*)::int AS n FROM outbox_events");
  return { consent: c.rows[0]?.n ?? -1, outbox: o.rows[0]?.n ?? -1 };
};

beforeAll(async () => {
  f = await createPersistenceFixture();
  useCase = new RecordConsentChange(f.runner, store, f.inbox, f.clock);
  await f.raw.query("INSERT INTO users (id) VALUES ($1), ($2)", [USER_A, USER_B]);
});
afterAll(() => f.close());

const change = (subjectId: string, granted = true) => ({
  subjectType: "user" as const,
  subjectId,
  purpose: "analytics",
  version: 1,
  granted,
  method: "settings" as const,
  ipHash: null,
});

describe("unit of work + outbox atomicity", () => {
  it("commits state and outbox event together", async () => {
    const out = await useCase.execute({
      requestId: REQ_1,
      session: { userId: USER_A, role: "customer" },
      change: change(USER_A),
    });
    expect(out).toBe("recorded");
    expect(await counts()).toEqual({ consent: 1, outbox: 1 });
    const ev = await f.raw.query<{ event_type: string; payload: Record<string, unknown>; aggregate_id: string }>(
      "SELECT event_type, payload, aggregate_id FROM outbox_events",
    );
    expect(ev.rows[0]?.event_type).toBe("consent.changed");
    expect(ev.rows[0]?.aggregate_id).toBe(USER_A);
    expect(ev.rows[0]?.payload).toEqual({ purpose: "analytics", granted: true, version: 1 });
    // no PII keys in the event
    expect(JSON.stringify(ev.rows[0]?.payload)).not.toMatch(/ip|phone|email/i);
  });

  it("rolls back BOTH the state change and the outbox row when the use case throws", async () => {
    const before = await counts();
    await expect(
      f.runner.run({ session: { userId: USER_A, role: "customer" }, process: "privacy.consent_change" }, async (tx) => {
        await store.append(tx, { ...change(USER_A, false), at: new Date(f.clock.nowMs()) });
        await tx.emit({
          aggregateType: "consent_subject",
          aggregateId: USER_A,
          eventType: "consent.changed",
          payload: { purpose: "analytics", granted: false, version: 1 },
        });
        throw new Error("boom after writes");
      }),
    ).rejects.toThrow("boom after writes");
    expect(await counts()).toEqual(before);
  });

  it("rejects an invalid event and leaves nothing behind", async () => {
    const before = await counts();
    await expect(
      f.runner.run({ session: { userId: USER_A, role: "customer" }, process: "privacy.consent_change" }, async (tx) => {
        await store.append(tx, { ...change(USER_A), at: new Date(f.clock.nowMs()) });
        await tx.emit({ aggregateType: "x", aggregateId: USER_A, eventType: "BadName", payload: {} });
      }),
    ).rejects.toThrow(/eventType/);
    expect(await counts()).toEqual(before);
  });

  it("validates session and process BEFORE opening a transaction", async () => {
    await expect(
      f.runner.run({ session: { userId: "not-a-uuid", role: "customer" }, process: "a.b" }, async () => 1),
    ).rejects.toBeInstanceOf(InvalidSessionError);
    await expect(f.runner.run({ process: "nodots" }, async () => 1)).rejects.toBeInstanceOf(InvalidSessionError);
    await expect(f.runner.run({ process: "a.b", statementTimeoutMs: 0 }, async () => 1)).rejects.toThrow(RangeError);
  });
});

describe("idempotent insert", () => {
  it("a repeated request id is a no-op: one consent row, one outbox row", async () => {
    const before = await counts();
    const args = { requestId: REQ_2, session: { userId: USER_B, role: "customer" as const }, change: change(USER_B) };
    expect(await useCase.execute(args)).toBe("recorded");
    expect(await useCase.execute(args)).toBe("duplicate");
    expect(await counts()).toEqual({ consent: before.consent + 1, outbox: before.outbox + 1 });
  });

  it("InboxConsumer from @outlet/outbox works over the Kysely UoW and inbox", async () => {
    const consumer = new InboxConsumer({
      uow: f.runner.unitOfWork({ process: "outbox.consumer", session: { userId: null, role: "system" } }),
      inbox: f.inbox,
      clock: { now: () => new Date(f.clock.nowMs()) },
    });
    let handled = 0;
    const msg = "0192f3a4-5b6c-7d8e-9f01-0000000000c1";
    const run = () => consumer.consume({ consumer: "ref.c", messageId: msg, handler: async () => void (handled += 1) });
    expect(await run()).toBe("processed");
    expect(await run()).toBe("duplicate");
    expect(handled).toBe(1);
  });
});

describe("RLS through the unit of work", () => {
  it("a customer sees only their own consent history; a foreign owner sees nothing", async () => {
    const own = await f.runner.run({ session: { userId: USER_A, role: "customer" }, process: "privacy.consent_read" }, (tx) =>
      store.historyCount(tx, "user", USER_A),
    );
    expect(own).toBeGreaterThanOrEqual(1);
    const foreign = await f.runner.run({ session: { userId: USER_B, role: "customer" }, process: "privacy.consent_read" }, (tx) =>
      store.historyCount(tx, "user", USER_A),
    );
    expect(foreign).toBe(0);
  });

  it("anonymous session (no identity) is denied everything", async () => {
    const rows = await f.runner.run({ process: "privacy.consent_read" }, (tx) => tx.db.selectFrom("users").select("id").execute());
    expect(rows).toHaveLength(0);
  });

  it("users table: customer sees only self", async () => {
    const rows = await f.runner.run({ session: { userId: USER_A, role: "customer" }, process: "auth.user_read" }, (tx) =>
      tx.db.selectFrom("users").select("id").execute(),
    );
    expect(rows.map((r) => r.id)).toEqual([USER_A]);
  });

  it("a customer cannot write a consent row for another subject (WITH CHECK)", async () => {
    const before = await counts();
    await expect(
      f.runner.run({ session: { userId: USER_A, role: "customer" }, process: "privacy.consent_change" }, (tx) =>
        store.append(tx, { ...change(USER_B), at: new Date(f.clock.nowMs()) }),
      ),
    ).rejects.toThrow(/row-level security/);
    expect(await counts()).toEqual(before);
  });

  it("the elevated system role used for outbox appends does not leak to later statements", async () => {
    const role = await f.runner.run({ session: { userId: USER_A, role: "customer" }, process: "a.b" }, async (tx) => {
      await tx.emit({ aggregateType: "t", aggregateId: USER_A, eventType: "t.happened", payload: {} });
      const r = await sql<{ r: string }>`SELECT current_setting('app.role') AS r`.execute(tx.db);
      return r.rows[0]?.r;
    });
    expect(role).toBe("customer");
  });
});

describe("session configuration", () => {
  it("tags application_name, statement_timeout and identity, and does not leak after commit", async () => {
    const inside = await f.runner.run(
      { session: { userId: USER_A, role: "customer" }, process: "checkout.reserve", profile: "reserve" },
      async (tx) => {
        const r = await sql<{ an: string; st: string; uid: string; role: string; cur: string }>`
          SELECT current_setting('application_name') AS an, current_setting('statement_timeout') AS st,
                 current_setting('app.user_id') AS uid, current_setting('app.role') AS role, current_user AS cur`.execute(tx.db);
        return r.rows[0];
      },
    );
    expect(inside).toEqual({ an: "checkout.reserve", st: "2s", uid: USER_A, role: "customer", cur: "app_user" });
    const after = await f.raw.query<{ an: string; uid: string | null }>(
      "SELECT current_setting('application_name') AS an, current_setting('app.user_id', true) AS uid",
    );
    expect(after.rows[0]?.an).not.toBe("checkout.reserve");
    expect(after.rows[0]?.uid ?? "").toBe("");
  });

  it("app_user cannot UPDATE an immutable table even with a staff role", async () => {
    await expect(
      f.runner.run({ session: { userId: USER_A, role: "dpo" }, process: "privacy.consent_change" }, (tx) =>
        sql`UPDATE consent_records SET granted = true`.execute(tx.db),
      ),
    ).rejects.toThrow(/permission denied|append-only/);
  });
});

describe("outbox store (relay side)", () => {
  it("claims due events in order, hides a blocked ordering key, supports DLQ and replay", async () => {
    const t0 = new Date(f.clock.nowMs() + 10_000_000);
    const emit = (agg: string) =>
      f.runner.run({ session: { userId: null, role: "system" }, process: "outbox.test" }, (tx) =>
        tx.emit({ aggregateType: "relay_test", aggregateId: agg, eventType: "relay_test.happened", payload: { n: 1 } }),
      );
    const a1 = await emit("0192f3a4-5b6c-7d8e-9f01-00000000f001");
    f.clock.advance(1);
    const a2 = await emit("0192f3a4-5b6c-7d8e-9f01-00000000f001");
    f.clock.advance(1);
    const b1 = await emit("0192f3a4-5b6c-7d8e-9f01-00000000f002");

    const due = (await f.outbox.claimDue(t0, 100)).filter((r) => r.aggregateType === "relay_test");
    expect(due.map((r) => r.id)).toEqual([a1.id, a2.id, b1.id]);

    // dead-letter the head of key A: a2 is withheld, b1 is not
    await f.outbox.deadLetter(a1.id, { error: "perm", attempts: 5, at: t0 });
    const afterDlq = (await f.outbox.claimDue(t0, 100)).filter((r) => r.aggregateType === "relay_test");
    expect(afterDlq.map((r) => r.id)).toEqual([b1.id]);
    expect((await f.outbox.listDeadLettered(10)).map((r) => r.id)).toContain(a1.id);

    await f.outbox.replay(a1.id, t0);
    const replayed = (await f.outbox.claimDue(t0, 100)).filter((r) => r.aggregateType === "relay_test");
    expect(replayed.map((r) => r.id)).toEqual([a1.id, a2.id, b1.id]);

    // failure schedules the retry in the future
    await f.outbox.recordFailure(b1.id, { error: "x", attempts: 1, nextAttemptAt: new Date(t0.getTime() + 60_000) });
    expect((await f.outbox.claimDue(t0, 100)).map((r) => r.id)).not.toContain(b1.id);
    expect((await f.outbox.claimDue(new Date(t0.getTime() + 60_000), 100)).map((r) => r.id)).toContain(b1.id);

    await f.outbox.markPublished(a1.id, t0);
    expect((await f.outbox.claimDue(t0, 100)).map((r) => r.id)).not.toContain(a1.id);

    await expect(f.outbox.replay(a2.id, t0)).rejects.toThrow(/not dead-lettered/);
    await expect(f.outbox.markPublished("0192f3a4-5b6c-7d8e-9f01-ffffffffffff", t0)).rejects.toThrow(/unknown/);
  });

  it("a duplicate event id raises DuplicateOutboxEventError", async () => {
    const id = "0192f3a4-5b6c-7d8e-9f01-00000000d0d0";
    const rec = {
      id, occurredAt: new Date(f.clock.nowMs()), aggregateType: "dup", aggregateId: USER_A, eventType: "dup.happened",
      eventVersion: 1, orderingKey: null, payload: {}, headers: {}, publishedAt: null, publishAttempts: 0,
      lastError: null, nextAttemptAt: null, deadLetteredAt: null,
    };
    const append = () =>
      f.runner.run({ session: { userId: null, role: "system" }, process: "outbox.test" }, (tx) => f.outbox.append(tx, rec));
    await append();
    await expect(append()).rejects.toThrow(/already exists/);
  });
});

describe("schema", () => {
  it("hand-written column maps match information_schema (drift check)", async () => {
    for (const [table, cols] of Object.entries(PLATFORM_COLUMNS)) {
      const r = await f.raw.query<{ column_name: string }>(
        "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1",
        [table],
      );
      expect(r.rows.map((x) => x.column_name).sort(), table).toEqual(Object.keys(cols).sort());
    }
  });

  it("toBigInt coerces driver int8 values and refuses unsafe numbers", () => {
    expect(toBigInt("9007199254740993")).toBe(9007199254740993n);
    expect(toBigInt(5)).toBe(5n);
    expect(() => toBigInt(2 ** 60)).toThrow(RangeError);
  });
});
