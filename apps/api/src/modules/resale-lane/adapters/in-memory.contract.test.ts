import { InMemoryResaleStore } from "./in-memory";
import { runResaleStoreContract } from "../test/repository-contract";

runResaleStoreContract("in-memory", async () => {
  const store = new InMemoryResaleStore();
  return { store, ensureUser: async () => undefined, eventTypes: async () => store.outbox.map((e) => e.type) };
});
