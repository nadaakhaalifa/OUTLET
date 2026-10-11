import { InMemoryWishlistRepository } from "./in-memory";
import { describeWishlistRepositoryContract } from "../test/repository-contract";

describeWishlistRepositoryContract("in-memory", async () => ({
  repo: new InMemoryWishlistRepository(),
  ensureUser: async () => undefined,
}));
