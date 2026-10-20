import { PlusScreen } from "../features/plus/PlusScreen";
import { GuestGate } from "../features/me/GuestGate";

export default function Route() {
  return <GuestGate feature="plus">{(guest) => <PlusScreen guest={guest} />}</GuestGate>;
}
