import { useEffect } from "react";
import { View } from "react-native";
import { useTranslation } from "react-i18next";
import { spacing } from "@outlet/ui-tokens";
import { Banner, Button, Card, Eyebrow, Screen, Text, successNotice } from "../../ui";
import { Illustration } from "../../art";
import { localizeDigits } from "../money-display";
import { Settle } from "../purchase/motion";
import { TrackOrderPrompt } from "../purchase/TrackOrderPrompt";
import { orderNumber, type ClientAction, type Submission } from "./model";

function NextSteps(props: { cod: boolean }) {
  const { t } = useTranslation();
  const steps = props.cod ? ["checkout.nextSeller", "checkout.nextCod", "checkout.nextReturn"] : ["checkout.nextSeller", "checkout.nextTrack", "checkout.nextReturn"];
  return (
    <Card variant="elevated" style={{ gap: spacing.md, alignSelf: "stretch" }}>
      <Text variant="headline" weight="600">{t("checkout.nextHeading")}</Text>
      {steps.map((k, i) => (
        <Settle key={k} delay={600 + i * 120} style={{ flexDirection: "row", gap: spacing.md, alignItems: "flex-start" }}>
          <Text variant="caption" secondary numeric style={{ width: 20 }}>{`0${i + 1}`}</Text>
          <Text variant="callout" style={{ flex: 1 }}>{t(k)}</Text>
        </Settle>
      ))}
    </Card>
  );
}

/** Order placed, or payment pending. Rendered by every step page when the shared submission reaches these states. */
export function DoneStates(props: {
  submission: Extract<Submission, { status: "done" | "awaitingPayment" }>;
  action: ClientAction | null;
  notice: string | null;
  locale: "ar" | "en";
  onCheckStatus: () => void;
  onViewOrders: () => void;
  onContinueShopping: () => void;
}) {
  const { t } = useTranslation();
  const s = props.submission;
  const done = s.status === "done";
  useEffect(() => { if (done) successNotice(); }, [done]);
  if (s.status === "done") {
    return (
      <Screen>
        <View style={{ alignItems: "center", gap: spacing.lg, paddingTop: spacing.xxxl }}>
          <Settle><Illustration name="success" size={132} label={t("checkout.doneTitle")} /></Settle>
          <Settle delay={240} style={{ alignItems: "center", gap: spacing.lg }}>
            <Eyebrow>{t("checkout.confirmedEyebrow")}</Eyebrow>
            <Text variant="display" align="center">{t("checkout.doneTitle")}</Text>
          </Settle>
          <Settle delay={420} style={{ alignItems: "center", gap: spacing.lg }}>
            <Text variant="callout" secondary align="center">{t(s.cod ? "checkout.doneCod" : "checkout.doneBody")}</Text>
            <Text variant="callout" numeric>{t("checkout.orderNumber", { id: localizeDigits(orderNumber(s.orderGroupId), props.locale) })}</Text>
          </Settle>
        </View>
        <NextSteps cod={s.cod} />
        <TrackOrderPrompt />
        <Settle delay={960} style={{ gap: spacing.sm }}>
          <Button title={t("checkout.viewOrders")} fullWidth onPress={props.onViewOrders} />
          <Button variant="ghost" title={t("checkout.continueShopping")} fullWidth onPress={props.onContinueShopping} />
        </Settle>
      </Screen>
    );
  }
  return (
    <Screen>
      <Settle style={{ alignItems: "center", gap: spacing.lg, paddingTop: spacing.xxxl }}>
        <Illustration name="deliveryTruck" size={120} />
        <Text variant="display" align="center">{t("checkout.awaitingTitle")}</Text>
        <Text variant="callout" secondary align="center">{t("checkout.awaitingBody")}</Text>
      </Settle>
      {props.action?.type === "reference_code" ? <Banner tone="info" message={t("checkout.referenceCode", { code: props.action.code })} /> : null}
      {props.notice !== null ? <Banner tone="warning" message={props.notice} /> : null}
      <Button title={t("checkout.checkStatus")} fullWidth onPress={props.onCheckStatus} />
      <Button variant="secondary" title={t("checkout.viewOrders")} fullWidth onPress={props.onViewOrders} />
    </Screen>
  );
}
