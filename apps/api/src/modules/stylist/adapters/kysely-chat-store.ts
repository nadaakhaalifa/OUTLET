import { sql, type Kysely } from "kysely";
import { z } from "zod";
import { ChatStateSchema, StoredBlockSchema } from "../domain/chat";
import type { AppendExchange, ChatEvent, ChatSessionRecord, ChatTurnRecord, StylistChatStore } from "../domain/chat-ports";
import type { IdPort } from "../domain/ports";

/** Raw SQL with Zod validated rows, as in the stylist and reviews adapters. */
export type ChatDb = Kysely<Record<string, never>>;

const Int = z.string().regex(/^-?\d+$/);
const SessionRow = z.object({
  id: z.string(),
  user_id: z.string(),
  state: ChatStateSchema,
  history_enabled: z.boolean(),
  created_ms: Int,
  updated_ms: Int,
});
const TurnRow = z.object({
  id: z.string(),
  session_id: z.string(),
  user_id: z.string(),
  seq: z.number().int(),
  role: z.enum(["user", "assistant"]),
  client_message_id: z.string().nullable(),
  text: z.string().nullable(),
  reply_code: z.string().nullable(),
  blocks: z.array(StoredBlockSchema),
  intent: z.string().nullable(),
  source: z.enum(["llm", "rules"]).nullable(),
  prompt_hash: z.string().nullable(),
  tokens_in: z.number().int(),
  tokens_out: z.number().int(),
  tool_calls: z.array(z.string()),
  created_ms: Int,
});

const EPOCH_MS = (col: string) => sql.raw(`floor(extract(epoch from ${col}) * 1000)::text`);
const SESSION_COLS = sql`id::text as id, user_id::text as user_id, state, history_enabled,
  ${EPOCH_MS("created_at")} as created_ms, ${EPOCH_MS("updated_at")} as updated_ms`;
const TURN_COLS = sql`id::text as id, session_id::text as session_id, user_id::text as user_id, seq, role,
  client_message_id::text as client_message_id, text, reply_code, blocks, intent, source, prompt_hash,
  tokens_in, tokens_out, tool_calls, ${EPOCH_MS("created_at")} as created_ms`;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const toSession = (raw: unknown): ChatSessionRecord => {
  const r = SessionRow.parse(raw);
  return { id: r.id, userId: r.user_id, state: r.state, historyEnabled: r.history_enabled, createdAtMs: Number(r.created_ms), updatedAtMs: Number(r.updated_ms) };
};
const toTurn = (raw: unknown): ChatTurnRecord => {
  const r = TurnRow.parse(raw);
  return {
    id: r.id,
    sessionId: r.session_id,
    userId: r.user_id,
    seq: r.seq,
    role: r.role,
    clientMessageId: r.client_message_id,
    text: r.text,
    replyCode: r.reply_code,
    blocks: r.blocks,
    intent: r.intent,
    source: r.source,
    promptHash: r.prompt_hash,
    tokensIn: r.tokens_in,
    tokensOut: r.tokens_out,
    toolCalls: r.tool_calls,
    createdAtMs: Number(r.created_ms),
  };
};

const isUniqueViolation = (e: unknown): boolean => {
  if (typeof e !== "object" || e === null) return false;
  const o = e as { readonly code?: unknown; readonly message?: unknown };
  return o.code === "23505" || (typeof o.message === "string" && o.message.includes("duplicate key"));
};

class Duplicate extends Error {}
class QuotaFull extends Error {}

function aggregateOf(e: ChatEvent): { type: string; id: string } {
  switch (e.type) {
    case "stylist_chat.turn":
    case "stylist_chat.refusal":
    case "chat.session_deleted":
      return { type: "stylist_chat_session", id: e.sessionId };
    case "stylist.injection_detected":
      return { type: "stylist_chat_session", id: e.sessionId ?? e.userId };
    case "stylist_chat.history_changed":
      return { type: "stylist_chat_session", id: e.userId };
  }
}

export class KyselyStylistChatStore implements StylistChatStore {
  constructor(
    private readonly db: ChatDb,
    private readonly ids: IdPort,
  ) {}

  private async tx<T>(run: (trx: ChatDb) => Promise<T>): Promise<T> {
    return this.db.transaction().execute(async (trx) => {
      await sql`select set_config('app.role', 'system', true)`.execute(trx);
      return run(trx as unknown as ChatDb);
    });
  }

