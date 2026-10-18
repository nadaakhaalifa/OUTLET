/** In-memory CutoutPort (tests, and with outcome "not_configured" the honest stand-in when nothing is connected). A stand-in cutout is the same picture, flagged `simulated`. */
import { registerDevHint } from "../../services/dev-hints";
import { CUTOUT_MODELS, CutoutError, fakeJobId, type CutoutJob, type CutoutModel, type CutoutPort, type CutoutVersion, type RefineParams, type RefineStroke } from "./model";

export interface FakeCutoutOptions {
  /** Statuses returned by successive refreshes after start (default: PROCESSING once, then settled). */
  readonly processingPolls?: number;
  readonly outcome?: "ready" | "review" | "failed" | "disabled" | "not_configured" | "quota";
  readonly nowMs?: () => number;
}

const SCORES = { ready: { score: 91, reasons: [] as string[] }, review: { score: 58, reasons: ["subject_touches_border", "white_on_white_risk"] } };

registerDevHint("cutout", "Background removal is not connected. Run tooling/media/run-sidecar.sh, then set EXPO_PUBLIC_DEV_CUTOUT_URL=http://127.0.0.1:8099 in apps/mobile/.env.local and restart Expo.");

/** One recorded editing call, for tests. */
export type FakeOp =
  | { readonly kind: "refine"; readonly jobId: string; readonly strokes: readonly RefineStroke[]; readonly params: RefineParams }
  | { readonly kind: "restore"; readonly jobId: string; readonly version: number }
  | { readonly kind: "accept"; readonly jobId: string; readonly version: number | null };

export class InMemoryCutoutPort implements CutoutPort {
  /** Every refine/restore/accept call in order. */
  readonly ops: FakeOp[] = [];
  private history = new Map<string, CutoutVersion[]>();
  private jobs = new Map<string, { job: CutoutJob; polls: number; uri: string }>();
  private seq = 0;
  constructor(private readonly o: FakeCutoutOptions = {}) {}

  private now(): number { return this.o.nowMs?.() ?? Date.now(); }

  async start(uri: string): Promise<CutoutJob> {
    const out = this.o.outcome ?? "ready";
    if (out === "disabled" || out === "not_configured" || out === "quota") throw new CutoutError(out);
    const jobId = fakeJobId(++this.seq);
    const job: CutoutJob = {
      jobId, status: "PROCESSING", decision: "none", qualityScore: null, reasons: [], model: "u2netp", attempts: 1, errorCode: null,
      originalUrl: uri, cutoutUrl: null, whiteUrl: null, linksExpireAtMs: this.now() + 10 * 60_000, simulated: true,
    };
    this.jobs.set(jobId, { job, polls: 0, uri });
    return job;
  }

  async refresh(jobId: string): Promise<CutoutJob> {
    const e = this.jobs.get(jobId);
    if (e === undefined) throw new CutoutError("failed");
    if (e.job.status === "PROCESSING") {
      e.polls += 1;
      if (e.polls > (this.o.processingPolls ?? 1)) e.job = this.settle(e.job, e.uri);
    }
    return e.job;
  }

  private settle(j: CutoutJob, uri: string): CutoutJob {
    const out = this.o.outcome ?? "ready";
    if (out === "failed") return { ...j, status: "FAILED", errorCode: "storage_error", originalUrl: uri };
    const s = out === "review" ? SCORES.review : SCORES.ready;
    this.history.set(j.jobId, [{ version: 1, kind: "original", qualityScore: s.score, reasons: s.reasons, cutoutUrl: uri, whiteUrl: uri, createdAtMs: this.now() }]);
    return { ...j, version: 1, status: out === "review" ? "NEEDS_REVIEW" : "READY", qualityScore: s.score, reasons: s.reasons, cutoutUrl: uri, whiteUrl: uri, originalUrl: uri };
  }

  private put(jobId: string, patch: Partial<CutoutJob>): CutoutJob {
    const e = this.jobs.get(jobId);
    if (e === undefined) throw new CutoutError("failed");
    e.job = { ...e.job, ...patch };
    return e.job;
  }

  async accept(jobId: string, version?: number): Promise<CutoutJob> {
    this.ops.push({ kind: "accept", jobId, version: version ?? null });
    if (version !== undefined) await this.restoreVersion(jobId, version);
    return this.put(jobId, { decision: "accepted", reviewed: version !== undefined ? true : this.jobs.get(jobId)?.job.reviewed ?? false });
  }
  async useOriginal(jobId: string): Promise<CutoutJob> { return this.put(jobId, { decision: "use_original" }); }
  async rerun(jobId: string, model: CutoutModel): Promise<CutoutJob> {
    if (!CUTOUT_MODELS.includes(model)) throw new CutoutError("failed");
    const e = this.jobs.get(jobId);
    if (e === undefined) throw new CutoutError("failed");
    if (e.job.attempts >= 5) throw new CutoutError("attempts");
    e.polls = 0;
    return this.put(jobId, { status: "PROCESSING", decision: "none", model, attempts: e.job.attempts + 1, cutoutUrl: null, whiteUrl: null, qualityScore: null, reasons: [], errorCode: null });
  }

  private editable(jobId: string): { job: CutoutJob; list: CutoutVersion[] } {
    if ((this.o.outcome ?? "ready") === "quota") throw new CutoutError("quota");
    const e = this.jobs.get(jobId);
    const list = this.history.get(jobId);
    if (e === undefined || list === undefined || e.job.status === "PROCESSING" || e.job.status === "FAILED") throw new CutoutError("failed");
    return { job: e.job, list };
  }

  /** Deterministic edit: each refine lowers nothing and raises the score by 2 per call (cap 99) and tags the url with the version. */
  async refine(jobId: string, strokes: readonly RefineStroke[], params: RefineParams): Promise<CutoutJob> {
    const { job, list } = this.editable(jobId);
    this.ops.push({ kind: "refine", jobId, strokes, params });
    const version = Math.max(...list.map((v) => v.version)) + 1;
    const score = Math.min(99, (job.qualityScore ?? 60) + 2);
    const reasons = score >= 70 ? [] : job.reasons;
    const base = job.originalUrl ?? "";
    const v: CutoutVersion = { version, kind: "edit", qualityScore: score, reasons, cutoutUrl: `${base}#v${version}`, whiteUrl: `${base}#w${version}`, createdAtMs: this.now() };
    list.push(v);
    return this.put(jobId, { version, qualityScore: score, reasons, cutoutUrl: v.cutoutUrl, whiteUrl: v.whiteUrl, decision: "none" });
  }

  async versions(jobId: string): Promise<readonly CutoutVersion[]> {
    const list = this.history.get(jobId);
    if (list === undefined) throw new CutoutError("failed");
    return [...list];
  }

  async restoreVersion(jobId: string, version: number): Promise<CutoutJob> {
    const { list } = this.editable(jobId);
    const v = list.find((x) => x.version === version);
    if (v === undefined) throw new CutoutError("failed");
    this.ops.push({ kind: "restore", jobId, version });
    return this.put(jobId, { version, qualityScore: v.qualityScore, reasons: v.reasons, cutoutUrl: v.cutoutUrl, whiteUrl: v.whiteUrl });
  }
}
