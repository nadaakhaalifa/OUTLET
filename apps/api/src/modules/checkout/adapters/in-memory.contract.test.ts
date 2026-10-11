import { InMemorySagaRepository } from "./in-memory";
import { describeSagaRepositoryContract } from "../test/repository-contract";

describeSagaRepositoryContract("in-memory", async () => {
  const repo = new InMemorySagaRepository();
  return {
    repo,
    ensureUser: async () => undefined,
    outboxTypes: async () => repo.outbox.map((e) => e.type),
  };
});
