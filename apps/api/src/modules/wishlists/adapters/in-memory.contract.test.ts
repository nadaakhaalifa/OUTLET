import { InMemoryWishlistEventLog, InMemoryWishlistRepository } from "./in-memory";
import { describeWishlistRepositoryContract } from "../test/repository-contract";

describeWishlistRepositoryContract("in-memory", async () => {
  const log = new InMemoryWishlistEventLog();
  return {
    repo: new InMemoryWishlistRepository(log),
    ensureUser: async () => undefined,
    recordedEventTypes: async () => log.events.map((e) => e.type),
  };
});
