import { defineMachine, guard } from "../state-machine/machine";
import { InvalidTaxInputError } from "./errors";

export const SUBMISSION_STATES = ["QUEUED", "SUBMITTED", "ACCEPTED", "REJECTED", "RETRY", "DEAD_LETTER"] as const;
export type SubmissionState = (typeof SUBMISSION_STATES)[number];

export const SUBMISSION_EVENTS = ["SUBMIT", "ACCEPT", "REJECT", "FAIL", "EXHAUST", "REQUEUE"] as const;
export type SubmissionEvent = (typeof SUBMISSION_EVENTS)[number];

export interface SubmissionContext {
  /** Attempts already made, including the current one. */
  readonly attempts: number;
  readonly maxAttempts: number;
}

export const DEFAULT_MAX_ATTEMPTS = 6;

const canRetry = guard<SubmissionContext>("attemptsBelowMax", (c) => c.attempts < c.maxAttempts);
const exhausted = guard<SubmissionContext>("attemptsAtMax", (c) => c.attempts >= c.maxAttempts);

/**
 * QUEUED -> SUBMITTED -> ACCEPTED | REJECTED | RETRY. RETRY resubmits with backoff. After the
 * attempt budget the document moves to DEAD_LETTER (DLQ) and only an admin REQUEUE leaves it.
 * ACCEPTED and REJECTED are final: a rejected document is corrected as a new version.
 */
export const submissionMachine = defineMachine<SubmissionState, SubmissionEvent, SubmissionContext>({
  name: "EtaSubmission",
  states: SUBMISSION_STATES,
  events: SUBMISSION_EVENTS,
  initial: "QUEUED",
  terminal: ["ACCEPTED", "REJECTED"],
  transitions: {
    QUEUED: { SUBMIT: { to: "SUBMITTED" } },
    SUBMITTED: {
      ACCEPT: { to: "ACCEPTED" },
      REJECT: { to: "REJECTED" },
      FAIL: { to: "RETRY", guard: canRetry },
      EXHAUST: { to: "DEAD_LETTER", guard: exhausted },
    },
    ACCEPTED: {},
    REJECTED: {},
    RETRY: { SUBMIT: { to: "SUBMITTED" } },
    DEAD_LETTER: { REQUEUE: { to: "QUEUED" } },
  },
});

export interface BackoffConfig {
  readonly baseMs: number;
  readonly capMs: number;
}
export const DEFAULT_BACKOFF: BackoffConfig = { baseMs: 30_000, capMs: 3_600_000 };

/**
 * Exponential backoff with "equal jitter": delay is uniform in [exp/2, exp] where
 * exp = min(cap, base * 2^(attempt-1)). `random01` is injected in [0,1) so tests are exact.
 */
export function backoffDelayMs(attempt: number, random01: number, cfg: BackoffConfig = DEFAULT_BACKOFF): number {
  if (!Number.isInteger(attempt) || attempt < 1) throw new InvalidTaxInputError("attempt must be an integer >= 1");
  if (!(random01 >= 0 && random01 < 1)) throw new InvalidTaxInputError("random01 must be in [0,1)");
  const exp = Math.min(cfg.capMs, cfg.baseMs * 2 ** Math.min(attempt - 1, 30));
  const half = Math.floor(exp / 2);
  return half + Math.floor(random01 * (exp - half + 1));
}
