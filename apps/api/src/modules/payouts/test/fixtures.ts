import { createIdGenerator, nodeCsprng } from "../../../platform";
import type { Clock } from "../../../platform/ports";
import { FakeApprovals, FakeFlags, FakeIbanNameMatch, FakePayoutLedger, FakePayoutPort, FakePayoutRisk, FakePayoutSource, FakeSellerBank } from "../adapters/fakes";
import { PayoutCommands } from "../application/commands";
import type { PayoutConfig, PayoutStore } from "../domain/ports";
import { DEFAULT_PAYOUT_CONFIG } from "../application/commands";

export const DAY = 86_400_000;
/** Wednesday 2026-10-14 12:00 UTC. The latest weekly cycle is Sunday 2026-10-11 10:00 Cairo (07:00 UTC). */
export const T0 = Date.UTC(2026, 9, 14, 12, 0, 0);
export const CYCLE_KEY = "2026-10-11";
export const CUTOFF = Date.UTC(2026, 9, 11, 7, 0, 0);
export const OLD = CUTOFF - 5 * DAY;
export const FRESH = CUTOFF - 1 * DAY;

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
export const STORE_A = "00000000-0000-4000-a000-00000000000a";
export const STORE_B = "00000000-0000-4000-a000-00000000000b";
export const FINANCE_1 = U(31);
export const FINANCE_2 = U(32);
export const ORDER = (n: number): string => U(1000 + n);
export const CLAWBACK = (n: number): string => U(2000 + n);

export interface Kit {
  readonly store: PayoutStore;
  readonly clock: TestClock;
  readonly commands: PayoutCommands;
  readonly source: FakePayoutSource;
  readonly bank: FakeSellerBank;
  readonly nameMatch: FakeIbanNameMatch;
  readonly risk: FakePayoutRisk;
  readonly approvals: FakeApprovals;
  readonly ledger: FakePayoutLedger;
  readonly provider: FakePayoutPort;
  readonly flags: FakeFlags;
}

export function kit(store: PayoutStore, clock: TestClock, config: PayoutConfig = DEFAULT_PAYOUT_CONFIG): Kit {
  const source = new FakePayoutSource();
  const bank = new FakeSellerBank();
  const nameMatch = new FakeIbanNameMatch(bank);
  const risk = new FakePayoutRisk();
  const approvals = new FakeApprovals();
  const ledger = new FakePayoutLedger();
  const provider = new FakePayoutPort();
  const flags = new FakeFlags();
  const ids = createIdGenerator(clock, nodeCsprng);
  return {
    store,
    clock,
    source,
    bank,
    nameMatch,
    risk,
    approvals,
    ledger,
    provider,
    flags,
    commands: new PayoutCommands({
      store,
      source,
      bank,
      nameMatch,
      risk,
      approvals,
      ledger,
      provider,
      flags,
      clock,
      ids,
      config,
    }),
  };
}

/** A store with matching bank details and plenty of ledger balance. */
export function seedStore(k: Kit, storeId: string, over: { legalName?: string; holder?: string; balance?: bigint } = {}): void {
  const token = `tok-${storeId.slice(-4)}`;
  k.bank.byStore.set(storeId, { accountToken: token, ibanLast4: "0002", legalName: over.legalName ?? "Nile Fashion LLC" });
  k.bank.holders.set(token, over.holder ?? "NILE FASHION");
  k.ledger.setBalance(storeId, over.balance ?? 100_000_000n);
}

export function addOrder(k: Kit, n: number, net: bigint, over: { storeId?: string; closedAtMs?: number | null; status?: string } = {}): string {
  const id = ORDER(n);
  k.source.addItem({
    sellerOrderId: id,
    storeId: over.storeId ?? STORE_A,
    net,
    status: over.status ?? "CLOSED",
    closedAtMs: over.closedAtMs === undefined ? OLD : over.closedAtMs,
    openDispute: false,
  });
  return id;
}
