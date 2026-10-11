import { defineMachine, guard } from "../state-machine/machine";
import { InvalidPrivacyInputError, NotYetExpirableError } from "./errors";

/**
 * DSAR export request (spec section 2 API, B1 Data subject rights).
 *
 *   requested -start-> collecting -complete-> ready -expire-> expired
 *   collecting -retry-> requested   (attempts left)
 *   collecting -abandon-> failed    (attempts exhausted)
 *
 * Product target: ready within 72 h of the request (B1). The download link is a signed URL valid
 * 24 h; the artifact itself is kept 7 days (inventory retention dsar_export_artifact).
 */
export const EXPORT_STATES = ["requested", "collecting", "ready", "expired", "failed"] as const;
export type ExportState = (typeof EXPORT_STATES)[number];

export const EXPORT_EVENTS = ["start", "complete", "retry", "abandon", "expire", "erase"] as const;
export type ExportEvent = (typeof EXPORT_EVENTS)[number];

export const EXPORT_READY_TARGET_MS = 72 * 3_600_000;
export const SIGNED_URL_TTL_SECONDS = 24 * 3_600;
export const EXPORT_ARTIFACT_RETENTION_MS = 7 * 86_400_000;
export const MAX_EXPORT_ATTEMPTS = 3;

export const EXPORT_LOCALES = ["ar", "en"] as const;
export type ExportLocale = (typeof EXPORT_LOCALES)[number];

export interface ExportCtx {
  /** Failed collection runs so far, including the one being decided. */
  readonly attempts: number;
}

export const exportMachine = defineMachine<ExportState, ExportEvent, ExportCtx>({
  name: "privacy.export_request",
  states: EXPORT_STATES,
  events: EXPORT_EVENTS,
  initial: "requested",
  terminal: ["expired", "failed"],
  transitions: {
    requested: { start: { to: "collecting" }, erase: { to: "expired" } },
    collecting: {
      erase: { to: "expired" },
      complete: { to: "ready" },
      retry: { to: "requested", guard: guard<ExportCtx>("attempts_left", (c) => c.attempts < MAX_EXPORT_ATTEMPTS) },
      abandon: { to: "failed", guard: guard<ExportCtx>("attempts_exhausted", (c) => c.attempts >= MAX_EXPORT_ATTEMPTS) },
    },
    ready: { expire: { to: "expired" }, erase: { to: "expired" } },
    expired: {},
    failed: {},
  },
});

export interface ExportRequest {
  readonly kind: "export";
  readonly id: string;
  readonly userId: string;
  readonly status: ExportState;
  readonly locale: ExportLocale;
  readonly requestedAtMs: number;
  readonly readyTargetAtMs: number;
  readonly attempts: number;
  readonly failureCode: string | null;
  /** Object-store key of the ZIP. Never a URL: URLs are signed on demand and expire in 24 h. */
  readonly objectRef: string | null;
  readonly completedAtMs: number | null;
  readonly artifactExpiresAtMs: number | null;
  readonly version: number;
  readonly updatedAtMs: number;
}

export function newExportRequest(
  input: { readonly id: string; readonly userId: string; readonly locale: ExportLocale },
  nowMs: number,
): ExportRequest {
  if (input.id.length === 0 || input.userId.length === 0) throw new InvalidPrivacyInputError("id and userId are required");
  if (!EXPORT_LOCALES.includes(input.locale)) throw new InvalidPrivacyInputError(`unsupported locale ${input.locale}`);
  return {
    kind: "export",
    id: input.id,
    userId: input.userId,
    status: exportMachine.initial,
    locale: input.locale,
    requestedAtMs: nowMs,
    readyTargetAtMs: nowMs + EXPORT_READY_TARGET_MS,
    attempts: 0,
    failureCode: null,
    objectRef: null,
    completedAtMs: null,
    artifactExpiresAtMs: null,
    version: 0,
    updatedAtMs: nowMs,
  };
}

const bump = (r: ExportRequest, nowMs: number, patch: Partial<ExportRequest>): ExportRequest => ({
  ...r,
  ...patch,
  version: r.version + 1,
  updatedAtMs: nowMs,
});

export function startExport(r: ExportRequest, nowMs: number): ExportRequest {
  const status = exportMachine.transition(r.status, "start", { attempts: r.attempts });
  return bump(r, nowMs, { status });
}

export function completeExport(r: ExportRequest, objectRef: string, nowMs: number): ExportRequest {
  if (objectRef.length === 0) throw new InvalidPrivacyInputError("objectRef is required");
  const status = exportMachine.transition(r.status, "complete", { attempts: r.attempts });
  return bump(r, nowMs, {
    status,
    objectRef,
    completedAtMs: nowMs,
    artifactExpiresAtMs: nowMs + EXPORT_ARTIFACT_RETENTION_MS,
    failureCode: null,
  });
}

/** Records one failed run: back to `requested` while attempts remain, else terminal `failed`. */
export function failExport(r: ExportRequest, failureCode: string, nowMs: number): ExportRequest {
  const attempts = r.attempts + 1;
  const event: ExportEvent = attempts < MAX_EXPORT_ATTEMPTS ? "retry" : "abandon";
  const status = exportMachine.transition(r.status, event, { attempts });
  return bump(r, nowMs, { status, attempts, failureCode });
}

export function expireExport(r: ExportRequest, nowMs: number): ExportRequest {
  const status = exportMachine.transition(r.status, "expire", { attempts: r.attempts });
  if (r.artifactExpiresAtMs === null || nowMs < r.artifactExpiresAtMs) throw new NotYetExpirableError("export artifact");
  return bump(r, nowMs, { status, objectRef: null });
}

/**
 * The subject was erased: the request ends now and any artifact reference is dropped, whatever the
 * retention clock says. The caller deletes the object itself BEFORE persisting this.
 */
export function expireExportForErasure(r: ExportRequest, nowMs: number): ExportRequest {
  const status = exportMachine.transition(r.status, "erase", { attempts: r.attempts });
  return bump(r, nowMs, { status, objectRef: null });
}

export function isExportTerminal(r: ExportRequest): boolean {
  return exportMachine.isTerminal(r.status);
}

/** True when the shopper may be handed a fresh signed URL. */
export function isDownloadable(r: ExportRequest, nowMs: number): boolean {
  return r.status === "ready" && r.objectRef !== null && r.artifactExpiresAtMs !== null && nowMs < r.artifactExpiresAtMs;
}

/** Past the 72 h readiness target without being ready (feeds the DPO queue). */
export function isExportOverdue(r: ExportRequest, nowMs: number): boolean {
  return (r.status === "requested" || r.status === "collecting") && nowMs > r.readyTargetAtMs;
}
