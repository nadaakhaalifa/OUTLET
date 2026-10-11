import type { Clock } from "../../ports";
import type { KyselyInboxStore } from "../outbox-store";
import type { KyselyTransactionRunner } from "../unit-of-work";
import type { RlsSession } from "../deps";
import type { ConsentChange, KyselyConsentStore } from "./consent-store";

export type RecordConsentOutcome = "recorded" | "duplicate";

/**
 * REFERENCE USE CASE: one transaction that (1) claims the request id in the
 * inbox (idempotent insert), (2) appends the consent row, (3) writes the
 * `consent.changed` outbox event. All three commit or none does.
 * The event carries NO personal data (purpose, version, granted only).
 */
export class RecordConsentChange {
  public constructor(
    private readonly runner: KyselyTransactionRunner,
    private readonly store: KyselyConsentStore,
    private readonly inbox: KyselyInboxStore,
    private readonly clock: Clock,
  ) {}

  public execute(input: {
    readonly requestId: string;
    readonly session: RlsSession;
    readonly change: Omit<ConsentChange, "at">;
  }): Promise<RecordConsentOutcome> {
    return this.runner.run({ session: input.session, process: "privacy.consent_change" }, async (tx) => {
      const at = new Date(this.clock.nowMs());
      const fresh = await this.inbox.tryRecord(tx, "reference.consent_change", input.requestId, at);
      if (!fresh) return "duplicate";
      await this.store.append(tx, { ...input.change, at });
      await tx.emit({
        aggregateType: "consent_subject",
        aggregateId: input.change.subjectId,
        eventType: "consent.changed",
        payload: { purpose: input.change.purpose, granted: input.change.granted, version: input.change.version },
      });
      return "recorded";
    });
  }
}
