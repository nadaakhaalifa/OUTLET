import { InMemoryReferralStore } from "./in-memory";
import { describeReferralStoreContract } from "../test/repository-contract";

describeReferralStoreContract("in-memory", async () => {
  const store = new InMemoryReferralStore();
  return {
    store,
    ensureUser: async () => undefined,
    eventTypes: async () => store.events.map((e) => e.type),
    rewardEventAmounts: async () =>
      store.events.flatMap((e) => (e.type === "referral.reward_earned" ? [e.amount.toString()] : [])),
  };
});
