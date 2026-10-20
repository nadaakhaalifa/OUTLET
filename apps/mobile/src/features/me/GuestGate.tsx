import type { ReactNode } from "react";
import { useRouter } from "expo-router";
import { useTranslation } from "react-i18next";
import { EmptyState, Screen } from "../../ui";
import { guestRule, type GuestFeature } from "../guest/capabilities";
import { guestStateCopy } from "./guest-states";
import { useGuestGateMode } from "./useGuest";

/**
 * Route guard. Members see the screen. A guest sees the screen in guest mode when the table says so, otherwise an honest
 * state: never a sign-up wall, a button to create an account, or a link to the sign-up route.
 */
export function GuestGate(props: { feature: GuestFeature; children: (guest: boolean) => ReactNode }) {
  const mode = useGuestGateMode();
  const { t } = useTranslation();
  const router = useRouter();
  if (mode === "unknown") return null;
  if (mode === "member") return <>{props.children(false)}</>;
  if (guestRule(props.feature).screen) return <>{props.children(true)}</>;
  const copy = guestStateCopy(props.feature);
  return (
    <Screen onBack={() => (router.canGoBack() ? router.back() : router.replace("/"))} backLabel={t("common.back")}>
      <EmptyState title={t(copy.titleKey)} description={t(copy.bodyKey)} />
    </Screen>
  );
}
