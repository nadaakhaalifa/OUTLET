import { InMemoryPaymentStore } from "../adapters/in-memory-store";
import { TestClock, nextId } from "./fixtures";
import { describePaymentStoreContract } from "./store-contract";

describePaymentStoreContract("in-memory", async () => {
  const store = new InMemoryPaymentStore(new TestClock(), nextId);
  return { store, ensureUser: async () => undefined, outboxTypes: async () => store.outboxTypes() };
});
