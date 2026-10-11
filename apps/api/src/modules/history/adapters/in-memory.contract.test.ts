import { InMemoryHistoryStore } from "./in-memory";
import { describeHistoryStoreContract } from "../test/repository-contract";

describeHistoryStoreContract("in-memory", async () => {
  const store = new InMemoryHistoryStore();
  return { store, ensureUser: async () => undefined, outboxTypes: async () => store.outbox.map((e) => e.type) };
});
