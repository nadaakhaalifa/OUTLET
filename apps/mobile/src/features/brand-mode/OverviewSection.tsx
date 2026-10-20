import { useState, type ReactNode } from "react";
import { View } from "react-native";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { radius } from "@outlet/ui-tokens";
import { BottomSheet, Button, Card, Icon, PressScale, Skeleton, Text, useTheme } from "../../ui";
import { formatAmount, localizeDigits, type DisplayLocale } from "../money-display";
import { StaleBanner, useBrand, useLoad, useMoney } from "./kit";
import {
  KPI_ORDER, bpsText, dailyBars, deltaTone, funnelView, kpiCards, repeatView, tenthsText, unavailableRows, updatedMinutes,
  type Delta, type DashboardSummary, type KpiCard, type KpiId, type KpiValue, type SummaryPeriod, type Tone,
} from "./summaryModel";

const FUNNEL_KEY = { views: "funnelViews", bagAdds: "funnelBagAdds", checkouts: "funnelCheckouts", purchases: "funnelPurchases" } as const;
const tint = (hex: string, alpha: string): string => (/^#[0-9a-fA-F]{6}$/.test(hex) ? `${hex}${alpha}` : hex);
const pctSign = (locale: DisplayLocale): string => (locale === "ar" ? "٪" : "%");

/** Percent text from a tenths-of-a-percent number, digits localised. */
function pctText(tenths: number, locale: DisplayLocale): string {
  return `${localizeDigits(tenthsText(tenths), locale)}${pctSign(locale)}`;
}
function bpsPct(bp: number, locale: DisplayLocale): string {
  return `${localizeDigits(bpsText(bp), locale)}${pctSign(locale)}`;
}

function useS(): (n: number) => number {
  return useTheme().s;
}

function useValueText(): (v: KpiValue) => string | null {
  const { t } = useTranslation();
  const { locale } = useBrand();
  const cur = t("brandMode.common.egp");
  return (v) => {
    switch (v.kind) {
      case "money": return `${formatAmount(v.value, locale)} ${cur}`;
      case "count": return localizeDigits(String(v.value), locale);
      case "bps": return bpsPct(v.value, locale);
      case "none": return null;
    }
  };
}

function toneColor(tone: Tone): "savings" | "danger" | "textSecondary" {
  return tone === "good" ? "savings" : tone === "bad" ? "danger" : "textSecondary";
}

export function DeltaChip(props: { delta: Delta; lowerIsBetter?: boolean; points?: boolean; testID?: string }) {
  const s = useS();
  const { t } = useTranslation();
  const { locale } = useBrand();
  const { colors } = useTheme();
  const d = props.delta;
  if (d.kind === "none") return null;
  const tone = deltaTone(d, props.lowerIsBetter === true);
  const color = toneColor(tone);
  const pct = d.kind === "up" || d.kind === "down" ? pctText(d.tenths, locale) : "";
  const label = d.kind === "new" ? t("brandMode.overview.deltaNew") : d.kind === "flat" ? t("brandMode.overview.deltaFlat") : pct;
  const bg = tone === "neutral" ? colors.fill : tint(tone === "good" ? colors.savings : colors.danger, "1F");
  return (
    <View testID={props.testID} style={{ alignSelf: "flex-start", flexDirection: "row", alignItems: "center", gap: s(3), minHeight: s(24), paddingHorizontal: s(8), borderRadius: radius.pill, backgroundColor: bg }}>
      {d.kind === "up" || d.kind === "down" ? <Icon name={d.kind === "up" ? "arrow-up" : "arrow-down"} size={s(12)} color={color} /> : null}
      <Text variant="caption" weight="600" color={color} numeric accessibilityRole="none">{label}</Text>
    </View>
  );
}

export function deltaA11y(t: TFunction, d: Delta, locale: DisplayLocale, points: boolean): string {
  if (d.kind === "none") return "";
  if (d.kind === "new") return t("brandMode.overview.deltaNew");
  if (d.kind === "flat") return t("brandMode.overview.deltaFlat");
  const pct = localizeDigits(tenthsText(d.tenths), locale);
  const key = points ? (d.kind === "up" ? "deltaPointsUpA11y" : "deltaPointsDownA11y") : d.kind === "up" ? "deltaUpA11y" : "deltaDownA11y";
  return t(`brandMode.overview.${key}`, { pct });
}

function KpiTileCard(props: { card: KpiCard; onOpen: (id: KpiId) => void }) {
  const s = useS();
  const { t } = useTranslation();
  const { locale } = useBrand();
  const text = useValueText();
  const c = props.card;
  const label = t(`brandMode.overview.kpi.${c.id}`);
  const value = text(c.value);
  const prev = text(c.previous);
  const a11yDelta = deltaA11y(t, c.delta, locale, c.id === "returnRate");
  return (
    <PressScale onPress={() => props.onOpen(c.id)} accessibilityRole="button"
      accessibilityLabel={t("brandMode.overview.cardA11y", { label, value: value ?? t("brandMode.overview.noValue"), delta: a11yDelta === "" ? (prev === null ? "" : t("brandMode.overview.previous", { value: prev })) : a11yDelta })}
      innerStyle={{ flex: 1 }} testID={`overview-kpi-${c.id}`}>
      <Card variant="outlined" style={{ gap: s(8), paddingHorizontal: s(12), paddingVertical: s(14), minHeight: s(128) }}>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: s(4) }}>
          <Text variant="caption" secondary numberOfLines={2} style={{ flexShrink: 1 }} accessibilityRole="none">{label}</Text>
          <Icon name="information-circle-outline" size={s(16)} color="textSecondary" />
        </View>
        {value !== null ? <Text variant="title2" numeric numberOfLines={1} accessibilityRole="none">{value}</Text> : <Text variant="callout" secondary accessibilityRole="none">{t("brandMode.overview.noValue")}</Text>}
        <DeltaChip delta={c.delta} lowerIsBetter={c.lowerIsBetter} />
        <Text variant="caption" secondary numberOfLines={1} accessibilityRole="none">{prev === null ? t("brandMode.overview.previousNone") : t("brandMode.overview.previous", { value: prev })}</Text>
      </Card>
    </PressScale>
  );
}

