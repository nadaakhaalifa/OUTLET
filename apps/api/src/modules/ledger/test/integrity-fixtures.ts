import { sha256Hex } from "@outlet/idempotency";
import { createIdGenerator, nodeCsprng } from "../../../platform";
import type { IntegrityJobReport } from "../application/integrity-job";
import { RecordIntegrityRun, type RecorderDeps } from "../application/integrity-recorder";
import type { IntegrityRunKind } from "../domain/integrity-runs";
import type { IntegrityRunStore } from "../domain/ports";

export const uid = (n: number): string => `0192f3a4-5b6c-7d8e-9f01-${String(n).padStart(12, "0")}`;
export const HEAD = "a".repeat(64);

export class FakeClock {
  constructor(public ms = Date.UTC(2026, 9, 29, 0, 30)) {}
  nowMs(): number {
    return this.ms;
  }
  advance(ms: number): void {
    this.ms += ms;
  }
}

export const okReport = (over: Partial<IntegrityJobReport> = {}): IntegrityJobReport => ({
  ok: true,
  trialBalance: { ok: true, offenders: [] },
  chain: { ok: true, length: 12, headHash: HEAD },
  storeCredit: { drift: [], negative: [] },
  ...over,
});

export const driftRow = (n: number, difference: bigint) => ({
  userId: uid(n),
  sub: "refund_credit",
  projected: 1000n,
  fromPostings: 1000n - difference,
  difference,
});

export const failedReport = (): IntegrityJobReport =>
  okReport({
    ok: false,
    trialBalance: { ok: false, offenders: [{ currency: "EGP", total: -5n }] },
    chain: { ok: false, seq: 7n, entryId: uid(77), reason: "entry_hash_mismatch" },
    storeCredit: { drift: [driftRow(1, 10n)], negative: [] },
  });

export interface Counters {
  runs: string[];
  auditFailed: number;
  logs: { event: string; attemptId: string }[];
}

export const recorderFor = (
  store: IntegrityRunStore,
  clock: FakeClock,
  job: { run(): Promise<IntegrityJobReport> },
  over: Partial<RecorderDeps> = {},
): { recorder: RecordIntegrityRun; counters: Counters } => {
  const counters: Counters = { runs: [], auditFailed: 0, logs: [] };
  const recorder = new RecordIntegrityRun({
    job,
    store,
    clock,
    ids: createIdGenerator(clock, nodeCsprng),
    sha256: sha256Hex,
    metrics: { run: (o) => counters.runs.push(o), auditFailed: () => (counters.auditFailed += 1) },
    log: (event, f) => counters.logs.push({ event, attemptId: f.attemptId }),
    sleep: async () => undefined,
    random: () => 0.5,
    ...over,
  });
  return { recorder, counters };
};

export type { IntegrityRunKind };
