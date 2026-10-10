import {
  InMemoryBreachRepository,
  InMemoryConsentRepository,
  InMemoryPrivacyOutbox,
  InMemoryPrivacyRequestRepository,
} from "./in-memory";
import { describePrivacyRepositoryContract } from "../test/repository-contract";

describePrivacyRepositoryContract("in-memory", async () => {
  const outbox = new InMemoryPrivacyOutbox();
  return {
    requests: new InMemoryPrivacyRequestRepository(outbox),
    breaches: new InMemoryBreachRepository(outbox),
    consents: new InMemoryConsentRepository(outbox),
    ensureUser: async () => undefined,
    eventTypes: async () => outbox.events.map((e) => e.type),
  };
});
