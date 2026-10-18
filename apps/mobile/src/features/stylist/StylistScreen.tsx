import { useCallback, useContext, useRef, useState } from "react";
import { ScrollView, View, useWindowDimensions } from "react-native";
import { useTranslation } from "react-i18next";
import { radius, spacing } from "@outlet/ui-tokens";
import { Banner, Button, Chip, Divider, Eyebrow, GutterContext, Icon, ListRow, PressScale, Reveal, Scrim, Screen, Skeleton, SwitchRow, Text, TextField, useTheme } from "../../ui";
import { ProductArt, type ProductKind } from "../../art";
import { OfflineBanner, StateScreen } from "../../components/states";
import { getFeaturePorts } from "../../state/ports";
import { formatMoney, type DisplayLocale } from "../money-display";
import { reasonOf, type AiFailureReason } from "../ai-failure";
import { wardrobeKindFor, type WardrobePort } from "../wardrobe/model";
import {
  OCCASIONS, VIBES, addOutcome, buildOutfitViews, parseBudgetEgp, replaceOutfit, stylistFailureState,
  type AddOutcome, type Occasion, type OutfitBagPort, type OutfitView, type StylistPort, type StylistScreenState, type Vibe,
} from "./model";

type Money = (minor: bigint) => string;

const SLOT_KIND: Readonly<Record<string, ProductKind>> = { top: "tee", bottom: "jeans", dress: "dress", shoes: "sneaker", bag: "bag", accessory: "scarf" };

function Choice(props: { label: string; selected: boolean; onPress: () => void }) {
  return <Chip label={props.label} selected={props.selected} onPress={props.onPress} />;
}

function useBleed(): number {
  const g = useContext(GutterContext);
  const { gutter } = useTheme();
  return g > 0 ? g : gutter;
}

