/**
 * Product photo background removal (docs/specs/phase-3/product-media-background-removal.md). Pure model: no React,
 * no router. A cutout is a suggestion the seller accepts or declines; the original always stays available.
 */
export const CUTOUT_MODELS = ["u2netp", "u2net", "birefnet-general-lite", "isnet-general-use"] as const;
export type CutoutModel = (typeof CUTOUT_MODELS)[number];
export type CutoutStatus = "PENDING" | "PROCESSING" | "READY" | "NEEDS_REVIEW" | "FAILED";
export type CutoutDecision = "none" | "accepted" | "use_original";
/** Score at or above which the server marks a cutout READY (spec: 70). Used only for the quiet chip tone. */
export const GOOD_SCORE = 70;
export const MAX_RUNS = 5;

export interface CutoutJob {
  readonly jobId: string;
  readonly status: CutoutStatus;
  readonly decision: CutoutDecision;
  readonly qualityScore: number | null;
  readonly reasons: readonly string[];
  readonly model: CutoutModel | null;
  readonly attempts: number;
  readonly errorCode: string | null;
  /** Signed, private, short-lived links (at most 15 minutes). Never persisted. */
  readonly originalUrl: string | null;
  readonly cutoutUrl: string | null;
  readonly whiteUrl: string | null;
  readonly linksExpireAtMs: number | null;
  /** True only for the in-memory dev port: the "cutout" is a stand-in, not a real result. */
  readonly simulated: boolean;
  /** Models the processing service reports as installed (dev sidecar only); absent means the full allow-list. */
  readonly availableModels?: readonly CutoutModel[];
  /** The derivative version currently shown (1 = the automatic cutout; each refine adds one). Absent on ports without history. */
  readonly version?: number;
  /** True once the seller has opened the cutout editor and confirmed (Done) at least once. */
  readonly reviewed?: boolean;
}

/** One saved derivative of a cutout. Version 1 is always the automatic result and is never overwritten. */
export interface CutoutVersion {
  readonly version: number;
  readonly kind: "original" | "edit";
  readonly qualityScore: number | null;
  readonly reasons: readonly string[];
  readonly cutoutUrl: string | null;
  readonly whiteUrl: string | null;
  readonly createdAtMs: number;
}

export type StrokeMode = "erase" | "restore";
/** A brush stroke in image-normalised coordinates (0..1 of the image width and height). */
export interface RefineStroke {
  readonly mode: StrokeMode;
  /** Brush radius as a fraction of the image width. */
  readonly radius: number;
  readonly points: readonly (readonly [number, number])[];
}
export type RefineBackground = "transparent" | "white" | "studio";
export interface RefineParams {
  /** Edge softness (feather), 0..4 px. */
  readonly featherPx: number;
  /** Mask smoothing, 0..1. */
  readonly smooth: number;
  /** Grow (+) or shrink (-) the edge, -3..3 px. */
  readonly edgeShiftPx: number;
  readonly background: RefineBackground;
}

export type CutoutBlock = "disabled" | "not_configured" | "quota" | "consent" | "attempts" | "offline" | "failed" | "too_large" | "session_expired"
  | "service_down" | "model_missing" | "busy" | "timeout";

export class CutoutError extends Error {
  constructor(readonly kind: CutoutBlock) {
    super(`cutout:${kind}`);
    this.name = "CutoutError";
  }
}

export interface CutoutPort {
  /** Upload the private original and start processing. Resolves with the first job view (may still be PROCESSING). */
  start(uri: string): Promise<CutoutJob>;
  refresh(jobId: string): Promise<CutoutJob>;
  /** Accept the cutout; with `version`, that derivative is the one used. */
  accept(jobId: string, version?: number): Promise<CutoutJob>;
  useOriginal(jobId: string): Promise<CutoutJob>;
  rerun(jobId: string, model: CutoutModel): Promise<CutoutJob>;
  /** Apply brush strokes and edge parameters on top of the automatic cutout; resolves with the new derivative (a new version). */
  refine(jobId: string, strokes: readonly RefineStroke[], params: RefineParams): Promise<CutoutJob>;
  /** Saved derivatives, oldest first (version 1 is the automatic cutout). */
  versions(jobId: string): Promise<readonly CutoutVersion[]>;
  /** Make a saved derivative the current one (undo, redo, back to the original cutout). */
  restoreVersion(jobId: string, version: number): Promise<CutoutJob>;
}

