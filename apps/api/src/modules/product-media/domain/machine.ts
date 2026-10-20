import type { Decision, JobStatus } from "./ports";

/** Explicit transition table (A2.6). `FAILED` and the review states can be re-run; a stale PROCESSING is failed by the sweeper first. */
export const TRANSITIONS: Readonly<Record<JobStatus, readonly JobStatus[]>> = {
  PENDING: ["PROCESSING", "FAILED"],
  PROCESSING: ["READY", "NEEDS_REVIEW", "FAILED"],
  // PROCESSING is also entered from a finished job by a manual refine; READY <-> NEEDS_REVIEW follows a version restore.
  READY: ["PENDING", "PROCESSING", "NEEDS_REVIEW"],
  NEEDS_REVIEW: ["PENDING", "PROCESSING", "READY"],
  FAILED: ["PENDING"],
};

export class InvalidTransitionError extends Error {
  constructor(readonly from: JobStatus, readonly to: JobStatus) {
    super(`invalid product-media transition ${from} -> ${to}`);
    this.name = "InvalidTransitionError";
  }
}

export function assertTransition(from: JobStatus, to: JobStatus): void {
  if (!TRANSITIONS[from].includes(to)) throw new InvalidTransitionError(from, to);
}

export const canTransition = (from: JobStatus, to: JobStatus): boolean => TRANSITIONS[from].includes(to);

/** Seller decisions. `accepted` needs a produced cutout; `use_original` is allowed whenever no run is in flight. */
export function canDecide(status: JobStatus, decision: Exclude<Decision, "none">): boolean {
  if (decision === "accepted") return status === "READY" || status === "NEEDS_REVIEW";
  return status !== "PROCESSING";
}

/** A PROCESSING row older than this was abandoned by a crashed worker. */
export const STALE_PROCESSING_MS = 5 * 60_000;
