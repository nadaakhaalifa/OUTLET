import { afterAll, describe, expect, it } from "vitest";
import { createTestDatabaseUpTo } from "@outlet/db";
import type { Kysely } from "kysely";
import { createPgliteDatabase, type PgliteInstance } from "../../../platform/db";
import { KyselyPaymentStore, type PaymentsDb } from "../adapters/kysely-store";
import { TestClock, intentRecord, nextId, rawRecord, SHOPPER_A } from "./fixtures";
import { describePaymentStoreContract } from "./store-contract";

const open: Kysely<Record<string, never>>[] = [];

const freshDb = async () => {
  const raw = await createTestDatabaseUpTo(32);
  const db: PaymentsDb = createPgliteDatabase<Record<string, never>>(raw as unknown as PgliteInstance);
  open.push(db);
  const clock = new TestClock();
  return { raw, clock, store: new KyselyPaymentStore(db, clock, nextId) };
};

afterAll(async () => {
  await Promise.all(open.map((d) => d.destroy()));
});

describePaymentStoreContract("kysely/pglite", async () => {
  const { raw, store } = await freshDb();
  return {
    store,
    ensureUser: async (id) => {
      await raw.query(`insert into users (id, status) values ($1, 'active') on conflict do nothing`, [id]);
    },
    outboxTypes: async () =>
      (await raw.query<{ t: string }>(`select event_type as t from outbox_events order by occurred_at, id`)).rows.map((r) => r.t),
  };
});

describe("KyselyPaymentStore specifics", () => {
  it("rolls the state change back with its outbox when an event row is rejected by the database", async () => {
    const { raw, store } = await freshDb();
    await raw.query(`insert into users (id, status) values ($1, 'active')`, [SHOPPER_A]);
    const i = intentRecord({ status: "REQUIRES_ACTION", providerRef: "pi_rb" });
    await store.insertIntent(i, []);
    await expect(
      store.mutateIntent({
        intentId: i.id,
        decide: (cur) => ({
          patch: { status: "AUTHORIZED" },
          // aggregate id is not a uuid: the outbox insert fails after the intent update
          events: [{ type: "payment.anomaly", intentId: "not-a-uuid", orderGroupId: cur.orderGroupId, anomaly: "late_success", detail: "x" }],
          outcome: "x",
        }),
      }),
    ).rejects.toThrow();
    expect((await store.getIntent(i.id))?.status).toBe("REQUIRES_ACTION");
  });

  it("rolls the inbox claim back with a failing transaction so the message can be retried", async () => {
    const { raw, store } = await freshDb();
    await raw.query(`insert into users (id, status) values ($1, 'active')`, [SHOPPER_A]);
    const i = intentRecord({ status: "REQUIRES_ACTION", providerRef: "pi_rb2" });
    await store.insertIntent(i, []);
    const inbox = { consumer: "payments.webhook_received", messageId: "00000000-0000-4000-9000-0000000000aa" };
    await expect(
      store.mutateIntent({
        intentId: i.id,
        inbox,
        decide: () => {
          throw new Error("boom");
        },
      }),
    ).rejects.toThrow("boom");
    const again = await store.mutateIntent({ intentId: i.id, inbox, decide: () => null });
    expect(again.kind).toBe("applied");
  });

  it("payment_events_raw bodies are immutable and undeletable at the database", async () => {
    const { raw, store } = await freshDb();
    const r = rawRecord();
    await store.recordRawEvent(r);
    await expect(raw.query(`update payment_events_raw set body = '{}'::jsonb where id = $1`, [r.id])).rejects.toThrow(/immutable/);
    await expect(raw.query(`delete from payment_events_raw where id = $1`, [r.id])).rejects.toThrow(/never deleted/);
  });
});
