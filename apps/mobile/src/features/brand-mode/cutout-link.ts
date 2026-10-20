/**
 * Linking background-removal cutouts to the product being edited (pure, no React).
 * A photo whose cutout job is settled with a decision (accepted or use_original) is sent as
 * `images: [{ media_job_id }]`; the server then uses the job's derivative (or keeps the original).
 */
import { isSettled, type CutoutJob, type CutoutView } from "../background-removal/model";
import type { PhotoItem } from "./model";

/** The job id to send for this photo, or null while the seller has not decided (the plain upload is used). */
export function linkedJobId(job: CutoutJob | null): string | null {
  // A simulated (dev stand-in) job does not exist on the server: it is never linked.
  if (job === null || job.simulated || !isSettled(job.status) || job.status === "FAILED") return null;
  return job.decision === "accepted" || job.decision === "use_original" ? job.jobId : null;
}

/** Photos with `mediaJobId` synced from the jobs; photos without a known job are left as they are. */
export function syncJobLinks(photos: readonly PhotoItem[], jobOf: (localId: string) => CutoutJob | null): { photos: readonly PhotoItem[]; changed: boolean } {
  let changed = false;
  const next = photos.map((p) => {
    const job = jobOf(p.localId);
    if (job === null) return p;
    const want = linkedJobId(job);
    if ((p.mediaJobId ?? null) === want) return p;
    changed = true;
    return { ...p, mediaJobId: want };
  });
  return { photos: changed ? next : photos, changed };
}

export type ImageEntry = { readonly upload_id: string } | { readonly media_job_id: string };

/** Ordered `images` for the product body, or null when no photo is job-backed (the legacy image_upload_ids is sent). */
export function imageEntries(photos: readonly PhotoItem[]): readonly ImageEntry[] | null {
  if (!photos.some((p) => p.mediaJobId !== undefined && p.mediaJobId !== null)) return null;
  return photos.flatMap((p): ImageEntry[] => {
    if (p.mediaJobId !== undefined && p.mediaJobId !== null) return [{ media_job_id: p.mediaJobId }];
    return p.uploadId === null ? [] : [{ upload_id: p.uploadId }];
  });
}

/** A signed link is unusable from its expiry on: never hand a stale one to an image view. */
export function freshLink(url: string | null, job: CutoutJob, nowMs: number): string | null {
  if (url === null) return null;
  return job.linksExpireAtMs !== null && nowMs >= job.linksExpireAtMs ? null : url;
}

/** What the photo tile shows: the fresh cutout, the local file, or a fresh signed original; null = placeholder (never a broken image). */
export function previewUri(photo: PhotoItem, job: CutoutJob | null, view: CutoutView, nowMs: number): string | null {
  if (job !== null && view.display === "cutout") {
    const c = freshLink(job.cutoutUrl, job, nowMs) ?? freshLink(job.whiteUrl, job, nowMs);
    if (c !== null) return c;
  }
  if (photo.uri !== "") return photo.uri;
  if (job === null) return null;
  return freshLink(job.whiteUrl, job, nowMs) ?? freshLink(job.originalUrl, job, nowMs);
}
