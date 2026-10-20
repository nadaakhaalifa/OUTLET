import { MAX_VERSIONS_PER_JOB, type ProductMediaJob, type ProductMediaVersion } from "../domain/ports";
import { versionsToPrune } from "../domain/edit";
import type { ProductMediaDeps } from "./shared";

const keysOf = (v: ProductMediaVersion): string[] =>
  [v.maskRef, v.pngRef, v.whiteJpgRef, v.shadowRef, v.backgroundRenderRef].filter((k): k is string => k !== null);

/**
 * Keeps at most MAX_VERSIONS_PER_JOB versions: the oldest non-current ones are removed (the database trigger buries their
 * keys; the objects are also deleted here, best effort). A key the job still points at is never deleted.
 */
export async function pruneVersions(d: ProductMediaDeps, job: ProductMediaJob): Promise<void> {
  const all = await d.store.listVersions(job.id);
  const live = new Set(
    [job.pngRef, job.whiteJpgRef, job.shadowRef, job.backgroundRenderRef, job.originalRef, job.promotedImageRef, job.promotedCutoutRef].filter(
      (k): k is string => k !== null,
    ),
  );
  for (const v of versionsToPrune(all, MAX_VERSIONS_PER_JOB, job.currentVersion)) {
    const removed = await d.store.deleteVersion(job.id, v.version);
    if (removed === null) continue;
    await Promise.allSettled(keysOf(removed).filter((k) => !live.has(k)).map((k) => d.blobs.delete(k)));
  }
}

/** A job created before versions existed gets its current derivatives recorded as version 1 (no stored mask). */
export async function ensureInitialVersion(d: ProductMediaDeps, job: ProductMediaJob): Promise<ProductMediaJob> {
  if (job.currentVersion > 0 || job.pngRef === null || job.whiteJpgRef === null || job.qualityScore === null) return job;
  const existing = await d.store.listVersions(job.id);
  const have = existing.find((v) => v.pngRef === job.pngRef);
  let n = have?.version ?? 0;
  if (n === 0) {
    n = existing.reduce((m, v) => Math.max(m, v.version), 0) + 1;
    await d.store.insertVersion({
      id: d.ids.uuidV7(),
      jobId: job.id,
      storeId: job.storeId,
      version: n,
      op: "initial",
      params: {},
      maskRef: null,
      pngRef: job.pngRef,
      whiteJpgRef: job.whiteJpgRef,
      shadowRef: job.shadowRef,
      backgroundRenderRef: job.backgroundRenderRef,
      modelId: job.modelId,
      modelVersion: job.modelVersion,
      latencyMs: job.latencyMs,
      qualityScore: job.qualityScore,
      qualityReasons: job.qualityReasons,
      createdAtMs: d.clock.nowMs(),
    });
  }
  const updated = await d.store.update(job.id, job.version, { currentVersion: n, updatedAtMs: d.clock.nowMs() });
  // Copies promoted before versions existed belong to this first version: stamp them so only a later edit re-promotes.
  if (job.promotedImageRef !== null && job.promotedVersion === 0) {
    await d.store.replacePromoted(job.id, job.promotedImageRef, { image: job.promotedImageRef, cutout: job.promotedCutoutRef }, n);
  }
  return (await d.store.getJob(job.id)) ?? updated ?? job;
}
