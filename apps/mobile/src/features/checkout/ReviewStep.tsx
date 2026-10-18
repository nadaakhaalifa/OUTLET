import { useEffect, useState } from "react";
import { View } from "react-native";
import { useRouter } from "expo-router";
import { useTranslation } from "react-i18next";
import { spacing } from "@outlet/ui-tokens";
import { Banner, Button, Icon, StoreName, Text, useTheme } from "../../ui";
import { Section } from "../purchase/Section";
import { TextAction } from "../purchase/TextAction";
import { Flow } from "../purchase/motion";
import { useCheckoutSession } from "./CheckoutSession";
import { StepFrame, stepHref } from "./StepFrame";
import { addressSummary, firstBlockedStep, needsReconfirmation, pickText, stepBlockers, visiblePaymentMethods } from "./model";

/** Step 3: read-only summary, price-delta re-confirmation and Place order (the only place the idempotency key is created). */
export function ReviewStep() {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const router = useRouter();
  const s = useCheckoutSession();
  const [showErrors, setShowErrors] = useState(false);
  const { quote, sel, lang, totals } = s;

  // Earlier steps must still be satisfied (a method can be kill-switched meanwhile): send the shopper back to the first broken one.
  const broken = quote !== null && sel !== null && s.submission.status !== "submitting" ? firstBlockedStep(quote, sel, s.reconfirmed) : null;
  useEffect(() => {
    if (broken !== null && broken !== "review") router.dismissTo(stepHref(broken));
  }, [broken]);

  const blockers = quote !== null && sel !== null ? stepBlockers("review", quote, sel, s.reconfirmed, s.admissionMissing) : [];
  const method = quote !== null && sel !== null ? visiblePaymentMethods(quote).find((m) => m.id === sel.paymentMethodId) : undefined;
  const busy = s.submission.status === "submitting";
  const failed = s.submission.status === "failed" ? s.submission : null;
  const saved = totals !== null && totals.verifiedSavings > 0n ? totals.verifiedSavings : null;

  return (
    <StepFrame step="review" blockers={blockers} showErrors={showErrors} ctaLabel={t(busy ? "checkout.placing" : "checkout.placeOrder")} ctaLoading={busy}
      onContinue={() => void s.place()} onBlocked={() => setShowErrors(true)}>
      {quote !== null && sel !== null && totals !== null ? (
        <>
          <Flow index={0}><Section title={t("checkout.reviewHeading")}>
            <View style={{ gap: spacing.xs }}>
              <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: spacing.md }}>
                <Text variant="callout" style={{ flex: 1 }}>{addressSummary(sel.address, quote.coverage, lang)}</Text>
                <TextAction label={t("checkoutSteps.edit")} onPress={() => router.dismissTo(stepHref("delivery"))} />
              </View>
            </View>
            {totals.shipments.map((sh) => (
              <View key={sh.shipmentId} style={{ gap: spacing.xs, borderTopWidth: 1, borderTopColor: colors.hairline, paddingTop: spacing.md }}>
                <StoreName name={sh.storeName} layout="row" />
                <Text variant="caption" secondary numeric>{sh.delivery === 0n ? t("checkout.free") : s.money(sh.delivery)}</Text>
              </View>
            ))}
            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: spacing.md, borderTopWidth: 1, borderTopColor: colors.hairline, paddingTop: spacing.md }}>
              <Text variant="callout" style={{ flex: 1 }}>{method !== undefined ? pickText(method.name, lang) : t("checkout.noExternalNeeded")}</Text>
              <TextAction label={t("checkoutSteps.edit")} onPress={() => router.dismissTo(stepHref("payment"))} />
            </View>
            {saved !== null ? <Text variant="callout" color="savings">{t("checkoutSteps.saved", { amount: s.money(saved) })}</Text> : null}
            <Text variant="caption" secondary>{t("checkout.feesNote")}</Text>
            <Text variant="caption" secondary>{t("checkout.priceLock", { minutes: s.num(Math.max(1, Math.round(quote.priceLockSeconds / 60))) })}</Text>
          </Section></Flow>

          {!quote.isPlusMember && quote.plusSavings !== null && quote.plusSavings > 0n ? (
            <View style={{ flexDirection: "row", gap: spacing.md, alignItems: "center", borderTopWidth: 1, borderBottomWidth: 1, borderColor: colors.hairline, paddingVertical: spacing.md }}>
              <Icon name="sparkles-outline" size={18} color="plus" />
              <Text variant="callout" color="plus" style={{ flex: 1 }}>{t("nav.plusNudge", { product: "Z-OUTLET", amount: s.money(quote.plusSavings) })}</Text>
            </View>
          ) : null}

          {totals.priceDelta !== 0n ? (
            <View style={{ gap: spacing.md }}>
              <Banner tone="warning" prefix={t("checkout.priceRoseTitle")}
                message={t(totals.priceDelta > 0n ? "checkout.priceRose" : "checkout.priceDropped", { amount: s.money(totals.priceDelta > 0n ? totals.priceDelta : -totals.priceDelta) })} />
              {needsReconfirmation(totals, s.reconfirmed) ? <Button variant="secondary" fullWidth title={t("checkout.acceptDelta")} onPress={() => s.acceptDelta(totals.priceDelta)} /> : null}
            </View>
          ) : null}

          {failed !== null ? (
            <Banner tone="error" message={failed.reason !== null ? t("checkout.rejected", { reason: pickText(failed.reason, lang) }) : t(failed.retryable ? "checkout.networkRetry" : "checkout.failedGeneric")} />
          ) : null}
        </>
      ) : null}
    </StepFrame>
  );
}
