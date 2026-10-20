import { InMemoryCreatorStore } from "./in-memory";
import { describeCreatorStoreContract } from "../test/repository-contract";

describeCreatorStoreContract("in-memory", async () => {
  const store = new InMemoryCreatorStore();
  return {
    store,
    ensureUser: async () => undefined,
    eventTypes: async () => store.events.map((e) => e.type),
  };
});
