import { createHash, createHmac, randomBytes } from "node:crypto";
import { chart, createJournalEntry, money, storeCreditExpired, type JournalEntry } from "@outlet/domain";
import type {
  AttestationPort,
  ConfigApprovalPort,
  EntitlementPort,
  HashPort,
  LedgerPort,
  RandomPort,
  RewardsSwitchPort,
  StoreCreditPort,
  VoucherPort,
} from "../domain/ports";

/** Balanced-only ledger fake. Idempotent on key; `failNext` simulates an outage. */
export class FakeLedger implements LedgerPort {
  readonly entries: JournalEntry[] = [];
  private readonly byKey = new Map<string, string>();
  private failures = 0;
  failNext(n = 1): void {
    this.failures += n;
  }
  /** Ends a simulated outage. */
  heal(): void {
    this.failures = 0;
  }
  async post(entry: JournalEntry): Promise<{ entryId: string; duplicate: boolean }> {
    if (this.failures > 0) {
      this.failures -= 1;
      throw new Error("ledger unavailable");
    }
    const known = this.byKey.get(entry.idempotencyKey);
    if (known !== undefined) return { entryId: known, duplicate: true };
    createJournalEntry(entry); // throws on an unbalanced entry
    this.entries.push(entry);
    this.byKey.set(entry.idempotencyKey, entry.id);
    return { entryId: entry.id, duplicate: false };
  }
  /** Sum of postings on an account (debit positive). */
  balanceOf(account: string): bigint {
    let s = 0n;
    for (const e of this.entries) for (const p of e.postings) if (p.account === account) s += p.amount.amount;
    return s;
  }
  trialBalance(): bigint {
    let s = 0n;
    for (const e of this.entries) for (const p of e.postings) s += p.amount.amount;
    return s;
  }
}

/** Store credit fake over the same ledger: balance is the credit side of store_credit:{user}:cashback_coins. */
export class FakeStoreCredit implements StoreCreditPort {
  readonly expiries: { userId: string; piastres: bigint; key: string }[] = [];
  private n = 0;
  constructor(private readonly ledger: FakeLedger) {}
  async cashbackBalance(userId: string): Promise<bigint> {
    return -this.ledger.balanceOf(chart.storeCredit(userId, { kind: "cashback_coins" }));
  }
  /** Simulates the shopper spending credit at checkout (store-credit module): Dr credit, Cr clearing. */
  async spend(userId: string, piastres: bigint): Promise<void> {
    this.n += 1;
    await this.ledger.post(
      createJournalEntry({
        id: `spend-${this.n}`,
        kind: "test_spend",
        idempotencyKey: `test-spend-${userId}-${this.n}`,
        occurredAt: new Date(0),
        ref: { type: "test", id: String(this.n) },
        postings: [
          { account: chart.storeCredit(userId, { kind: "cashback_coins" }), amount: money(piastres) },
          { account: chart.pspClearing("fake"), amount: money(-piastres) },
        ],
      }),
    );
  }
  async expireCoins(input: { userId: string; piastres: bigint; idempotencyKey: string }): Promise<{ entryId: string }> {
    this.expiries.push({ userId: input.userId, piastres: input.piastres, key: input.idempotencyKey });
    const r = await this.ledger.post(
      storeCreditExpired(
        { userId: input.userId, sub: { kind: "cashback_coins" }, amount: money(input.piastres) },
        { id: `exp-${input.idempotencyKey}`, idempotencyKey: input.idempotencyKey, occurredAt: new Date(0), ref: { type: "rewards_expiry", id: input.idempotencyKey } },
      ),
    );
    return { entryId: r.entryId };
  }
}

export class FakePlusEntitlements implements EntitlementPort {
  private readonly plus = new Set<string>();
  grant(userId: string): void {
    this.plus.add(userId);
  }
  async hasPlusCoinsBonus(userId: string): Promise<boolean> {
    return this.plus.has(userId);
  }
}

export class FakeVouchers implements VoucherPort {
  readonly granted: { userId: string; templateId: string; key: string; voucherId: string }[] = [];
  async grant(i: { userId: string; templateId: string; idempotencyKey: string }): Promise<{ voucherId: string }> {
    const known = this.granted.find((g) => g.key === i.idempotencyKey);
    if (known !== undefined) return { voucherId: known.voucherId };
    const voucherId = `voucher-${this.granted.length + 1}`;
    this.granted.push({ userId: i.userId, templateId: i.templateId, key: i.idempotencyKey, voucherId });
    return { voucherId };
  }
}

/** Switches. Games default OFF like the production kill switch; coins default ON for tests. */
export class StaticRewardsSwitch implements RewardsSwitchPort {
  constructor(
    private games = false,
    private coins = true,
  ) {}
  setGames(v: boolean): void {
    this.games = v;
  }
  setCoins(v: boolean): void {
    this.coins = v;
  }
  async gamesEnabled(): Promise<boolean> {
    return this.games;
  }
  async coinsEnabled(): Promise<boolean> {
    return this.coins;
  }
}

/** Structural subset of FlagClient (packages/feature-flags). It fails closed on error. */
export interface RewardsFlagClient {
  isEnabled(key: "kill.games" | "kill.rewards_coins"): Promise<boolean>;
}
export class FlagRewardsSwitch implements RewardsSwitchPort {
  constructor(private readonly flags: RewardsFlagClient) {}
  async gamesEnabled(): Promise<boolean> {
    return this.flags.isEnabled("kill.games");
  }
  async coinsEnabled(): Promise<boolean> {
    return this.flags.isEnabled("kill.rewards_coins");
  }
}

export class FakeAttestation implements AttestationPort {
  async verify(i: { userId: string; token: string | null }): Promise<boolean> {
    return i.token !== null && i.token === `attest-${i.userId}`;
  }
}

/** Approved when `approvalId` was registered with two approvers other than the requester. */
export class FakeApprovals implements ConfigApprovalPort {
  private readonly approved = new Map<string, { kind: string; approvers: readonly string[] }>();
  approve(approvalId: string, kind: "rewards_config" | "game_odds", approvers: readonly string[]): void {
    this.approved.set(approvalId, { kind, approvers });
  }
  async isApproved(i: { approvalId: string; kind: "rewards_config" | "game_odds"; requesterId: string }): Promise<boolean> {
    const a = this.approved.get(i.approvalId);
    if (a === undefined || a.kind !== i.kind) return false;
    const others = new Set(a.approvers.filter((x) => x !== i.requesterId));
    return others.size >= 2;
  }
}

export class NodeHash implements HashPort {
  sha256Hex(input: string): string {
    return createHash("sha256").update(input).digest("hex");
  }
  hmacSha256(keyHex: string, message: string): Uint8Array {
    return new Uint8Array(createHmac("sha256", Buffer.from(keyHex, "hex")).update(message).digest());
  }
}
export class NodeRandom implements RandomPort {
  secureHex(bytes: number): string {
    return randomBytes(bytes).toString("hex");
  }
}
/** Deterministic seeds for tests. */
export class SequenceRandom implements RandomPort {
  private n = 0;
  secureHex(bytes: number): string {
    this.n += 1;
    return this.n.toString(16).padStart(bytes * 2, "0");
  }
}
