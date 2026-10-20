import { useEffect, useState } from "react";
import { View } from "react-native";
import { useRouter, type Href } from "expo-router";
import { useTranslation } from "react-i18next";
import { Button, Chip, Text, TextField } from "../../ui";
import { Illustration } from "../../art";
import { StepScaffold } from "../../components/Scaffold";
import { STORAGE_KEYS } from "../../platform/secure-storage";
import { useServices } from "../../state/services";
import {
  BRAND_OPTIONS, EMPTY_PREFS, SIZE_OPTIONS, VIBE_OPTIONS, nextPrefStep, parseMonthlyBudget, parsePrefs, toggle,
  type OnboardingPrefs, type PrefStep,
} from "./model";

const ROUTES: Record<PrefStep, string> = {
  vibes: "/onboarding/vibes", sizes: "/onboarding/sizes", brands: "/onboarding/brands", budget: "/onboarding/budget", notifications: "/onboarding/notifications",
};

const PREF_ORDER: readonly PrefStep[] = ["vibes", "sizes", "brands", "budget", "notifications"];

export function PrefStepScreen(props: { step: PrefStep }) {
  const { t } = useTranslation();
  const router = useRouter();
  const services = useServices();
  const [prefs, setPrefs] = useState<OnboardingPrefs>(EMPTY_PREFS);
  const [budgetText, setBudgetText] = useState("");
  const [budgetError, setBudgetError] = useState(false);

  useEffect(() => {
    let alive = true;
    void services.storage.getString(STORAGE_KEYS.onboardingPrefs).then((v) => { if (alive) setPrefs(parsePrefs(v)); }, () => undefined);
    return () => { alive = false; };
  }, [services]);

  const advance = async (next: OnboardingPrefs, skipped: boolean) => {
    try {
      await services.storage.setString(STORAGE_KEYS.onboardingPrefs, JSON.stringify(next));
    } catch {
      // Preferences are optional; not persisting is safe.
    }
    void skipped;
    const n = nextPrefStep(props.step);
    router.replace((n === null ? "/onboarding/welcome" : ROUTES[n]) as Href);
  };

  const s = props.step;
  const chips = (options: readonly string[], selected: readonly string[], on: (v: string) => void, label?: (v: string) => string) => (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
      {options.map((o) => <Chip key={o} label={label?.(o) ?? o} selected={selected.includes(o)} onPress={() => on(o)} />)}
    </View>
  );

  return (
    <StepScaffold
      step="done"
      progress={{ current: PREF_ORDER.indexOf(s) + 1, total: PREF_ORDER.length, label: t("onboarding.prefs.progress", { current: PREF_ORDER.indexOf(s) + 1, total: PREF_ORDER.length }) }}
      title={t(`onboarding.prefs.${s}.title`)} body={t(`onboarding.prefs.${s}.body`)}
    >
      {s === "vibes" ? chips(VIBE_OPTIONS, prefs.vibes, (v) => setPrefs((p) => ({ ...p, vibes: toggle(p.vibes, v) })), (v) => t(`onboarding.prefs.vibes.${v}`)) : null}
      {s === "sizes" ? (
        <>
          {chips(SIZE_OPTIONS, prefs.sizes, (v) => setPrefs((p) => ({ ...p, sizes: toggle(p.sizes, v), measureLater: false })))}
          <Chip label={t("onboarding.prefs.sizes.later")} selected={prefs.measureLater} onPress={() => setPrefs((p) => ({ ...p, measureLater: !p.measureLater, sizes: [] }))} />
        </>
      ) : null}
      {s === "brands" ? chips(BRAND_OPTIONS, prefs.brands, (v) => setPrefs((p) => ({ ...p, brands: toggle(p.brands, v) }))) : null}
      {s === "budget" ? (
        <TextField
          label={`${t("onboarding.prefs.budget.label")} (${t("common.currency")})`}
          value={budgetText}
          onChangeText={(v) => { setBudgetText(v); setBudgetError(false); }}
          keyboardType="numeric"
          helper={t("onboarding.prefs.budget.helper")}
          {...(budgetError ? { error: t("onboarding.prefs.budget.invalid") } : {})}
        />
      ) : null}
      {s === "notifications" ? (
        <View style={{ alignItems: "center", gap: 12, paddingVertical: 12 }}>
          <Illustration name="stylistSparkle" size={96} />
          <Text secondary align="center">{t("onboarding.prefs.notifications.value")}</Text>
        </View>
      ) : null}
      <Button
        variant="brand"
        title={s === "notifications" ? t("onboarding.prefs.notifications.allow") : t("common.continue")}
        onPress={() => {
          if (s === "budget") {
            const r = parseMonthlyBudget(budgetText);
            if (!r.ok) { setBudgetError(true); return; }
            void advance({ ...prefs, budgetEgp: r.value }, false);
            return;
          }
          void advance(s === "notifications" ? { ...prefs, notifications: "asked" } : prefs, false);
        }}
      />
      <Button
        title={t("common.skip")}
        variant="ghost"
        onPress={() => void advance(s === "notifications" ? { ...prefs, notifications: "later" } : prefs, true)}
      />
    </StepScaffold>
  );
}
