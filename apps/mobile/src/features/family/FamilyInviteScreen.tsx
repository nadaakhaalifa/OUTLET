import { useMemo, useRef, useState } from "react";
import { View } from "react-native";
import { useTranslation } from "react-i18next";
import { Banner, Button, Checkbox, EmptyState, Eyebrow, Reveal, Screen, Text } from "../../ui";
import { Illustration } from "../../art";
import { getFeaturePorts } from "../../state/ports";
import { newIdempotencyKey } from "../plus/idempotency";
import { PortError } from "../worlds/model";
import { localizeDigits } from "../money-display";
import { isPlausibleInviteToken, type AcceptOutcome, type DisplayLocale, type FamilyPort } from "./model";

type Phase =
  | { readonly kind: "ready" }
  | { readonly kind: "busy" }
  | { readonly kind: "done"; readonly ownPlanEnding: boolean }
  | { readonly kind: "refused"; readonly reason: string; readonly minAge: number | null }
  | { readonly kind: "failed"; readonly offline: boolean };

/**
 * Reached from an invitation link. The token comes from the route, is checked for shape and passed to the port;
 * it is never rendered, logged, put in analytics or kept in component state beyond the route param itself.
 */
export function FamilyInviteScreen(props: { token: string; port?: FamilyPort; onBack?: () => void; onDone?: () => void }) {
  const { t, i18n } = useTranslation();
  const locale: DisplayLocale = i18n.language === "en" ? "en" : "ar";
  const port = useMemo<FamilyPort>(() => props.port ?? getFeaturePorts().family, [props.port]);
  const [phase, setPhase] = useState<Phase>({ kind: "ready" });
  const [choice, setChoice] = useState(false);
  const [needsChoice, setNeedsChoice] = useState(false);
  const key = useRef<string | null>(null);
  const valid = isPlausibleInviteToken(props.token);

  const accept = async () => {
    if (phase.kind === "busy") return;
    setPhase({ kind: "busy" });
    key.current ??= newIdempotencyKey();
    let out: AcceptOutcome;
    try {
      out = await port.acceptInvite(props.token, choice, key.current);
    } catch (e) {
      setPhase({ kind: "failed", offline: e instanceof PortError && e.kind === "offline" });
      return;
    }
    key.current = null;
    if (out.kind === "accepted") setPhase({ kind: "done", ownPlanEnding: out.ownPlanEnding });
    else if (out.kind === "choiceRequired") { setNeedsChoice(true); setPhase({ kind: "ready" }); }
    else setPhase({ kind: "refused", reason: out.reason, minAge: out.minAge });
  };

  const back = props.onBack;
  return (
    <Screen title={t("family.accept.title")} onBack={back} backLabel={t("common.back")}>
      {!valid ? (
        <EmptyState illustration={<Illustration name="error" size={120} />} title={t("family.accept.invalidTitle")} description={t("family.accept.invalidBody")} {...(back !== undefined ? { actionTitle: t("common.back"), onAction: back } : {})} />
      ) : phase.kind === "done" ? (
        <View style={{ gap: 14 }}>
          <Banner tone="success" message={t("family.accept.done")} />
          {phase.ownPlanEnding ? <Text variant="callout" secondary>{t("family.accept.ownPlanEnding")}</Text> : null}
          {props.onDone !== undefined ? <Button variant="brand" title={t("family.accept.openPlus")} onPress={props.onDone} /> : null}
        </View>
      ) : phase.kind === "refused" ? (
        <EmptyState
          illustration={<Illustration name="error" size={120} />}
          title={t("family.accept.refusedTitle")}
          description={t(`family.accept.refused.${phase.reason}`, { age: localizeDigits(String(phase.minAge ?? 21), locale) })}
          {...(back !== undefined ? { actionTitle: t("common.back"), onAction: back } : {})}
        />
      ) : (
        <View style={{ gap: 18 }}>
          <Reveal index={0}><Text variant="lede" secondary>{t("family.accept.lede")}</Text></Reveal>
          <Reveal index={1} style={{ gap: 6 }}>
            <Eyebrow>{t("family.accept.whatYouGet")}</Eyebrow>
            <Text variant="callout">{t("family.accept.benefits")}</Text>
            <Text variant="caption" secondary>{t("family.accept.privacy")}</Text>
          </Reveal>
          {needsChoice ? (
            <View style={{ gap: 8 }}>
              <Banner tone="info" message={t("family.accept.hasOwnPlan")} />
              <Checkbox label={t("family.accept.endOwnPlan")} value={choice} onValueChange={setChoice} />
            </View>
          ) : null}
          {phase.kind === "failed" ? <Banner tone="error" message={t(phase.offline ? "family.accept.offline" : "family.accept.failed")} /> : null}
          <Button
            variant="brand"
            title={t("family.accept.action")}
            loading={phase.kind === "busy"}
            disabled={phase.kind === "busy" || (needsChoice && !choice)}
            onPress={() => void accept()}
          />
        </View>
      )}
    </Screen>
  );
}
