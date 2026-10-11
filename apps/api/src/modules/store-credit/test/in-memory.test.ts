import { InMemoryStoreCredit } from "../adapters/in-memory";
import { describeStoreCreditSuite } from "./suite";

describeStoreCreditSuite("in-memory", async () => ({ store: new InMemoryStoreCredit(), ensureUser: async () => undefined }));
