import { InMemoryCartRepository } from "./in-memory";
import { describeCartRepositoryContract } from "../test/repository-contract";

describeCartRepositoryContract("in-memory", async () => ({
  repo: new InMemoryCartRepository(),
  ensureUser: async () => undefined,
}));
