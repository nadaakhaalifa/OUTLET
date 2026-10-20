import { sha256Hex } from "@outlet/idempotency";
import { headerValue, type ApiRequest, type ApiResponse } from "./http-types";
import { ProblemError, Problems } from "./problem";

/**
 * Anonymous catalog reads (`/v1/public/*`, spec P3-06). Shared mechanics only: the kill switch,
 * CDN cache headers and conditional GET. Each module owns its own allow-listed projection.
 */
export interface PublicReadGate {
  /** True when the anonymous catalog surface may answer (`kill.public_catalog`, ADR-0028 polarity). */
  enabled(): Promise<boolean>;
}

/** Fails closed: a gate that throws or says no answers 503 and nothing is read. */
export async function assertPublicReadEnabled(gate: PublicReadGate): Promise<void> {
  const on = await gate.enabled().catch(() => false);
  if (!on) throw Problems.unavailable("public_catalog_disabled");
}

/**
 * Guest browsing release flag (`flag.guest_browsing`, ADR-0055). Blocked, throwing or slow-to-fail all answer 404:
 * while the flag is off the guest-only routes do not exist as far as a client can tell, and nothing is read.
 */
export async function assertGuestBrowsingEnabled(gate: PublicReadGate): Promise<void> {
  const on = await gate.enabled().catch(() => false);
  if (!on) throw Problems.notFound();
}

/** CDN windows per resource class (seconds). The PDP price budget is 5 s (spec 5), lists 60 s (spec 4). */
export const PUBLIC_CACHE = {
  product: { sMaxAge: 5, staleWhileRevalidate: 5 },
  store: { sMaxAge: 60, staleWhileRevalidate: 30 },
  search: { sMaxAge: 30, staleWhileRevalidate: 30 },
  sitemap: { sMaxAge: 300, staleWhileRevalidate: 60 },
  /** Platform-owned taxonomy: changes by migration only (spec 3, 4). */
  category: { sMaxAge: 300, staleWhileRevalidate: 60 },
  /** Guest browsing (ADR-0055): non-personalised feed, banners and prefix suggestions, same for every caller. */
  feed: { sMaxAge: 30, staleWhileRevalidate: 30 },
  banners: { sMaxAge: 30, staleWhileRevalidate: 30 },
  suggest: { sMaxAge: 30, staleWhileRevalidate: 30 },
} as const;

export interface PublicCachePolicy {
  readonly sMaxAge: number;
  readonly staleWhileRevalidate: number;
}

const etagOf = (wire: unknown): string => `"${sha256Hex(JSON.stringify(wire)).slice(0, 32)}"`;
const tokens = (h: string): string[] => h.split(",").map((t) => t.trim().replace(/^W\//, ""));

/**
 * Sets ETag and a shared-cache policy (no private data exists in these bodies, so `public` is safe;
 * `max-age=0` keeps browsers revalidating) and answers 304 on a matching If-None-Match.
 * Never sets a cookie and never varies on credentials.
 */
export function respondPublic<T>(req: ApiRequest, res: ApiResponse, wire: T, policy: PublicCachePolicy): T {
  const etag = etagOf(wire);
  res.setHeader("ETag", etag);
  res.setHeader(
    "Cache-Control",
    `public, max-age=0, s-maxage=${policy.sMaxAge}, stale-while-revalidate=${policy.staleWhileRevalidate}`,
  );
  const inm = headerValue(req, "if-none-match");
  if (inm !== undefined && tokens(inm).some((t) => t === etag || t === "*")) {
    throw new ProblemError(304, "not-modified", "Not modified");
  }
  return wire;
}

export const gone = (): ProblemError => new ProblemError(410, "gone", "This resource is no longer available", { code: "gone" });
