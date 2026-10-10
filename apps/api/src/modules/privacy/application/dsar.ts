import { DomainError } from "@outlet/domain";
import type { Clock, IdGenerator } from "../../../platform/ports";
import {
  breachClocks,
  buildDsarQueue,
  closeBreach,
  notifyPdpc,
  notifySubjects,
  recordBreach,
  triageBreach,
  type BreachClocks,
  type BreachEntry,
  type BreachSeverity,
  type DpoDecision,
  type DsarKind,
  type DsarQueue,
} from "../domain/bridge";
import { privacyEvents } from "../domain/events";
import type { BreachRepository, PrivacyRequestRepository } from "../domain/ports";

/** Safety cap on open rows read for the summary; the open set is small by construction. */
const OPEN_QUEUE_CAP = 10_000;

/** DSAR queue read model for the DPO. */
export class ListDsarQueue {
  constructor(
    private readonly repo: PrivacyRequestRepository,
    private readonly clock: Clock,
  ) {}

  async execute(input: {
    readonly kind?: DsarKind;
    readonly overdueOnly?: boolean;
    readonly includeClosed?: boolean;
    readonly limit?: number;
  }): Promise<DsarQueue> {
    const limit = Math.min(input.limit ?? 200, 500);
    // ALL open rows (filtered in the repository, oldest/most overdue first) feed the summary and the
    // overdue ordering; `limit` only trims the returned items, so old open requests are never hidden.
    const open = await this.repo.listForQueue(OPEN_QUEUE_CAP);
    const closed = input.includeClosed === true ? await this.repo.listRecentClosed(limit) : [];
    const built = buildDsarQueue([...open, ...closed], this.clock.nowMs(), {
      ...(input.kind !== undefined ? { kind: input.kind } : {}),
      ...(input.overdueOnly !== undefined ? { overdueOnly: input.overdueOnly } : {}),
      ...(input.includeClosed !== undefined ? { includeClosed: input.includeClosed } : {}),
    });
    return { items: built.items.slice(0, limit), summary: built.summary };
  }
}

export interface BreachView {
  readonly entry: BreachEntry;
  readonly clocks: BreachClocks;
}

export type BreachAction = "triage" | "notify_pdpc" | "notify_subjects" | "close";

export type BreachResult =
  | { readonly kind: "ok"; readonly view: BreachView }
  | { readonly kind: "not_found" }
  | { readonly kind: "invalid_transition" }
  | { readonly kind: "conflict" };

export class BreachRegister {
  constructor(
    private readonly repo: BreachRepository,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async record(input: {
    readonly detectedAtMs: number;
    readonly severity: BreachSeverity;
    readonly summary: string;
    readonly affectedCount: number;
  }): Promise<BreachView> {
    const now = this.clock.nowMs();
    const entry = recordBreach({ id: this.ids.uuidV7(), ...input }, now);
    await this.repo.insert(entry, [privacyEvents.breachRecorded(this.ids.uuidV7(), entry, now)]);
    return { entry, clocks: breachClocks(entry, now) };
  }

  async list(limit = 100): Promise<readonly BreachView[]> {
    const now = this.clock.nowMs();
    return (await this.repo.list(limit)).map((entry) => ({ entry, clocks: breachClocks(entry, now) }));
  }

  async advance(id: string, action: BreachAction, decision?: DpoDecision): Promise<BreachResult> {
    const current = await this.repo.get(id);
    if (current === null) return { kind: "not_found" };
    const now = this.clock.nowMs();
    let next: BreachEntry;
    try {
      if (action === "triage") {
        if (decision === undefined) return { kind: "invalid_transition" };
        next = triageBreach(current, decision, now);
      } else if (action === "notify_pdpc") next = notifyPdpc(current, now);
      else if (action === "notify_subjects") next = notifySubjects(current, now);
      else next = closeBreach(current, now);
    } catch (e) {
      if (e instanceof DomainError) return { kind: "invalid_transition" };
      throw e;
    }
    const outcome = await this.repo.update(next, [privacyEvents.breachAdvanced(this.ids.uuidV7(), next, now)]);
    if (outcome === "not_found") return { kind: "not_found" };
    if (outcome === "conflict") return { kind: "conflict" };
    return { kind: "ok", view: { entry: next, clocks: breachClocks(next, now) } };
  }
}
