import { useLocalSearchParams } from "expo-router";
import { LegalScreen } from "../../features/legal/LegalScreen";
import { isLegalDocId } from "../../features/legal/model";
import { Redirect } from "expo-router";

export default function LegalRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  if (!isLegalDocId(id)) return <Redirect href="/settings" />;
  return <LegalScreen id={id} />;
}
