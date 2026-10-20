import { describeForecastStoreContract } from "../test/repository-contract";
import { InMemoryForecastStore } from "./in-memory";

describeForecastStoreContract("in-memory", async () => ({ store: new InMemoryForecastStore() }));
