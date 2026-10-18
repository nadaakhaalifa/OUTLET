import { useEffect, useState } from "react";
import { Linking, View } from "react-native";
import { useRouter } from "expo-router";
import { useTranslation } from "react-i18next";
import { Banner, Eyebrow, Text } from "../../ui";
import { Section } from "../purchase/Section";
import { TextAction } from "../purchase/TextAction";
import { Flow } from "../purchase/motion";
import { Choice } from "./Choice";
import { useCheckoutSession } from "./CheckoutSession";
import { StepFrame, stepHref } from "./StepFrame";
import { installmentLine, pickText, stepBlockers, validateAddress, visiblePaymentMethods } from "./model";

/** Step 2: payment method, vouchers, store credit. Method availability and installment lines come from the quote only. */
export function PaymentStep() {
  const { t } = useTranslation();
  const router = useRouter();
  const s = useCheckoutSession();
  const [showErrors, setShowErrors] = useState(false);
  const { quote, sel, lang, totals } = s;

  // A method that became unavailable or kill-switched between steps drops the selection (never silently kept).
  const stillValid = quote !== null && sel !== null && (sel.paymentMethodId === null || visiblePaymentMethods(quote).some((m) => m.id === sel.paymentMethodId));
  useEffect(() => {
    if (!stillValid) { s.update({ paymentMethodId: null }); s.setNotice(t("checkoutSteps.methodDropped")); }
  }, [stillValid]);

  const blockers = quote !== null && sel !== null ? stepBlockers("payment", quote, sel, s.reconfirmed) : [];
  const method = quote !== null && sel !== null ? visiblePaymentMethods(quote).find((m) => m.id === sel.paymentMethodId) : undefined;
  const codNeedsAddress = quote !== null && sel !== null && method?.kind === "cod" && validateAddress(sel.address, quote.coverage, true).length > 0;

  return (
    <StepFrame step="payment" blockers={blockers} showErrors={showErrors} ctaLabel={t("checkoutSteps.continue")}
      onContinue={() => {
        if (codNeedsAddress) { router.dismissTo({ pathname: "/checkout", params: { highlight: "1" } } as never); return; }
        router.push(stepHref("review"));
      }}
      onBlocked={() => setShowErrors(true)}>
      {quote !== null && sel !== null && totals !== null ? (
        <>
          <Flow index={0}><Section title={t("checkout.paymentHeading")}>
            {totals.payable === 0n ? <Text variant="callout" secondary>{t("checkout.noExternalNeeded")}</Text> : (
              <View accessibilityRole="radiogroup" accessibilityLabel={t("checkout.paymentHeading")}>
                {visiblePaymentMethods(quote).map((m) => {
                  const inst = installmentLine(m);
                  const reason = m.unavailableReason !== null ? pickText(m.unavailableReason, lang) : null;
                  return (
                    <Choice key={m.id} label={pickText(m.name, lang)} selected={sel.paymentMethodId === m.id} disabled={!m.available}
                      onPress={() => s.update({ paymentMethodId: m.id })}
                      detail={
                        <>
                          {!m.available ? <Text variant="caption" color="danger">{reason !== null ? t("checkout.methodUnavailable", { reason }) : t("checkout.methodUnavailableGeneric")}</Text> : null}
                          {m.available && inst !== null ? (
                            <>
                              <Text variant="caption" secondary>
                                {t("checkout.installmentLine", { provider: inst.providerName, monthly: s.money(inst.monthly), months: s.num(inst.tenorMonths) })}
                              </Text>
                              <Text variant="caption" secondary>{t("checkout.installmentFee", { amount: s.money(inst.adminFee) })}</Text>
                              {inst.termsUrl.startsWith("https://") ? (
                                <TextAction label={t("checkout.installmentTerms", { provider: inst.providerName })} onPress={() => void Linking.openURL(inst.termsUrl)} />
                              ) : null}
                            </>
                          ) : null}
                          {m.note !== null ? <Text variant="caption" secondary>{pickText(m.note, lang)}</Text> : null}
                        </>
                      } />
                  );
                })}
              </View>
            )}
            {showErrors && (blockers.includes("paymentMethod") || blockers.includes("methodUnavailable")) ? (
              <Text variant="caption" color="danger">{t(blockers.includes("paymentMethod") ? "checkout.blockers.paymentMethod" : "checkout.blockers.methodUnavailable")}</Text>
            ) : null}
            {codNeedsAddress ? <Banner tone="warning" message={t("checkoutSteps.codNeedsPin")} /> : null}
          </Section></Flow>

          <Flow index={1}><Section title={t("checkout.vouchersHeading")}>
            {quote.vouchers.length === 0 ? <Text variant="callout" secondary>{t("checkout.noVouchers")}</Text> : quote.vouchers.map((v) => (
              <Choice key={v.code} role="checkbox" selected={sel.voucherCodes.includes(v.code)}
                label={t("checkout.voucherLine", { code: v.code, amount: s.money(v.discount) })}
                accessibilityLabel={t("checkout.voucherToggleName", { code: v.code })}
                onPress={() => s.update({ voucherCodes: sel.voucherCodes.includes(v.code) ? sel.voucherCodes.filter((c) => c !== v.code) : [...sel.voucherCodes, v.code] })} />
            ))}
            <Eyebrow>{t("checkout.creditHeading")}</Eyebrow>
            {quote.storeCreditBalance <= 0n ? <Text variant="callout" secondary>{t("checkout.creditNone")}</Text> : (
              <Choice role="checkbox" selected={sel.useStoreCredit} label={t("checkout.creditToggle", { balance: s.money(quote.storeCreditBalance) })}
                onPress={() => s.update({ useStoreCredit: !sel.useStoreCredit })} />
            )}
          </Section></Flow>
        </>
      ) : null}
    </StepFrame>
  );
}
