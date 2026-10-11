import { createIdGenerator, nodeCsprng } from "../../../platform";
import { sha256Hex } from "@outlet/idempotency";
import { IntegrityJob } from "../application/integrity-job";
import { PostingService } from "../application/posting-service";
import { InMemoryLedger, InMemoryProjection, type InMemoryLedgerTx } from "./in-memory";
import { describeLedgerContract, type BoundPosting, type LedgerHarness } from "../test/contract";

class Clock {
  nowMs(): number {
    return Date.UTC(2026, 9, 11, 10);
  }
}

const fresh = async (): Promise<LedgerHarness> => {
  const store = new InMemoryLedger();
  const clock = new Clock();
  let giftCards = true;
  const projection = new InMemoryProjection();
  const service = new PostingService<InMemoryLedgerTx>({
    store,
    clock,
    ids: createIdGenerator(clock, nodeCsprng),
    sha256: sha256Hex,
    flags: { giftCardSalesEnabled: () => giftCards },
  });
  const state: string[] = [];
  const job = new IntegrityJob({ snapshots: store, projection, sha256: sha256Hex, pageSize: 2 });
  return {
    run: (fn) =>
      store.run(async (tx) => {
        const bound: BoundPosting = {
          postCommand: (c) => service.postCommand(tx, c),
          reversal: (id) => service.reversal(tx, id),
          markState: async (l) => {
            tx.onCommit.push(() => state.push(l));
          },
          emitCaller: async (t) => {
            await tx.emit({ aggregateType: "order_group", aggregateId: "x", eventType: t as never, payload: {} });
          },
        };
        return fn(bound);
      }),
    reads: store,
    setGiftCardFlag: (on) => {
      giftCards = on;
    },
    integrity: () => job.run(),
    committedState: async () => state,
    outboxTypes: async () => store.events.map((e) => e.eventType),
    tamperPostingAmount: async (id) => {
      store.tamper(id, (e) => ({
        ...e,
        postings: e.postings.map((p, i) => (i === 0 ? { ...p, amount: { ...p.amount, amount: p.amount.amount + 1n } } : p)),
      }));
    },
    setProjection: (rows) => {
      projection.data.splice(0, projection.data.length, ...rows);
    },
  };
};

describeLedgerContract("in-memory", fresh);

