import { InMemorySubscriptionStore } from "./in-memory";
import { describeSubscriptionStoreContract } from "../test/repository-contract";

describeSubscriptionStoreContract("in-memory", async () => {
  const store = new InMemorySubscriptionStore();
  return {
    store,
    ensureUser: async () => undefined,
    eventTypes: async () => store.events.map((e) => e.type),
  };
});
