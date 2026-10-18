import { describeAddressContract } from "./test/contract";
import { InMemoryAddressStore } from "./in-memory";

describeAddressContract("in-memory", async () => ({
  store: new InMemoryAddressStore(),
  ensureUser: async () => undefined,
  clock: { ms: 1_800_000_000_000 },
}));
