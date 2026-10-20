import { View } from "react-native";
import { spacing } from "@outlet/ui-tokens";
import { ErrorState, PressScale, SwitchRow, Skeleton, Text } from "../../ui";
import { Rail, ProductTile, useFormat, useOpenProduct } from "../home/parts";
import type { DiscoverModule, DiscoverScreenState } from "./model";
import { buildModules, DEFAULT_FLAGS, type DiscoverFlags } from "./model";

const WIDTH = 160;
/** Minimum touch target. */
const TARGET = spacing.xxxl - spacing.xs;

function titleOf(f: ReturnType<typeof useFormat>, m: DiscoverModule): string {
  switch (m.id) {
    case "becauseSaved": return f.t("forYou.becauseSaved", { title: m.savedTitle ?? "" });
    case "goesWithBag": return f.t("forYou.goesWithBag");
    case "priceDropped": return f.t("forYou.priceDropped");
    case "picked": return f.t("forYou.picked");
    case "popular": return f.t("forYou.popular");
    case "recentlyViewed": return f.t("forYou.recentlyViewed");
  }
}

/** Personal rails of the Discover tab. Each module hides when empty; the whole block is silent while there is nothing to show. */
export function DiscoverModules(props: { state: DiscoverScreenState; flags?: DiscoverFlags; onRetry: () => void; onOpenSettings: () => void; onClearLocalHistory?: () => void; historyPaused?: boolean; onTogglePause?: (on: boolean) => void }) {
  const f = useFormat();
  const open = useOpenProduct();
  const s = props.state;
  if (s.status === "loading") {
    return (
      <View style={{ paddingHorizontal: 20, gap: 12 }} accessibilityLabel={f.t("common.loading")} testID="discover-loading">
        <Skeleton height={22} width="50%" />
        <View style={{ flexDirection: "row", gap: 12 }}>{[0, 1, 2].map((i) => <Skeleton key={i} width={WIDTH} height={220} />)}</View>
      </View>
    );
  }
  if (s.status === "error") {
    return (
      <View style={{ paddingHorizontal: 20 }}>
        <ErrorState offline={s.offline} title={s.offline ? f.t("forYou.offlineBanner") : f.t("forYou.moduleFailed")} description="" retryTitle={f.t("forYou.retry")} onRetry={props.onRetry} />
      </View>
    );
  }
  const modules = buildModules(s.data, props.flags ?? DEFAULT_FLAGS);
  const off = !s.data.settings.personalization;
  const local = props.onClearLocalHistory;
  return (
    <View style={{ gap: 28 }} testID="discover-modules">
      {local !== undefined ? (
        // Signed out: ordering happens on this phone. The control clears only device history (bag and saved stay).
        <View style={{ paddingHorizontal: spacing.xl, gap: spacing.xs }}>
          <Text variant="caption" secondary accessibilityRole="none">{f.t("guestSurfaces.discoverLocalNote")}</Text>
          {props.onTogglePause !== undefined ? (
            <SwitchRow label={f.t("guestSurfaces.pauseHistory")} value={props.historyPaused === true} onValueChange={props.onTogglePause} />
          ) : null}
          {props.historyPaused === true ? <Text variant="caption" secondary accessibilityRole="none">{f.t("guestSurfaces.historyPausedNote")}</Text> : null}
          <PressScale onPress={local} accessibilityRole="button" accessibilityLabel={f.t("guestSurfaces.clearHistory")} accessibilityHint={f.t("guestSurfaces.clearHistoryHint")} testID="discover-clear-local" innerStyle={{ minHeight: TARGET, justifyContent: "center" }}>
            <Text variant="caption" weight="600" accessibilityRole="none">{f.t("guestSurfaces.clearHistory")}</Text>
          </PressScale>
        </View>
      ) : null}
      {off && local === undefined ? (
        <View style={{ paddingHorizontal: 20, gap: 4 }}>
          <Text variant="callout" secondary accessibilityRole="none">{f.t("forYou.personalizationOff")}</Text>
          <PressScale onPress={props.onOpenSettings} accessibilityRole="link" accessibilityLabel={f.t("forYou.openSettings")} testID="discover-open-settings" innerStyle={{ minHeight: 44, justifyContent: "center" }}>
            <Text variant="caption" weight="600" accessibilityRole="none">{f.t("forYou.openSettings")}</Text>
          </PressScale>
        </View>
      ) : null}
      {modules.map((m) => (
        <Rail key={m.id} title={titleOf(f, m)} itemWidth={WIDTH}>
          {m.products.map((p) => (
            <View key={p.id} style={{ width: WIDTH }}>
              <ProductTile product={p} onOpen={open} />
              {m.captions?.[p.id] !== undefined ? <Text variant="caption" secondary numberOfLines={2}>{m.captions[p.id]}</Text> : null}
            </View>
          ))}
        </Rail>
      ))}
    </View>
  );
}