function SectionCard(props: { title: string; trailing?: ReactNode; children: ReactNode; testID?: string }) {
  const s = useS();
  return (
    <View testID={props.testID}>
      <Card variant="outlined" style={{ gap: s(14) }}>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: s(12) }}>
          <Text variant="headline" weight="600" accessibilityRole="header" style={{ flexShrink: 1 }}>{props.title}</Text>
          {props.trailing}
        </View>
        {props.children}
      </Card>
    </View>
  );
}

const dayLabel = (iso: string, locale: DisplayLocale): string =>
  new Intl.DateTimeFormat(locale === "ar" ? "ar-EG" : "en-GB", { timeZone: "UTC", day: "numeric", month: "short" }).format(new Date(`${iso}T12:00:00Z`));

function SalesChart(props: { s: DashboardSummary }) {
  const s = useS();
  const { t } = useTranslation();
  const { colors, spacing } = useTheme();
  const { locale } = useBrand();
  const money = useMoney();
  const days = props.s.dailySales;
  const bars = dailyBars(days);
  const total = props.s.current.grossSales;
  const h = spacing.xxxl * 2;
  const first = days[0];
  const last = days[days.length - 1];
  return (
    <SectionCard title={t("brandMode.overview.chartTitle")} testID="overview-chart" trailing={<Text variant="callout" numeric secondary accessibilityRole="none">{t("brandMode.overview.chartTotal", { value: money(total) })}</Text>}>
      {bars === null ? (
        <Text variant="callout" secondary>{days.length < 2 ? t("brandMode.overview.chartTodayHint") : t("brandMode.overview.chartEmpty")}</Text>
      ) : (
        <>
          <View style={{ flexDirection: "row", alignItems: "flex-end", gap: bars.length > 14 ? s(2) : spacing.sm, height: h }} accessible accessibilityLabel={t("brandMode.overview.chartA11y", { days: localizeDigits(String(bars.length), locale), total: money(total) })}>
            {bars.map((b, i) => (
              <View key={days[i]?.day ?? i} style={{ flex: 1, height: Math.max(spacing.xs, Math.round(b * h)), borderRadius: radius.sm, backgroundColor: i === bars.length - 1 ? colors.savings : colors.fill }} />
            ))}
          </View>
          <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
            <Text variant="caption" secondary accessibilityRole="none">{first === undefined ? "" : dayLabel(first.day, locale)}</Text>
            <Text variant="caption" secondary accessibilityRole="none">{last === undefined ? "" : dayLabel(last.day, locale)}</Text>
          </View>
        </>
      )}
    </SectionCard>
  );
}

