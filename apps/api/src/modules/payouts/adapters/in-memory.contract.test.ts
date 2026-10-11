import { InMemoryPayoutStore } from "./in-memory";
import { describePayoutScenarios } from "../test/scenarios";
import { TestClock } from "../test/fixtures";

describePayoutScenarios("in-memory", async () => {
  const clock = new TestClock();
  const store = new InMemoryPayoutStore(clock);
  return {
    store,
    clock,
    ensureUser: async () => undefined,
    outboxTypes: async () => store.outbox.map((e) => e.type),
  };
});
