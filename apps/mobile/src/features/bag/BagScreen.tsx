import { useCallback, useEffect, useMemo, useRef, useState } from "react";
// eslint-disable-next-line no-restricted-imports -- the board needs a borderless inline promo field the kit TextField (boxed, floating label) cannot express
import { ScrollView, StyleSheet, TextInput, View } from "react-native";
import { Image } from "expo-image";
import { useFocusEffect } from "expo-router";
import { useTranslation } from "react-i18next";
import { radius, spacing } from "@outlet/ui-tokens";
import {
  Banner, Button, Divider, EmptyState, ErrorState, Eyebrow, Icon, IconButton, LoadingState, PressScale, QuantityStepper, Screen, Text, useTheme,
} from "../../ui";
import { Illustration } from "../../art";
import { formatMoney, localizeDigits, type DisplayLocale } from "../money-display";
import { ItemArt } from "../purchase/ItemArt";
import { Flow, ValueFade } from "../purchase/motion";
import {
  BagCapError, MAX_UNITS_PER_SKU, applyQty, applyRemoved, applySaved, bagFailureState, buildBag, changeHeadline, claimOf, rankSuggestions, suggestionHint,
  type BagPort, type BagScreenState, type BagSnapshot, type LineView, type StoreGroup, type Suggestion,
} from "./model";
import { devImageFor } from "./dev-images";
import { TestId } from "../../components/TestId";
import { getFeaturePorts } from "../../state/ports";
import { pluralKey } from "../../i18n/plural";
import { useCheckoutEntry } from "../checkout-gate";
import { MAX_BAG_LINES } from "../guest";

type Money = (minor: bigint) => string;
const THUMB_W = 104;
const THUMB_H = 124;

function LineRow(props: {
  v: LineView; store: string; money: Money; num: (n: number) => string; seenTime: (ms: number) => string; saved: boolean;
  onToggleSaved: () => void; onQty: (q: number) => void; onRemove: () => void;
}) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const { line, change, purchasable } = props.v;
  const head = changeHeadline(change);
  const claim = claimOf(line);
  const photo = line.imageUrl ?? devImageFor(line.id);
  return (
    <View style={{ flexDirection: "row", gap: spacing.md, opacity: purchasable || props.saved ? 1 : 0.62 }}>
      <View style={{ width: THUMB_W, height: THUMB_H, borderRadius: radius.lg, overflow: "hidden", backgroundColor: colors.fill }}>
        {photo !== undefined ? (
          <Image source={{ uri: photo }} contentFit="cover" style={{ width: THUMB_W, height: THUMB_H }} accessibilityLabel={line.title} />
        ) : (
          <ItemArt title={line.title} seed={line.id} width={THUMB_W} label={line.title} />
        )}
        {line.imageUrl !== undefined || photo === undefined ? (
          <View style={{ position: "absolute", top: 4, end: 4 }}>
            <IconButton icon={props.saved ? "heart" : "heart-outline"} label={t("bag.favourite")} onPress={props.onToggleSaved} size={16} color="textSecondary" />
          </View>
        ) : null}
      </View>
      <View style={{ flex: 1, minHeight: THUMB_H, justifyContent: "space-between" }}>
        <View style={{ gap: 3 }}>
          <Eyebrow color="textPrimary" numberOfLines={1}>{line.brand ?? props.store}</Eyebrow>
          <Text variant="caption" secondary numberOfLines={1}>{line.title}</Text>
          {line.sizeLabel !== null ? <Text variant="caption" secondary>{line.sizeLabel}</Text> : null}
          <View style={{ flexDirection: "row", alignItems: "baseline", gap: spacing.sm }}>
            <ValueFade value={String(props.v.total)}><Text variant="caption" numeric weight="600">{props.money(props.v.total)}</Text></ValueFade>
            {claim !== null ? <Text variant="caption" numeric secondary style={{ textDecorationLine: "line-through" }}>{props.money(claim.referencePrice * BigInt(line.qty))}</Text> : null}
          </View>
          {claim !== null ? (
            <View style={{ alignSelf: "flex-start", backgroundColor: colors.brand, borderRadius: radius.pill, paddingHorizontal: spacing.sm, paddingVertical: 3 }}>
              <Text variant="caption" weight="600" numeric style={{ color: colors.background }}>{`-${props.num(claim.percent)}%`}</Text>
            </View>
          ) : null}
          {line.priceStale === true && line.seenAt !== undefined ? <Text variant="caption" secondary>{t("guestMerge.lastSeen", { time: props.seenTime(line.seenAt) })}</Text> : null}
          {head !== null && !props.saved ? (
            <Text variant="caption" color={head.direction === "dropped" ? "savings" : "textSecondary"}>
              {t(head.direction === "dropped" ? "bag.priceDropped" : "bag.priceRose", { amount: props.money(head.delta) })}
            </Text>
          ) : null}
          {!props.saved && line.qty >= MAX_UNITS_PER_SKU ? <Text variant="caption" secondary>{t("guestMerge.capUnits", { max: props.num(MAX_UNITS_PER_SKU) })}</Text> : null}
          {line.availability === "soldOut" ? <Text variant="caption" color="danger">{t("bag.soldOut")}</Text> : null}
          {line.availability === "paused" ? <Text variant="caption" color="danger">{t("bag.paused")}</Text> : null}
        </View>
      </View>
      <View style={{ alignItems: "flex-end", justifyContent: "space-between", minHeight: THUMB_H }}>
        <IconButton icon="close-outline" label={t("bag.removeName", { title: line.title })} onPress={props.onRemove} size={18} color="textSecondary" />
        {!props.saved && props.v.purchasable ? (
          <View style={{ transform: [{ scale: 0.7 }], transformOrigin: "right bottom" }}>
          <QuantityStepper
            value={line.qty} valueLabel={props.num(line.qty)} min={1} max={MAX_UNITS_PER_SKU} onChange={props.onQty}
            decrementLabel={t("bag.qtyDecrease", { title: line.title })} incrementLabel={t("bag.qtyIncrease", { title: line.title })}
          />
          </View>
        ) : <Text variant="caption" secondary>{t("bag.quantity", { count: props.num(line.qty) })}</Text>}
      </View>
    </View>
  );
}

