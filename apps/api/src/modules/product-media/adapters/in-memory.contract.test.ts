import { InMemoryProductMediaStore } from "./in-memory";
import { describeProductMediaStoreContract } from "../test/store-contract";

describeProductMediaStoreContract("in-memory", async () => ({ store: new InMemoryProductMediaStore() }));
