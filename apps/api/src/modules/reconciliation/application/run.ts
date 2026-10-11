import type { Clock, IdGenerator } from "../../../platform/ports";
import {
  MS_PER_DAY,
  MS_PER_HOUR,
  cairoDateKey,
  planTickets,
  reconcileAcrossFiles,
  reconcileEta,
  reconcileSettlementFile,
  reconcileStoreCredit,
  reconcileTrialBalance,
  rejectedFileFinding,
  reconciliationDue,
  suiteFailedFinding,
  type Finding,
  type ReconSource,
  type ReconSchedule,
  type SettlementFileSource,
} from "../domain/bridge";
import type {
  EtaSourcePort,
  FileKind,
  IntegrityPort,
  LedgerClearingPort,
  OutboxEventDraft,
  ReconAlertPort,
  ReconFlagsPort,
  ReconStore,
  RunRecord,
  TicketUpsert,
} from "../domain/ports";

export interface ReconDeps {
  readonly store: ReconStore;
  readonly clearing: LedgerClearingPort;
  readonly eta: EtaSourcePort;
  readonly integrity: IntegrityPort;
  readonly alerts: ReconAlertPort;
  readonly flags: ReconFlagsPort;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly schedule?: ReconSchedule;
}

export type RunMode = "nightly" | "intraday";

export type RunResult =
  | {
      readonly kind: "completed";
      readonly runId: string;
      readonly mode: RunMode;
      readonly findings: number;
      readonly opened: number;
      readonly escalated: number;
      readonly resolved: number;
      readonly alertFailures: number;
      readonly ok: boolean;
    }
  | { readonly kind: "already_ran" };

const SOURCE_OF_FILE: Readonly<Record<FileKind, SettlementFileSource>> = {
  psp: "psp_settlement",
  cod: "cod_remittance",
  bnpl: "bnpl_settlement",
};

/** Nightly looks back 30 days of files, intraday 24 hours (spec reconciliation C6). */
const WINDOW_MS: Readonly<Record<RunMode, number>> = { nightly: 30 * MS_PER_DAY, intraday: 24 * MS_PER_HOUR };

/**
 * Builds findings from every suite, upserts tickets and raises alerts. Read-only on money: it never
 * posts. A suite that throws becomes a critical `suite_failed` finding and the others still run.
 * Auto-resolution only touches tickets this run actually re-evaluated (nightly, item inside the
 * window, suite ran), so a narrow or failed run never closes tickets it did not look at.
 */
export class RunReconciliation {
  constructor(private readonly d: ReconDeps) {}

