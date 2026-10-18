import { useLocalSearchParams, useRouter } from "expo-router";
import { FamilyInviteScreen } from "../../features/family/FamilyInviteScreen";

/** Deep link target for family invitations (zoutlet://family-invite/<token>). The token is never logged. */
export default function Route() {
  const router = useRouter();
  const { token } = useLocalSearchParams<{ token: string }>();
  return (
    <FamilyInviteScreen
      token={typeof token === "string" ? token : ""}
      onBack={() => (router.canGoBack() ? router.back() : router.replace("/"))}
      onDone={() => router.replace("/plus")}
    />
  );
}
