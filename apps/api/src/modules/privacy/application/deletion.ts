import { DomainError } from "@outlet/domain";
import type { Clock, IdGenerator } from "../../../platform/ports";
import {
  DEFAULT_COOLING_DAYS,
  beginErasure,
  cancelDeletion,
  completeErasure,
  deletionBlockers,
  erasureBackoffMs,
  expireExportForErasure,
  holdDeletion,
  isErasureParked,
  recordErasureFailure,
  planErasure,
  pseudonymFor,
  startDeletion,
  type DeletionBlocker,
  type DeletionRequest,
  type InventoryTable,
} from "../domain/bridge";
import { privacyEvents } from "../domain/events";
import type { BlockersPort, ErasureExecutorPort, PreErasureStepPort, PrivacyRequestRepository } from "../domain/ports";

export type RequestDeletionResult =
  | { readonly kind: "created" | "existing"; readonly request: DeletionRequest }
  | { readonly kind: "blocked"; readonly blockers: readonly DeletionBlocker[] }
  | { readonly kind: "forfeiture_ack_required"; readonly balanceMinor: bigint };

/** POST /v1/me/privacy/delete. */
export class RequestDeletion {
  constructor(
    private readonly repo: PrivacyRequestRepository,
    private readonly blockers: BlockersPort,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly coolingDays: number = DEFAULT_COOLING_DAYS,
  ) {}

  async execute(input: { readonly userId: string; readonly acknowledgedForfeiture: boolean }): Promise<RequestDeletionResult> {
    // A repeat of a request that is already running is answered with that request, not re-evaluated.
    const open = await this.repo.findLatest(input.userId, "delete");
    if (open !== null && open.status !== "cancelled" && open.status !== "completed") {
      return { kind: "existing", request: open };
    }
    const now = this.clock.nowMs();
    const result = startDeletion(
      { id: this.ids.uuidV7(), userId: input.userId, acknowledgedForfeiture: input.acknowledgedForfeiture },
      await this.blockers.snapshot(input.userId),
      now,
      this.coolingDays,
    );
    if (result.kind !== "ok") return result;
    const events = [privacyEvents.deletionRequested(this.ids.uuidV7(), result.request, now)];
    return this.repo.insertDeletion(result.request, events);
  }
}

export type CancelDeletionResult =
  | { readonly kind: "cancelled"; readonly request: DeletionRequest }
  | { readonly kind: "not_found" }
  | { readonly kind: "not_cancellable"; readonly status: string }
  | { readonly kind: "conflict" };

/** DELETE /v1/me/privacy/delete: cancel during the cooling period. */
export class CancelDeletion {
  constructor(
    private readonly repo: PrivacyRequestRepository,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async execute(input: { readonly userId: string }): Promise<CancelDeletionResult> {
    const r = await this.repo.findLatest(input.userId, "delete");
    if (r === null || r.status === "cancelled" || r.status === "completed") return { kind: "not_found" };
    const now = this.clock.nowMs();
    let next: DeletionRequest;
    try {
      next = cancelDeletion(r, now);
    } catch (e) {
      if (e instanceof DomainError) return { kind: "not_cancellable", status: r.status };
      throw e;
    }
    const outcome = await this.repo.update(next, [privacyEvents.deletionCancelled(this.ids.uuidV7(), next, now)]);
    return outcome === "ok" ? { kind: "cancelled", request: next } : { kind: "conflict" };
  }
}

/** GET /v1/me/privacy/delete: the user's current or latest deletion request. */
export class GetDeletion {
  constructor(private readonly repo: PrivacyRequestRepository) {}
  execute(input: { readonly userId: string }): Promise<DeletionRequest | null> {
    return this.repo.findLatest(input.userId, "delete");
  }
}

export class ErasureNotConfiguredError extends Error {}

export type ProcessDeletionResult =
  | { readonly kind: "completed" | "on_hold" | "still_blocked" | "skipped"; readonly request: DeletionRequest }
  | { readonly kind: "not_found" };

/**
 * Worker: after cooling, re-checks blockers (an order placed during cooling parks the request),
 * then applies the erasure plan derived from the inventory and completes. Fails closed when the
 * inventory is empty: erasing nothing and reporting success would be a false compliance claim.
 */
export class ProcessDeletions {
  constructor(
    private readonly repo: PrivacyRequestRepository,
    private readonly blockers: BlockersPort,
    private readonly executor: ErasureExecutorPort,
    private readonly inventory: () => readonly InventoryTable[],
    private readonly pseudonymHasher: (input: string) => string,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly preErasureSteps: readonly PreErasureStepPort[] = [],
  ) {}

