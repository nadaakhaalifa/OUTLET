import { InMemorySavedSearchRepository, InMemorySearchIndex } from "./in-memory";
import { describeSearchIndexContract } from "../test/index-contract";
import { describeSavedSearchContract } from "../test/saved-contract";

describeSearchIndexContract("in-memory", async () => {
  const idx = new InMemorySearchIndex();
  return { port: idx, writer: idx };
});

describeSavedSearchContract("in-memory", async () => ({
  repo: new InMemorySavedSearchRepository(),
  ensureUser: async () => undefined,
}));