  private async writeEvents(trx: ChatDb, events: readonly ChatEvent[]): Promise<void> {
    for (const e of events) {
      const agg = aggregateOf(e);
      await sql`
        insert into outbox_events (id, aggregate_type, aggregate_id, event_type, ordering_key, payload)
        values (${this.ids.uuidV7()}::uuid, ${agg.type}, ${agg.id}::uuid, ${e.type},
                ${`${agg.type}:${agg.id}`}, ${JSON.stringify(e)}::jsonb)`.execute(trx);
    }
  }

  async createSession(s: ChatSessionRecord): Promise<void> {
    await this.tx(async (trx) => {
      await sql`
        insert into stylist_chat_sessions (id, user_id, state, history_enabled, created_at, updated_at)
        values (${s.id}::uuid, ${s.userId}::uuid, ${JSON.stringify(s.state)}::jsonb, ${s.historyEnabled},
                to_timestamp(${s.createdAtMs}::double precision / 1000), to_timestamp(${s.updatedAtMs}::double precision / 1000))`.execute(trx);
    });
  }

  async getSession(id: string): Promise<ChatSessionRecord | null> {
    if (!UUID_RE.test(id)) return null;
    return this.tx(async (trx) => {
      const res = await sql`select ${SESSION_COLS} from stylist_chat_sessions where id = ${id}::uuid`.execute(trx);
      const row = res.rows[0];
      return row === undefined ? null : toSession(row);
    });
  }

  async listSessions(userId: string, limit: number): Promise<readonly ChatSessionRecord[]> {
    return this.tx(async (trx) => {
      const res = await sql`
        select ${SESSION_COLS} from stylist_chat_sessions where user_id = ${userId}::uuid
        order by updated_at desc, id desc limit ${limit}`.execute(trx);
      return res.rows.map(toSession);
    });
  }

  async appendExchange(x: AppendExchange): Promise<"stored" | "duplicate" | "quota_exceeded"> {
    try {
      return await this.tx(async (trx) => {
        // Serialises concurrent turns of one session, so seq numbers and the dedup check are race free.
        const lock = await sql`select id from stylist_chat_sessions where id = ${x.session.id}::uuid for update`.execute(trx);
        if (lock.rows.length === 0) throw new Error("session not found");
        const cid = x.userTurn.clientMessageId;
        if (cid !== null) {
          const dup = await sql`select 1 as one from stylist_chat_turns where session_id = ${x.session.id}::uuid and client_message_id = ${cid}::uuid`.execute(trx);
          if (dup.rows.length > 0) throw new Duplicate();
        }
        const q = await sql`
          insert into stylist_chat_quota (user_id, day, turns) values (${x.session.userId}::uuid, ${x.day}::date, 1)
          on conflict (user_id, day) do update set turns = stylist_chat_quota.turns + 1
            where stylist_chat_quota.turns < ${x.dailyLimit}
          returning turns`.execute(trx);
        if (q.rows.length === 0) throw new QuotaFull();
        const m = await sql`select coalesce(max(seq), 0)::int as n from stylist_chat_turns where session_id = ${x.session.id}::uuid`.execute(trx);
        const base = z.object({ n: z.number() }).parse(m.rows[0]).n;
        let seq = base;
        for (const t of [x.userTurn, x.assistantTurn]) {
          seq += 1;
          await sql`
            insert into stylist_chat_turns (id, session_id, user_id, seq, role, client_message_id, text, reply_code, blocks,
                                            intent, source, prompt_hash, tokens_in, tokens_out, tool_calls, created_at)
            values (${t.id}::uuid, ${t.sessionId}::uuid, ${t.userId}::uuid, ${seq}, ${t.role},
                    ${t.clientMessageId === null ? null : t.clientMessageId}::uuid, ${t.text}, ${t.replyCode},
                    ${JSON.stringify(t.blocks)}::jsonb, ${t.intent}, ${t.source}, ${t.promptHash}, ${t.tokensIn}, ${t.tokensOut},
                    ${JSON.stringify(t.toolCalls)}::jsonb, to_timestamp(${t.createdAtMs}::double precision / 1000))`.execute(trx);
        }
        await sql`
          update stylist_chat_sessions
          set state = ${JSON.stringify(x.session.state)}::jsonb, history_enabled = ${x.session.historyEnabled},
              updated_at = to_timestamp(${x.session.updatedAtMs}::double precision / 1000)
          where id = ${x.session.id}::uuid`.execute(trx);
        await this.writeEvents(trx, x.events);
        return "stored" as const;
      });
    } catch (e) {
      if (e instanceof Duplicate || isUniqueViolation(e)) return "duplicate";
      if (e instanceof QuotaFull) return "quota_exceeded";
      throw e;
    }
  }

