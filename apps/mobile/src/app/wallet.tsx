import { WalletScreen } from "../features/wallet/WalletScreen";
import { GuestGate } from "../features/me/GuestGate";

export default function Route() {
  return <GuestGate feature="wallet">{() => <WalletScreen />}</GuestGate>;
}
