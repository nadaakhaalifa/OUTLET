import { InMemoryHubStore } from "./in-memory";
import { runHubStoreContract } from "../test/repository-contract";

runHubStoreContract("in-memory", async () => {
  const store = new InMemoryHubStore();
  return {
    store,
    ensureUser: async () => undefined,
    eventTypes: async () => store.outbox.map((e) => e.type),
  };
});
