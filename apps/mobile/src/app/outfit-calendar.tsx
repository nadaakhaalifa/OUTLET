import { OutfitCalendarScreen } from "../features/outfit-calendar/OutfitCalendarScreen";
import { GuestGate } from "../features/me/GuestGate";

export default function Route() {
  return <GuestGate feature="outfitCalendar">{() => <OutfitCalendarScreen />}</GuestGate>;
}
