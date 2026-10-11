import type { BudgetSettings, Commitment, SpendEvent, SpendLine } from "../domain/bridge";
import type { BudgetRecord, CommitmentRecord, CycleRecord, FieldCipherPort, SpendEventRecord } from "../domain/ports";

export class CipherUnavailableError extends Error {
  constructor() {
    super("field cipher unavailable");
    this.name = "CipherUnavailableError";
  }
}

const enc = new TextEncoder();
const dec = new TextDecoder();

interface DetailJson {
  a: string;
  l: { s: string; c: string; m: string }[];
  v: string;
  p: string;
}

/** The single place where P3 budget fields cross the encryption boundary (spec 12, T5). */
export class BudgetCodec {
  constructor(private readonly cipher: FieldCipherPort) {}

  private async seal(text: string, aad: string): Promise<Uint8Array> {
    try {
      return await this.cipher.encrypt(enc.encode(text), aad);
    } catch {
      throw new CipherUnavailableError();
    }
  }
  private async open(bytes: Uint8Array, aad: string): Promise<string> {
    try {
      return dec.decode(await this.cipher.decrypt(bytes, aad));
    } catch {
      throw new CipherUnavailableError();
    }
  }
  private sealInt(n: bigint, aad: string): Promise<Uint8Array> {
    return this.seal(n.toString(), aad);
  }
  private async openInt(b: Uint8Array, aad: string): Promise<bigint> {
    return BigInt(await this.open(b, aad));
  }

  async sealBudget(userId: string, s: BudgetSettings, holdUntilMs: number | null, version: number, now: { created: number; updated: number }): Promise<BudgetRecord> {
    const cats = Object.keys(s.perCategory).length === 0 ? null : JSON.stringify(Object.fromEntries(Object.entries(s.perCategory).map(([k, v]) => [k, v.toString()])));
    return {
      userId,
      amountEnc: await this.sealInt(s.amount, `budget:${userId}:amount`),
      perCategoryEnc: cats === null ? null : await this.seal(cats, `budget:${userId}:per_category`),
      payday: s.payday,
      capMode: s.capMode,
      holdUntilMs,
      version,
      createdAtMs: now.created,
      updatedAtMs: now.updated,
    };
  }

  async openBudget(r: BudgetRecord): Promise<BudgetSettings> {
    const amount = await this.openInt(r.amountEnc, `budget:${r.userId}:amount`);
    let perCategory: Record<string, bigint> = {};
    if (r.perCategoryEnc !== null) {
      const raw = JSON.parse(await this.open(r.perCategoryEnc, `budget:${r.userId}:per_category`)) as Record<string, string>;
      perCategory = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, BigInt(v)]));
    }
    return { amount, perCategory, payday: r.payday, capMode: r.capMode };
  }

  async sealCycle(userId: string, c: { startMs: number; endMs: number; spent: bigint; refunded: bigint; refundReceived: bigint }, rolledAtMs: number, nowMs: number): Promise<CycleRecord> {
    const p = `cycle:${userId}:${c.startMs}`;
    return {
      userId,
      startMs: c.startMs,
      endMs: c.endMs,
      spentEnc: await this.sealInt(c.spent, `${p}:spent`),
      refundedEnc: await this.sealInt(c.refunded, `${p}:refunded`),
      refundReceivedEnc: await this.sealInt(c.refundReceived, `${p}:refund_received`),
      rolledAtMs,
      updatedAtMs: nowMs,
    };
  }

  async openCycle(r: CycleRecord): Promise<{ spent: bigint; refunded: bigint; refundReceived: bigint }> {
    const p = `cycle:${r.userId}:${r.startMs}`;
    return {
      spent: await this.openInt(r.spentEnc, `${p}:spent`),
      refunded: await this.openInt(r.refundedEnc, `${p}:refunded`),
      refundReceived: await this.openInt(r.refundReceivedEnc, `${p}:refund_received`),
    };
  }

  async sealEvent(userId: string, e: SpendEvent): Promise<SpendEventRecord> {
    const detail: DetailJson = {
      a: e.amount.toString(),
      l: e.lines.map((l) => ({ s: l.storeId, c: l.categoryId, m: l.amount.toString() })),
      v: e.verifiedSavings.toString(),
      p: e.plusSavings.toString(),
    };
    return {
      userId,
      key: e.key,
      kind: e.kind,
      orderPlacedAtMs: e.orderPlacedAtMs,
      occurredAtMs: e.occurredAtMs,
      detailEnc: await this.seal(JSON.stringify(detail), `spend:${userId}:${e.key}`),
    };
  }

  async openEvent(r: SpendEventRecord): Promise<SpendEvent> {
    const d = JSON.parse(await this.open(r.detailEnc, `spend:${r.userId}:${r.key}`)) as DetailJson;
    const lines: SpendLine[] = d.l.map((l) => ({ storeId: l.s, categoryId: l.c, amount: BigInt(l.m) }));
    return {
      key: r.key,
      kind: r.kind,
      amount: BigInt(d.a),
      orderPlacedAtMs: r.orderPlacedAtMs,
      occurredAtMs: r.occurredAtMs,
      lines,
      verifiedSavings: BigInt(d.v),
      plusSavings: BigInt(d.p),
    };
  }

  async sealCommitment(userId: string, c: Commitment): Promise<CommitmentRecord> {
    return {
      userId,
      provider: c.provider,
      source: c.source,
      startsAtMs: c.startsAtMs,
      endsAtMs: c.endsAtMs,
      monthlyEnc: await this.sealInt(c.monthly, `commitment:${userId}:${c.source}:${c.provider}:${c.startsAtMs}`),
    };
  }

  async openCommitment(r: CommitmentRecord): Promise<Commitment> {
    return {
      provider: r.provider,
      source: r.source,
      startsAtMs: r.startsAtMs,
      endsAtMs: r.endsAtMs,
      monthly: await this.openInt(r.monthlyEnc, `commitment:${r.userId}:${r.source}:${r.provider}:${r.startsAtMs}`),
    };
  }
}