export const isSettled = (s: CutoutStatus): boolean => s === "READY" || s === "NEEDS_REVIEW" || s === "FAILED";

/** Backoff for status polling: 1 s, 1.5 s, 2.25 s ... capped at 8 s. Pure so tests can assert it. */
export function pollDelayMs(attempt: number): number {
  return Math.min(8000, Math.round(1000 * Math.pow(1.5, Math.max(0, attempt))));
}

export interface PollOptions {
  readonly sleep: (ms: number) => Promise<void>;
  readonly maxAttempts?: number;
  readonly cancelled?: () => boolean;
  readonly onUpdate?: (j: CutoutJob) => void;
}

/** Polls until the job settles, the budget is spent, or the caller cancels. Never throws on a spent budget: it returns the last view. */
export async function pollUntilSettled(port: CutoutPort, first: CutoutJob, o: PollOptions): Promise<CutoutJob> {
  let job = first;
  const max = o.maxAttempts ?? 14;
  for (let i = 0; i < max && !isSettled(job.status); i++) {
    if (o.cancelled?.() === true) return job;
    await o.sleep(pollDelayMs(i));
    if (o.cancelled?.() === true) return job;
    job = await port.refresh(job.jobId);
    o.onUpdate?.(job);
  }
  return job;
}

/** Re-fetch the signed links this long before they expire (they live at most 15 minutes); never sooner than MIN. */
export const REFRESH_LEAD_MS = 30_000;
export const MIN_REFRESH_DELAY_MS = 5_000;
/** Delay until the job's links should be re-fetched, or null when it holds no expiring link. */
export function refreshDelayMs(j: CutoutJob, nowMs: number): number | null {
  if (j.linksExpireAtMs === null) return null;
  return Math.max(MIN_REFRESH_DELAY_MS, j.linksExpireAtMs - nowMs - REFRESH_LEAD_MS);
}

/** Signed links expire; refresh before showing a stale one. */
export const linksExpired = (j: CutoutJob, nowMs: number): boolean => j.linksExpireAtMs !== null && nowMs >= j.linksExpireAtMs - 5_000;

const KNOWN_REASONS = new Set([
  "no_subject_detected", "subject_too_small", "subject_small", "subject_fills_frame", "subject_cut_by_frame",
  "subject_touches_border", "multiple_components", "mask_holes", "mask_small_holes", "soft_edges",
  "slightly_soft_edges", "white_on_white_risk", "low_contrast_backdrop",
]);
/** i18n key suffix for a server reason code; unknown codes fall back to a generic line so nothing raw is shown. */
export function reasonKey(code: string): string {
  return KNOWN_REASONS.has(code) ? code : "other";
}

/** Models offered for "Try another model": the documented allow-list minus the one that produced the current result. */
export function otherModels(job: CutoutJob): readonly CutoutModel[] {
  const pool = job.availableModels ?? CUTOUT_MODELS;
  return CUTOUT_MODELS.filter((m) => m !== job.model && pool.includes(m));
}
export const canRerun = (j: CutoutJob): boolean => j.attempts < MAX_RUNS && (j.status === "READY" || j.status === "NEEDS_REVIEW" || j.status === "FAILED");

export type CutoutPhase = "working" | "ready" | "review" | "failed" | "unavailable" | "accepted" | "original";
export interface CutoutView {
  readonly phase: CutoutPhase;
  /** Which image the photo grid should use for this photo. */
  readonly display: "original" | "cutout";
  readonly canToggle: boolean;
}

/** Everything the panel needs to decide what to render, from the job and any blocking error. */
export function viewOf(job: CutoutJob | null, block: CutoutBlock | null, working: boolean): CutoutView {
  if (block === "disabled" || block === "not_configured") return { phase: "unavailable", display: "original", canToggle: false };
  if (working || (job !== null && !isSettled(job.status))) return { phase: "working", display: "original", canToggle: false };
  if (job === null) return { phase: block === null ? "working" : "failed", display: "original", canToggle: false };
  if (job.decision === "use_original") return { phase: "original", display: "original", canToggle: job.cutoutUrl !== null };
  if (job.status === "FAILED") return { phase: "failed", display: "original", canToggle: false };
  if (job.decision === "accepted") return { phase: "accepted", display: "cutout", canToggle: true };
  return { phase: job.status === "READY" ? "ready" : "review", display: "original", canToggle: job.cutoutUrl !== null };
}

/** Deterministic id for a dev/fake job so tests are stable. */
export function fakeJobId(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}