function FunnelCard(props: { s: DashboardSummary }) {
  const s = useS();
  const { t } = useTranslation();
  const { colors } = useTheme();
  const { locale } = useBrand();
  const f = funnelView(props.s.current.funnel);
  return (
    <SectionCard title={t("brandMode.overview.funnelTitle")} testID="overview-funnel">
      {f.empty ? <Text variant="callout" secondary>{t("brandMode.overview.funnelEmpty")}</Text> : (
        <View style={{ gap: s(14) }}>
          {f.steps.map((st) => (
            <View key={st.id} style={{ gap: s(6) }} accessible accessibilityLabel={`${t(`brandMode.overview.${FUNNEL_KEY[st.id]}`)}: ${localizeDigits(String(st.count), locale)}${st.stepRateBp === null ? "" : `, ${t("brandMode.overview.funnelStep", { pct: bpsPct(st.stepRateBp, locale) })}`}`} testID={`overview-funnel-${st.id}`}>
              <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: s(8) }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: s(6), flexShrink: 1 }}>
                  <Text variant="callout" weight="500" accessibilityRole="none" style={{ flexShrink: 1 }}>{t(`brandMode.overview.${FUNNEL_KEY[st.id]}`)}</Text>
                  {st.sampled ? <Text variant="caption" secondary accessibilityRole="none">{t("brandMode.overview.funnelSampled")}</Text> : null}
                </View>
                <Text variant="callout" weight="600" numeric accessibilityRole="none">{localizeDigits(String(st.count), locale)}</Text>
              </View>
              <View style={{ height: s(8), borderRadius: radius.pill, backgroundColor: colors.fill, overflow: "hidden", flexDirection: "row" }}>
                <View style={{ width: `${Math.max(2, Math.round(st.ratio * 100))}%`, backgroundColor: st.id === "purchases" ? colors.savings : colors.textSecondary, borderRadius: radius.pill }} />
              </View>
              {st.stepRateBp !== null ? <Text variant="caption" secondary numeric accessibilityRole="none">{t("brandMode.overview.funnelStep", { pct: bpsPct(st.stepRateBp, locale) })}</Text> : null}
            </View>
          ))}
          {f.overallBp !== null ? <Text variant="callout" weight="500" numeric>{t("brandMode.overview.funnelOverall", { pct: bpsPct(f.overallBp, locale) })}</Text> : null}
          <Text variant="caption" secondary>{t("brandMode.overview.funnelNote")}</Text>
        </View>
      )}
    </SectionCard>
  );
}

function TopProducts(props: { s: DashboardSummary }) {
  const s = useS();
  const { t } = useTranslation();
  const { colors } = useTheme();
  const { locale } = useBrand();
  const money = useMoney();
  const rows = props.s.current.topProducts;
  return (
    <SectionCard title={t("brandMode.overview.topTitle")} testID="overview-top-products">
      {rows.length === 0 ? <Text variant="callout" secondary>{t("brandMode.overview.topEmpty")}</Text> : (
        <View>
          {rows.map((p, i) => (
            <View key={p.productId} testID={`overview-top-${p.productId}`} style={{ flexDirection: "row", alignItems: "center", gap: s(12), minHeight: s(52), borderTopWidth: i === 0 ? 0 : 1, borderTopColor: colors.hairline }}>
              <View style={{ width: s(28), height: s(28), borderRadius: radius.pill, backgroundColor: colors.fill, alignItems: "center", justifyContent: "center" }}>
                <Text variant="caption" weight="600" numeric accessibilityRole="none">{localizeDigits(String(i + 1), locale)}</Text>
              </View>
              <View style={{ flex: 1, minWidth: s(0), gap: s(2) }}>
                <Text variant="callout" weight="500" numberOfLines={1} accessibilityRole="none">{p.title === null ? t("brandMode.overview.topUnknown") : locale === "ar" ? p.title.ar : p.title.en}</Text>
                <Text variant="caption" secondary numeric accessibilityRole="none">{t("brandMode.overview.topUnits", { count: localizeDigits(String(p.units), locale) })}</Text>
              </View>
              <Text variant="callout" weight="600" numeric accessibilityRole="none">{money(p.grossSales)}</Text>
            </View>
          ))}
        </View>
      )}
    </SectionCard>
  );
}

