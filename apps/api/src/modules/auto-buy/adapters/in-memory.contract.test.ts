import { InMemoryAutoBuyStore } from "./in-memory";
import { describeAutoBuyStoreContract } from "../test/repository-contract";

describeAutoBuyStoreContract("in-memory", async () => {
  const store = new InMemoryAutoBuyStore();
  return {
    store,
    ensureUser: async () => {},
    eventTypes: async () => store.events.map((e) => e.type),
  };
});
