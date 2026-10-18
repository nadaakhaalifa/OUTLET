import { InMemoryEvalRunStore, InMemoryShadowLogStore } from "../index";
import { describeRankingStoreContract } from "./store-contract";

describeRankingStoreContract("in-memory", async () => ({ shadow: new InMemoryShadowLogStore(), evals: new InMemoryEvalRunStore() }));
