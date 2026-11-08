import type { Queryable, SqlClient } from "@outlet/db";
import { createTestClient } from "@outlet/db/testing";
import { uuidv7 } from "@outlet/ids";
import { OutboxWriter, pgTransactionalWriter } from "@outlet/outbox";
import type { PrivacyDeps } from "../src/index.js";

export interface Env {
  client: SqlClient;
  close: () => Promise<void>;
  clock: { t: number };
  deps: PrivacyDeps;
}

export const T0 = Date.UTC(2026, 10, 8, 12, 0, 0);

export const setupEnv = async (): Promise<Env> => {
  const { client, close } = await createTestClient();
  const clock = { t: T0 };
  // Strictly increasing clock so "latest record" ordering is deterministic.
  const now = (): Date => {
    clock.t += 1;
    return new Date(clock.t);
  };
  return { client, close, clock, deps: { db: client, outbox: new OutboxWriter(pgTransactionalWriter), now, newId: uuidv7 } };
};

export const insertUser = async (db: Queryable, market = "EG"): Promise<string> => {
  const id = uuidv7();
  await db.query("INSERT INTO users (id, market_id, created_at, updated_at) VALUES ($1,$2,now(),now())", [id, market]);
  return id;
};

export const events = async (db: Queryable, type?: string): Promise<{ event_type: string; payload: Record<string, unknown> }[]> =>
  (
    await db.query<{ event_type: string; payload: Record<string, unknown> }>(
      "SELECT event_type, payload FROM outbox_events WHERE ($1::text IS NULL OR event_type = $1) ORDER BY occurred_at, id",
      [type ?? null],
    )
  ).rows;