  async execute(requestId: string): Promise<ProcessDeletionResult> {
    const found = await this.repo.get(requestId);
    if (found === null || found.kind !== "delete") return { kind: "not_found" };
    let r: DeletionRequest = found;
    const now = this.clock.nowMs();
    if (r.status === "cancelled" || r.status === "completed") return { kind: "skipped", request: r };
    // Parked after repeated erasure failures: needs the DPO, never retried automatically.
    if (isErasureParked(r)) return { kind: "still_blocked", request: r };
    if ((r.status === "cooling" || r.status === "on_hold") && now < r.coolingEndsAtMs) return { kind: "skipped", request: r };

    if (r.status === "cooling" || r.status === "on_hold") {
      const blockers = deletionBlockers(await this.blockers.snapshot(r.userId));
      if (blockers.length > 0) {
        if (r.status === "on_hold") return { kind: "still_blocked", request: r };
        const held = holdDeletion(r, blockers, now);
        const events = [privacyEvents.deletionOnHold(this.ids.uuidV7(), held, now)];
        return (await this.repo.update(held, events)) === "ok"
          ? { kind: "on_hold", request: held }
          : { kind: "skipped", request: r };
      }
      const erasing = beginErasure(r, now);
      if ((await this.repo.update(erasing, [])) !== "ok") return { kind: "skipped", request: r };
      r = erasing;
    }

    const plan = planErasure(this.inventory());
    if (plan.tables.length === 0) throw new ErasureNotConfiguredError("data inventory is empty; refusing to erase");
    // The subject's export ZIPs are personal data: the executor removes them as part of the erasure.
    const exports = await this.repo.listExportsForUser(r.userId);
    const artifactKeys = [
      ...new Set(exports.flatMap((e) => [`exports/${e.userId}/${e.id}.zip`, ...(e.objectRef === null ? [] : [e.objectRef])])),
    ];
    // Steps that need the user id run first; a failure here is retryable and stops the erasure before any row is touched.
    for (const step of this.preErasureSteps) await step.run(r.userId);
    await this.executor.execute({
      userId: r.userId,
      pseudonym: pseudonymFor(r.userId, this.pseudonymHasher),
      plan,
      artifactKeys,
    });
    await this.endExports(r.userId);
    const doneAt = this.clock.nowMs();
    const done = completeErasure(r, doneAt);
    const outcome = await this.repo.update(done, [privacyEvents.deletionCompleted(this.ids.uuidV7(), done, doneAt)]);
    return outcome === "ok" ? { kind: "completed", request: done } : { kind: "skipped", request: r };
  }

  /** Marks every non-terminal export of the erased subject expired (artifact already deleted). */
  private async endExports(userId: string): Promise<void> {
    for (let pass = 0; pass < 2; pass += 1) {
      let conflict = false;
      for (const e of await this.repo.listExportsForUser(userId)) {
        if (e.status === "expired" || e.status === "failed") continue;
        const next = expireExportForErasure(e, this.clock.nowMs());
        if ((await this.repo.update(next, [])) === "conflict") conflict = true;
      }
      if (!conflict) return;
    }
    throw new Error("export requests of the erased subject kept changing; will retry");
  }

  /**
   * Each due request is isolated: one failure is recorded (attempt + backoff + outbox event used as
   * the metric) and the loop continues. After MAX_ERASURE_ATTEMPTS the request is parked `on_hold`
   * with a failure code for the DPO.
   */
  async runDue(limit = 20): Promise<readonly ProcessDeletionResult[]> {
    const out: ProcessDeletionResult[] = [];
    const candidates = await this.repo.listDueDeletions(this.clock.nowMs(), limit * 5);
    for (const c of candidates) {
      if (out.length >= limit) break;
      const now = this.clock.nowMs();
      if (c.attempts > 0 && now < c.updatedAtMs + erasureBackoffMs(c.attempts)) continue;
      try {
        out.push(await this.execute(c.id));
      } catch {
        out.push(await this.recordFailure(c.id));
      }
    }
    return out;
  }

  private async recordFailure(id: string): Promise<ProcessDeletionResult> {
    try {
      const cur = await this.repo.get(id);
      if (cur === null || cur.kind !== "delete") return { kind: "not_found" };
      if (cur.status === "completed" || cur.status === "cancelled") return { kind: "skipped", request: cur };
      const now = this.clock.nowMs();
      const failed = recordErasureFailure(cur, now);
      await this.repo.update(failed, [privacyEvents.deletionErasureFailed(this.ids.uuidV7(), failed, now)]);
      return { kind: failed.status === "on_hold" ? "on_hold" : "skipped", request: failed };
    } catch {
      // The store itself is failing; the next sweep retries. Never let this stop the loop.
      return { kind: "not_found" };
    }
  }
}