function OutfitCard(props: {
  n: number;
  v: OutfitView;
  money: Money;
  busy: boolean;
  outcome: AddOutcome | null;
  titles: Readonly<Record<string, string>>;
  onAdd: () => void;
  onFeedback: (skuId: string, s: "like" | "dislike") => void;
  onSwap: (skuId: string) => void;
}) {
  const { t } = useTranslation();
  const { v, money } = props;
  const fit = v.fit;
  const { colors } = useTheme();
  const bleed = useBleed();
  const { width } = useWindowDimensions();
  const tileW = Math.round(width * 0.64);
  // Budget fill: total against budget (derived from the fit), never animated into a "success" colour when over.
  const budget = fit.kind === "fits" ? v.total + fit.spare : fit.kind === "over" ? v.total - fit.by : fit.kind === "exact" ? v.total : 0n;
  const ratio = fit.kind === "none" || budget <= 0n ? 0 : Math.min(1, Number(v.total) / Number(budget));
  const storeTotals = Array.from(
    v.outfit.items.reduce((m, i) => m.set(i.storeId, { id: i.storeId, name: i.storeName, total: (m.get(i.storeId)?.total ?? 0n) + i.unitPrice }), new Map<string, { id: string; name: string; total: bigint }>()).values(),
  );
  return (
    <Reveal index={props.n - 1}>
      <View style={{ gap: spacing.lg, paddingTop: spacing.xxl }}>
        <View style={{ gap: spacing.xs }}>
          <Eyebrow>{t("stylist.outfitHeading", { n: props.n })}</Eyebrow>
          <Text variant="display" numeric>{t("stylist.outfitTotal", { amount: money(v.total) })}</Text>
        </View>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          decelerationRate="fast"
          snapToInterval={tileW + spacing.sm}
          snapToAlignment="start"
          style={{ marginHorizontal: -bleed }}
          contentContainerStyle={{ paddingHorizontal: bleed, gap: spacing.sm }}
        >
          {v.outfit.items.map((i) => (
            <View key={i.skuId} style={{ width: tileW, borderRadius: radius.lg, overflow: "hidden" }}>
              <ProductArt kind={SLOT_KIND[i.slot] ?? "tee"} seed={i.skuId} ratio="3:4" />
              <Scrim position="bottom" />
              <View style={{ position: "absolute", start: spacing.md, end: spacing.md, bottom: spacing.md, gap: 2 }}>
                <Text variant="eyebrow" color="onImage" accessibilityRole="none">{t(`stylist.slotName.${i.slot}`)}</Text>
                <Text variant="quote" color="onImage" numberOfLines={2} accessibilityRole="none">{i.title}</Text>
              </View>
            </View>
          ))}
        </ScrollView>
        <View style={{ gap: spacing.sm }}>
          <View accessibilityRole="progressbar" accessibilityLabel={fit.kind === "none" ? t("stylist.budgetNone") : undefined} style={{ height: 3, backgroundColor: colors.hairline }}>
            <View style={{ height: 3, width: `${Math.round(ratio * 100)}%`, backgroundColor: fit.kind === "over" ? colors.danger : colors.textPrimary }} />
          </View>
          <Text variant="callout" color={fit.kind === "over" ? "danger" : fit.kind === "none" ? "textSecondary" : "savings"}>
            {fit.kind === "none" ? t("stylist.budgetNone") : fit.kind === "exact" ? t("stylist.budgetExact") : fit.kind === "fits" ? t("stylist.budgetFits", { amount: money(fit.spare) }) : t("stylist.budgetOver", { amount: money(fit.by) })}
          </Text>
        </View>
        <View>
          {v.outfit.items.map((i) => (
            <View key={i.skuId}>
              <Divider />
              <View style={{ paddingVertical: spacing.md, gap: spacing.xs }}>
                <View style={{ flexDirection: "row", justifyContent: "space-between", gap: spacing.md }}>
                  <Text style={{ flex: 1 }}>{i.title}</Text>
                  <Text numeric>{money(i.unitPrice)}</Text>
                </View>
                <Text variant="caption" secondary>{`${t(`stylist.slotName.${i.slot}`)} · ${i.storeName} · ${i.sizeLabel}`}</Text>
                <View style={{ flexDirection: "row", gap: spacing.md }}>
                  <PressScale onPress={() => props.onFeedback(i.skuId, "like")} accessibilityRole="button" accessibilityLabel={t("stylist.likeName", { title: i.title })} innerStyle={{ minHeight: 44, minWidth: 44, justifyContent: "center", alignItems: "center" }}><Icon name="thumbs-up-outline" size={20} /></PressScale>
                  <PressScale onPress={() => props.onFeedback(i.skuId, "dislike")} accessibilityRole="button" accessibilityLabel={t("stylist.dislikeName", { title: i.title })} innerStyle={{ minHeight: 44, minWidth: 44, justifyContent: "center", alignItems: "center" }}><Icon name="thumbs-down-outline" size={20} /></PressScale>
                  <PressScale onPress={() => props.onSwap(i.skuId)} accessibilityRole="button" accessibilityLabel={t("stylist.swapName", { title: i.title })} innerStyle={{ minHeight: 44, minWidth: 44, justifyContent: "center", alignItems: "center" }}><Icon name="swap-horizontal-outline" size={20} /></PressScale>
                </View>
              </View>
            </View>
          ))}
          <Divider />
        </View>
        {storeTotals.map((st) => (
          <View key={st.id} style={{ flexDirection: "row", justifyContent: "space-between", gap: spacing.md }}>
            <Text variant="callout" secondary>{st.name}</Text>
            <Text variant="callout" numeric>{money(st.total)}</Text>
          </View>
        ))}
        {v.deliveries.map((d) => (
          <Text key={d.storeId} variant="caption" secondary>
            {d.fee === 0n ? t("stylist.deliveryFree", { store: d.storeName }) : t("stylist.deliveryFee", { store: d.storeName, amount: money(d.fee) })}
          </Text>
        ))}
        {v.isPartial ? (
          <View style={{ gap: spacing.xs }}>
            <Banner tone="info" message={t("stylist.partialHeading")} />
            {v.missing.map((m) => (
              <Text key={m.slot}>{t("stylist.partialMissing", { amount: money(m.shortfall), slot: t(`stylist.slot.${m.slot}`) })}</Text>
            ))}
          </View>
        ) : null}
        {props.outcome?.kind === "added" ? <Banner tone="success" message={t("stylist.added")} /> : null}
        {props.outcome !== null && props.outcome.kind !== "added" ? (
          <View style={{ gap: spacing.xs }}>
            <Banner tone="warning" message={t(props.outcome.kind === "partial" ? "stylist.addedPartial" : "stylist.addFailed")} />
            <Text variant="caption" secondary>{t("stylist.rejectedHeading")}</Text>
            {props.outcome.rejected.map((r) => {
              const title = props.titles[r.skuId] ?? r.skuId;
              return (
                <Text key={r.skuId}>
                  {r.reason === "soldOut"
                    ? t("stylist.rejectSoldOut", { title })
                    : r.reason === "paused"
                      ? t("stylist.rejectPaused", { title })
                      : t("stylist.rejectPrice", { title, amount: money(r.currentPrice ?? 0n) })}
                </Text>
              );
            })}
          </View>
        ) : null}
        <Button title={t(props.busy ? "stylist.adding" : "stylist.addAll")} loading={props.busy} disabled={props.busy} onPress={props.onAdd} />
      </View>
    </Reveal>
  );
}

