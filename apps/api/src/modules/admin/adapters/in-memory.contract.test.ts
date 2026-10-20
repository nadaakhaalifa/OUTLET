import { describeAdminContract, type AdminContractContext } from "../test/contract";
import { InMemoryAdminAudit, InMemoryAdminStore, InMemorySellerKyc } from "./in-memory";

describeAdminContract("in-memory", async (): Promise<AdminContractContext> => {
  const store = new InMemoryAdminStore();
  const kyc = new InMemorySellerKyc();
  const audit = new InMemoryAdminAudit();
  return {
    store,
    kyc,
    audit,
    seedUser: async () => {},
    seedSeller: async (id, state, name) => kyc.seed({ sellerId: id, state, storeCount: 1, storeNames: [name], updatedAtMs: 1 }),
    auditRows: async () => audit.entries.map((e) => ({ action: e.action, reasonCode: e.reasonCode, actorId: e.actorId })),
  };
});