function RepeatCard(props: { s: DashboardSummary; onOpen: () => void }) {
  const s = useS();
  const { t } = useTranslation();
  const { locale } = useBrand();
  const r = repeatView(props.s);
  return (
    <PressScale onPress={props.onOpen} accessibilityRole="button" accessibilityLabel={`${t("brandMode.overview.repeatTitle")}: ${r.kind === "value" ? bpsPct(r.bps, locale) : t("brandMode.overview.repeatNeeds", { min: localizeDigits(String(r.min), locale) })}`} testID="overview-repeat">
      <Card variant="outlined" style={{ gap: s(8) }}>
        <Text variant="headline" weight="600" accessibilityRole="header">{t("brandMode.overview.repeatTitle")}</Text>
        {r.kind === "value" ? (
          <>
            <Text variant="title1" numeric accessibilityRole="none">{bpsPct(r.bps, locale)}</Text>
            <Text variant="caption" secondary>{t("brandMode.overview.repeatBody")}</Text>
          </>
        ) : (
          <>
            <Text variant="title2" secondary accessibilityRole="none">{t("brandMode.overview.repeatNeeds", { min: localizeDigits(String(r.min), locale) })}</Text>
            <Text variant="caption" secondary>{t("brandMode.overview.repeatNeedsBody", { min: localizeDigits(String(r.min), locale) })}</Text>
          </>
        )}
      </Card>
    </PressScale>
  );
}

function UntrackedCard(props: { s: DashboardSummary }) {
  const s = useS();
  const { t } = useTranslation();
  const { colors } = useTheme();
  const rows = unavailableRows(props.s);
  if (rows.length === 0) return null;
  return (
    <SectionCard title={t("brandMode.overview.untrackedTitle")} testID="overview-untracked">
      <Text variant="caption" secondary>{t("brandMode.overview.untrackedBody")}</Text>
      <View>
        {rows.map((m, i) => (
          <View key={m} testID={`overview-untracked-${m}`} accessible accessibilityLabel={`${t(`brandMode.overview.untracked.${m}`)}: ${t("brandMode.overview.untrackedBadge")}`} style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: s(12), minHeight: s(48), borderTopWidth: i === 0 ? 0 : 1, borderTopColor: colors.hairline }}>
            <Text variant="callout" style={{ flex: 1 }} accessibilityRole="none">{t(`brandMode.overview.untracked.${m}`)}</Text>
            <View style={{ paddingHorizontal: s(10), minHeight: s(24), justifyContent: "center", borderRadius: radius.pill, backgroundColor: colors.fill }}>
              <Text variant="caption" weight="500" secondary accessibilityRole="none">{t("brandMode.overview.untrackedBadge")}</Text>
            </View>
          </View>
        ))}
      </View>
    </SectionCard>
  );
}

function SummarySkeleton() {
  const s = useS();
  const { t } = useTranslation();
  return (
    <View style={{ gap: s(12) }} accessibilityLabel={t("common.loading")} testID="overview-loading">
      <View style={{ flexDirection: "row", gap: s(10) }}><Skeleton height={s(128)} width="48%" /><Skeleton height={s(128)} width="48%" /></View>
      <View style={{ flexDirection: "row", gap: s(10) }}><Skeleton height={s(128)} width="48%" /><Skeleton height={s(128)} width="48%" /></View>
      <Skeleton height={s(190)} radius={radius.lg} />
      <Skeleton height={s(260)} radius={radius.lg} />
    </View>
  );
}

/**
 * Shopify-style overview for one period. Own load state per period (the parent keys it by period), so switching
 * period never shows another period's numbers. `fallback` is the simple dashboard used when the endpoint is flagged off.
 */
