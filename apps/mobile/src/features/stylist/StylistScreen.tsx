import { useCallback, useRef, useState } from "react";
import { View } from "react-native";
import { useTranslation } from "react-i18next";
import { spacing } from "@outlet/ui-tokens";
import { Banner, Button, Card, Checkbox, Divider, EmptyState, ErrorState, LoadingState, Screen, Text, TextField } from "../../ui";
import { getFeaturePorts } from "../../state/ports";
import { formatMoney, type DisplayLocale } from "../money-display";
import {
  OCCASIONS, VIBES, addOutcome, buildOutfitViews, parseBudgetEgp, replaceOutfit, stylistFailureState,
  type AddOutcome, type Occasion, type OutfitBagPort, type OutfitView, type StylistPort, type StylistScreenState, type Vibe,
} from "./model";

type Money = (minor: bigint) => string;

function Choice(props: { label: string; selected: boolean; onPress: () => void }) {
  const { t } = useTranslation();
  return (
    <Button
      variant={props.selected ? "primary" : "secondary"}
      title={props.label}
      accessibilityLabel={props.label}
      {...(props.selected ? { accessibilityHint: t("common.on") } : {})}
      onPress={props.onPress}
    />
  );
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
  return (
    <Card>
      <Text variant="heading">{t("stylist.outfitHeading", { n: props.n })}</Text>
      {v.outfit.items.map((i) => (
        <View key={i.skuId} style={{ gap: spacing.xs }}>
          <Text variant="caption" secondary>{t(`stylist.slotName.${i.slot}`)}</Text>
          <Text>{t("stylist.itemLine", { title: i.title, store: i.storeName, size: i.sizeLabel, amount: money(i.unitPrice) })}</Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.xs }}>
            <Button variant="secondary" title={t("stylist.like")} accessibilityLabel={t("stylist.likeName", { title: i.title })} onPress={() => props.onFeedback(i.skuId, "like")} />
            <Button variant="secondary" title={t("stylist.dislike")} accessibilityLabel={t("stylist.dislikeName", { title: i.title })} onPress={() => props.onFeedback(i.skuId, "dislike")} />
            <Button variant="secondary" title={t("stylist.swap")} accessibilityLabel={t("stylist.swapName", { title: i.title })} onPress={() => props.onSwap(i.skuId)} />
          </View>
        </View>
      ))}
      <Divider />
      <Text>{t("stylist.outfitTotal", { amount: money(v.total) })}</Text>
      {v.deliveries.map((d) => (
        <Text key={d.storeId} variant="caption" secondary>
          {d.fee === 0n ? t("stylist.deliveryFree", { store: d.storeName }) : t("stylist.deliveryFee", { store: d.storeName, amount: money(d.fee) })}
        </Text>
      ))}
      <Text secondary>
        {fit.kind === "none" ? t("stylist.budgetNone") : fit.kind === "exact" ? t("stylist.budgetExact") : fit.kind === "fits" ? t("stylist.budgetFits", { amount: money(fit.spare) }) : t("stylist.budgetOver", { amount: money(fit.by) })}
      </Text>
      {v.isPartial ? (
        <View style={{ gap: spacing.xs }}>
          <Banner tone="info" message={t("stylist.partialHeading")} />
          {v.missing.map((m) => (
            <Text key={m.slot}>{t("stylist.partialMissing", { amount: money(m.shortfall), slot: t(`stylist.slot.${m.slot}`) })}</Text>
          ))}
        </View>
      ) : null}
      {props.outcome?.kind === "added" ? <Banner tone="info" message={t("stylist.added")} /> : null}
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
    </Card>
  );
}

/** Dev fixtures only; production wiring replaces the ports when the API client lands. */
export function StylistScreen(props: { port?: StylistPort; bagPort?: OutfitBagPort; newKey?: () => string }) {
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

  const generate = async () => {
    const parsed = parseBudgetEgp(budgetText);
    setBudgetError(!parsed.ok);
    if (!parsed.ok) return;
    setState({ status: "loading" });
    setOutcomes({});
    setNotice(null);
    try {
      const result = await port.generate({ occasion, vibe, modest, budget: parsed.value });
      setState({ status: "ready", result, budget: parsed.value });
    } catch (e) {
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
    <Screen>
      <Text variant="title">{t("stylist.title")}</Text>
      <Banner tone="info" message={t("stylist.aiLabel")} />
      <Text variant="heading">{t("stylist.occasionHeading")}</Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.xs }}>
        {OCCASIONS.map((o) => <Choice key={o} label={t(`stylist.occasion.${o}`)} selected={o === occasion} onPress={() => setOccasion(o)} />)}
      </View>
      <Text variant="heading">{t("stylist.vibeHeading")}</Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.xs }}>
        {VIBES.map((o) => <Choice key={o} label={t(`stylist.vibe.${o}`)} selected={o === vibe} onPress={() => setVibe(o)} />)}
      </View>
      <Checkbox label={t("stylist.modest")} value={modest} onValueChange={setModest} />
      <TextField
        label={`${t("stylist.budgetLabel")} (${currency})`}
        value={budgetText}
        onChangeText={setBudgetText}
        keyboardType="numeric"
        helper={t("stylist.budgetHelper")}
        {...(budgetError ? { error: t("stylist.budgetInvalid") } : {})}
      />
      <Button title={t("stylist.generate")} loading={state.status === "loading"} disabled={state.status === "loading"} onPress={() => void generate()} />

      {state.status === "loading" ? <LoadingState label={t("stylist.loading")} /> : null}
      {state.status === "error" ? (
        <ErrorState
          offline={state.offline}
          title={t(state.offline ? "stylist.offlineTitle" : "stylist.errorTitle")}
          description={t(state.offline ? "stylist.offlineBody" : "stylist.errorBody")}
          retryTitle={t("common.retry")}
          onRetry={() => void generate()}
        />
      ) : null}
      {state.status === "ready" && state.result.source === "rules" ? <Banner tone="warning" message={t("stylist.rulesFallback")} /> : null}
      {notice === "feedback" ? <Banner tone="error" message={t("stylist.feedbackFailed")} /> : null}
      {notice === "swap" ? <Banner tone="error" message={t("stylist.swapFailed")} /> : null}
      {state.status === "ready" && views.length === 0 ? <EmptyState title={t("stylist.emptyTitle")} description={t("stylist.emptyBody")} /> : null}
      {views.map((v, idx) => (
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
      ))}
      {typeof __DEV__ !== "undefined" && __DEV__ ? <Banner tone="info" message={t("common.devFixtureBackend")} /> : null}
    </Screen>
  );
}
