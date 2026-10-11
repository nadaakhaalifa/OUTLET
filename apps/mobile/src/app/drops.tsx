import { useLocalSearchParams, useRouter } from "expo-router";
import { DropScreen } from "../features/drops/DropScreen";

export default function Route() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id?: string }>();
  // The admission token is handed to checkout through memory (features/drops/admissionStore), never the URL.
  return <DropScreen dropId={typeof id === "string" ? id : ""} onEnter={(dropId) => router.push({ pathname: "/checkout", params: { drop: dropId } })} />;
}
