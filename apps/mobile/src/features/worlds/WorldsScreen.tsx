import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, View } from "react-native";
import { useTranslation } from "react-i18next";
import { minTouchTarget, radius, spacing } from "@outlet/ui-tokens";
import { Banner, Card, EmptyState, ErrorState, ListRow, LoadingState, Screen, Text, useTheme, Badge } from "../../ui";
import { useServices } from "../../state/services";
import { getFeaturePorts } from "../../state/ports";
import { formatAmount, type DisplayLocale } from "../money-display";
import {
  DEFAULT_SORT, DEFAULT_WORLD, STORE_SORTS, WORLDS, buildDirectory, decodePreference, encodePreference, failureState,
  worldAfterWiden, type StoreSort, type StoreSummary, type World, type WorldsPort, type WorldsScreenState, type WorldPreferencePort,
  } from "./model";

const PREF_KEY = "worlds.selection";

function Chip(props: { label: string; selected: boolean; onPress: () => void; role: "radio" | "button"; testID?: string }) {
  const { colors } = useTheme();
  return (
    <Pressable
      testID={props.testID}
      accessibilityRole={props.role}
      accessibilityLabel={props.label}
      accessibilityState={{ selected: props.selected }}
      onPress={props.onPress}
      style={{
        minHeight: minTouchTarget, minWidth: minTouchTarget, justifyContent: "center", paddingHorizontal: spacing.md,
        borderRadius: radius.pill, borderWidth: 1,
        borderColor: props.selected ? colors.accent : colors.border,
        backgroundColor: props.selected ? colors.accent : "transparent",
      }}
    >
      <Text style={{ color: props.selected ? colors.onAccent : colors.textPrimary, fontWeight: "600" }}>{props.label}</Text>
    </Pressable>
  );
}

function StoreRow(props: { store: StoreSummary; locale: DisplayLocale }) {
  const { t } = useTranslation();
  const s = props.store;
  const parts: string[] = [];
  if (s.maxVerifiedDiscountPct !== null) parts.push(t("worlds.discountUpTo", { pct: formatAmount(BigInt(s.maxVerifiedDiscountPct) * 100n, props.locale) }));
  if (s.rating !== null) parts.push(t("worlds.rating", { value: s.rating.toFixed(1) }));
  parts.push(t("worlds.followers", { count: s.followerCount }));
  if (s.deliveryDays !== null) parts.push(t("worlds.delivery", { days: s.deliveryDays }));
  return (
    <ListRow
      title={s.name}
      subtitle={parts.join(" . ")}
      accessibilityHint={t("worlds.openStore")}
      trailing={
        <View style={{ gap: spacing.xs }}>
          {s.liveDrop ? <Badge tone="info" label={t("worlds.liveDrop")} /> : null}
          {s.isFavourite ? <Badge tone="info" label={t("worlds.favourite")} /> : null}
        </View>
      }
      onPress={() => undefined}
    />
  );
}

/** Dev fixtures only; production wiring replaces the port when the API client lands. */
export function WorldsScreen(props: { port?: WorldsPort }) {
  const { t, i18n } = useTranslation();
  const services = useServices();
  const locale: DisplayLocale = i18n.language === "en" ? "en" : "ar";
  const port = useMemo<WorldsPort>(() => props.port ?? getFeaturePorts().worlds, [props.port]);
  const prefs = useMemo<WorldPreferencePort>(() => ({
    load: async () => decodePreference(await services.storage.getString(PREF_KEY)),
    save: (p) => services.storage.setString(PREF_KEY, encodePreference(p)),
  }), [services]);
  const [world, setWorld] = useState<World>(DEFAULT_WORLD);
  const [sort, setSort] = useState<StoreSort>(DEFAULT_SORT);
  const [state, setState] = useState<WorldsScreenState>({ status: "loading" });

  const load = useCallback(async () => {
    setState({ status: "loading" });
    try {
      setState({ status: "ready", stores: await port.listStores() });
    } catch (e) {
      setState(failureState(e));
    }
  }, [port]);

  useEffect(() => {
    void (async () => {
      try {
        const p = await prefs.load();
        if (p !== null) {
          setWorld(p.world);
          setSort(p.sort);
        }
      } catch {
        // Preference unreadable: keep defaults.
      }
    })();
    void load();
  }, [prefs, load]);

  const choose = (w: World, s: StoreSort) => {
    setWorld(w);
    setSort(s);
    void prefs.save({ world: w, sort: s }).catch(() => undefined);
  };

  const view = useMemo(() => (state.status === "ready" ? buildDirectory(state.stores, world, sort) : null), [state, world, sort]);

  return (
    <Screen>
      <Text variant="title">{t("worlds.title")}</Text>
      <View accessibilityRole="radiogroup" accessibilityLabel={t("worlds.pickerLabel")} style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.sm }}>
        {WORLDS.map((w) => (
          <Chip key={w} testID={`world-${w}`} role="radio" label={t(`worlds.${w}`)} selected={w === world} onPress={() => choose(w, sort)} />
        ))}
      </View>
      <View accessibilityLabel={t("worlds.sortLabel")} style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.sm }}>
        {STORE_SORTS.map((s) => (
          <Chip key={s} role="button" label={t(`worlds.sort.${s}`)} selected={s === sort} onPress={() => choose(world, s)} />
        ))}
      </View>
      {state.status === "loading" ? <LoadingState label={t("worlds.loading")} /> : null}
      {state.status === "error" ? (
        <ErrorState
          offline={state.offline}
          title={t(state.offline ? "worlds.offlineTitle" : "worlds.errorTitle")}
          description={t(state.offline ? "worlds.offlineBody" : "worlds.errorBody")}
          retryTitle={t("common.retry")}
          onRetry={() => void load()}
        />
      ) : null}
      {view !== null ? (
        <>
          {view.hiddenFavouriteCount > 0 ? <Banner tone="info" message={t("worlds.hiddenFavourites", { count: view.hiddenFavouriteCount })} /> : null}
          {view.empty === null ? (
            <Card>{view.rows.map((s) => <StoreRow key={s.id} store={s} locale={locale} />)}</Card>
          ) : (
            <EmptyState
              title={t(view.empty === "noStores" ? "worlds.emptyStoresTitle" : view.empty === "noFavourites" ? "worlds.emptyFavouritesTitle" : "worlds.emptyHiddenTitle")}
              description={t(view.empty === "noStores" ? "worlds.emptyStoresBody" : view.empty === "noFavourites" ? "worlds.emptyFavouritesBody" : "worlds.emptyHiddenBody")}
              {...(view.canWiden ? { actionTitle: t("worlds.widen"), onAction: () => choose(worldAfterWiden(), sort) } : {})}
            />
          )}
        </>
      ) : null}
      {typeof __DEV__ !== "undefined" && __DEV__ ? <Banner tone="info" message={t("common.devFixtureBackend")} /> : null}
    </Screen>
  );
}