  async execute(mode: RunMode): Promise<RunResult> {
    const startedAtMs = this.d.clock.nowMs();
    const windowFromMs = startedAtMs - WINDOW_MS[mode];
    const findings: Finding[] = [];
    const evaluated = new Set<ReconSource>();
    const failedSuites = new Set<string>();

    const suite = async (name: string, sources: readonly ReconSource[], fn: () => Promise<Finding[]>): Promise<void> => {
      try {
        findings.push(...(await fn()));
        for (const s of sources) evaluated.add(s);
      } catch {
        failedSuites.add(name);
        findings.push(suiteFailedFinding(name, startedAtMs));
      }
    };

    const files = await this.d.store.parsedFilesSince(windowFromMs);
    for (const kind of ["psp", "cod", "bnpl"] as const) {
      const source = SOURCE_OF_FILE[kind];
      const ofKind = files.filter((f) => f.kind === kind);
      let ok = true;
      for (const f of ofKind) {
        await suite(`file:${f.kind}:${f.provider}:${f.settlementId}`, [], async () => {
          const occurred = f.lines.map((l) => l.occurredAtMs);
          const fromMs = Math.min(...occurred) - MS_PER_DAY;
          const toMs = Math.max(...occurred) + MS_PER_DAY;
          const internal = await this.d.clearing.clearingLines({ kind: f.kind, party: f.provider, fromMs, toMs });
          const posted = await this.d.clearing.postedSettlement({ kind: f.kind, party: f.provider, settlementId: f.settlementId });
          return [
            ...reconcileSettlementFile({
              source,
              file: {
                settlementId: f.settlementId,
                provider: f.provider,
                lines: f.lines,
                totals: { gross: f.gross ?? 0n, fee: f.fee ?? 0n, net: f.net ?? 0n },
              },
              internal,
              posted,
            }).findings,
          ];
        });
        if (failedSuites.has(`file:${f.kind}:${f.provider}:${f.settlementId}`)) ok = false;
      }
      await suite(`cross_file:${kind}`, [], async () =>
        reconcileAcrossFiles(
          source,
          ofKind.map((f) => ({
            settlementId: f.settlementId,
            provider: f.provider,
            lines: f.lines,
            totals: { gross: f.gross ?? 0n, fee: f.fee ?? 0n, net: f.net ?? 0n },
          })),
        ),
      );
      if (failedSuites.has(`cross_file:${kind}`)) ok = false;
      if (ok) evaluated.add(source);
    }

    for (const r of await this.d.store.rejectedFilesSince(windowFromMs)) {
      findings.push(rejectedFileFinding(SOURCE_OF_FILE[r.kind], r.id, r.errorCodes, r.receivedAtMs));
    }

    await suite("eta", ["eta_submission"], async () =>
      reconcileEta({
        internal: await this.d.eta.internal(windowFromMs),
        reported: await this.d.eta.reported(windowFromMs),
        nowMs: startedAtMs,
      }),
    );
    await suite("store_credit", ["store_credit"], async () =>
      reconcileStoreCredit({
        projection: await this.d.integrity.projection(),
        balances: await this.d.integrity.balances(),
        nowMs: startedAtMs,
      }),
    );
    await suite("trial_balance", ["trial_balance"], async () =>
      reconcileTrialBalance(await this.d.integrity.totals(), startedAtMs),
    );

    const live = await this.d.store.liveTickets();
    const plan = planTickets(
      findings,
      new Map(live.map((t) => [t.dedupeKey, t] as const)),
      startedAtMs,
    );
    const liveByKey = new Map(live.map((t) => [t.dedupeKey, t] as const));
    // Nightly only, and only tickets of suites that ran over an item inside the window.
    const resolveKeys =
      mode === "nightly"
        ? plan.resolved.filter((key) => {
            const t = liveByKey.get(key);
            return t !== undefined && evaluated.has(t.source) && t.itemAtMs >= windowFromMs;
          })
        : [];

    const upserts: TicketUpsert[] = [];
    const opened = new Set(plan.opened.map((f) => f.dedupeKey));
    const escalated = new Set(plan.escalated.map((f) => f.dedupeKey));
    const ticketIds = new Map<string, string>();
    for (const f of [...plan.opened, ...plan.escalated, ...plan.continuing]) {
      if (ticketIds.has(f.dedupeKey)) continue;
      const status = plan.statusByKey.get(f.dedupeKey) ?? "open";
      const id = liveByKey.get(f.dedupeKey)?.id ?? this.d.ids.uuidV7();
      ticketIds.set(f.dedupeKey, id);
      upserts.push({ id, finding: f, status });
    }

    const finishedAtMs = this.d.clock.nowMs();
    const runId = this.d.ids.uuidV7();
    const run: RunRecord = {
      id: runId,
      mode,
      nightlyKey: mode === "nightly" ? cairoDateKey(startedAtMs) : null,
      startedAtMs,
      finishedAtMs,
      windowFromMs,
      windowToMs: startedAtMs,
      findingCount: findings.length,
      opened: opened.size,
      escalated: escalated.size,
      resolved: resolveKeys.length,
      ok: findings.length === 0,
    };
    const event = (type: string, aggregateId: string, payload: OutboxEventDraft["payload"]): OutboxEventDraft => ({
      id: this.d.ids.uuidV7(),
      type,
      aggregateId,
      occurredAtMs: finishedAtMs,
      payload,
    });
    const events: OutboxEventDraft[] = [event("reconciliation.run_completed", runId, { mode, findings: findings.length, ok: run.ok })];
    const payloadOf = (f: Finding): OutboxEventDraft["payload"] => ({
      source: f.source,
      kind: f.kind,
      severity: f.severity,
      ref: f.ref,
      delta: f.delta.toString(),
    });
    for (const f of plan.opened) events.push(event("reconciliation.ticket_opened", ticketIds.get(f.dedupeKey) ?? runId, payloadOf(f)));
    for (const f of plan.escalated) {
      events.push(event("reconciliation.ticket_escalated", ticketIds.get(f.dedupeKey) ?? runId, payloadOf(f)));
    }
    for (const key of resolveKeys) events.push(event("reconciliation.ticket_resolved", runId, { dedupe_key: key }));

    const committed = await this.d.store.commitRun({ run, upserts, resolveKeys, events });
    if (committed.kind === "already_ran") return { kind: "already_ran" };

    // Alerts go after the commit. A failing channel never undoes tickets; the open list is the source.
    let alertFailures = 0;
    const alertFor = async (type: "ticket_opened" | "ticket_escalated", f: Finding): Promise<void> => {
      try {
        await this.d.alerts.notify({
          type,
          ticketId: ticketIds.get(f.dedupeKey) ?? "",
          source: f.source,
          kind: f.kind,
          severity: f.severity,
          ref: f.ref,
          amountDelta: f.delta,
        });
      } catch {
        alertFailures += 1;
      }
    };
    for (const f of plan.opened) await alertFor("ticket_opened", f);
    for (const f of plan.escalated) await alertFor("ticket_escalated", f);

    return {
      kind: "completed",
      runId,
      mode,
      findings: findings.length,
      opened: opened.size,
      escalated: escalated.size,
      resolved: resolveKeys.length,
      alertFailures,
      ok: run.ok,
    };
  }
}

/** Decides which runs are due and runs them. A use case: nothing calls `tick` yet (the integrator wires a job). */
export class ScheduleReconciliation {
  constructor(
    private readonly d: ReconDeps,
    private readonly runner: RunReconciliation,
  ) {}

  async tick(): Promise<readonly RunResult[]> {
    const nowMs = this.d.clock.nowMs();
    const due = reconciliationDue({
      nowMs,
      lastNightlyKey: await this.d.store.lastNightlyKey(),
      lastIntradayAtMs: await this.d.store.lastIntradayAtMs(),
      intradayEnabled: await this.d.flags.intradayEnabled(),
      ...(this.d.schedule !== undefined ? { schedule: this.d.schedule } : {}),
    });
    const out: RunResult[] = [];
    if (due.nightly) out.push(await this.runner.execute("nightly"));
    if (due.intraday) out.push(await this.runner.execute("intraday"));
    return out;
  }
}