function SuggestionRail(props: { items: readonly Suggestion[]; money: Money; onAdd: (s: Suggestion) => void; store: string }) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  return (
    <View style={{ gap: spacing.md }}>
      <Eyebrow>{t("bag.suggestionsHeading")}</Eyebrow>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: spacing.md }}>
        {props.items.map((s) => (
          <View key={s.skuId} style={{ width: 112, gap: spacing.xs }}>
            <View>
              <ItemArt title={s.title} seed={s.skuId} width={112} />
              <PressScale
                accessibilityRole="button"
                accessibilityLabel={t("bag.addSuggestionName", { title: s.title, size: s.sizeLabel })}
                onPress={() => props.onAdd(s)}
                hitSlop={4}
                style={{ position: "absolute", end: 6, bottom: 6 }}
                innerStyle={{ width: 44, height: 44, alignItems: "center", justifyContent: "center", backgroundColor: colors.surface, borderRadius: radius.pill }}
              >
                <Icon name="add" size={20} />
              </PressScale>
            </View>
            <Text variant="caption" numberOfLines={1}>{s.title}</Text>
            <Text variant="caption" secondary numeric>{`${s.sizeLabel}  ·  ${props.money(s.unitPrice)}`}</Text>
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

function GroupSection(props: {
  index: number; showStore: boolean; g: StoreGroup; money: Money; num: (n: number) => string; seenTime: (ms: number) => string; port: BagPort;
  onToggle: (id: string, saved: boolean) => void; onQty: (id: string, q: number) => void; onRemove: (id: string) => void; onAdd: (s: Suggestion) => void;
}) {
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
    <Flow index={props.index} style={{ gap: spacing.lg }}>
      {props.showStore ? (
        <View style={{ gap: spacing.sm }}>
          <Divider />
          <Eyebrow numberOfLines={1}>{g.store.name}</Eyebrow>
        </View>
      ) : null}
      {g.locked ? <Banner tone="error" message={`${t("bag.suspendedTitle")}. ${t("bag.suspendedBody")}`} /> : null}
      {!g.locked && fd.threshold > 0n ? (
        <TestId id={fd.viaPlus || fd.unlocked ? "bag-free-delivery-unlocked" : "bag-free-delivery-progress"}>
          <Text variant="caption" color={fd.viaPlus ? "plus" : fd.unlocked ? "savings" : "textSecondary"}>
            {fd.viaPlus ? t("bag.freePlus") : fd.unlocked ? t("bag.freeUnlocked") : t("bag.freeProgress", { amount: money(fd.remaining), store: g.store.name })}
          </Text>
        </TestId>
      ) : null}
      {g.lines.map((v, li) => (
        <Flow key={v.line.id} style={{ gap: spacing.lg }}>
          {li > 0 ? <Divider /> : null}
          <LineRow v={v} store={g.store.name} money={money} num={props.num} seenTime={props.seenTime} saved={false}
            onToggleSaved={() => props.onToggle(v.line.id, true)} onQty={(q) => props.onQty(v.line.id, q)} onRemove={() => props.onRemove(v.line.id)} />
        </Flow>
      ))}
      {suggestions.length > 0 ? <SuggestionRail items={suggestions} money={money} store={g.store.name} onAdd={props.onAdd} /> : null}
      {g.saved.length > 0 ? (
        <View style={{ gap: spacing.lg }}>
          <Eyebrow>{t("bag.savedHeading")}</Eyebrow>
          {g.saved.map((v) => (
            <Flow key={v.line.id}>
              <LineRow v={v} store={g.store.name} money={money} num={props.num} seenTime={props.seenTime} saved
                onToggleSaved={() => props.onToggle(v.line.id, false)} onQty={() => undefined} onRemove={() => props.onRemove(v.line.id)} />
            </Flow>
          ))}
        </View>
      ) : null}
    </Flow>
  );
}

/** Bag tab: lines grouped by store with honest price movement, per-store free delivery, checkout bar. */
export function BagScreen(props: { port?: BagPort; onCheckout?: () => void; onShop?: () => void }) {
  const { t, i18n } = useTranslation();
  const { colors } = useTheme();
  const locale: DisplayLocale = i18n.language === "en" ? "en" : "ar";
  const port = useMemo<BagPort>(() => props.port ?? getFeaturePorts().bag, [props.port]);
  const [state, setState] = useState<BagScreenState>({ status: "loading" });
  const [saveFailed, setSaveFailed] = useState<false | "generic" | "lines" | "units">(false);
  const startCheckout = useCheckoutEntry();
  const [code, setCode] = useState("");
  const currency = t("common.currency");
  const money = useCallback<Money>((m) => formatMoney(m, locale, currency), [locale, currency]);
  const num = useCallback((n: number) => localizeDigits(String(n), locale), [locale]);
  const seenTime = useCallback((ms: number) => new Date(ms).toLocaleString(locale === "en" ? "en-GB" : "ar-EG", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }), [locale]);

  const load = useCallback(async (silent = false) => {
    if (!silent) setState({ status: "loading" });
    try {
      setState({ status: "ready", snapshot: await port.load() });
    } catch (e) {
      setState(bagFailureState(e));
    }
  }, [port]);
  useEffect(() => { void load(); }, [load]);
  // The Bag tab stays mounted: reload when it regains focus (the Checkout gate switches a guest bag to the server bag).
  const focusedOnce = useRef(false);
  useFocusEffect(useCallback(() => {
    if (focusedOnce.current) void load(true);
    focusedOnce.current = true;
  }, [load]));

  /** Optimistic local change, then the port; the bag reloads so the server's prices win. */
  const mutate = async (next: (s: BagSnapshot) => BagSnapshot, call: () => Promise<void>) => {
    if (state.status !== "ready") return;
    setSaveFailed(false);
    const before = state;
    setState({ status: "ready", snapshot: next(state.snapshot) });
    try {
      await call();
      await load(true);
    } catch (e) {
      setState(before);
      setSaveFailed(e instanceof BagCapError ? e.cap : "generic");
    }
  };

  const view = state.status === "ready" ? buildBag(state.snapshot) : null;
  const ready = view !== null && !view.isEmpty;
  const itemCount = view !== null ? view.groups.reduce((n, g) => n + g.lines.length, 0) : 0;
  const canPromo = port.applyCode !== undefined;
  const submitCode = async () => {
    const apply = port.applyCode;
    if (apply === undefined || code.trim().length === 0) return;
    try {
      setState({ status: "ready", snapshot: await apply.call(port, code.trim()) });
    } catch {
      setSaveFailed("generic");
    }
  };
  const clearAll = () => {
    if (state.status !== "ready") return;
    const ids = state.snapshot.lines.filter((l) => !l.savedForLater).map((l) => l.id);
    void mutate((sn) => ids.reduce(applyRemoved, sn), async () => { for (const id of ids) await port.removeLine(id); });
  };

  return (
    <Screen onRefresh={() => void load(true)}>
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
      {view !== null && view.isEmpty ? (
        <EmptyState
          illustration={<Illustration name="emptyBag" size={120} label={t("bag.emptyTitle")} />}
          title={t("bag.emptyTitle")} description={state.status === "ready" && state.snapshot.guest === true ? t("guestMerge.emptyLocal") : t("bag.emptyBody")}
          {...(props.onShop !== undefined ? { actionTitle: t("bag.emptyAction"), onAction: props.onShop } : {})}
        />
      ) : null}
      {ready ? (
        <View style={{ flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between" }}>
          <View style={{ gap: 2 }}>
            <Text variant="title1" accessibilityRole="header">{t("bag.heading")}</Text>
            <Text variant="caption" secondary>{t(pluralKey("bag.itemsCaption", itemCount), { count: num(itemCount) })}</Text>
          </View>
          <IconButton icon="trash-outline" label={t("bag.clearAll")} onPress={clearAll} size={22} />
        </View>
      ) : null}
      {saveFailed !== false ? (
        <Banner tone="error" message={saveFailed === "lines" ? t("guestMerge.capLines", { max: num(MAX_BAG_LINES) }) : saveFailed === "units" ? t("guestMerge.capUnits", { max: num(MAX_UNITS_PER_SKU) }) : t("bag.saveFailed")} />
      ) : null}
      {ready && state.status === "ready" ? (
        <>
          {view.groups.map((g, gi) => (
            <GroupSection
              key={g.store.id} index={gi} showStore={view.groups.length > 1} g={g} money={money} num={num} seenTime={seenTime} port={port}
              onToggle={(id, s) => void mutate((sn) => applySaved(sn, id, s), () => port.setSavedForLater(id, s))}
              onQty={(id, q) => void mutate((sn) => applyQty(sn, id, q), () => port.setQuantity(id, q))}
              onRemove={(id) => void mutate((sn) => applyRemoved(sn, id), () => port.removeLine(id))}
              onAdd={(s) => void mutate((sn) => sn, () => port.addLine(s.skuId, suggestionHint(g.store, s)))}
            />
          ))}
          {canPromo ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, borderRadius: radius.md, paddingStart: spacing.md, paddingEnd: spacing.xs, height: 44 }}>
              <TextInput
                value={code} onChangeText={setCode} placeholder={t("bag.promoPlaceholder")} placeholderTextColor={colors.textSecondary}
                accessibilityLabel={t("bag.promoLabel")} autoCapitalize="characters" autoCorrect={false} onSubmitEditing={() => void submitCode()}
                // eslint-disable-next-line no-restricted-syntax -- kit Text variant does not apply to TextInput
                style={{ flex: 1, color: colors.textPrimary, fontSize: 12 }}
              />
              <PressScale
                accessibilityRole="button" accessibilityLabel={t("bag.promoApply")} onPress={() => void submitCode()} hitSlop={8}
                innerStyle={{ backgroundColor: colors.fill, borderRadius: radius.pill, paddingHorizontal: spacing.md, height: 30, alignItems: "center", justifyContent: "center" }}
              >
                <Text variant="caption" weight="500" accessibilityRole="none">{t("bag.promoApply")}</Text>
              </PressScale>
            </View>
          ) : null}
          <View style={{ gap: spacing.sm }}>
            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "baseline" }}>
              <Text variant="callout" secondary>{t("bag.subtotalLabel")}</Text>
              <Text variant="callout" numeric>{money(view.total)}</Text>
            </View>
            {view.discount !== null ? (
              <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "baseline" }}>
                <Text variant="callout" secondary>{t("bag.discountLabel")}</Text>
                <Text variant="callout" numeric>{`-${money(view.discount)}`}</Text>
              </View>
            ) : null}
            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "baseline", marginTop: spacing.xs }}>
              <Text variant="title1" accessibilityRole="none">{t("bag.totalLabel")}</Text>
              <ValueFade value={String(view.payable)}><Text variant="title1" numeric>{money(view.payable)}</Text></ValueFade>
            </View>
          </View>
          {state.snapshot.guest === true ? <Text variant="caption" secondary>{t("guestMerge.bagLocalNote")}</Text> : null}
          {itemCount >= MAX_BAG_LINES ? <Text variant="caption" secondary>{t("guestMerge.capLines", { max: num(MAX_BAG_LINES) })}</Text> : null}
          {state.snapshot.offline === true ? <Banner tone="info" message={t("guestMerge.offlineCheckout")} /> : null}
          <TestId id="bag-checkout">
            <Button title={t("bag.checkoutCta")} icon="bag-outline" fullWidth disabled={view.payable <= 0n || state.snapshot.offline === true} onPress={props.onCheckout ?? startCheckout} />
          </TestId>
        </>
      ) : null}
    </Screen>
  );
}
