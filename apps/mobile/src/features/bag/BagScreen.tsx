import { useCallback, useEffect, useMemo, useState } from "react";
import { View } from "react-native";
import { useTranslation } from "react-i18next";
import { radius, spacing } from "@outlet/ui-tokens";
import { Banner, Button, Card, Divider, EmptyState, ErrorState, LoadingState, Screen, Text, useTheme } from "../../ui";
import { formatMoney, type DisplayLocale } from "../money-display";
import {
  applySaved, bagFailureState, buildBag, rankSuggestions,
  type BagPort, type BagScreenState, type LineView, type StoreGroup, type Suggestion,
} from "./model";
import { TestId } from "../../components/TestId";
import { getFeaturePorts } from "../../state/ports";

type Money = (minor: bigint) => string;

function LineRow(props: { v: LineView; money: Money; onToggleSaved: () => void; saved: boolean }) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const { line, change, purchasable } = props.v;
  return (
    <View style={{ gap: spacing.xs, opacity: purchasable || props.saved ? 1 : 0.7 }}>
      <Text>{line.title}</Text>
      <Text variant="caption" secondary>
        {[line.sizeLabel !== null ? t("bag.sizeLabel", { size: line.sizeLabel }) : null, t("bag.quantity", { count: line.qty }), t("bag.lineTotal", { amount: props.money(props.v.total) })]
          .filter((s): s is string => s !== null).join(" . ")}
      </Text>
      {change.kind === "dropped" ? <Text variant="caption" style={{ color: colors.accent }}>{t("bag.priceDropped", { amount: props.money(change.delta) })}</Text> : null}
      {change.kind === "rose" ? <Text variant="caption" style={{ color: colors.textPrimary }}>{t("bag.priceRose", { amount: props.money(change.delta) })}</Text> : null}
      {line.availability === "soldOut" ? <Banner tone="warning" message={t("bag.soldOut")} /> : null}
      {line.availability === "paused" ? <Banner tone="warning" message={t("bag.paused")} /> : null}
      <Button
        variant="secondary"
        title={t(props.saved ? "bag.moveToBag" : "bag.saveForLater")}
        accessibilityLabel={t(props.saved ? "bag.moveToBagName" : "bag.saveForLaterName", { title: line.title })}
        onPress={props.onToggleSaved}
      />
    </View>
  );
}

function ProgressBar(props: { pct: number; name: string; value: string }) {
  const { colors } = useTheme();
  return (
    <View
      accessibilityRole="progressbar"
      accessibilityLabel={props.name}
      accessibilityValue={{ min: 0, max: 100, now: props.pct, text: props.value }}
      style={{ height: 8, borderRadius: radius.pill, backgroundColor: colors.border, overflow: "hidden" }}
    >
      <View style={{ width: `${props.pct}%`, height: 8, backgroundColor: colors.accent }} />
    </View>
  );
}

function GroupCard(props: { g: StoreGroup; money: Money; port: BagPort; locale: DisplayLocale; onToggle: (id: string, saved: boolean) => void }) {
  const { t } = useTranslation();
  const { g, money } = props;
  const [suggestions, setSuggestions] = useState<readonly Suggestion[]>([]);
  const remaining = g.freeDelivery.remaining;

  useEffect(() => {
    let alive = true;
    if (g.locked || remaining <= 0n) {
      setSuggestions([]);
      return;
    }
    props.port.inSizeSuggestions(g.store.id).then(
      (c) => { if (alive) setSuggestions(rankSuggestions(c, remaining)); },
      () => { if (alive) setSuggestions([]); },
    );
    return () => { alive = false; };
  }, [props.port, g.store.id, g.locked, remaining]);

  const fd = g.freeDelivery;
  return (
    <Card>
      <Text variant="heading">{g.store.name}</Text>
      {g.locked ? <Banner tone="error" message={`${t("bag.suspendedTitle")}. ${t("bag.suspendedBody")}`} /> : null}
      {g.lines.map((v) => (
        <LineRow key={v.line.id} v={v} money={money} saved={false} onToggleSaved={() => props.onToggle(v.line.id, true)} />
      ))}
      {g.lines.length > 0 ? <Divider /> : null}
      {!g.locked ? (
        <>
          <Text>{t("bag.storeSubtotal", { amount: money(g.subtotal) })}</Text>
          <TestId id="bag-free-delivery-bar"><ProgressBar
            pct={fd.progressPct}
            name={t("bag.freeProgressName", { store: g.store.name })}
            value={t("bag.freeProgressValue", { current: money(g.subtotal), threshold: money(fd.threshold) })}
          /></TestId>
          <TestId id={fd.viaPlus || fd.unlocked ? "bag-free-delivery-unlocked" : "bag-free-delivery-progress"}>
            <Text secondary>
              {fd.viaPlus ? t("bag.freePlus") : fd.unlocked ? t("bag.freeUnlocked") : t("bag.freeProgress", { amount: money(fd.remaining), store: g.store.name })}
            </Text>
          </TestId>
          <Text variant="caption" secondary>{t("bag.thresholdNote", { amount: money(fd.threshold) })}</Text>
          {suggestions.length > 0 ? (
            <View style={{ gap: spacing.xs }}>
              <Text variant="caption" secondary>{t("bag.suggestionsHeading")}</Text>
              {suggestions.map((s) => (
                <Text key={s.skuId}>{t("bag.suggestionLine", { title: s.title, size: s.sizeLabel, amount: money(s.unitPrice) })}</Text>
              ))}
            </View>
          ) : null}
        </>
      ) : null}
      {g.saved.length > 0 ? (
        <>
          <Divider />
          <Text variant="caption" secondary>{t("bag.savedHeading")}</Text>
          {g.saved.map((v) => (
            <LineRow key={v.line.id} v={v} money={money} saved onToggleSaved={() => props.onToggle(v.line.id, false)} />
          ))}
        </>
      ) : null}
    </Card>
  );
}