function LookSkeleton(props: { label: string }) {
  const bleed = useBleed();
  const { width } = useWindowDimensions();
  const tileW = Math.round(width * 0.64);
  return (
    <View accessibilityRole="progressbar" accessibilityLabel={props.label} style={{ gap: spacing.md, paddingTop: spacing.xl }}>
      <Skeleton width={120} height={12} />
      <Skeleton width="60%" height={28} />
      <View style={{ flexDirection: "row", gap: spacing.sm, marginHorizontal: -bleed, paddingHorizontal: bleed, overflow: "hidden" }}>
        <Skeleton width={tileW} height={Math.round(tileW * (4 / 3))} radius={radius.lg} />
        <Skeleton width={tileW} height={Math.round(tileW * (4 / 3))} radius={radius.lg} />
      </View>
    </View>
  );
}

/** Dev fixtures only; production wiring replaces the ports when the API client lands. */
export function StylistScreen(props: {
  port?: StylistPort;
  bagPort?: OutfitBagPort;
  newKey?: () => string;
  /** Opens the chat inside the Stylist tab (Phase 3). Hidden when not provided. */
  onOpenChat?: () => void;
  /** Wardrobe port for the "use my wardrobe" toggle (defaults to the feature container). */
  wardrobePort?: WardrobePort;
}) {
  const { t, i18n } = useTranslation();
  const locale: DisplayLocale = i18n.language === "en" ? "en" : "ar";
  const port: StylistPort = props.port ?? getFeaturePorts().stylist;
  const bagPort: OutfitBagPort = props.bagPort ?? getFeaturePorts().outfitBag;
  const counter = useRef(0);
  const newKey = props.newKey ?? (() => `outfit-${Date.now()}-${(counter.current += 1)}`);
  const currency = t("common.currency");
  const money = useCallback<Money>((m) => formatMoney(m, locale, currency), [locale, currency]);

  const [occasion, setOccasion] = useState<Occasion>("work");
  const [vibe, setVibe] = useState<Vibe>("classic");
  const [modest, setModest] = useState(false);
  const [budgetText, setBudgetText] = useState("");
  const [budgetError, setBudgetError] = useState(false);
  const [state, setState] = useState<StylistScreenState>({ status: "idle" });
  const [busyId, setBusyId] = useState<string | null>(null);
  const [outcomes, setOutcomes] = useState<Readonly<Record<string, AddOutcome>>>({});
  const [notice, setNotice] = useState<"feedback" | "swap" | "fairUse" | null>(null);
  const [useWardrobe, setUseWardrobe] = useState(false);
  const [ownedSlots, setOwnedSlots] = useState<Readonly<Record<string, readonly string[]>>>({});
  const [wardrobeOnly, setWardrobeOnly] = useState(false);
  const [wardrobeFailure, setWardrobeFailure] = useState<AiFailureReason | null>(null);

  const generate = async () => {
    const parsed = parseBudgetEgp(budgetText);
    setBudgetError(!parsed.ok);
    if (!parsed.ok) return;
    setState({ status: "loading" });
    setOutcomes({});
    setNotice(null);
    setWardrobeFailure(null);
    setOwnedSlots({});
    setWardrobeOnly(false);
    try {
      if (useWardrobe) {
        // Owned pieces fill their slots at no cost; only the missing ones are suggested from stores.
        const look = await (props.wardrobePort ?? getFeaturePorts().wardrobe).completeLook({ kind: wardrobeKindFor(occasion), modest, budget: parsed.value });
        setOwnedSlots(look.ownedSlots);
        setWardrobeOnly(look.ownedOnly);
        setState({ status: "ready", result: { outfits: look.outfits, source: look.source }, budget: parsed.value });
        return;
      }
      const result = await port.generate({ occasion, vibe, modest, budget: parsed.value });
      setState({ status: "ready", result, budget: parsed.value });
    } catch (e) {
      if (useWardrobe) {
        setWardrobeFailure(reasonOf(e));
        setState({ status: "idle" });
        return;
      }
      setState(stylistFailureState(e));
    }
  };

  const views = state.status === "ready" ? buildOutfitViews(state.result.outfits, state.budget) : [];
  const titles: Record<string, string> = {};
  for (const v of views) for (const i of v.outfit.items) titles[i.skuId] = i.title;

  const add = async (outfitId: string) => {
    setBusyId(outfitId);
    try {
      const r = await bagPort.addOutfit(outfitId, newKey());
      setOutcomes((o) => ({ ...o, [outfitId]: addOutcome(r) }));
    } catch {
      setOutcomes((o) => ({ ...o, [outfitId]: { kind: "none", rejected: [] } }));
    } finally {
      setBusyId(null);
    }
  };
  const feedback = async (outfitId: string, skuId: string, s: "like" | "dislike") => {
    setNotice(null);
    try { await port.feedback(outfitId, skuId, s); } catch { setNotice("feedback"); }
  };
  const swap = async (outfitId: string, skuId: string) => {
    if (state.status !== "ready") return;
    setNotice(null);
    try {
      const next = await port.swap(outfitId, skuId);
      setState({ ...state, result: { ...state.result, outfits: replaceOutfit(state.result.outfits, next) } });
    } catch { setNotice("swap"); }
  };

  return (
    <Screen title={t("stylist.title")}>
      <Text variant="lede" secondary>{t("stylist.aiLabel")}</Text>
      {props.onOpenChat !== undefined ? (
        <ListRow title={t("stylistChat.entry")} subtitle={t("stylistChat.entryHint")} leadingIcon="chatbubble-ellipses-outline" divider onPress={props.onOpenChat} />
      ) : null}
      <OfflineBanner visible={state.status === "error" && state.offline} message={t("common.offlineBanner")} />
      <Eyebrow>{t("stylist.occasionHeading")}</Eyebrow>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.sm }}>
        {OCCASIONS.map((o) => <Choice key={o} label={t(`stylist.occasion.${o}`)} selected={o === occasion} onPress={() => setOccasion(o)} />)}
      </View>
      <Eyebrow>{t("stylist.vibeHeading")}</Eyebrow>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.sm }}>
        {VIBES.map((o) => <Choice key={o} label={t(`stylist.vibe.${o}`)} selected={o === vibe} onPress={() => setVibe(o)} />)}
        <Choice label={t("stylist.modest")} selected={modest} onPress={() => setModest((m) => !m)} />
      </View>
      <TextField
        label={`${t("stylist.budgetLabel")} (${currency})`}
        value={budgetText}
        onChangeText={setBudgetText}
        keyboardType="numeric"
        helper={t("stylist.budgetHelper")}
        {...(budgetError ? { error: t("stylist.budgetInvalid") } : {})}
      />
      <SwitchRow label={t("wardrobe.useWardrobe")} value={useWardrobe} onValueChange={setUseWardrobe} />
      <Text variant="caption" secondary>{t("wardrobe.useWardrobeHelp")}</Text>
      <Button variant="brand" title={t("stylist.generate")} loading={state.status === "loading"} disabled={state.status === "loading"} onPress={() => void generate()} />

      {state.status === "loading" ? <LookSkeleton label={t("stylist.loading")} /> : null}
      {state.status === "error" ? (
        <StateScreen
          illustration={state.offline ? "offline" : "error"}
          title={t(state.offline ? "stylist.offlineTitle" : "stylist.errorTitle")}
          description={t(state.offline ? "stylist.offlineBody" : "stylist.errorBody")}
          actionTitle={t("common.retry")}
          onAction={() => void generate()}
        />
      ) : null}
      {wardrobeFailure !== null ? <Banner tone={wardrobeFailure === "nothingOwned" || wardrobeFailure === "consent" ? "info" : "error"} message={t(`aiFailure.${wardrobeFailure}`)} /> : null}
      {state.status === "ready" && wardrobeOnly ? <Banner tone="success" message={t("wardrobe.ownedOnly")} /> : null}
      {state.status === "ready" && state.result.source === "rules" ? <Banner tone="warning" message={t("stylist.rulesFallback")} /> : null}
      {notice === "feedback" ? <Banner tone="error" message={t("stylist.feedbackFailed")} /> : null}
      {notice === "swap" ? <Banner tone="error" message={t("stylist.swapFailed")} /> : null}
      {state.status === "ready" && views.length === 0 ? <StateScreen illustration="noResults" title={t("stylist.emptyTitle")} description={t("stylist.emptyBody")} /> : null}
      {views.map((v, idx) => (
        <View key={v.outfit.id}>
          {(ownedSlots[v.outfit.id] ?? []).length > 0 ? (
            <Text variant="caption" secondary>{t("wardrobe.ownedFromWardrobe", { slots: (ownedSlots[v.outfit.id] ?? []).map((s) => t(`stylist.slotName.${s}`)).join(", ") })}</Text>
          ) : null}
        <OutfitCard
          key={v.outfit.id}
          n={idx + 1}
          v={v}
          money={money}
          busy={busyId === v.outfit.id}
          outcome={outcomes[v.outfit.id] ?? null}
          titles={titles}
          onAdd={() => void add(v.outfit.id)}
          onFeedback={(sku, s) => void feedback(v.outfit.id, sku, s)}
          onSwap={(sku) => void swap(v.outfit.id, sku)}
        />
        </View>
      ))}
    </Screen>
  );
}
