import { useEffect } from "react";
import type { Href } from "expo-router";
import { View } from "react-native";
import { useTranslation } from "react-i18next";
import { FadeIn, LoadingState, useTheme } from "../../../ui";
import { Monogram } from "../../../art";
import { useBrandApply } from "../context";
import { useFlowNav } from "../nav";
import { errorCodeOf, resumeTarget } from "../model";

/** `/brand`: decides where a brand applicant lands (type choice, a saved step, or the status screen). */
export function GateScreen() {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const s = useBrandApply();
  const nav = useFlowNav();
  const { ready, draft, kit, strongFactor, setApp } = s;

  useEffect(() => {
    if (!ready) return;
    let alive = true;
    void (async () => {
      if (draft.draftId === null) {
        const t0 = resumeTarget(draft, null, strongFactor);
        if (alive) nav.replace(t0.route === "status" ? "status" : t0.step === "type" ? "type" : t0.step);
        return;
      }
      try {
        const app = await kit.port.getApplication(draft.draftId);
        setApp(app);
        const t0 = resumeTarget(draft, app, strongFactor);
        if (alive) nav.replace(t0.route === "status" ? "status" : t0.step);
      } catch (e) {
        if (!alive) return;
        const code = errorCodeOf(e);
        // A session that ended (or an app that is gone) sends the brand back through verification, keeping the draft.
        if (code === "not_found") { s.clearDraft(); nav.replace("type"); }
        else nav.router.replace("/brand/account?signin=1" as Href);
      }
    })();
    return () => { alive = false; };
  }, [ready]);

  return (
    <View style={{ flex: 1, backgroundColor: colors.background, alignItems: "center", justifyContent: "center", gap: 24 }}>
      <FadeIn><Monogram size={56} /></FadeIn>
      <LoadingState label={t("brandApply.common.loading")} />
    </View>
  );
}
