import type {
  BackgroundRemovalPort,
  Clock,
  IdPort,
  ProductMediaBlobPort,
  ProductMediaConsentPort,
  ProductMediaFlagPort,
  ProductMediaJob,
  ProductMediaStore,
} from "../domain/ports";

export interface ProductMediaConfig {
  readonly maxBytes: number;
  readonly maxDimension: number;
  /** Background-removal runs (first runs and re-runs) per store per UTC day. */
  readonly dailyRuns: number;
  readonly maxAttemptsPerJob: number;
  readonly signedGetTtlSeconds: number;
  readonly cutoutTimeoutMs: number;
  readonly listLimit: number;
  /** Refine (sidecar) timeout. */
  readonly refineTimeoutMs: number;
}

export const DEFAULT_PRODUCT_MEDIA_CONFIG: ProductMediaConfig = {
  maxBytes: 12 * 1024 * 1024,
  maxDimension: 4096,
  dailyRuns: 200,
  maxAttemptsPerJob: 5,
  signedGetTtlSeconds: 600,
  cutoutTimeoutMs: 30_000,
  listLimit: 50,
  refineTimeoutMs: 30_000,
};

export interface ProductMediaDeps {
  readonly store: ProductMediaStore;
  readonly blobs: ProductMediaBlobPort;
  readonly removal: BackgroundRemovalPort;
  readonly flags: ProductMediaFlagPort;
  readonly consent: ProductMediaConsentPort;
  readonly clock: Clock;
  readonly ids: IdPort;
  readonly cfg: ProductMediaConfig;
}

export const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export async function flagOn(flags: ProductMediaFlagPort, key: string): Promise<boolean> {
  try {
    return await flags.isEnabled(key);
  } catch {
    return false; // fail closed
  }
}

export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

export interface SignedLink {
  readonly url: string;
  readonly expiresAtMs: number;
}
export interface JobView {
  readonly job: ProductMediaJob;
  /** Signed, short-lived links. Only present for outputs that exist; never public. */
  readonly links: {
    readonly original: SignedLink | null;
    readonly png: SignedLink | null;
    readonly whiteJpg: SignedLink | null;
    readonly shadow: SignedLink | null;
    readonly backgroundRender: SignedLink | null;
  };
}

export async function viewOf(d: ProductMediaDeps, job: ProductMediaJob): Promise<JobView> {
  const sign = async (key: string | null, enabled = true): Promise<SignedLink | null> => {
    if (key === null || !enabled || !d.blobs.configured) return null;
    try {
      return await d.blobs.signGet(key, d.cfg.signedGetTtlSeconds);
    } catch {
      return null;
    }
  };
  const hasOutputs = job.status === "READY" || job.status === "NEEDS_REVIEW";
  return {
    job,
    links: {
      original: await sign(job.originalRef),
      png: await sign(job.pngRef, hasOutputs),
      whiteJpg: await sign(job.whiteJpgRef, hasOutputs),
      shadow: await sign(job.shadowRef, hasOutputs),
      backgroundRender: await sign(job.backgroundRenderRef, hasOutputs),
    },
  };
}
