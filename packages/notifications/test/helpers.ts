import type { SqlClient } from "@outlet/db";
import { createTestClient, roleClient } from "@outlet/db/testing";
import { uuidv7 } from "@outlet/ids";
import { createLogger } from "@outlet/logger";
import { OutboxWriter, pgTransactionalWriter } from "@outlet/outbox";
import type { OutboxEvent } from "@outlet/outbox";
import { ConsentService } from "@outlet/privacy";
import { Dispatcher } from "../src/index.js";
import type { Channel, ChannelPort, DispatcherDeps } from "../src/index.js";
import { FakeChannel, FakeKillSwitch } from "../src/testing.js";

export const NOON = Date.UTC(2026, 10, 8, 10, 0, 0); // 12:00 Cairo (UTC+2)

export interface Env {
  client: SqlClient;
  close: () => Promise<void>;
  clock: { t: number };
  logs: string[];
  kill: FakeKillSwitch;
  fakes: Record<Channel, FakeChannel>;
  outbox: OutboxWriter;
  dispatcher: (over?: Partial<DispatcherDeps>) => Dispatcher;
}

export const setupEnv = async (scripts: Partial<Record<Channel, readonly ("ok" | "template_rejected" | "no_destination" | "provider_error" | "rate_limited")[]>> = {}): Promise<Env> => {
  const { client, close } = await createTestClient();
  const clock = { t: NOON };
  const logs: string[] = [];
  const kill = new FakeKillSwitch();
  const fakes = Object.fromEntries((["push", "in_app", "whatsapp", "sms", "email"] as const).map((c) => [c, new FakeChannel(`fake-${c}`, scripts[c])])) as Record<Channel, FakeChannel>;
  const outbox = new OutboxWriter(pgTransactionalWriter);
  const dispatcher = (over: Partial<DispatcherDeps> = {}): Dispatcher =>
    new Dispatcher({
      db: roleClient(client, "outlet_worker"),
      outbox,
      channels: Object.fromEntries(Object.entries(fakes).map(([k, v]) => [k, [v as ChannelPort]])) as Record<Channel, ChannelPort[]>,
      killSwitch: kill,
      consentFor: (db) => new ConsentService({ db, outbox }),
      logger: createLogger({ write: (l) => logs.push(l), level: "debug" }),
      now: () => new Date(clock.t),
      random: () => 0,
      ...over,
    });
  return { client, close, clock, logs, kill, fakes, outbox, dispatcher };
};

export const insertUser = async (db: SqlClient, locale = "ar-EG", market = "EG"): Promise<string> => {
  const id = uuidv7();
  await db.query("INSERT INTO users (id, market_id, locale, created_at, updated_at) VALUES ($1,$2,$3,now(),now())", [id, market, locale]);
  return id;
};

export const event = (type: string, userId: string | undefined, payload: Record<string, unknown> = {}, market = "EG"): OutboxEvent => ({
  id: uuidv7(), type, aggregateType: "order_group", aggregateId: uuidv7(), marketId: market, occurredAt: new Date(NOON).toISOString(), visibility: "internal",
  payload: { ...(userId === undefined ? {} : { user_id: userId }), ...payload },
});

export const logRows = async (db: SqlClient, userId: string): Promise<{ channel: string; status: string; suppression_reason: string | null; provider: string | null; error_code: string | null; category: string; scheduled_for: Date; attempts: number }[]> =>
  (await db.query<{ channel: string; status: string; suppression_reason: string | null; provider: string | null; error_code: string | null; category: string; scheduled_for: Date; attempts: number }>(
    "SELECT channel, status, suppression_reason, provider, error_code, category, scheduled_for, attempts FROM notification_log WHERE user_id = $1 ORDER BY created_at, id", [userId])).rows;
