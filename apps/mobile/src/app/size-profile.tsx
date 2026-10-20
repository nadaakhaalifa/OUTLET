import { useMemo } from "react";
import { SizeProfileScreen } from "../features/size-profile/SizeProfileScreen";
import { LocalSizeProfilePort } from "../features/size-profile/local";
import { GuestGate } from "../features/me/GuestGate";
import { useServices } from "../state/services";

export default function Screen() {
  const services = useServices();
  // A guest's profile lives on this phone only (SecureStore); the server port is never created for a guest.
  const local = useMemo(() => new LocalSizeProfilePort(services.storage), [services]);
  return <GuestGate feature="sizeProfile">{(guest) => (guest ? <SizeProfileScreen port={local} single /> : <SizeProfileScreen />)}</GuestGate>;
}
