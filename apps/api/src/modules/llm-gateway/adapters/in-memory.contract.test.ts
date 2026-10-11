import { InMemoryAuditStore, InMemoryTokenUsage } from "./in-memory";
import { describeGatewayStoresContract } from "./stores.contract";

describeGatewayStoresContract("in-memory", async () => ({
  audit: new InMemoryAuditStore(),
  usage: new InMemoryTokenUsage(),
  ensureUser: async () => undefined,
}));
