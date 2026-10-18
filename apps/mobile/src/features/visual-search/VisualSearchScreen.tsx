import { useMemo, useRef, useState } from "react";
import { View } from "react-native";
import { useTranslation } from "react-i18next";
import { Banner, Button, Card, EmptyState, ErrorState, Eyebrow, Icon, Reveal, Screen, Skeleton, Text } from "../../ui";
import { Illustration } from "../../art";
import { getFeaturePorts } from "../../state/ports";
import { GridSkeleton, ProductGrid, SectionTitle } from "../home/parts";
import { ExpoImageSource } from "./image-source";
import {
  canRetry, runVisualSearch, toTile,
  type ImageSource, type ImageSourcePort, type VisualScreenState, type VisualSearchPort,
} from "./model";

/** The privacy line sits above the actions and stays visible with the results: the shopper reads it before choosing a photo. */
function PrivacyLine() {
  const { t } = useTranslation();
  return (
    <Card variant="filled" style={{ flexDirection: "row", gap: 10, alignItems: "flex-start" }}>
      <View style={{ paddingTop: 2 }}><Icon name="lock-closed-outline" size={16} color="textSecondary" /></View>
      <Text variant="caption" secondary style={{ flex: 1 }} accessibilityRole="none">{t("visualSearch.privacy")}</Text>
    </Card>
  );
}

export function VisualSearchScreen(props: {
  port?: VisualSearchPort;
  source?: ImageSourcePort;
  onBack?: () => void;
  onOpenProduct?: (id: string) => void;
}) {
  const { t } = useTranslation();
  const port = useMemo<VisualSearchPort>(() => props.port ?? getFeaturePorts().visualSearch, [props.port]);
  const source = useMemo<ImageSourcePort>(() => props.source ?? new ExpoImageSource(), [props.source]);
  const [state, setState] = useState<VisualScreenState>({ status: "idle" });
  const last = useRef<ImageSource>("library");
  const seq = useRef(0);

  const start = (from: ImageSource) => {
    last.current = from;
    const mine = ++seq.current;
    // "Searching" shows only after the picker returned a valid photo (a cancelled picker leaves the screen as it was).
    void runVisualSearch(source, port, from, false, () => { if (mine === seq.current) setState({ status: "searching" }); })
      .then((s) => { if (mine === seq.current) setState(s); });
  };

  const actions = (
    <View style={{ gap: 10 }}>
      <Button icon="camera-outline" title={t("visualSearch.takePhoto")} disabled={state.status === "searching"} onPress={() => start("camera")} />
      <Button variant="secondary" icon="images-outline" title={t("visualSearch.choosePhoto")} disabled={state.status === "searching"} onPress={() => start("library")} />
    </View>
  );

  return (
    <Screen title={t("visualSearch.title")} onBack={props.onBack} backLabel={t("common.back")}>
      {state.status === "idle" || state.status === "denied" || state.status === "invalid" ? (
        <>
          <Reveal index={0}><Text variant="lede" secondary>{t("visualSearch.lede")}</Text></Reveal>
          {state.status === "denied" ? <Banner tone="warning" message={t("visualSearch.denied")} /> : null}
          {state.status === "invalid" ? <Banner tone="error" message={t(`visualSearch.invalid.${state.problem}`)} /> : null}
          <Reveal index={1}>{actions}</Reveal>
          <PrivacyLine />
          <Text variant="caption" secondary>{t("visualSearch.tips")}</Text>
        </>
      ) : null}

      {state.status === "searching" ? (
        <View accessibilityRole="progressbar" accessibilityLabel={t("visualSearch.searching")} style={{ gap: 14 }}>
          <Text variant="callout" secondary>{t("visualSearch.searching")}</Text>
          <Skeleton height={14} width="60%" />
          <GridSkeleton rows={2} />
        </View>
      ) : null}

      {state.status === "error" ? (
        <>
          <ErrorState
            offline={state.offline}
            title={t(state.offline ? "visualSearch.offlineTitle" : state.reason !== null ? `visualSearch.reason.${state.reason}.title` : "visualSearch.errorTitle")}
            description={t(state.offline ? "visualSearch.offlineBody" : state.reason !== null ? `visualSearch.reason.${state.reason}.body` : "visualSearch.errorBody")}
            retryTitle={canRetry(state.reason) ? t("common.retry") : t("visualSearch.anotherPhoto")}
            onRetry={() => (canRetry(state.reason) ? start(last.current) : setState({ status: "idle" }))}
          />
          <PrivacyLine />
        </>
      ) : null}

      {state.status === "results" ? (
        <View style={{ gap: 20 }}>
          {state.view.banner === "lowConfidence" ? <Banner tone="info" message={t("visualSearch.lowConfidence")} /> : null}
          {state.view.banner === "degraded" ? <Banner tone="info" message={t("visualSearch.degraded")} /> : null}
          {state.view.empty ? (
            <EmptyState
              illustration={<Illustration name="noResults" size={120} />}
              title={t("visualSearch.emptyTitle")}
              description={t("visualSearch.emptyBody")}
              actionTitle={t("visualSearch.anotherPhoto")}
              onAction={() => setState({ status: "idle" })}
            />
          ) : (
            <>
              {state.view.sections.map((s) => (
                <View key={s.key} style={{ gap: 14, marginHorizontal: -20 }}>
                  <SectionTitle title={t(`visualSearch.section.${s.key}`)} inset={20} />
                  <ProductGrid products={s.items.map(toTile)} onOpen={(id) => props.onOpenProduct?.(id)} />
                </View>
              ))}
              <Eyebrow>{t("visualSearch.aiNote")}</Eyebrow>
              <Button variant="secondary" title={t("visualSearch.anotherPhoto")} onPress={() => setState({ status: "idle" })} />
              <PrivacyLine />
            </>
          )}
        </View>
      ) : null}
    </Screen>
  );
}
