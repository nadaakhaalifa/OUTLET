import { describeOdooStoreContract } from "../test/repository-contract";
import { InMemoryOdooStore } from "./in-memory";

describeOdooStoreContract("in-memory", async () => ({ store: new InMemoryOdooStore(), seed: async () => undefined }));
