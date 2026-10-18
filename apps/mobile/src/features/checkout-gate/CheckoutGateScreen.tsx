import { useRouter } from "expo-router";
import { View } from "react-native";
import { useTranslation } from "react-i18next";
import { AccountCreateScreen } from "../account-creation/AccountCreateScreen";
import { setReturnTarget } from "../flow";
import { MergePhase } from "./MergePhase";

/**
 * The Checkout gate (spec F3): the only place a guest is asked to create an account (owner rule R0). It hosts the
 * existing account-creation flow with a short honest reason; cancelling returns to the Bag untouched.
 */
export function CheckoutGateScreen(props: { phase?: string | undefined }) {
  const { t } = useTranslation();
  const router = useRouter();
  if (props.phase === "merge") return <MergePhase />;
  return (
    <View testID="checkout-gate" style={{ flex: 1 }}>
    <AccountCreateScreen
      gate={{
        reason: t("checkoutGate.reason"),
        mergeRule: t("checkoutGate.mergeRule"),
        cancelLabel: t("checkoutGate.cancel"),
        onCancel: () => { setReturnTarget(null); router.back(); },
      }}
    />
    </View>
  );
}
