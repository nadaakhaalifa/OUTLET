import { InMemoryFulfillmentRepository } from "./in-memory";
import { describeFulfillmentRepositoryContract } from "../test/repository-contract";

describeFulfillmentRepositoryContract("in-memory", async () => {
  const repo = new InMemoryFulfillmentRepository();
  return {
    repo,
    outboxCount: async (type: string) => repo.outbox.filter((e) => e.type === type).length,
  };
});
