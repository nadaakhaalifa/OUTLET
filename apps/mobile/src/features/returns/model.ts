/** Returns and exchange-first flow (spec §22). Pure model, ports and in-memory fakes. */
import { PortError, type PortFailure } from "../worlds/model";
import type { LocalizedText } from "../checkout/model";

export { PortError };
export type { PortFailure, LocalizedText };

export type ReturnReason = "too_small" | "too_large" | "not_as_described" | "defective" | "changed_mind" | "late" | "wrong_item";
export const RETURN_REASONS: readonly ReturnReason[] = ["too_small", "too_large", "not_as_described", "defective", "changed_mind", "late", "wrong_item"];

const PHOTO_REQUIRED: ReadonlySet<ReturnReason> = new Set(["defective", "not_as_described"]);
const SIZE_REASONS: ReadonlySet<ReturnReason> = new Set(["too_small", "too_large"]);
/** Reasons that fall under the 30-day defect window rather than the 14-day change-of-mind window. */
const DEFECT_WINDOW: ReadonlySet<ReturnReason> = new Set(["defective", "not_as_described", "wrong_item"]);

export const MAX_PHOTOS = 5;

export function photosRequired(r: ReturnReason): boolean {
  return PHOTO_REQUIRED.has(r);
}
export function isSizeReason(r: ReturnReason): boolean {
  return SIZE_REASONS.has(r);
}

export type ReturnMethod = "pickup" | "dropoff";
export type Resolution = "exchange" | "refund";
export type RefundTarget = "original" | "credit";

export interface ReturnEligibility {
  readonly eligible: boolean;
  /** Server reason in both languages; shown verbatim when not eligible or restricted. */
  readonly message: LocalizedText | null;
  readonly deliveredAt: string;
  /** Windows in days counted from deliveredAt (14 change of mind, 30 defects; server supplied). */
  readonly changeOfMindDays: number;
  readonly defectDays: number;
  readonly exchangeInStock: boolean;
  readonly allowedRefundTargets: readonly RefundTarget[];
  readonly returnShippingPaidBy: "shopper" | "seller" | "free";
}

export interface ReturnCandidate {
  readonly orderLineId: string;
  readonly title: string;
  readonly storeName: string;
  readonly eligibility: ReturnEligibility;
}

export interface Photo {
  readonly uri: string;
}

export interface ReturnRequest {
  readonly orderLineId: string;
  readonly reason: ReturnReason;
  readonly photoUris: readonly string[];
  /** Ids from the signed-upload port, in the same order as the photos that finished uploading. */
  readonly photoUploadIds?: readonly string[];
  readonly method: ReturnMethod;
  readonly resolution: Resolution;
  readonly refundTarget: RefundTarget | null;
}

export interface ReturnsPort {
  load(orderLineId: string): Promise<ReturnCandidate>;
  submit(request: ReturnRequest, idempotencyKey: string): Promise<{ readonly ok: true; readonly returnId: string } | { readonly ok: false; readonly reason: LocalizedText }>;
}

export interface PhotoPickerPort {
  pick(): Promise<Photo | null>;
}

const DAY_MS = 86_400_000;

export interface WindowInfo {
  readonly days: number;
  readonly endsAtMs: number;
  /** Whole days left, floor; 0 on the last day, negative when closed. */
  readonly daysLeft: number;
  readonly open: boolean;
}

/** The window always counts from the courier-confirmed delivered_at, never the order date. */
export function windowFor(reason: ReturnReason, e: ReturnEligibility, nowMs: number): WindowInfo {
  const days = DEFECT_WINDOW.has(reason) ? e.defectDays : e.changeOfMindDays;
  const endsAtMs = Date.parse(e.deliveredAt) + days * DAY_MS;
  const daysLeft = Math.floor((endsAtMs - nowMs) / DAY_MS);
  return { days, endsAtMs, daysLeft, open: nowMs <= endsAtMs };
}

export interface FlowDraft {
  readonly reason: ReturnReason | null;
  readonly photos: readonly Photo[];
  readonly method: ReturnMethod;
  readonly resolution: Resolution | null;
  readonly refundTarget: RefundTarget | null;
}
export const EMPTY_DRAFT: FlowDraft = { reason: null, photos: [], method: "pickup", resolution: null, refundTarget: null };

export function addPhoto(d: FlowDraft, p: Photo): FlowDraft {
  if (d.photos.length >= MAX_PHOTOS || d.photos.some((x) => x.uri === p.uri)) return d;
  return { ...d, photos: [...d.photos, p] };
}
export function removePhoto(d: FlowDraft, uri: string): FlowDraft {
  return { ...d, photos: d.photos.filter((p) => p.uri !== uri) };
}

/** Exchange is offered first for size reasons when an instant swap is in stock (spec §22). */
export function resolutionOptions(reason: ReturnReason | null, e: ReturnEligibility): readonly Resolution[] {
  if (reason === null) return [];
  if (isSizeReason(reason) && e.exchangeInStock) return ["exchange", "refund"];
  return ["refund"];
}

