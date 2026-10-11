import { InMemoryDropStore } from "./in-memory";
import { describeDropStoreContract } from "../test/store-contract";

describeDropStoreContract("in-memory", async () => {
  const store = new InMemoryDropStore();
  return { store, ensureUser: async () => undefined, eventTypes: async () => store.events.map((e) => e.type) };
});
