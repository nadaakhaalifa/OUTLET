import { InMemoryAdmissionStore } from "./in-memory";
import { describeAdmissionStoreContract } from "../test/store-contract";

describeAdmissionStoreContract("in-memory", async () => {
  const store = new InMemoryAdmissionStore();
  return {
    store,
    ensureDrop: async () => undefined,
    ensureUser: async () => undefined,
    eventTypes: async () => store.events.map((e) => e.type),
  };
});
