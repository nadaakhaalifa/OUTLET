import { InMemoryClaimStore, InMemoryEnforcementStore, InMemoryPriceEventStore } from "../adapters/in-memory";
import { describePriceIntegrityContract } from "./contract";

describePriceIntegrityContract("in-memory", async () => ({
  events: new InMemoryPriceEventStore(),
  claims: new InMemoryClaimStore(),
  enforcement: new InMemoryEnforcementStore(),
  close: async () => undefined,
}));
