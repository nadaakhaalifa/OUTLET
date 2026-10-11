import { InMemoryRefundStore } from "../adapters/in-memory";
import { describeRefundStoreContract } from "./store-contract";

describeRefundStoreContract("in-memory", async () => {
  const store = new InMemoryRefundStore();
  return {
    store,
    ensureUser: async () => undefined,
    eventTypes: async () => store.events.map((e) => e.type),
  };
});
