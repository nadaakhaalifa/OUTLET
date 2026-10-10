import { describeReturnRepositoryContract } from "../test/repository-contract";
import { InMemoryReturnRepository } from "./in-memory";

describeReturnRepositoryContract("in-memory", async () => ({
  repo: new InMemoryReturnRepository(),
  ensureUser: async () => undefined,
}));
