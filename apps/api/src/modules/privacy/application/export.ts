import type { Clock, IdGenerator } from "../../../platform/ports";
import {
  SIGNED_URL_TTL_SECONDS,
  completeExport,
  expireExport,
  failExport,
  isDownloadable,
  newExportRequest,
  startExport,
  type ExportLocale,
  type ExportRequest,
} from "../domain/bridge";
import { privacyEvents } from "../domain/events";
import type { ObjectStorePort, PrivacyRequestRepository, SignedUrl } from "../domain/ports";
import { assembleExportZip } from "./bundle";
import type { ExporterRegistry } from "./exporters";

export type RequestExportResult =
  | { readonly kind: "created"; readonly request: ExportRequest }
  | { readonly kind: "existing"; readonly request: ExportRequest };

/** POST /v1/me/privacy/export. One open export per user: a repeat returns the open one (idempotent). */
export class RequestExport {
  constructor(
    private readonly repo: PrivacyRequestRepository,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async execute(input: { readonly userId: string; readonly locale: ExportLocale }): Promise<RequestExportResult> {
    const now = this.clock.nowMs();
    const request = newExportRequest({ id: this.ids.uuidV7(), userId: input.userId, locale: input.locale }, now);
    return this.repo.insertExport(request, [privacyEvents.exportRequested(this.ids.uuidV7(), request, now)]);
  }
}

export interface ExportView {
  readonly request: ExportRequest;
  /** Fresh signed URL (24 h) while the artifact is available, else null. */
  readonly download: SignedUrl | null;
}

/** GET /v1/me/privacy/export/{id}. Not found and not owned are indistinguishable (null). */
export class GetExport {
  constructor(
    private readonly repo: PrivacyRequestRepository,
    private readonly store: ObjectStorePort,
    private readonly clock: Clock,
  ) {}

  async execute(input: { readonly userId: string; readonly id: string }): Promise<ExportView | null> {
    const r = await this.repo.get(input.id);
    if (r === null || r.kind !== "export" || r.userId !== input.userId) return null;
    const now = this.clock.nowMs();
    if (!isDownloadable(r, now) || r.objectRef === null) return { request: r, download: null };
    return { request: r, download: await this.store.signGetUrl(r.objectRef, SIGNED_URL_TTL_SECONDS, now) };
  }
}

export type ProcessExportResult =
  | { readonly kind: "ready"; readonly request: ExportRequest }
  | { readonly kind: "retry" | "failed"; readonly request: ExportRequest }
  | { readonly kind: "skipped" | "not_found" };

/** Worker: collects, zips, stores. Safe to run concurrently: only the claimant (CAS on version) proceeds. */
export class ProcessExport {
  constructor(
    private readonly repo: PrivacyRequestRepository,
    private readonly registry: ExporterRegistry,
    private readonly store: ObjectStorePort,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async execute(requestId: string): Promise<ProcessExportResult> {
    const found = await this.repo.get(requestId);
    if (found === null || found.kind !== "export") return { kind: "not_found" };
    if (found.status !== "requested") return { kind: "skipped" };
    const claimed = startExport(found, this.clock.nowMs());
    if ((await this.repo.update(claimed, [])) !== "ok") return { kind: "skipped" };

    try {
      const collected = await this.registry.collect(claimed.userId);
      const { bytes } = assembleExportZip({ collected, locale: claimed.locale, generatedAtMs: this.clock.nowMs() });
      const key = `exports/${claimed.userId}/${claimed.id}.zip`;
      await this.store.put(key, bytes, "application/zip");
      const now = this.clock.nowMs();
      const done = completeExport(claimed, key, now);
      const outcome = await this.repo.update(done, [privacyEvents.exportReady(this.ids.uuidV7(), done, now)]);
      if (outcome !== "ok") {
        await this.store.delete(key);
        return { kind: "skipped" };
      }
      return { kind: "ready", request: done };
    } catch (e) {
      const now = this.clock.nowMs();
      const failed = failExport(claimed, e instanceof Error ? "exporter_error" : "unknown_error", now);
      const outcome = await this.repo.update(failed, [privacyEvents.exportFailed(this.ids.uuidV7(), failed, now)]);
      if (outcome !== "ok") return { kind: "skipped" };
      return { kind: failed.status === "failed" ? "failed" : "retry", request: failed };
    }
  }

  /** Picks up requests waiting in `requested` (new or retrying). */
  async runDue(limit = 20): Promise<readonly ProcessExportResult[]> {
    const pending = await this.repo.listPendingExports(limit);
    const out: ProcessExportResult[] = [];
    for (const r of pending) out.push(await this.execute(r.id));
    return out;
  }
}

/** Removes artifacts after their 7-day retention (inventory retention dsar_export_artifact). */
export class ExpireExports {
  constructor(
    private readonly repo: PrivacyRequestRepository,
    private readonly store: ObjectStorePort,
    private readonly clock: Clock,
  ) {}

  async run(limit = 50): Promise<number> {
    const now = this.clock.nowMs();
    let expired = 0;
    for (const r of await this.repo.listExpiredExports(now, limit)) {
      // Delete first: if the state update loses a race the next sweep deletes again (idempotent).
      if (r.objectRef !== null) await this.store.delete(r.objectRef);
      if ((await this.repo.update(expireExport(r, now), [])) === "ok") expired += 1;
    }
    return expired;
  }
}
