import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter, type Href } from "expo-router";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { spacing } from "@outlet/ui-tokens";
import { Banner, Button, LoadingState, Screen, Text } from "../../ui";
import { getGuestStore } from "../../state/ports";
import { useServices } from "../../state/services";
import { getApiRuntime, getSharedClient } from "../../services/runtime";
import { ApiMergeTransport, newMergeKey, noteText, runGuestMerge, type MergeSummary } from "../guest";
import { localizeDigits } from "../money-display";
import { flushAfterSignUp } from "./model";
import { CHECKOUT_STEP_ONE, isNewAccountSignUp, peekReturnTarget, takeReturnTarget } from "../flow";
import { SIGN_UP_ROUTE } from "./model";
import { shouldFlushConsents, offersContinueWithout } from "./merge-phase-logic";

type Phase = { readonly kind: "running" } | { readonly kind: "failed"; readonly status: number } | { readonly kind: "summary"; readonly summary: MergeSummary };

/** Spec F3 step 6: merge once, tell the shopper only if something changed, then Delivery. A failed merge never blocks checkout. */
export function MergePhase() {
  const { t, i18n } = useTranslation();
  const num = (v: number): string => localizeDigits(String(v), i18n.language === "en" ? "en" : "ar");
  const router = useRouter();
  const services = useServices();
  const [phase, setPhase] = useState<Phase>({ kind: "running" });
  const started = useRef(false);

  const leave = useCallback(() => {
    router.replace((takeReturnTarget() ?? CHECKOUT_STEP_ONE) as Href);
  }, [router]);

  const run = useCallback(async () => {
    setPhase({ kind: "running" });
    const runtime = getApiRuntime();
    if (runtime === null) { leave(); return; } // no backend (fixture mode): nothing to merge into
    try {
      const out = await runGuestMerge({
        store: getGuestStore(),
        transport: new ApiMergeTransport(getSharedClient(runtime)),
        newKey: newMergeKey,
        includeViewed: services.consent.isGranted("personalization"),
      });
      if (out.kind === "failed") { setPhase({ kind: "failed", status: out.status }); return; }
      if (out.kind === "done" && out.summary.changed) { setPhase({ kind: "summary", summary: out.summary }); return; }
      leave();
    } catch {
      setPhase({ kind: "failed", status: 0 });
    }
  }, [leave, services]);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (peekReturnTarget() === null) { router.replace("/(tabs)" as Href); return; } // nothing is waiting for a merge
    // New accounts only: device guest decisions must never overwrite an existing member's consents. Awaited so the
    // personalization consent is stored before the merge reads it.
    void (async () => {
      if (shouldFlushConsents(isNewAccountSignUp())) await flushAfterSignUp(services);
      await run();
    })();
  }, [run, router, services]);

  return (
    <Screen><View testID="merge-phase">
      {phase.kind === "running" ? <LoadingState label={t("guestMerge.moving")} /> : null}
      {phase.kind === "failed" ? (
        <View style={{ gap: spacing.md }}>
          <Text variant="title1" accessibilityRole="header">{t("guestMerge.failedTitle")}</Text>
          <Text variant="body" secondary>{t("guestMerge.failedBody")}</Text>
          <Button variant="brand" title={t("guestMerge.retry")} onPress={() => void run()} testID="merge-retry" />
          {offersContinueWithout(phase.status)
            ? <Button variant="ghost" title={t("guestMerge.continueWithout")} onPress={leave} testID="merge-skip" />
            : <Button variant="ghost" title={t("guestMerge.signInAgain")} onPress={() => router.replace(SIGN_UP_ROUTE as Href)} testID="merge-signin-again" />}
        </View>
      ) : null}
      {phase.kind === "summary" ? (
        <View testID="merge-summary" style={{ gap: spacing.md }}>
          <Text variant="title1" accessibilityRole="header">{t("guestMerge.summaryTitle")}</Text>
          {phase.summary.notes.map((n, i) => <Banner key={`${n.kind}-${i}`} tone="info" message={t(noteText(n, num).key, noteText(n, num).params)} />)}
          {phase.summary.savedOverCap > 0 ? <Banner tone="info" message={t("guestMerge.savedOverCap", { max: num(200) })} /> : null}
          {phase.summary.savedUnavailable > 0 ? <Banner tone="info" message={t("guestMerge.savedUnavailable")} /> : null}
          <Button variant="brand" title={t("guestMerge.continue")} onPress={leave} testID="merge-continue" />
          <Button variant="ghost" title={t("guestMerge.reviewBag")} onPress={() => { takeReturnTarget(); router.replace("/(tabs)/bag" as Href); }} testID="merge-review-bag" />
        </View>
      ) : null}
    </View></Screen>
  );
}