/** Dev fixtures only; production wiring replaces the port when the API client lands. */
export function BagScreen(props: { port?: BagPort; onCheckout?: () => void }) {
  const { t, i18n } = useTranslation();
  const locale: DisplayLocale = i18n.language === "en" ? "en" : "ar";
  const port = useMemo<BagPort>(() => props.port ?? getFeaturePorts().bag, [props.port]);
  const [state, setState] = useState<BagScreenState>({ status: "loading" });
  const [saveFailed, setSaveFailed] = useState(false);
  const currency = t("common.currency");
  const money = useCallback<Money>((m) => formatMoney(m, locale, currency), [locale, currency]);

  const load = useCallback(async () => {
    setState({ status: "loading" });
    try {
      setState({ status: "ready", snapshot: await port.load() });
    } catch (e) {
      setState(bagFailureState(e));
    }
  }, [port]);
  useEffect(() => { void load(); }, [load]);

  const toggle = async (lineId: string, saved: boolean) => {
    if (state.status !== "ready") return;
    setSaveFailed(false);
    try {
      await port.setSavedForLater(lineId, saved);
      setState({ status: "ready", snapshot: applySaved(state.snapshot, lineId, saved) });
    } catch {
      setSaveFailed(true);
    }
  };

  const view = state.status === "ready" ? buildBag(state.snapshot) : null;
  return (
    <Screen>
      <Text variant="title">{t("bag.title")}</Text>
      {state.status === "loading" ? <LoadingState label={t("bag.loading")} /> : null}
      {state.status === "error" ? (
        <ErrorState
          offline={state.offline}
          title={t(state.offline ? "bag.offlineTitle" : "bag.errorTitle")}
          description={t(state.offline ? "bag.offlineBody" : "bag.errorBody")}
          retryTitle={t("common.retry")}
          onRetry={() => void load()}
        />
      ) : null}
      {view !== null && view.isEmpty ? <EmptyState title={t("bag.emptyTitle")} description={t("bag.emptyBody")} /> : null}
      {saveFailed ? <Banner tone="error" message={t("bag.saveFailed")} /> : null}
      {view !== null && !view.isEmpty ? (
        <>
          {view.groups.map((g) => (
            <GroupCard key={g.store.id} g={g} money={money} port={port} locale={locale} onToggle={(id, s) => void toggle(id, s)} />
          ))}
          <Text variant="heading">{t("bag.total", { amount: money(view.total) })}</Text>
          {props.onCheckout !== undefined ? (
            <TestId id="bag-checkout">
              <Button title={t("nav.goToCheckout")} disabled={view.total <= 0n} onPress={props.onCheckout} />
            </TestId>
          ) : null}
        </>
      ) : null}
      {typeof __DEV__ !== "undefined" && __DEV__ ? <Banner tone="info" message={t("common.devFixtureBackend")} /> : null}
    </Screen>
  );
}
