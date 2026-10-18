import { describeHomeBannerStoreContract } from "../test/store-contract";
import { InMemoryHomeBannerStore } from "./in-memory";

describeHomeBannerStoreContract("in-memory", async () => ({ store: new InMemoryHomeBannerStore() }));
