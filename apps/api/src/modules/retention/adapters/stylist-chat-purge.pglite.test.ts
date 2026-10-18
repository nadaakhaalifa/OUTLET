import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { KyselyPurgeExecutor, type RetentionDb } from "./kysely-store";
import { TARGETS } from "../domain/catalog";
import { createFullDatabase, type PgliteLike } from "../test/pglite-db";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const NOW = Date.UTC(2026, 9, 12, 1, 0, 0);
const DAY = 86_400_000;
const ago = (days: number): string => new Date(NOW - days * DAY).toISOString();
let pg: PgliteLike;
let db: RetentionDb;
let seq = 0;
const uuid = (): string => `00000000-0000-7000-8000-${String(++seq).padStart(12, "0")}`;
const q = async <T>(sql: string, params: unknown[] = []): Promise<T[]> => (await pg.query<T>(sql, params)).rows;
const n = async (sql: string): Promise<number> => Number((await q<{ n: string }>(sql))[0]?.n);
const target = (id: string) => {
  const t = TARGETS.find((x) => x.id === id);
  if (t === undefined) throw new Error(id);
  return t;
};
// The retention rules' effective cutoff for a 2 year rule is now - 2 years; the text target is shifted to 30 days.
const cutoff2y = NOW - 2 * 365 * DAY;

beforeAll(async () => {
  ({ pg, db } = await createFullDatabase());
});
afterAll(async () => {
  await db.destroy();
});

describe("stylist chat retention targets against the real schema", () => {
  it("nullifies turn text older than 30 days only, keeps the row and newer text", async () => {
    const u = uuid();
    const s = uuid();
    await q(`insert into users (id, status) values ($1,'active')`, [u]);
    await q(`insert into stylist_chat_sessions (id, user_id, state, history_enabled) values ($1,$2,'{}'::jsonb,true)`, [s, u]);
    const t = (seqNo: number, text: string, at: string) =>
      q(`insert into stylist_chat_turns (id, session_id, user_id, seq, role, text, created_at) values ($1,$2,$3,$4,'user',$5,$6)`, [uuid(), s, u, seqNo, text, at]);
    await t(1, "old", ago(45));
    await t(2, "recent", ago(10));
    const ex = new KyselyPurgeExecutor(db);
    // The catalog age expression is "created_at - (2y - 30d)"; the rule's cutoff is now - 2y.
    const tg = target("stylist_chat_turns.text");
    expect((await ex.count(tg, cutoff2y)).eligible).toBe(1);
    expect(await ex.purgeBatch(tg, cutoff2y, 100)).toBe(1);
    expect(await n(`select count(*)::text n from stylist_chat_turns where session_id='${s}'`)).toBe(2);
    expect(await n(`select count(*)::text n from stylist_chat_turns where session_id='${s}' and text is not null`)).toBe(1);
  });

  it("deletes sessions idle for more than 2 years with their turns; a legal hold keeps them", async () => {
    const u = uuid();
    const held = uuid();
    await q(`insert into users (id, status) values ($1,'active'), ($2,'active')`, [u, held]);
    await q(`insert into retention_legal_holds (id, subject_type, subject_id, reason, placed_at) values ($1,'user',$2,'case', now())`, [uuid(), held]);
    const mk = async (user: string, at: string) => {
      const s = uuid();
      await q(`insert into stylist_chat_sessions (id, user_id, state, history_enabled, updated_at) values ($1,$2,'{}'::jsonb,false,$3)`, [s, user, at]);
      await q(`insert into stylist_chat_turns (id, session_id, user_id, seq, role) values ($1,$2,$3,1,'user')`, [uuid(), s, user]);
      return s;
    };
    const old = await mk(u, ago(800));
    const fresh = await mk(u, ago(30));
    const heldOld = await mk(held, ago(800));
    const ex = new KyselyPurgeExecutor(db);
    const tg = target("stylist_chat_sessions.old");
    expect(await ex.purgeBatch(tg, cutoff2y, 100)).toBe(1);
    expect(await n(`select count(*)::text n from stylist_chat_sessions where id='${old}'`)).toBe(0);
    expect(await n(`select count(*)::text n from stylist_chat_turns where session_id='${old}'`)).toBe(0);
    expect(await n(`select count(*)::text n from stylist_chat_sessions where id in ('${fresh}','${heldOld}')`)).toBe(2);
  });

  it("drops quota counters older than the technical window", async () => {
    const u = uuid();
    await q(`insert into users (id, status) values ($1,'active')`, [u]);
    await q(`insert into stylist_chat_quota (user_id, day, turns) values ($1, $2::date, 3), ($1, $3::date, 1)`, [u, ago(90).slice(0, 10), ago(1).slice(0, 10)]);
    const ex = new KyselyPurgeExecutor(db);
    expect(await ex.purgeBatch(target("stylist_chat_quota.old"), NOW - 30 * DAY, 100)).toBe(1);
    expect(await n(`select count(*)::text n from stylist_chat_quota where user_id='${u}'`)).toBe(1);
  });
});