  async findAnswer(sessionId: string, clientMessageId: string): Promise<ChatTurnRecord | null> {
    if (!UUID_RE.test(sessionId) || !UUID_RE.test(clientMessageId)) return null;
    return this.tx(async (trx) => {
      const res = await sql`
        select ${TURN_COLS} from stylist_chat_turns a
        where a.session_id = ${sessionId}::uuid and a.role = 'assistant'
          and a.seq = (select u.seq + 1 from stylist_chat_turns u
                       where u.session_id = ${sessionId}::uuid and u.client_message_id = ${clientMessageId}::uuid)`.execute(trx);
      const row = res.rows[0];
      return row === undefined ? null : toTurn(row);
    });
  }

  async listTurns(sessionId: string, limit: number): Promise<readonly ChatTurnRecord[]> {
    return this.tx(async (trx) => {
      const res = await sql`
        select ${TURN_COLS} from stylist_chat_turns where session_id = ${sessionId}::uuid order by seq limit ${limit}`.execute(trx);
      return res.rows.map(toTurn);
    });
  }

  async turnsOnDay(userId: string, day: string): Promise<number> {
    return this.tx(async (trx) => {
      const res = await sql`select turns from stylist_chat_quota where user_id = ${userId}::uuid and day = ${day}::date`.execute(trx);
      const row = res.rows[0];
      return row === undefined ? 0 : z.object({ turns: z.number() }).parse(row).turns;
    });
  }

  async deleteSession(id: string, userId: string, events: readonly ChatEvent[]): Promise<boolean> {
    if (!UUID_RE.test(id)) return false;
    return this.tx(async (trx) => {
      const res = await sql`delete from stylist_chat_sessions where id = ${id}::uuid and user_id = ${userId}::uuid returning id`.execute(trx);
      if (res.rows.length === 0) return false;
      await this.writeEvents(trx, events);
      return true;
    });
  }

  async getHistoryEnabled(userId: string): Promise<boolean> {
    return this.tx(async (trx) => {
      const res = await sql`select history_enabled from stylist_chat_settings where user_id = ${userId}::uuid`.execute(trx);
      const row = res.rows[0];
      return row === undefined ? false : z.object({ history_enabled: z.boolean() }).parse(row).history_enabled;
    });
  }

  async setHistoryEnabled(userId: string, enabled: boolean, atMs: number, events: readonly ChatEvent[]): Promise<void> {
    await this.tx(async (trx) => {
      await sql`
        insert into stylist_chat_settings (user_id, history_enabled, updated_at)
        values (${userId}::uuid, ${enabled}, to_timestamp(${atMs}::double precision / 1000))
        on conflict (user_id) do update set history_enabled = excluded.history_enabled, updated_at = excluded.updated_at`.execute(trx);
      if (!enabled) await sql`update stylist_chat_turns set text = null where user_id = ${userId}::uuid and text is not null`.execute(trx);
      await this.writeEvents(trx, events);
    });
  }

  async expireTexts(userId: string, beforeMs: number): Promise<number> {
    return this.tx(async (trx) => {
      const res = await sql`
        with c as (update stylist_chat_turns set text = null
                   where user_id = ${userId}::uuid and text is not null
                     and created_at < to_timestamp(${beforeMs}::double precision / 1000)
                   returning 1)
        select count(*)::text as n from c`.execute(trx);
      const row = res.rows[0];
      return row === undefined ? 0 : Number(z.object({ n: z.string() }).parse(row).n);
    });
  }

  async emit(events: readonly ChatEvent[]): Promise<void> {
    await this.tx((trx) => this.writeEvents(trx, events));
  }

  async eraseForUser(userId: string): Promise<void> {
    await this.tx(async (trx) => {
      await sql`delete from stylist_chat_sessions where user_id = ${userId}::uuid`.execute(trx);
      await sql`delete from stylist_chat_quota where user_id = ${userId}::uuid`.execute(trx);
      await sql`delete from stylist_chat_settings where user_id = ${userId}::uuid`.execute(trx);
    });
  }
}
