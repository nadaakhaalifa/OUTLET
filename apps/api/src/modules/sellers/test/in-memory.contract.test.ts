import { InMemoryBrandApplicationRepository } from "../adapters/in-memory";
import { describeSellersRepositoryContract } from "./repository-contract";

describeSellersRepositoryContract("in-memory", async () => {
  const repo = new InMemoryBrandApplicationRepository();
  return { repo, outboxTypes: async () => repo.outbox.map((e) => e.type) };
});
