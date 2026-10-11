import { InMemoryCrawlStore } from "./in-memory";
import { runCrawlStoreContract } from "../test/repository-contract";

runCrawlStoreContract("in-memory", async () => {
  const store = new InMemoryCrawlStore();
  return { store, eventTypes: async () => store.outbox.map((e) => e.type) };
});
