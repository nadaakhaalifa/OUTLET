import { useState } from "react";
import { StylistScreen } from "../features/stylist/StylistScreen";
import { StylistChatScreen } from "../features/stylist-chat/StylistChatScreen";
import { GuestGate } from "../features/me/GuestGate";

/** Stylist route (not a tab, ADR-0044): the structured stylist, with the chat opened inside the tab (back returns here). */
export default function Screen() {
  const [chat, setChat] = useState(false);
  return (
    <GuestGate feature="stylist">
      {() => (chat ? <StylistChatScreen onBack={() => setChat(false)} /> : <StylistScreen onOpenChat={() => setChat(true)} />)}
    </GuestGate>
  );
}
