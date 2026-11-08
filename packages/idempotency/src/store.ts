import { z } from "zod";
import type { Queryable } from "./ports.js";

export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
/** How long an in-progress key blocks same-hash retries before a retry may take it over (crashed first request). */
export const IDEMPOTENCY_LEASE_MS = 60 * 1000;

export const storedResponseSchema = z.strictObject({
  status: z.number().int().min(100).max(599),
  body: z.json(),
  /** Sensitive responses (tokens): no body is persisted, only the status; a replay cannot be served (fail closed). */
  redacted: z.boolean().optional(),
});
export type StoredResponse = z.infer<typeof storedResponseSchema>;

export const beginInputSchema = z.strictObject({
  key: z.uuid(),
  route: z.string().min(1),
  actorId: z.uuid(),
  /** SHA-256 of the canonical request body (see requestHash). */
  requestHash: z.custom<Uint8Array>((h) => h instanceof Uint8Array && h.length === 32, "requestHash must be 32 bytes"),
});
const keySchema = z.object({ key: z.uuid(), route: z.string().min(1), actorId: z.uuid() });
export type BeginInput = z.input<typeof beginInputSchema>;

export type BeginResult =
  | { readonly kind: "fresh" }
  | { readonly kind: "replay"; readonly response: StoredResponse }
  /** Same key, different request body: the caller answers 422. */
  | { readonly kind: "conflict" }
  /** Same key and body, first request still running: the caller answers 409 + Retry-After. */
  | { readonly kind: "in_progress" };

interface Row {
  request_hash: Uint8Array;
  status: string;
  response_status: number | null;
  response_body: unknown;
}

/** What is persisted instead of a sensitive body. */
const REDACTED_MARKER = { response_redacted: true } as const;
const isRedacted = (body: unknown): boolean => typeof body === "object" && body !== null && (body as { response_redacted?: unknown }).response_redacted === true;

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((v, i) => v === b[i]);

/** Postgres-backed store. Framework-agnostic: call begin() before the handler and complete() after. */
export class IdempotencyStore {
  constructor(
    private readonly db: Queryable,
    private readonly now: () => Date = () => new Date(),
    private readonly ttlMs: number = IDEMPOTENCY_TTL_MS,
    private readonly leaseMs: number = IDEMPOTENCY_LEASE_MS,
  ) {}

  /**
   * One atomic upsert decides the race: the INSERT wins only if no live row exists (an expired row is
   * taken over), or if the row is still `in_progress` with an expired lease (`locked_until`) and the retry has the SAME
   * request hash: the first request crashed or hung, so the retry runs fresh instead of getting 409 until the 24 h expiry.
   * A different hash never takes over (422 stays). Two concurrent takeovers: the row lock plus the re-checked WHERE
   * (READ COMMITTED) let exactly one win; the loser sees a fresh lease and answers in_progress. The primary key (key, actor_id, route) makes concurrent first requests produce exactly one `fresh`.
   */
  async begin(input: BeginInput): Promise<BeginResult> {
    const { key, route, actorId, requestHash } = beginInputSchema.parse(input);
    const now = this.now();
    const won = await this.db.query(
      `INSERT INTO idempotency_keys (key, actor_id, route, request_hash, status, created_at, expires_at, locked_until)
       VALUES ($1, $2, $3, $4, 'in_progress', $5, $6, $7)
       ON CONFLICT (key, actor_id, route) DO UPDATE
         SET request_hash = EXCLUDED.request_hash, status = 'in_progress', response_status = NULL, response_body = NULL,
             created_at = EXCLUDED.created_at, expires_at = EXCLUDED.expires_at, locked_until = EXCLUDED.locked_until
         WHERE idempotency_keys.expires_at <= $5
            OR (idempotency_keys.status = 'in_progress' AND idempotency_keys.locked_until <= $5
                AND idempotency_keys.request_hash = EXCLUDED.request_hash)
       RETURNING key`,
      [key, actorId, route, requestHash, now.toISOString(), new Date(now.getTime() + this.ttlMs).toISOString(), new Date(now.getTime() + this.leaseMs).toISOString()],
    );
    if (won.rows.length > 0) return { kind: "fresh" };

    const { rows } = await this.db.query<Row>(
      "SELECT request_hash, status, response_status, response_body FROM idempotency_keys WHERE key=$1 AND actor_id=$2 AND route=$3",
      [key, actorId, route],
    );
    const row = rows[0];
    if (!row) return { kind: "in_progress" }; // purged between the two statements; caller retries
    if (!sameBytes(new Uint8Array(row.request_hash), requestHash)) return { kind: "conflict" };
    if (row.status !== "completed" || row.response_status === null) return { kind: "in_progress" };
    if (isRedacted(row.response_body)) return { kind: "replay", response: { status: row.response_status, body: null, redacted: true } };
    return { kind: "replay", response: storedResponseSchema.parse({ status: row.response_status, body: row.response_body }) };
  }

  /** Stores the response for replay. Only the request that got `fresh` should call it. */
  async complete(input: Omit<BeginInput, "requestHash">, response: StoredResponse): Promise<void> {
    const { key, route, actorId } = keySchema.parse(input);
    const res = storedResponseSchema.parse(response);
    const r = await this.db.query(
      `UPDATE idempotency_keys SET status='completed', response_status=$4, response_body=$5::jsonb, locked_until=NULL
        WHERE key=$1 AND actor_id=$2 AND route=$3 AND status='in_progress' RETURNING key`,
      [key, actorId, route, res.status, JSON.stringify(res.redacted === true ? REDACTED_MARKER : res.body)],
    );
    if (r.rows.length === 0) throw new Error("idempotency: no in-progress record to complete");
  }

  /** Releases the key after a failure that must be retryable with the same key (e.g. 5xx). */
  async abandon(input: Omit<BeginInput, "requestHash">): Promise<void> {
    const { key, route, actorId } = keySchema.parse(input);
    await this.db.query("DELETE FROM idempotency_keys WHERE key=$1 AND actor_id=$2 AND route=$3 AND status='in_progress'", [key, actorId, route]);
  }

  /** Purge job: deletes expired rows. Returns the count. */
  async purgeExpired(): Promise<number> {
    const r = await this.db.query("DELETE FROM idempotency_keys WHERE expires_at <= $1 RETURNING key", [this.now().toISOString()]);
    return r.rows.length;
  }
}