export function OverviewSection(props: { period: SummaryPeriod; nowMs: number; fallback: (hint: string) => ReactNode }) {
  const s0 = useS();
  const { t } = useTranslation();
  const { port, locale } = useBrand();
  const { state, reload } = useLoad<DashboardSummary | null>(`summary:${props.period}`, () => port.dashboardSummary(props.period));
  const [open, setOpen] = useState<KpiId | "repeat" | null>(null);

  if (state.status === "loading") return <SummarySkeleton />;
  if (state.status === "error") {
    const f = state.failure;
    if (f === "forbidden" || f === "unsupported") return <>{props.fallback(t("brandMode.overview.fallbackHint"))}</>;
    return (
      <View testID="overview-error"><Card variant="outlined" style={{ gap: s0(10) }}>
        <Text variant="headline" weight="600">{f === "offline" ? t("brandMode.common.offlineTitle") : t("brandMode.overview.summaryErrorTitle")}</Text>
        <Text variant="callout" secondary>{f === "offline" ? t("brandMode.common.offlineBody") : t("brandMode.overview.summaryErrorBody")}</Text>
        <Button title={t("brandMode.common.retry")} variant="secondary" onPress={reload} />
      </Card></View>
    );
  }
  const s = state.data;
  if (s === null) return <>{props.fallback(t("brandMode.overview.fallbackHint"))}</>;
  const cards = kpiCards(s);
  const minutes = updatedMinutes(s.asOfMs, props.nowMs);
  const sheetKey = open === null ? null : open === "repeat" ? "repeat_customer_rate" : (cards.find((c) => c.id === open)?.definitionKey ?? null);
  const sheetTitle = open === null ? "" : open === "repeat" ? t("brandMode.overview.repeatTitle") : t(`brandMode.overview.kpi.${open}`);
  // Arabic shows the app's own wording for the known keys; English and unknown keys use the server definition.
  const localDef = sheetKey !== null && locale === "ar" && ["gross_sales", "net_after_commission", "return_rate", "repeat_customer_rate", "growth"].includes(sheetKey) ? t(`brandMode.overview.def.${sheetKey}`) : undefined;
  const definition = localDef ?? (sheetKey === null ? undefined : s.definitions[sheetKey]);
  const rowsOfCards: KpiCard[][] = KPI_ORDER.reduce<KpiCard[][]>((rows, id, i) => {
    const c = cards.find((x) => x.id === id);
    if (c === undefined) return rows;
    if (i % 2 === 0) rows.push([c]); else rows[rows.length - 1]?.push(c);
    return rows;
  }, []);
  return (
    <View style={{ gap: s0(16) }} testID="overview">
      <StaleBanner visible={state.stale} />
      <View style={{ gap: s0(4) }}>
        <Text variant="caption" secondary testID="overview-updated">
          {minutes === null ? t("brandMode.overview.updatedUnknown") : minutes === 0 ? t("brandMode.overview.updatedNow") : t("brandMode.overview.updated", { minutes: localizeDigits(String(minutes), locale) })}
          {" · "}{t("brandMode.overview.compare")}
        </Text>
        {!s.withinSlo ? <Text variant="caption" color="danger">{t("brandMode.overview.behind")}</Text> : null}
      </View>
      {rowsOfCards.map((row, i) => (
        <View key={i} style={{ flexDirection: "row", gap: s0(10) }}>
          {row.map((c) => <View key={c.id} style={{ flex: 1, minWidth: 0 }}><KpiTileCard card={c} onOpen={setOpen} /></View>)}
          {row.length === 1 ? <View style={{ flex: 1 }} /> : null}
        </View>
      ))}
      <SalesChart s={s} />
      <FunnelCard s={s} />
      <TopProducts s={s} />
      <RepeatCard s={s} onOpen={() => setOpen("repeat")} />
      <UntrackedCard s={s} />
      <BottomSheet visible={open !== null} onClose={() => setOpen(null)} title={t("brandMode.overview.definitionTitle")} closeLabel={t("brandMode.overview.definitionClose")}>
        <View style={{ gap: s0(10) }} testID="overview-definition">
          <Text variant="headline" weight="600">{sheetTitle}</Text>
          <Text variant="body">{definition ?? t("brandMode.overview.definitionMissing")}</Text>
        </View>
      </BottomSheet>
    </View>
  );
}
