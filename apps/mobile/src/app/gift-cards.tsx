import { GiftCardsScreen } from "../features/gift-cards/GiftCardsScreen";
import { GuestGate } from "../features/me/GuestGate";

export default function Route() {
  return <GuestGate feature="giftCards">{() => <GiftCardsScreen />}</GuestGate>;
}
