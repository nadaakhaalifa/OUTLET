/** Pure deadline and backoff functions (SLO: initiated within 24 h of return receipt, spec 15.6, T8). */
export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;

export const INITIATION_SLO_MS = 24 * HOUR_MS;
/** Assumed legal refund deadline from return receipt: VERIFY BEFORE LAUNCH (VR-RF-05, CPL 181/2018). */
export const LEGAL_PAYMENT_DEADLINE_MS = 14 * DAY_MS;

export function initiationDeadline(receivedAtMs: number): number {
  return receivedAtMs + INITIATION_SLO_MS;
}

export function legalDeadline(receivedAtMs: number): number {
  return receivedAtMs + LEGAL_PAYMENT_DEADLINE_MS;
}

export type SloState = "on_track" | "initiation_breached" | "legal_deadline_breached";

/** `initiatedAtMs` is when the refund first left REQUESTED (ledger posted), `paidAtMs` when it completed. */
export function sloState(input: {
  readonly receivedAtMs: number;
  readonly initiatedAtMs: number | null;
  readonly paidAtMs: number | null;
  readonly nowMs: number;
}): SloState {
  const legal = legalDeadline(input.receivedAtMs);
  const paidLate = input.paidAtMs !== null ? input.paidAtMs > legal : input.nowMs > legal;
  if (paidLate) return "legal_deadline_breached";
  const initiated = input.initiatedAtMs ?? input.nowMs;
  if (initiated > initiationDeadline(input.receivedAtMs)) return "initiation_breached";
  return "on_track";
}

export const RETRY_BASE_MS = 60_000;
export const RETRY_CAP_MS = HOUR_MS;

/**
 * Exponential backoff with jitter. `attempt` is the number of failed attempts so far (>= 1).
 * `jitter` is a unit float in [0, 1) supplied by the caller so this stays pure: the delay is
 * between half and all of the exponential step.
 */
export function retryDelayMs(attempt: number, jitter: number): number {
  const n = Math.max(1, Math.floor(attempt));
  const step = Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** (n - 1));
  const j = Math.min(Math.max(jitter, 0), 0.999999);
  return Math.floor(step / 2 + (step / 2) * j);
}

export function nextRetryAt(nowMs: number, attempt: number, jitter: number): number {
  return nowMs + retryDelayMs(attempt, jitter);
}
