import { useEffect, useRef, useState, type ReactNode } from "react";
import { View } from "react-native";
import { useRouter, type Href } from "expo-router";
import { useTranslation } from "react-i18next";
import { spacing } from "@outlet/ui-tokens";
import { Banner, EmptyState, ErrorState, LoadingState, Screen, StepIndicator } from "../../ui";
import { Illustration } from "../../art";
import { useCheckoutSession } from "./CheckoutSession";
import { DoneStates } from "./DoneStates";
import { BackBlockedBanner, SummaryBar } from "./SummaryBar";
import { CHECKOUT_STEPS, previousStep, type CheckoutStep, type StepBlocker } from "./model";

export const stepHref = (s: CheckoutStep): Href => (s === "delivery" ? "/checkout" : `/checkout/${s}`) as Href;

export function blockerText(b: StepBlocker | undefined, t: (k: string) => string): string | null {
  if (b === undefined) return null;
  return b === "admission" ? t("nav.admissionMissing") : t(`checkout.blockers.${b}`);
}

/**
 * Shared chrome for the three step pages: step indicator, loading/error/empty states, done and awaiting-payment states,
 * the sticky summary bar and back handling (ADR-0053). The page body renders only when a quote and selection exist.
 */
export function StepFrame(props: {
  step: CheckoutStep;
  blockers: readonly StepBlocker[];
  showErrors: boolean;
  ctaLabel: string;
  ctaLoading?: boolean;
  /** Called when Continue is pressed with no blockers. */
  onContinue: () => void;
  /** Called when Continue is pressed while blockers remain (the page reveals its field errors). */
  onBlocked: () => void;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const router = useRouter();
  const s = useCheckoutSession();
  const [backBlocked, setBackBlocked] = useState(false);
  const enteredAt = useRef(Date.now());
  const viewed = useRef(false);
  const { quote, sel } = s;

  useEffect(() => { s.noteStep(props.step); }, [props.step]);
  useEffect(() => {
    if (quote !== null && !viewed.current) {
      viewed.current = true;
      s.telemetry.stepViewed(props.step, quote.shipments.filter((x) => x.lines.length > 0).length);
    }
  }, [quote, props.step, s.telemetry]);

  const viewOrders = () => router.replace("/orders");
  if (s.submission.status === "done" || s.submission.status === "awaitingPayment") {
    return (
      <DoneStates submission={s.submission} action={s.action} notice={s.notice} locale={s.lang}
        onCheckStatus={() => void s.checkStatus()} onViewOrders={viewOrders} onContinueShopping={() => router.replace("/(tabs)" as Href)} />
    );
  }

  const idx = CHECKOUT_STEPS.indexOf(props.step);
  const goBack = () => {
    if (s.locked) { setBackBlocked(true); return; }
    if (previousStep(props.step) !== null || router.canGoBack()) router.back();
    else router.replace("/(tabs)" as Href);
  };
  const ready = quote !== null && sel !== null && s.totals !== null && !s.empty;
  const busy = s.submission.status === "submitting";
  const onPress = () => {
    if (props.blockers.length > 0) { props.onBlocked(); return; }
    s.telemetry.stepCompleted(props.step, Date.now() - enteredAt.current);
    props.onContinue();
  };
  const footer = ready ? (
    <SummaryBar quote={quote} sel={sel} lang={s.lang} money={s.money}
      blockerText={props.showErrors ? blockerText(props.blockers[0], t) : null}
      cta={{ label: props.ctaLabel, onPress, disabled: busy || (props.step === "review" && s.admissionMissing), loading: props.ctaLoading === true,
        testID: props.step === "review" ? "checkout-place-order" : `checkout-continue-${props.step}` }} />
  ) : undefined;

  return (
    <Screen title={t("checkout.title")} onBack={goBack} backLabel={t("common.back")} {...(footer !== undefined ? { footer } : {})}>
      {ready || s.state.status === "loading" ? (
        <StepIndicator testID="checkout-steps" doneLabel={t("checkoutSteps.edit")}
          steps={CHECKOUT_STEPS.map((id, i) => ({ id, label: t(`checkoutSteps.${id}`), done: i < idx, active: i === idx }))}
          onPress={(id) => { const target = CHECKOUT_STEPS.indexOf(id as CheckoutStep); if (target < idx && !s.locked) router.dismissTo(stepHref(id as CheckoutStep)); }} />
      ) : null}
      {backBlocked && s.locked ? <BackBlockedBanner onViewOrders={viewOrders} /> : null}
      {s.state.status === "loading" ? <LoadingState label={t("checkout.loading")} /> : null}
      {s.state.status === "error" ? (
        <View style={{ gap: spacing.md }}>
          <ErrorState offline={s.state.offline} title={t(s.state.offline ? "checkout.offlineTitle" : "checkout.errorTitle")}
            description={t(s.state.offline ? "checkout.offlineBody" : "checkout.errorBody")} retryTitle={t("common.retry")} onRetry={s.reload} />
          {sel !== null ? <Banner tone="info" message={t("checkoutSteps.quoteFailed")} /> : null}
        </View>
      ) : null}
      {s.admissionMissing ? <Banner tone="error" message={t("nav.admissionMissing")} /> : null}
      {s.empty ? <EmptyState illustration={<Illustration name="emptyBag" size={110} />} title={t("checkout.emptyTitle")} description={t("checkoutSteps.emptyBag")} /> : null}
      {ready ? props.children : null}
      {s.notice !== null ? <Banner tone="warning" message={s.notice} /> : null}
    </Screen>
  );
}
