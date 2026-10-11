import {
  GENESIS_HASH,
  checkTrialBalance,
  storeCreditDrift,
  verifyChain,
  type ChainVerification,
  type DriftRow,
  type Sha256Hex,
  type TrialBalanceReport,
} from "../domain/bridge";
import type { IntegritySnapshots, ProjectionSource } from "../domain/ports";

export interface IntegrityJobReport {
  readonly ok: boolean;
  readonly trialBalance: TrialBalanceReport;
  readonly chain: ChainVerification;
  readonly storeCredit: { readonly drift: readonly DriftRow[]; readonly negative: readonly DriftRow[] };
}

export interface IntegrityJobDeps {
  readonly snapshots: IntegritySnapshots;
  readonly projection: ProjectionSource;
  readonly sha256: Sha256Hex;
  /** Entries per page when walking the chain. */
  readonly pageSize?: number;
}

/**
 * Nightly and intraday integrity check (T4): trial balance equals zero, hash chain verified from
 * genesis in pages from ONE consistent snapshot, and per-user store-credit projection drift. It
 * returns a report and never throws on a finding: the scheduler alerts Finance on `ok: false`.
 */
export class IntegrityJob {
  constructor(private readonly deps: IntegrityJobDeps) {}

  async run(): Promise<IntegrityJobReport> {
    const pageSize = this.deps.pageSize ?? 1_000;
    // F-12: the wallet projection lives in another module and cannot join the ledger's REPEATABLE
    // READ snapshot. A grant or capture can land between the two reads, so the projection is read
    // before AND after the snapshot and an account is reported as drift only when the ledger
    // matches NEITHER read. A change in flight matches one of them; real drift matches neither.
    const projectionBefore = await this.deps.projection.rows();
    const report = await this.deps.snapshots.withSnapshot(async (source) => {
      const totals = await source.trialBalance();
      let chain: ChainVerification = { ok: true, length: 0, headHash: GENESIS_HASH };
      let after: bigint | null = null;
      let length = 0;
      let head = GENESIS_HASH;
      for (;;) {
        const page = await source.chainPage(after, pageSize);
        if (page.length === 0) break;
        const r = verifyChain(page, this.deps.sha256, head);
        if (!r.ok) {
          chain = r;
          break;
        }
        length += r.length;
        head = r.headHash;
        after = page[page.length - 1]?.link.seq ?? after;
        chain = { ok: true, length, headHash: head };
        if (page.length < pageSize) break;
      }
      const balances = await source.storeCreditBalances();
      const stored = balances.map((b) => ({ account: b.account, currency: b.currency, raw: b.raw }));
      return { totals, chain, stored };
    });
    const projectionAfter = await this.deps.projection.rows();
    const before = storeCreditDrift(projectionBefore, report.stored);
    const after = storeCreditDrift(projectionAfter, report.stored);
    const persistent = new Set(after.drift.map((d) => JSON.stringify([d.userId, d.sub])));
    const storeCredit = {
      drift: before.drift.filter((d) => persistent.has(JSON.stringify([d.userId, d.sub]))),
      negative: before.negative,
    };
    const trial = checkTrialBalance(report.totals);
    return {
      ok: trial.ok && report.chain.ok && storeCredit.drift.length === 0 && storeCredit.negative.length === 0,
      trialBalance: trial,
      chain: report.chain,
      storeCredit,
    };
  }
}
