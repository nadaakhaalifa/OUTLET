import { afterAll, describe, expect, it } from "vitest";
import { createDropsDatabase } from "../test/pglite-db";
import { DEV, T0, U, describeAdmissionStoreContract, rec } from "../test/store-contract";
import { KyselyAdmissionStore, type WaitingRoomDb } from "./kysely-admission-store";

const open: WaitingRoomDb[] = [];
let seq = 0;
const ids = { uuidV7: (): string => `00000000-0000-7000-8000-${String(++seq).padStart(12, "0")}`, hex: (): string => "ab" };

afterAll(async () => {
  await Promise.all(open.map((d) => d.destroy()));
});

const fresh = async () => {
  const { pg, db } = await createDropsDatabase();
  open.push(db);
  return {
    pg,
    store: new KyselyAdmissionStore(db, ids),
    ensureDrop: async (id: string) => {
      await pg.query(
        `insert into drops (id, store_id, type, state, title, starts_at, ends_at, admit_per_sec, limits)
         values ($1, $2, 'public', 'LIVE', 'Test drop', now(), now() + interval '1 hour', 10, '{"per_user":1,"per_device":1}'::jsonb)
         on conflict do nothing`,
        [id, U(9001)],
      );
    },
    ensureUser: async (id: string) => {
      await pg.query(`insert into users (id, status) values ($1, 'active') on conflict do nothing`, [id]);
    },
    eventTypes: async () => (await pg.query<{ event_type: string }>(`select event_type from outbox_events order by id`)).rows.map((r) => r.event_type),
  };
};

describeAdmissionStoreContract("kysely/pglite", fresh);

describe("waiting-room tables", () => {
  it("outbox payload has ids only, no device hash", async () => {
    const c = await fresh();
    await c.ensureDrop(U(100));
    await c.ensureUser(U(1));
    await c.store.recordAdmission(rec(1), [{ type: "queue.admitted", dropId: U(100), ticketId: U(301), waitedMs: 1 }]);
    const r = await c.pg.query<{ payload: unknown }>(`select payload from outbox_events`);
    expect(JSON.stringify(r.rows)).not.toContain(DEV(1));
    expect(JSON.stringify(r.rows)).not.toContain(U(1));
  });

  it("device hashes are stored hashed-length only (64 chars)", async () => {
    const c = await fresh();
    await c.ensureDrop(U(100));
    await c.ensureUser(U(1));
    await expect(c.store.recordAdmission(rec(1, { deviceHash: "raw-device-id" }), [])).rejects.toThrow();
  });

  it("an admission persists the ticket audit row and the token row together", async () => {
    const c = await fresh();
    await c.ensureDrop(U(100));
    await c.ensureUser(U(1));
    await c.store.recordAdmission(rec(1, { issuedAtMs: T0, expiresAtMs: T0 + 900_000 }), []);
    expect((await c.pg.query(`select 1 from queue_tickets where state = 'admitted'`)).rows).toHaveLength(1);
    expect((await c.pg.query(`select 1 from admission_tokens`)).rows).toHaveLength(1);
  });
});
