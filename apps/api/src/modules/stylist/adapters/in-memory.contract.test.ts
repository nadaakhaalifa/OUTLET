import { InMemoryStylistStore } from "./in-memory";
import { describeStylistStoreContract } from "../test/store-contract";

describeStylistStoreContract("in-memory", async () => {
  const store = new InMemoryStylistStore();
  return { store, ensureUser: async () => undefined, eventTypes: async () => store.events.map((e) => e.type) };
});
