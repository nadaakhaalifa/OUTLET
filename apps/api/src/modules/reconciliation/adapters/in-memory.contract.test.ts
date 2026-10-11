import { InMemoryReconStore } from "./in-memory";
import { describeReconScenarios } from "../test/scenarios";
import { TestClock } from "../test/fixtures";

describeReconScenarios("in-memory", async () => {
  const store = new InMemoryReconStore();
  return { store, clock: new TestClock(), outboxTypes: async () => store.outbox.map((e) => e.type) };
});
