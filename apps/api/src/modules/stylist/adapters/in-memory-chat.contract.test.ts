import { InMemoryChatStore } from "./in-memory-chat";
import { describeChatStoreContract } from "../test/chat-store-contract";

describeChatStoreContract("in-memory", async () => {
  const store = new InMemoryChatStore();
  return {
    store,
    ensureUser: async () => undefined,
    eventTypes: async () => store.events.map((e) => e.type),
  };
});
