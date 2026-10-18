import { afterAll, describe, expect, it } from "vitest";
import { createStylistDatabase } from "../test/pglite-db";
import { U } from "../test/fixtures";
import { describeChatStoreContract, session, turns } from "../test/chat-store-contract";
import { KyselyStylistChatStore, type ChatDb } from "./kysely-chat-store";

const open: ChatDb[] = [];
let seq = 0;
const ids = { uuidV7: (): string => `00000000-0000-7000-8000-${String(++seq).padStart(12, "0")}` };

afterAll(async () => {
  await Promise.all(open.map((d) => d.destroy()));
});

const fresh = async () => {
  const { pg, db } = await createStylistDatabase();
  open.push(db);
  return {
    pg,
    store: new KyselyStylistChatStore(db, ids),
    ensureUser: async (id: string) => {
      await pg.query(`insert into users (id, status) values ($1, 'active') on conflict do nothing`, [id]);
    },
    eventTypes: async () => (await pg.query<{ event_type: string }>(`select event_type from outbox_events order by id`)).rows.map((r) => r.event_type),
  };
};

describeChatStoreContract("kysely/pglite", fresh);

describe("migrations 0066 and 0067 constraints", () => {
  it("refuses assistant text and a client message id on an assistant turn", async () => {
    const c = await fresh();
    await c.ensureUser(U(1));
    const s = session(1, U(1));
    await c.store.createSession(s);
    const t = turns(s, "0192f3a4-5b6c-7d8e-9f01-000000000001", null);
    await expect(
      c.store.appendExchange({
        session: s,
        userTurn: t.user,
        assistantTurn: { ...t.assistant, text: "the dress costs 5 EGP" },
        day: "2026-10-12",
        dailyLimit: 30,
        events: [],
      }),
    ).rejects.toThrow();
    // The failed transaction left nothing behind, including the quota counter.
    expect(await c.store.turnsOnDay(U(1), "2026-10-12")).toBe(0);
    expect(await c.store.listTurns(s.id, 10)).toEqual([]);
  });

  it("has no price column and RLS enabled on all four tables", async () => {
    const c = await fresh();
    const cols = await c.pg.query<{ column_name: string }>(
      `select column_name from information_schema.columns where table_name in ('stylist_chat_sessions','stylist_chat_turns','stylist_chat_settings','stylist_chat_quota')`,
    );
    expect(cols.rows.map((r) => r.column_name).filter((n) => /price|piastre|amount/i.test(n))).toEqual([]);
    const rls = await c.pg.query<{ relname: string; relrowsecurity: boolean }>(
      `select relname, relrowsecurity from pg_class where relname in ('stylist_chat_sessions','stylist_chat_turns','stylist_chat_settings','stylist_chat_quota')`,
    );
    expect(rls.rows.length).toBe(4);
    expect(rls.rows.every((r) => r.relrowsecurity)).toBe(true);
  });
});
