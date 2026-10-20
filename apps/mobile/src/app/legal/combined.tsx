import { LegalCombinedScreen } from "../../features/legal/LegalCombinedScreen";

/** One screen with both the Terms of Service and the Privacy Policy. A static route wins over `[id]`. */
export default function LegalCombinedRoute() {
  return <LegalCombinedScreen />;
}
