import { InMemoryRecoStore } from "./in-memory";
import { describeRecoStoreContract } from "../test/reco-contract";

describeRecoStoreContract("in-memory", async () => {
  const store = new InMemoryRecoStore();
  return {
    store,
    outboxTypes: async () => store.events.map((e) => e.type),
    setActiveModel: async (v) => store.setActiveModel(v),
  };
});
