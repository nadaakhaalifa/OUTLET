import { describeWardrobeStoreContract } from "../test/store-contract";
import { InMemoryWardrobeStore } from "./in-memory";

describeWardrobeStoreContract("in-memory", async () => {
  const store = new InMemoryWardrobeStore();
  return {
    store,
    ensureUser: async () => undefined,
    graveyard: async () => [...store.graveyard],
    eventTypes: async () => store.events.map((e) => e.type),
  };
});
