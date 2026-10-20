import { z } from "zod";
import { InvalidPseudonymousIdError } from "./errors";
import type { Clock, IdGenerator, PseudonymousIdProvider } from "./ports";

/**
 * Pseudonymous analytics ids are rotated yearly (spec §T6). Rotation epoch = the UTC calendar year of
 * the injected clock. A rotated id is unlinkable to the previous one by design: nothing derived from
 * the old id is used to mint the new one.
 *
 * Calendar-year versus rolling-365-days is an owner/DPO decision (see docs/analytics/event-taxonomy.md).
 */
export const pseudonymousIdSchema = z.string().regex(/^px_[A-Za-z0-9_-]{16,64}$/);

export interface PseudonymState {
  readonly id: string;
  /** UTC calendar year the id was minted for. */
  readonly epoch: number;
}

export const pseudonymStateSchema = z.strictObject({
  id: pseudonymousIdSchema,
  epoch: z.number().int().min(2000).max(9999),
});

export function rotationEpoch(at: Date): number {
  return at.getUTCFullYear();
}

/** True when the state must be replaced. A future epoch (clock moved backwards) also rotates: it cannot be trusted. */
export function needsRotation(state: PseudonymState, at: Date): boolean {
  return state.epoch !== rotationEpoch(at);
}

/**
 * Pure transition. Keeps `state` while it belongs to the current epoch, otherwise mints a new id via
 * `mintId`. The raw generator output is prefixed and validated so a bad generator fails loudly here.
 */
export function nextPseudonymState(
  state: PseudonymState | undefined,
  at: Date,
  mintId: () => string,
): PseudonymState {
  if (state !== undefined && !needsRotation(state, at)) return state;
  const id = `px_${mintId()}`;
  const parsed = pseudonymousIdSchema.safeParse(id);
  if (!parsed.success) {
    throw new InvalidPseudonymousIdError("id generator produced an id that is not px_ + 16-64 URL-safe characters");
  }
  return { id: parsed.data, epoch: rotationEpoch(at) };
}

/** Port: durable per-install storage for the state (MMKV on device, never SecureStore-required). */
export interface PseudonymStore {
  read(): unknown;
  write(state: PseudonymState): void;
  clear(): void;
}

export interface RotatingPseudonymOptions {
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly store: PseudonymStore;
}

/**
 * Client-side provider. Persisted state that fails validation is discarded, not repaired.
 * `reset()` must be called when `analytics` consent is withdrawn so a later re-grant starts a fresh id.
 */
export class RotatingPseudonymousId implements PseudonymousIdProvider {
  constructor(private readonly options: RotatingPseudonymOptions) {}

  current(): string {
    const { clock, ids, store } = this.options;
    const parsed = pseudonymStateSchema.safeParse(store.read());
    const next = nextPseudonymState(parsed.success ? parsed.data : undefined, clock.now(), () => ids.next());
    if (!parsed.success || parsed.data.id !== next.id) store.write(next);
    return next.id;
  }

  reset(): void {
    this.options.store.clear();
  }
}

/**
 * Server-side provider for strictly-necessary events: the id is derived, not stored, so there is no
 * mapping table to leak. `hmac` is injected (HMAC-SHA-256 with a KMS-held key in production) and must
 * return lowercase hex or URL-safe characters. The user key is never placed in the output.
 */
export function derivePseudonymousId(
  userKey: string,
  at: Date,
  hmac: (message: string) => string,
): string {
  if (userKey.length === 0) throw new InvalidPseudonymousIdError("userKey must not be empty");
  const digest = hmac(`pseudonym:v1:${rotationEpoch(at)}:${userKey}`).slice(0, 32);
  const id = `px_${digest}`;
  const parsed = pseudonymousIdSchema.safeParse(id);
  if (!parsed.success) throw new InvalidPseudonymousIdError("hmac output is too short or contains unsafe characters");
  return parsed.data;
}