export function setReason(d: FlowDraft, reason: ReturnReason, e: ReturnEligibility): FlowDraft {
  const opts = resolutionOptions(reason, e);
  return { ...d, reason, resolution: opts[0] ?? null, refundTarget: null };
}

export type FlowBlocker = "reason" | "window" | "photos" | "resolution" | "refundTarget" | "notEligible";

export function flowBlockers(d: FlowDraft, e: ReturnEligibility, nowMs: number): readonly FlowBlocker[] {
  const out: FlowBlocker[] = [];
  if (!e.eligible) out.push("notEligible");
  if (d.reason === null) {
    out.push("reason");
    return out;
  }
  if (!windowFor(d.reason, e, nowMs).open) out.push("window");
  if (photosRequired(d.reason) && d.photos.length === 0) out.push("photos");
  if (d.resolution === null) out.push("resolution");
  if (d.resolution === "refund" && e.allowedRefundTargets.length > 1 && d.refundTarget === null) out.push("refundTarget");
  return out;
}

export function buildReturnRequest(orderLineId: string, d: FlowDraft, e: ReturnEligibility): ReturnRequest | null {
  if (d.reason === null || d.resolution === null) return null;
  const target = d.resolution === "refund" ? (d.refundTarget ?? e.allowedRefundTargets[0] ?? null) : null;
  return { orderLineId, reason: d.reason, photoUris: d.photos.map((p) => p.uri), method: d.method, resolution: d.resolution, refundTarget: target };
}

export type ReturnsScreenState =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly offline: boolean }
  | { readonly status: "ready"; readonly candidate: ReturnCandidate };

export function returnsFailureState(e: unknown): ReturnsScreenState {
  return { status: "error", offline: e instanceof PortError && e.kind === "offline" };
}

export const FIXTURE_CANDIDATE: ReturnCandidate = {
  orderLineId: "l9", title: "Linen dress", storeName: "Delta Dresses",
  eligibility: {
    eligible: true, message: null, deliveredAt: "2026-10-01T12:00:00Z", changeOfMindDays: 14, defectDays: 30,
    exchangeInStock: true, allowedRefundTargets: ["original", "credit"], returnShippingPaidBy: "shopper",
  },
};

export class InMemoryReturnsPort implements ReturnsPort {
  submitted: Array<{ request: ReturnRequest; key: string }> = [];
  constructor(private readonly candidate: ReturnCandidate = FIXTURE_CANDIDATE, private failure: PortFailure | null = null) {}
  setFailure(f: PortFailure | null): void { this.failure = f; }
  async load(): Promise<ReturnCandidate> {
    if (this.failure !== null) throw new PortError(this.failure);
    return this.candidate;
  }
  async submit(request: ReturnRequest, key: string) {
    if (this.failure !== null) throw new PortError(this.failure);
    this.submitted.push({ request, key });
    return { ok: true as const, returnId: "ret-1" };
  }
}

export class FakePhotoPicker implements PhotoPickerPort {
  private n = 0;
  async pick(): Promise<Photo | null> {
    this.n += 1;
    return { uri: `file:///fake/photo-${this.n}.jpg` };
  }
}

/* ---- photo upload (signed-upload port) ---- */

export interface PhotoUploadPort {
  /** Uploads one local photo through a signed upload and resolves its upload id. */
  upload(uri: string): Promise<{ readonly uploadId: string }>;
}

export class FakePhotoUpload implements PhotoUploadPort {
  uploaded: string[] = [];
  constructor(private failUris: ReadonlySet<string> = new Set()) {}
  async upload(uri: string): Promise<{ uploadId: string }> {
    if (this.failUris.has(uri)) throw new PortError("failed");
    this.uploaded.push(uri);
    return { uploadId: `up-${this.uploaded.length}` };
  }
}

export type UploadState = { readonly state: "uploading" } | { readonly state: "ready"; readonly uploadId: string } | { readonly state: "failed" };
export type UploadMap = Readonly<Record<string, UploadState>>;

/** Submission waits for in-flight uploads; a failed upload must be removed or retried first. */
export function uploadBlockers(photos: readonly Photo[], uploads: UploadMap): readonly ("uploading" | "uploadFailed")[] {
  const out: ("uploading" | "uploadFailed")[] = [];
  const st = photos.map((p) => uploads[p.uri]?.state ?? "uploading");
  if (st.includes("uploading")) out.push("uploading");
  if (st.includes("failed")) out.push("uploadFailed");
  return out;
}

export function readyUploadIds(photos: readonly Photo[], uploads: UploadMap): readonly string[] {
  return photos.flatMap((p) => {
    const u = uploads[p.uri];
    return u !== undefined && u.state === "ready" ? [u.uploadId] : [];
  });
}
