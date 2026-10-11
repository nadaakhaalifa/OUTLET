import { sql, type Kysely } from "kysely";
import { z } from "zod";
import type { AuditRecord, AuditStore, TokenUsageStore } from "../domain/types";

export type GatewayDb = Kysely<Record<string, never>>;

const Row = z.object({
  id: z.string(),
  feature: z.string(),
  prompt_id: z.string(),
  prompt_hash: z.string(),
  model: z.string(),
  tokens_in: z.number().int(),
  tokens_out: z.number().int(),
  latency_ms: z.number().int(),
  outcome: z.enum(["ok", "cached", "invalid_output", "provider_error", "timeout", "blocked"]),
  at_ms: z.string().regex(/^\d+$/).transform(Number),
});

const asSystem = async <T>(db: GatewayDb, run: (trx: GatewayDb) => Promise<T>): Promise<T> =>
  db.transaction().execute(async (trx) => {
    await sql`select set_config('app.role', 'system', true)`.execute(trx);
    return run(trx as unknown as GatewayDb);
  });

/** Append only audit of hashes and counters. There is nowhere to put prompt text. */
export class KyselyAuditStore implements AuditStore {
  constructor(private readonly db: GatewayDb) {}

  async record(r: AuditRecord): Promise<void> {
    await asSystem(this.db, async (trx) => {
      await sql`
        insert into llm_audit_log (id, feature, prompt_id, prompt_hash, model, tokens_in, tokens_out, latency_ms, outcome, occurred_at)
        values (${r.id}::uuid, ${r.feature}, ${r.promptId}, ${r.promptHash}, ${r.model}, ${r.tokensIn}, ${r.tokensOut},
                ${r.latencyMs}, ${r.outcome}, to_timestamp(${r.atMs}::double precision / 1000))`.execute(trx);
    });
  }

  async list(feature: string, limit: number): Promise<readonly AuditRecord[]> {
    return asSystem(this.db, async (trx) => {
      const res = await sql`
        select id::text as id, feature, prompt_id, prompt_hash, model, tokens_in, tokens_out, latency_ms, outcome,
               floor(extract(epoch from occurred_at) * 1000)::text as at_ms
        from llm_audit_log where feature = ${feature}
        order by occurred_at desc, id desc limit ${limit}`.execute(trx);
      return res.rows.map((raw) => {
        const r = Row.parse(raw);
        return {
          id: r.id,
          feature: r.feature,
          promptId: r.prompt_id,
          promptHash: r.prompt_hash,
          model: r.model,
          tokensIn: r.tokens_in,
          tokensOut: r.tokens_out,
          latencyMs: r.latency_ms,
          outcome: r.outcome,
          atMs: r.at_ms,
        };
      });
    });
  }
}

export class KyselyTokenUsage implements TokenUsageStore {
  constructor(private readonly db: GatewayDb) {}

  async used(userId: string, day: string, feature: string): Promise<number> {
    return asSystem(this.db, async (trx) => {
      const res = await sql`
        select tokens::text as tokens from llm_token_usage
        where user_id = ${userId}::uuid and day = ${day}::date and feature = ${feature}`.execute(trx);
      const row = res.rows[0];
      return row === undefined ? 0 : Number(z.object({ tokens: z.string() }).parse(row).tokens);
    });
  }

  async add(userId: string, day: string, feature: string, tokens: number): Promise<void> {
    await asSystem(this.db, async (trx) => {
      await sql`
        insert into llm_token_usage (user_id, day, feature, tokens)
        values (${userId}::uuid, ${day}::date, ${feature}, ${tokens})
        on conflict (user_id, day, feature) do update set tokens = llm_token_usage.tokens + excluded.tokens`.execute(trx);
    });
  }
}
