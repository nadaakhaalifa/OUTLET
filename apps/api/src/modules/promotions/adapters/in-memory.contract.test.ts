import { describePromotionRepositoryContract } from "../test/repository-contract";
import { InMemoryPromotionRepository } from "./in-memory";

describePromotionRepositoryContract("in-memory", async () => ({
  repo: new InMemoryPromotionRepository(),
  ensureUser: async () => undefined,
}));
