import { useState } from "react";
import { View } from "react-native";
import { useTranslation } from "react-i18next";
import { spacing } from "@outlet/ui-tokens";
import { Banner, Button, StickyBar, Text, useTheme } from "../../ui";
import { TestId } from "../../components/TestId";
import { TextAction } from "../purchase/TextAction";
import { ValueFade } from "../purchase/motion";
import { pickText, summaryLines, type CheckoutQuote, type CheckoutSelection, type SummaryLine } from "./model";

export interface SummaryCta {
  readonly label: string;
  readonly onPress: () => void;
  readonly disabled: boolean;
  readonly loading?: boolean;
  readonly testID: string;
}

function Row(props: { label: string; value: string; strong?: boolean; savings?: boolean }) {
  return (
    <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "baseline", gap: spacing.md }}>
      <Text variant={props.strong === true ? "headline" : "callout"} secondary={props.strong !== true} style={{ flexShrink: 1 }}>{props.label}</Text>
      <Text variant="callout" numeric weight={props.strong === true ? "600" : "400"} {...(props.savings === true ? { color: "savings" as const } : {})}>{props.value}</Text>
    </View>
  );
}

/**
 * Sticky footer on every step (ADR-0053). Everything below comes from `summaryLines`, which reads only the quote and the
 * selection, so the numbers on Delivery, Payment and Review are identical for the same choices (no drip pricing).
 */
export function SummaryBar(props: {
  quote: CheckoutQuote;
  sel: CheckoutSelection;
  lang: "ar" | "en";
  money: (m: bigint) => string;
  cta: SummaryCta;
  blockerText?: string | null;
}) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const [open, setOpen] = useState(false);
  const lines = summaryLines(props.quote, props.sel);
  const total = lines.find((l) => l.kind === "payable") ?? lines.find((l) => l.kind === "total");
  const label = (l: SummaryLine): string => {
    switch (l.kind) {
      case "merchandise": return t("checkoutSteps.merchandise");
      case "delivery": return t("checkoutSteps.deliveryFrom", { store: l.storeName });
      case "fee": return pickText(l.name, props.lang);
      case "voucher": return t("checkoutSteps.voucher");
      case "credit": return t("checkoutSteps.storeCredit");
      case "total": return t("checkoutSteps.total");
      case "payable": return t("checkoutSteps.payable");
      case "saved": return t("checkoutSteps.saved", { amount: props.money(l.amount) });
    }
  };
  return (
    <StickyBar>
      {open ? (
        <View testID="checkout-summary-details" style={{ gap: spacing.sm, borderBottomWidth: 1, borderBottomColor: colors.hairline, paddingBottom: spacing.md }}>
          {lines.filter((l) => l.kind !== "saved").map((l, i) => (
            <Row key={`${l.kind}-${String(i)}`} label={label(l)} strong={l.kind === "total"}
              value={l.kind === "delivery" && l.amount === 0n ? t("checkout.free") : `${l.kind === "voucher" || l.kind === "credit" ? "-" : ""}${props.money(l.amount)}`} />
          ))}
          {lines.map((l) => (l.kind === "saved" ? <Text key="saved" variant="callout" color="savings">{label(l)}</Text> : null))}
        </View>
      ) : null}
      <View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", alignItems: "baseline", gap: spacing.sm }}>
        <View style={{ flexDirection: "row", gap: spacing.md, alignItems: "baseline", flexShrink: 1 }}>
          <Text variant="callout" weight="500">{total?.kind === "payable" ? t("checkoutSteps.payable") : t("checkoutSteps.total")}</Text>
          <TestId id="checkout-summary-toggle"><TextAction label={t(open ? "checkoutSteps.hideDetails" : "checkoutSteps.details")} onPress={() => setOpen((o) => !o)} /></TestId>
        </View>
        <ValueFade value={String(total?.amount ?? 0n)}><Text variant="title2" weight="600" numeric>{props.money(total?.amount ?? 0n)}</Text></ValueFade>
      </View>
      {props.blockerText !== undefined && props.blockerText !== null ? <Text variant="caption" color="danger">{props.blockerText}</Text> : null}
      <TestId id={props.cta.testID}>
        <Button title={props.cta.label} fullWidth loading={props.cta.loading === true} disabled={props.cta.disabled} onPress={props.cta.onPress} />
      </TestId>
    </StickyBar>
  );
}

export function BackBlockedBanner(props: { onViewOrders: () => void }) {
  const { t } = useTranslation();
  return (
    <View style={{ gap: spacing.sm }}>
      <Banner tone="warning" message={t("checkoutSteps.backBlocked")} />
      <TextAction label={t("checkoutSteps.viewOrders")} onPress={props.onViewOrders} />
    </View>
  );
}
