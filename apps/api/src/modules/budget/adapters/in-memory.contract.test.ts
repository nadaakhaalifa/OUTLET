import { InMemoryBudgetStore } from "./in-memory";
import { describeBudgetStoreContract } from "../test/repository-contract";

describeBudgetStoreContract("in-memory", async () => {
  const store = new InMemoryBudgetStore();
  return { store, ensureUser: async () => undefined, eventTypes: async () => store.events.map((e) => e.type) };
});
