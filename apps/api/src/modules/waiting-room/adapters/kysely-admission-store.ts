import { sql, type Kysely } from "kysely";
import { z } from "zod";
import type {
  AdmissionRecord,
  AdmissionStore,
  EndedTicket,
  IdPort,
  WaitingRoomEvent,
} from "../domain/ports";

export type WaitingRoomDb = Kysely<Record<string, never>>;

const Ms = z.string().regex(/^-?\d+$/).transform((s) => Number(s));
const Row = z.object({
  jti: z.string(),
  ticket_id: z.string(),
  drop_id: z.string(),
  user_id: z.string(),
  device_hash: z.string(),
  issued_ms: Ms,
  expires_ms: Ms,
  used_ms: Ms.nullable(),
});
const iso = (ms: number): string => new Date(ms).toISOString();

const aggregateId = (e: WaitingRoomEvent): string => e.ticketId;

/** Postgres admission audit. One transaction per call, `system` role, outbox in the same tx. */
export class KyselyAdmissionStore implements AdmissionStore {
  constructor(
    private readonly db: WaitingRoomDb,
    private readonly ids: IdPort,
  ) {}

  private async tx<T>(run: (trx: WaitingRoomDb) => Promise<T>): Promise<T> {
    return this.db.transaction().execute(async (trx) => {
      await sql`select set_config('app.role', 'system', true)`.execute(trx);
      return run(trx as unknown as WaitingRoomDb);
    });
  }

  private async emit(trx: WaitingRoomDb, events: readonly WaitingRoomEvent[]): Promise<void> {
    for (const e of events) {
      await sql`
        insert into outbox_events (id, aggregate_type, aggregate_id, event_type, ordering_key, payload)
        values (${this.ids.uuidV7()}::uuid, 'queue_ticket', ${aggregateId(e)}::uuid, ${e.type},
                ${`drop:${e.dropId}`}, ${JSON.stringify(e)}::jsonb)`.execute(trx);
    }
  }

  async recordJoined(_dropId: string, _ticketId: string, events: readonly WaitingRoomEvent[]): Promise<void> {
    await this.tx((trx) => this.emit(trx, events));
  }

  async recordAdmission(r: AdmissionRecord, events: readonly WaitingRoomEvent[]): Promise<void> {
    await this.tx(async (trx) => {
      await sql`
        insert into queue_tickets (id, drop_id, user_id, device_hash, state, joined_at, ended_at)
        values (${r.ticketId}::uuid, ${r.dropId}::uuid, ${r.userId}::uuid, ${r.deviceHash}, 'admitted',
                ${iso(r.joinedAtMs)}::timestamptz, ${iso(r.issuedAtMs)}::timestamptz)
        on conflict (drop_id, user_id, joined_at) do nothing`.execute(trx);
      const ins = await sql<{ jti: string }>`
        insert into admission_tokens (jti, drop_id, user_id, device_hash, ticket_id, issued_at, expires_at)
        values (${r.jti}::uuid, ${r.dropId}::uuid, ${r.userId}::uuid, ${r.deviceHash}, ${r.ticketId}::uuid,
                ${iso(r.issuedAtMs)}::timestamptz, ${iso(r.expiresAtMs)}::timestamptz)
        on conflict (jti) do nothing returning jti::text as jti`.execute(trx);
      if (ins.rows[0] !== undefined) await this.emit(trx, events);
    });
  }

  async recordEnded(t: EndedTicket, events: readonly WaitingRoomEvent[]): Promise<void> {
    await this.tx(async (trx) => {
      const ins = await sql<{ id: string }>`
        insert into queue_tickets (id, drop_id, user_id, device_hash, state, joined_at, ended_at)
        values (${t.ticketId}::uuid, ${t.dropId}::uuid, ${t.userId}::uuid, ${t.deviceHash}, ${t.state},
                ${iso(t.joinedAtMs)}::timestamptz, ${iso(t.atMs)}::timestamptz)
        on conflict (id) do nothing returning id::text as id`.execute(trx);
      if (ins.rows[0] !== undefined) await this.emit(trx, events);
    });
  }

  async latestAdmission(dropId: string, userId: string): Promise<AdmissionRecord | null> {
    return this.tx(async (trx) => {
      const r = await sql<unknown>`
        select jti::text as jti, ticket_id::text as ticket_id, drop_id::text as drop_id, user_id::text as user_id,
               device_hash,
               (extract(epoch from issued_at) * 1000)::bigint::text as issued_ms,
               (extract(epoch from expires_at) * 1000)::bigint::text as expires_ms,
               (extract(epoch from used_at) * 1000)::bigint::text as used_ms
        from admission_tokens where drop_id = ${dropId}::uuid and user_id = ${userId}::uuid
        order by issued_at desc, jti desc limit 1`.execute(trx);
      const row = r.rows[0];
      if (row === undefined) return null;
      const p = Row.parse(row);
      const joined = await sql<{ j: string }>`
        select (extract(epoch from joined_at) * 1000)::bigint::text as j from queue_tickets where id = ${p.ticket_id}::uuid`.execute(trx);
      return {
        jti: p.jti,
        ticketId: p.ticket_id,
        dropId: p.drop_id,
        userId: p.user_id,
        deviceHash: p.device_hash,
        joinedAtMs: Number(joined.rows[0]?.j ?? p.issued_ms),
        issuedAtMs: p.issued_ms,
        expiresAtMs: p.expires_ms,
        usedAtMs: p.used_ms,
      };
    });
  }

  async consume(jti: string, nowMs: number): Promise<"used" | "already_used" | "unknown" | "expired"> {
    return this.tx(async (trx) => {
      const upd = await sql<{ jti: string }>`
        update admission_tokens set used_at = ${iso(nowMs)}::timestamptz
        where jti = ${jti}::uuid and used_at is null and expires_at > ${iso(nowMs)}::timestamptz
        returning jti::text as jti`.execute(trx);
      if (upd.rows[0] !== undefined) return "used";
      const cur = await sql<{ used: boolean; expired: boolean }>`
        select used_at is not null as used, expires_at <= ${iso(nowMs)}::timestamptz as expired
        from admission_tokens where jti = ${jti}::uuid`.execute(trx);
      const row = cur.rows[0];
      if (row === undefined) return "unknown";
      return row.used ? "already_used" : "expired";
    });
  }
}
