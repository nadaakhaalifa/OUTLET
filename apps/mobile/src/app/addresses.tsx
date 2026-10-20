import { AddressesScreen } from "../features/addresses/AddressesScreen";
import { GuestGate } from "../features/me/GuestGate";

export default function Route() {
  return <GuestGate feature="addresses">{() => <AddressesScreen />}</GuestGate>;
}
