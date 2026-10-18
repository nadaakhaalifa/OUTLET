import { useState } from "react";
import { View } from "react-native";
import { Image } from "expo-image";
import { useTranslation } from "react-i18next";
import { Banner, Button, Chip, SegmentedControl, Skeleton, Text, useTheme } from "../../ui";
import { Checkerboard } from "./Backdrops";
import { GOOD_SCORE, canRerun, otherModels, reasonKey, type CutoutBlock, type CutoutJob, type CutoutModel, type CutoutView } from "./model";

const W = 220, H = 280;

export interface CutoutPanelProps {
  readonly originalUri: string;
  readonly job: CutoutJob | null;
  readonly block: CutoutBlock | null;
  readonly view: CutoutView;
  readonly acting: boolean;
  readonly onAccept: () => void;
  readonly onUseOriginal: () => void;
  readonly onRerun: (m: CutoutModel) => void;
  readonly onRetry: () => void;
}

/**
 * Before/after for one photo. Never claims the cutout is perfect: the score is a quiet chip with plain reasons, and
 * the original is always one tap away. Never blocks the form (it is a section, not a modal).
 */
export function CutoutPanel(p: CutoutPanelProps) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const [showModels, setShowModels] = useState(false);
  const [seg, setSeg] = useState(1);
  const { phase } = p.view;

  if (phase === "unavailable") {
    return (
      <View style={{ gap: 12 }}>
        <Banner tone="info" message={t("brandMode.cutout.unavailable")} />
        <Button title={t("brandMode.cutout.useOriginal")} variant="secondary" onPress={p.onUseOriginal} testID="cutout-original" />
      </View>
    );
  }
  if (phase === "working") {
    return (
      <View style={{ gap: 12 }} accessibilityLiveRegion="polite">
        <Skeleton height={H} />
        <Text variant="callout" secondary align="center" testID="cutout-working">{t("brandMode.cutout.working")}</Text>
      </View>
    );
  }
  const blockedMsg = p.block === "quota" ? "quota" : p.block === "consent" ? "consent" : p.block === "attempts" ? "attempts" : p.block === "too_large" ? "tooLarge" : p.block === "offline" ? "offline"
    : p.block === "service_down" ? "serviceDown" : p.block === "model_missing" ? "modelMissing" : p.block === "busy" ? "busy" : p.block === "timeout" ? "timeout" : null;
  const score = p.job?.qualityScore ?? null;
  const good = score !== null && score >= GOOD_SCORE;
  const showCutout = p.view.canToggle && seg === 1 && (p.job?.cutoutUrl ?? null) !== null;
  const shown = showCutout ? p.job?.cutoutUrl ?? p.originalUri : p.job?.originalUrl ?? p.originalUri;
  const models = p.job === null ? [] : otherModels(p.job);

  return (
    <View style={{ gap: 12 }}>
      {blockedMsg !== null ? <Banner tone="warning" message={t(`brandMode.cutout.block.${blockedMsg}`)} /> : null}
      {phase === "failed" && blockedMsg === null ? <Banner tone="warning" message={t("brandMode.cutout.failed")} /> : null}
      {phase === "review" ? <Banner tone="info" message={t("brandMode.cutout.review")} /> : null}

      {p.view.canToggle ? (
        <SegmentedControl options={[t("brandMode.cutout.original"), t("brandMode.cutout.cutout")]} index={seg} onChange={setSeg} testID="cutout-toggle" />
      ) : null}

      <View style={{ alignItems: "center" }}>
        {showCutout ? (
          <Checkerboard width={W} height={H}>
            <Image source={{ uri: shown }} contentFit="contain" style={{ width: W, height: H }} accessibilityLabel={t("brandMode.cutout.cutoutAlt")} />
          </Checkerboard>
        ) : (
          <View style={{ width: W, height: H, borderRadius: 18, overflow: "hidden", backgroundColor: colors.fill }}>
            <Image source={{ uri: shown }} contentFit="contain" style={{ width: W, height: H }} accessibilityLabel={t("brandMode.cutout.originalAlt")} />
          </View>
        )}
      </View>

      {score !== null && phase !== "failed" ? (
        <View style={{ gap: 6 }}>
          <View style={{ flexDirection: "row" }}>
            <Chip label={t(good ? "brandMode.cutout.scoreGood" : "brandMode.cutout.scoreCheck", { score })} />
          </View>
          {(p.job?.reasons ?? []).map((r) => <Text key={r} variant="caption" secondary>{t(`brandMode.cutout.reason.${reasonKey(r)}`)}</Text>)}
          <Text variant="caption" secondary>{t("brandMode.cutout.notPerfect")}</Text>
        </View>
      ) : null}

      {phase === "failed" ? <Button title={t("brandMode.cutout.retry")} variant="secondary" onPress={p.onRetry} disabled={p.acting} /> : null}
      {phase === "ready" || phase === "review" ? (
        <View style={{ gap: 8 }}>
          <Button title={t("brandMode.cutout.use")} onPress={p.onAccept} loading={p.acting} disabled={(p.job?.cutoutUrl ?? null) === null} testID="cutout-accept" />
          <Button title={t("brandMode.cutout.useOriginal")} variant="secondary" onPress={p.onUseOriginal} disabled={p.acting} testID="cutout-original" />
        </View>
      ) : null}
      {phase === "accepted" ? <Text variant="callout" color="savings">{t("brandMode.cutout.accepted")}</Text> : null}
      {phase === "original" ? <Text variant="callout" secondary>{t("brandMode.cutout.usingOriginal")}</Text> : null}
      {p.job !== null && canRerun(p.job) && models.length > 0 ? (
        <View style={{ gap: 8 }}>
          <Button title={t("brandMode.cutout.tryAnother")} variant="ghost" fullWidth={false} onPress={() => setShowModels((v) => !v)} disabled={p.acting} testID="cutout-rerun" />
          {showModels ? (
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
              {models.map((m) => <Chip key={m} label={t(`brandMode.cutout.models.${m}`)} onPress={() => { setShowModels(false); p.onRerun(m); }} />)}
            </View>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
