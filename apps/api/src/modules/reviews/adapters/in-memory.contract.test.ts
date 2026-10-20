import { InMemoryReviewStore } from "./in-memory";
import { describeReviewStoreContract } from "../test/repository-contract";

describeReviewStoreContract("in-memory", async () => {
  const store = new InMemoryReviewStore();
  return {
    store,
    ensureUser: async () => undefined,
    eventTypes: async () => store.events.map((e) => e.type),
  };
});
