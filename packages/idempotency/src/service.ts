import {
  IdempotencyInFlightError,
  IdempotencyKeyReuseError,
  IdempotencyStoreError,
  InvalidIdempotencyKeyError,
} from "./errors";
import type { IdempotencyStore } from "./store";
import {
  IdempotencyKeySchema,
  OpaqueKeySchema,
  StoredResponseSchema,
  type Clock,
  type StoredResponse,
} from "./types";

export const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_LEASE_MS = 5 * 60 * 1000;

export interface IdempotencyServiceDeps {
  readonly store: IdempotencyStore;
  readonly clock: Clock;
  /** Injected randomness: unique claim token per attempt. */
  readonly newClaimToken: () => string;
  readonly ttlMs?: number;
  readonly leaseMs?: number;
  /** "uuidv7" for client writes (default), "opaque" for webhooks keyed by provider event id. */
  readonly keyPolicy?: "uuidv7" | "opaque";
}

export interface ExecuteInput {
  readonly key: string;
  readonly route: string;
  readonly actor: string;
  /** From hashRequest(). */
  readonly requestHash: string;
  readonly handler: () => Promise<StoredResponse>;
}

export interface ExecuteResult {
  readonly response: StoredResponse;
  /** True when served from the stored record without running the handler. */
  readonly replayed: boolean;
  /** True when a 5xx response was returned but intentionally not stored (retry will re-run). */
  readonly stored: boolean;
}

/**
 * Failure handling:
 * - handler throws: claim is released (retry re-runs), error is rethrown. The handler must itself be
 *   transactional so a throw means no side effect was committed.
 * - handler returns status >= 500: response returned, claim released, not stored.
 * - handler returns status < 500 (including 4xx): stored and replayed for 24h, so a client does not
 *   get a different answer to the same key.
 * - store failure before the handler runs: IdempotencyStoreError, handler NOT run (fail closed).
 * - store failure after the handler ran: the handler's response is returned and the claim is left to
 *   expire by lease; a retry within the lease gets IdempotencyInFlightError, never a double run.
 */
export class IdempotencyService {
  private readonly ttlMs: number;
  private readonly leaseMs: number;
  private readonly keySchema;

  constructor(private readonly deps: IdempotencyServiceDeps) {
    this.ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS;
    this.leaseMs = deps.leaseMs ?? DEFAULT_LEASE_MS;
    this.keySchema = deps.keyPolicy === "opaque" ? OpaqueKeySchema : IdempotencyKeySchema;
  }

  async execute(input: ExecuteInput): Promise<ExecuteResult> {
    if (!this.keySchema.safeParse(input.key).success) {
      throw new InvalidIdempotencyKeyError("Idempotency-Key is missing or malformed");
    }
    const scope = { actor: input.actor, key: input.key } as const;
    const claimToken = this.deps.newClaimToken();

    let claim;
    try {
      claim = await this.deps.store.claim({
        scope,
        route: input.route,
        requestHash: input.requestHash,
        claimToken,
        nowMs: this.deps.clock.nowMs(),
        ttlMs: this.ttlMs,
        leaseMs: this.leaseMs,
      });
    } catch (cause) {
      throw new IdempotencyStoreError(`claim failed: ${describe(cause)}`);
    }

    if (claim.kind === "existing") {
      const rec = claim.record;
      if (rec.requestHash !== input.requestHash || rec.route !== input.route) {
        throw new IdempotencyKeyReuseError("Idempotency-Key was already used with a different request");
      }
      if (rec.state === "in_flight") {
        throw new IdempotencyInFlightError("a request with this Idempotency-Key is still in progress");
      }
      return { response: rec.response, replayed: true, stored: true };
    }

    let response: StoredResponse;
    try {
      response = StoredResponseSchema.parse(await input.handler());
    } catch (err) {
      await this.safeRelease(scope, claimToken);
      throw err;
    }

    if (response.status >= 500) {
      await this.safeRelease(scope, claimToken);
      return { response, replayed: false, stored: false };
    }
    try {
      await this.deps.store.complete(scope, claimToken, response, this.deps.clock.nowMs());
    } catch {
      // Leave the claim to expire by lease; never re-run a handler that already committed.
    }
    return { response, replayed: false, stored: true };
  }

  private async safeRelease(scope: { actor: string; key: string }, token: string): Promise<void> {
    try {
      await this.deps.store.release(scope, token);
    } catch {
      // lease expiry will free it
    }
  }
}

function describe(e: unknown): string {
  return e instanceof Error ? e.message : "unknown";
}
