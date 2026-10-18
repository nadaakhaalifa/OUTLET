import { RewardsScreen } from "../features/rewards/RewardsScreen";
import { GuestGate } from "../features/me/GuestGate";

export default function Route() {
  return <GuestGate feature="rewards">{() => <RewardsScreen />}</GuestGate>;
}
