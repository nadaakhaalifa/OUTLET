import { WardrobeScreen } from "../features/wardrobe/WardrobeScreen";
import { GuestGate } from "../features/me/GuestGate";

export default function Route() {
  return <GuestGate feature="wardrobe">{() => <WardrobeScreen />}</GuestGate>;
}
