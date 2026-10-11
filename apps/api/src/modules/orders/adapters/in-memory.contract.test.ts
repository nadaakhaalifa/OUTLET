import { InMemoryOrderRepository } from "./in-memory";
import { describeOrderRepositoryContract } from "../test/repository-contract";
import { TestClock } from "../test/fixtures";

describeOrderRepositoryContract("in-memory", async () => {
  const clock = new TestClock();
  let n = 0;
  const repo = new InMemoryOrderRepository(clock, () => `00000000-0000-4000-8000-${String(900_000 + n++).padStart(12, "0")}`);
  return {
    repo,
    clock,
    ensureUser: async () => undefined,
    outboxTypes: async () => repo.outbox.map((e) => e.type),
    historyCount: async (id) => repo.history.filter((h) => h.sellerOrderId === id).length,
  };
});
