import { createIdGenerator, nodeCsprng } from "../../../platform";
import type { Clock } from "../../../platform/ports";
import { FakeEtaSource, FakeIntegrity, FakeLedgerClearing, FakeReconAlerts, FakeReconFlags, FixtureSettlementFilePort } from "../adapters/fakes";
import { IngestSettlementFile } from "../application/ingest";
import { FinanceReconReadModel } from "../application/queries";
import { RunReconciliation, ScheduleReconciliation } from "../application/run";
import type { ReconStore } from "../domain/ports";
import { SETTLEMENT_CSV_HEADER } from "../domain/bridge";

export const DAY = 86_400_000;
/** Wednesday 2026-10-14 03:30 Cairo (00:30 UTC): after the 02:00 nightly hour. */
export const T0 = Date.UTC(2026, 9, 14, 0, 30, 0);

export class TestClock implements Clock {
  constructor(private ms = T0) {}
  nowMs(): number {
    return this.ms;
  }
  advance(ms: number): void {
    this.ms += ms;
  }
  set(ms: number): void {
    this.ms = ms;
  }
}

export const U = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const FINANCE = U(31);
export const OPS = U(41);

export interface Kit {
  readonly store: ReconStore;
  readonly clock: TestClock;
  readonly clearing: FakeLedgerClearing;
  readonly eta: FakeEtaSource;
  readonly integrity: FakeIntegrity;
  readonly alerts: FakeReconAlerts;
  readonly flags: FakeReconFlags;
  readonly ingest: IngestSettlementFile;
  readonly runner: RunReconciliation;
  readonly scheduler: ScheduleReconciliation;
  readonly read: FinanceReconReadModel;
}

export function kit(store: ReconStore, clock: TestClock): Kit {
  const clearing = new FakeLedgerClearing();
  const eta = new FakeEtaSource();
  const integrity = new FakeIntegrity();
  const alerts = new FakeReconAlerts();
  const flags = new FakeReconFlags();
  const ids = createIdGenerator(clock, nodeCsprng);
  const deps = { store, clearing, eta, integrity, alerts, flags, clock, ids };
  const runner = new RunReconciliation(deps);
  return {
    store,
    clock,
    clearing,
    eta,
    integrity,
    alerts,
    flags,
    ingest: new IngestSettlementFile(store, new FixtureSettlementFilePort(), clock, ids),
    runner,
    scheduler: new ScheduleReconciliation(deps, runner),
    read: new FinanceReconReadModel(store),
  };
}

export interface CsvLine {
  readonly no: number;
  readonly kind?: "capture" | "refund" | "chargeback" | "remittance" | "adjustment";
  readonly ref: string;
  readonly gross: bigint;
  readonly fee?: bigint;
  readonly at: number;
}

/** Fixture-format file with a correct TOTAL row. */
export function csv(settlementId: string, lines: readonly CsvLine[], provider = "fakepay"): string {
  let g = 0n;
  let f = 0n;
  const rows = lines.map((l) => {
    const fee = l.fee ?? 0n;
    g += l.gross;
    f += fee;
    return [settlementId, provider, l.no, l.kind ?? (l.gross < 0n ? "refund" : "capture"), l.ref, l.gross, fee, l.gross - fee, "EGP", new Date(l.at).toISOString().replace(".000Z", "Z")].join(",");
  });
  return [SETTLEMENT_CSV_HEADER, ...rows, `TOTAL,,,,,${g},${f},${g - f},EGP,`].join("\n");
}
