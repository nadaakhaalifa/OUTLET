import {
  buildEntry,
  chart,
  money,
  parseSubKeyOrNull,
  type JournalEntry,
} from "./domain";
import {
  LedgerKeyConflictError,
  type LedgerPort as CheckoutLedgerPort,
} from "../modules/checkout";
import { PostingConflictError, type LedgerReadModel, type LedgerStore, type LedgerTxn, type PostingService } from "../modules/ledger";
import type { CreditLedgerPort } from "../modules/store-credit";
import type { RefundLedgerPort } from "../modules/refunds";
import type { PayoutLedgerPort } from "../modules/payouts";
import type { Late } from "./late";

/** Runs `fn` in one unit of work that the posting service joins (ledger spec: caller's transaction). */
export interface LedgerUnitOfWork {
  run<R>(fn: (tx: LedgerTxn) => Promise<R>): Promise<R>;
}

export interface LedgerGatewayDeps {
  readonly posting: Late<PostingService<LedgerTxn>>;
  readonly store: Late<LedgerStore<LedgerTxn>>;
  readonly reads: Late<LedgerReadModel>;
  readonly uow: LedgerUnitOfWork;
}

const SYSTEM_SCOPE = { actorId: "00000000-0000-4000-8000-000000000000", role: "finance" } as const;

/**
 * One gateway over the ledger posting service. Checkout, store credit, refunds and payouts each see
 * their own port shape, but every write is the same idempotent `PostingService.post` under the
 * entry's idempotency key, so a replay can never post twice and a changed payload is a typed error.
 */
export class LedgerGateway {
  constructor(private readonly deps: LedgerGatewayDeps) {}

  private async post(entry: JournalEntry): Promise<"posted" | "replayed"> {
    const { posting, uow } = this.deps;
    const out = await uow.run((tx) => posting.get().post(tx, entry));
    return out.kind;
  }

  private findByKey(key: string): Promise<JournalEntry | null> {
    const { store, uow } = this.deps;
    return uow.run(async (tx) => (await store.get().findByKey(tx, key))?.entry ?? null);
  }

  checkout(): CheckoutLedgerPort {
    return {
      post: async (entry) => {
        try {
          const kind = await this.post(entry);
          return { kind: kind === "posted" ? "posted" : "duplicate" };
        } catch (e) {
          if (e instanceof PostingConflictError) throw new LedgerKeyConflictError(entry.idempotencyKey);
          throw e;
        }
      },
      find: (key) => this.findByKey(key),
    };
  }

  credit(): CreditLedgerPort {
    return {
      post: async (entry) => ({ kind: await this.post(entry) }),
      hasEntry: async (key) => (await this.findByKey(key)) !== null,
      balances: async (userId) => {
        const rows = await this.deps.reads.get().balances(SYSTEM_SCOPE, { type: "store_credit", ownerId: userId, limit: 200 });
        const out = new Map<string, bigint>();
        for (const r of rows) {
          if (parseSubKeyOrNull(r.subKey) === null) continue;
          out.set(r.subKey, (out.get(r.subKey) ?? 0n) + r.natural);
        }
        return out;
      },
    };
  }

  refunds(): RefundLedgerPort {
    return {
      post: async (entry) => ({ kind: await this.post(entry) }),
      hasEntry: async (key) => (await this.findByKey(key)) !== null,
    };
  }

  payouts(bankAccountFallback = "bank_settlement"): PayoutLedgerPort {
    const entryFor = (i: { ref: string; storeId: string; amount: bigint; bankAccount: string }) =>
      buildEntry(
        { type: "seller_payout", payoutId: i.ref, storeId: i.storeId, amount: money(i.amount), bankAccount: i.bankAccount || bankAccountFallback },
        { id: "00000000-0000-4000-8000-000000000000", occurredAt: new Date(0) },
      );
    return {
      postPayout: async (i) => {
        // The entry id is assigned by the posting service's id generator: PostingService.postCommand.
        const { posting, uow } = this.deps;
        const out = await uow.run((tx) =>
          posting.get().postCommand(tx, {
            type: "seller_payout",
            payoutId: i.ref,
            storeId: i.storeId,
            amount: money(i.amount),
            bankAccount: i.bankAccount || bankAccountFallback,
          }),
        );
        return { kind: out.kind };
      },
      reversePayout: async (ref) => {
        const original = await this.findByKey(entryFor({ ref, storeId: "x", amount: 1n, bankAccount: "x" }).idempotencyKey);
        if (original === null) throw new Error(`no payout entry for ${ref}`);
        const { posting, uow } = this.deps;
        const out = await uow.run((tx) => posting.get().reversal(tx, original.id));
        return { kind: out.kind };
      },
      hasPayoutEntry: async (ref) =>
        (await this.findByKey(entryFor({ ref, storeId: "x", amount: 1n, bankAccount: "x" }).idempotencyKey)) !== null,
      payableBalance: async (storeId) => {
        const rows = await this.deps.reads.get().balances(SYSTEM_SCOPE, { type: "seller_payable", ownerId: storeId, limit: 1 });
        const account = chart.sellerPayable(storeId);
        return rows.find((r) => r.account === account)?.natural ?? 0n;
      },
    };
  }
}
