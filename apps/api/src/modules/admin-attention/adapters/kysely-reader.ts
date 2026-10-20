import { sql, type Kysely } from "kysely";
import { z } from "zod";
import type { AuditChainReader, ChainVerification, AdminRoleName } from "../domain/ports";

export type AuditReadDb = Kysely<Record<string, never>>;
const HEX = (b: unknown): string => (b instanceof Uint8Array ? Buffer.from(b).toString("hex") : String(b).replace(/^\\x/, ""));
const Problem = z.object({ seq: z.coerce.number(), problem: z.string().max(128) });
const Head = z.object({ seq: z.coerce.string(), hash: z.unknown() });

/**
 * Read-only: counts rows, reads the head and calls audit_log_verify(chain) (SECURITY DEFINER, STABLE).
 * Each call runs in a read-only transaction under the single `app.role` that satisfied the gate.
 */
export class KyselyAuditChainReader implements AuditChainReader {
  constructor(private readonly db: AuditReadDb, private readonly statementTimeoutMs = 10_000) {}

  private async withRole<T>(role: AdminRoleName, fn: (trx: AuditReadDb) => Promise<T>): Promise<T> {
    return this.db.transaction().execute(async (trx) => {
      await sql`set transaction read only`.execute(trx);
      await sql`select set_config('app.role', ${role}, true), set_config('statement_timeout', ${String(this.statementTimeoutMs)}, true)`.execute(trx);
      return fn(trx as unknown as AuditReadDb);
    });
  }

  async chainLength(chainId: string, role: AdminRoleName): Promise<number> {
    return this.withRole(role, async (trx) => {
      const r = await sql<{ n: string }>`select count(*)::text as n from audit_log where chain_id = ${chainId}`.execute(trx);
      return Number(r.rows[0]?.n ?? "0");
    });
  }

  async verify(chainId: string, role: AdminRoleName): Promise<ChainVerification> {
    return this.withRole(role, async (trx) => {
      const rows = await sql<{ n: string }>`select count(*)::text as n from audit_log where chain_id = ${chainId}`.execute(trx);
      const head = await sql`select seq::text as seq, hash from audit_log where chain_id = ${chainId} order by seq desc limit 1`.execute(trx);
      const cps = await sql<{ n: string }>`select count(*)::text as n from audit_chain_checkpoints where chain_id = ${chainId}`.execute(trx);
      const probs = await sql`select seq::text as seq, problem from audit_log_verify(${chainId}) order by seq limit 101`.execute(trx);
      const h = head.rows[0] === undefined ? null : Head.parse(head.rows[0]);
      return {
        rowsChecked: Number(rows.rows[0]?.n ?? "0"),
        headSeq: h === null ? null : h.seq,
        headHash: h === null ? null : HEX(h.hash),
        checkpointsChecked: Number(cps.rows[0]?.n ?? "0"),
        problems: probs.rows.map((p) => Problem.parse(p)),
      };
    });
  }
}
