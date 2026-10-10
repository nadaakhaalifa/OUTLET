import { describeAnalyticsStoreContract } from "../test/repository-contract";
import { InMemoryAnalyticsStore } from "./in-memory";

describeAnalyticsStoreContract("in-memory", async () => ({ store: new InMemoryAnalyticsStore() }));
