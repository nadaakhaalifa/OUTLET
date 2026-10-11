import { InMemorySignedDocumentStore, InMemoryTaxConfigRepository, InMemoryTaxDocumentRepository } from "./in-memory";
import { describeTaxRepositoryContract } from "../test/repository-contract";

describeTaxRepositoryContract("in-memory", async () => ({
  config: new InMemoryTaxConfigRepository(),
  documents: new InMemoryTaxDocumentRepository(),
  signed: new InMemorySignedDocumentStore(),
  ensureUser: async () => undefined,
}));
