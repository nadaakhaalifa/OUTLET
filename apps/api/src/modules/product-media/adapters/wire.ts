import type { VersionSummary } from "../application/refine";
import type { JobView, SignedLink } from "../application/shared";

const iso = (ms: number): string => new Date(ms).toISOString();
const link = (l: SignedLink | null) => (l === null ? null : { url: l.url, expires_at: iso(l.expiresAtMs) });

export function jobWire(v: JobView) {
  const j = v.job;
  return {
    id: j.id,
    store_id: j.storeId,
    status: j.status,
    decision: j.decision,
    requested_model: j.requestedModel,
    model_id: j.modelId,
    model_version: j.modelVersion,
    quality_score: j.qualityScore,
    quality_reasons: [...j.qualityReasons],
    latency_ms: j.latencyMs,
    error_code: j.errorCode,
    attempts: j.attempts,
    /** Edit version the links below belong to (0 = not versioned yet) and manual refines used so far. */
    current_version: j.currentVersion,
    edit_count: j.editCount,
    /** Product the job backs (null = free). The cutout is "attached to product" once set. */
    attached_product_id: j.attachedProductId,
    version: j.version,
    created_at: iso(j.createdAtMs),
    updated_at: iso(j.updatedAtMs),
    /** Private, short-lived signed links (<= 15 min). Absent outputs are null. */
    links: {
      original: link(v.links.original),
      png: link(v.links.png),
      white_jpg: link(v.links.whiteJpg),
      shadow: link(v.links.shadow),
      background_render: link(v.links.backgroundRender),
    },
  };
}

export const summaryWire = (j: JobView["job"]) => {
  const w = jobWire({ job: j, links: { original: null, png: null, whiteJpg: null, shadow: null, backgroundRender: null } });
  const { links: _links, ...rest } = w;
  void _links;
  return rest;
};

export const versionWire = (v: VersionSummary) => ({
  version: v.version,
  op: v.op,
  quality_score: v.qualityScore,
  quality_reasons: [...v.qualityReasons],
  created_at: iso(v.createdAtMs),
  is_current: v.isCurrent,
  thumbnail: link(v.thumbnail),
});
