import { InMemoryRewardsStore } from "./in-memory";
import { describeRewardsStoreContract } from "../test/repository-contract";

describeRewardsStoreContract("in-memory", async () => {
  const store = new InMemoryRewardsStore();
  return {
    store,
    ensureUser: async () => undefined,
    eventTypes: async () => store.events.map((e) => e.type),
  };
});
