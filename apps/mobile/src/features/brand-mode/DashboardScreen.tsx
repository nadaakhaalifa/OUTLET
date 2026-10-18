import { useEffect, useState, type ReactNode } from "react";
import { ScrollView, View } from "react-native";
import { useRouter } from "expo-router";
import { useTranslation } from "react-i18next";
import { radius } from "@outlet/ui-tokens";
import { Illustration } from "../../art";
import { Avatar, Banner, Button, Card, Icon, PressScale, Reveal, Screen, Skeleton, Text, useTheme, useToast } from "../../ui";
import { formatAmount, localizeDigits } from "../money-display";
import { FailureView, ProgressRule, StaleBanner, useBrand, useLoad, useMoney } from "./kit";
import { countdownLabel, countdownTone, kpiTiles, sectionOrder, type KpiTile } from "./dashboardModel";
import { buildDashboard, orderActions, serverNow, slaCountdown, type BrandOrder, type DashboardData, type DashboardView } from "./model";

const GAP = 24;
/** Soft tint of a solid #RRGGBB token (alpha suffix): keeps the token as the single colour source. */
const tint = (hex: string, alpha: string): string => (/^#[0-9a-fA-F]{6}$/.test(hex) ? `${hex}${alpha}` : hex);

function useTick(ms: number): number {
  const [n, setN] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setN(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return n;
}

export function DashboardScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const toast = useToast();
  const { colors } = useTheme();
  const { port, account, clock, syncClock, locale } = useBrand();
  const money = useMoney();
  const { state, reload, reloading } = useLoad<DashboardData>("dashboard", () => port.dashboard());
  const now = useTick(60_000);
  const [busy, setBusy] = useState<string | null>(null);
  const data = state.status === "ready" ? state.data : null;
  useEffect(() => { if (data !== null && !(state.status === "ready" && state.stale)) syncClock(data.serverNowMs); }, [data, state, syncClock]);
  const name = locale === "ar" ? account.name.ar : account.name.en;
  const view: DashboardView | null = data === null ? null : buildDashboard(data, clock, now);
  const num = (n: number) => localizeDigits(String(n), locale);
  const pct = (bp: number | null) => (bp === null ? null : `${localizeDigits((bp / 100).toFixed(1), locale)}${locale === "ar" ? "٪" : "%"}`);
  const toOrders = () => router.navigate("/brand-mode/orders");

  const accept = async (o: BrandOrder) => {
    setBusy(o.id);
    try {
      await port.acceptOrder(o.id);
      toast.show(t("brandMode.dashboard.acceptDone"), "success");
      reload();
    } catch {
      toast.show(t("brandMode.dashboard.acceptFailed"), "error");
    } finally {
      setBusy(null);
    }
  };

  const ladderGood = data !== null && data.trust.ladder === "good_standing";

  return (
    <Screen title={t("brandMode.dashboard.title")} onRefresh={reload} refreshing={reloading} contentStyle={{ gap: GAP }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 16, marginTop: -8 }}>
        <View style={{ flex: 1, gap: 8 }}>
          <Text variant="callout" secondary numberOfLines={1} accessibilityRole="none">{name}</Text>
          {data !== null ? (
            <View style={{ alignSelf: "flex-start", flexDirection: "row", alignItems: "center", gap: 6, minHeight: 28, paddingHorizontal: 10, borderRadius: radius.pill, backgroundColor: ladderGood ? tint(colors.savings, "1A") : colors.fill }}>
              <Icon name={ladderGood ? "checkmark-circle" : "alert-circle-outline"} size={14} color={ladderGood ? "savings" : "textSecondary"} />
              <Text variant="caption" weight="500" color={ladderGood ? "savings" : "textSecondary"} accessibilityRole="none">{t(`brandMode.dashboard.ladder.${data.trust.ladder}`)}</Text>
            </View>
          ) : null}
        </View>
        <Avatar name={name} size={44} />
      </View>

      {state.status === "loading" ? <DashboardSkeleton /> : null}
      {state.status === "error" ? <FailureView failure={state.failure} onRetry={reload} /> : null}
      {view !== null && data !== null ? (
        <>
          <StaleBanner visible={state.status === "ready" && state.stale} />

          <View style={{ gap: 10 }}>
            <View style={{ flexDirection: "row", gap: 10 }}>
              {kpiTiles(view).map((k) => <KpiCell key={k.key} tile={k} />)}
            </View>
            <Text variant="caption" secondary>
              {view.freshnessMin === null ? t("brandMode.dashboard.freshnessUnknown") : view.freshnessMin === 0 ? t("brandMode.dashboard.freshnessNow") : t("brandMode.dashboard.freshness", { minutes: num(view.freshnessMin) })}
            </Text>
            {view.sales.kind === "unavailable" || view.orders.kind === "unavailable" ? <Text variant="caption" secondary>{t("brandMode.common.notEnoughDataHint")}</Text> : null}
          </View>

          {sectionOrder(view).map((key, i) => {
            switch (key) {
              case "actions":
                return (
                  <Reveal key={key} index={i}>
                    <Section title={t("brandMode.dashboard.needsAction")} actionLabel={t("brandMode.dashboard.seeAll")} onAction={toOrders}>
                      {view.awaitingBreached > 0 ? <Banner tone="error" message={t("brandMode.dashboard.awaitingBreached", { count: num(view.awaitingBreached) })} /> : null}
                      {view.awaiting.map(({ order, sla }) => (
                        <ActionCard
                          key={order.id}
                          order={order}
                          price={money(order.subtotal)}
                          buyer={t("brandMode.orders.buyerMasked", { name: order.buyer.firstName ?? "—", governorate: order.buyer.governorate })}
                          canAccept={orderActions(order.status, account.role, sla.level === "breached").includes("accept")}
                          busy={busy === order.id}
                          onAccept={() => { void accept(order); }}
                          onReview={toOrders}
                        />
                      ))}
                    </Section>
                  </Reveal>
                );
              case "caughtUp":
                return (
                  <Reveal key={key} index={i}>
                    <View style={{ alignItems: "center", gap: 8, paddingVertical: 12 }} testID="dashboard-caught-up">
                      <Illustration name="noOrders" size={96} />
                      <Text variant="title2" align="center">{t("brandMode.dashboard.caughtUpTitle")}</Text>
                      <Text variant="callout" secondary align="center">{t("brandMode.dashboard.caughtUpBody")}</Text>
                    </View>
                  </Reveal>
                );
              case "lowStock":
                return (
                  <Reveal key={key} index={i}>
                    <Section title={t("brandMode.dashboard.lowStockTitle")} actionLabel={t("brandMode.dashboard.restock")} onAction={() => router.navigate("/brand-mode/products")}>
                      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 12 }} testID="dashboard-low-stock">
                        {view.lowStock.map((s) => (
                          <View key={s.skuId} style={{ width: 168, gap: 10 }}>
                            <Card variant="outlined" style={{ gap: 10 }}>
                              <Thumb size={56} />
                              <Text variant="callout" weight="500" numberOfLines={1}>{s.productTitle}</Text>
                              <Chip tone={s.available === 0 ? "urgent" : "calm"} label={t("brandMode.dashboard.lowStockChip", { size: s.sizeLabel, count: num(s.available) })} />
                            </Card>
                          </View>
                        ))}
                      </ScrollView>
                    </Section>
                  </Reveal>
                );
              case "money":
                return (
                  <Reveal key={key} index={i}>
                    <View style={{ gap: 12 }}>
                      <Card variant="outlined" style={{ gap: 16 }}>
                        <Text variant="headline" weight="600" accessibilityRole="header">{t("brandMode.dashboard.payoutTitle")}</Text>
                        <View style={{ flexDirection: "row", gap: 16 }}>
                          <Stat label={t("brandMode.dashboard.payoutEligible")} value={view.payoutEligible.kind === "value" ? money(view.payoutEligible.value) : null} />
                          <Stat label={t("brandMode.dashboard.payoutPending")} value={data.payout.pendingRelease === null ? null : money(data.payout.pendingRelease)} />
                        </View>
                        {view.payoutHeld !== null ? (
                          <Text variant="callout" color="danger">
                            {t("brandMode.dashboard.payoutHeld")}: {money(view.payoutHeld)}. {data.payout.heldReasons.length === 0 ? t("brandMode.dashboard.payoutHeldNoReason") : t("brandMode.dashboard.payoutHeldReason", { reasons: data.payout.heldReasons.join(", ") })}
                          </Text>
                        ) : (
                          <Text variant="caption" secondary>{t("brandMode.dashboard.payoutNoHold")}</Text>
                        )}
                        <Text variant="caption" secondary>
                          {t("brandMode.dashboard.payoutNext")}: {data.payout.nextPayoutAtMs === null ? t("brandMode.dashboard.payoutNextUnknown") : new Intl.DateTimeFormat(locale === "ar" ? "ar-EG" : "en-GB", { timeZone: "Africa/Cairo", day: "numeric", month: "long" }).format(new Date(data.payout.nextPayoutAtMs))}
                        </Text>
                      </Card>

                      <Card variant="outlined" style={{ gap: 14 }}>
                        <Text variant="headline" weight="600" accessibilityRole="header">{t("brandMode.dashboard.trustTitle")}</Text>
                        <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 16 }}>
                          <Stat label={t("brandMode.dashboard.trustScore")} value={data.trust.score === null ? null : `${localizeDigits(String(Math.round(data.trust.score)), locale)}/${localizeDigits("100", locale)}`} />
                        </View>
                        {data.trust.score !== null ? <ProgressRule ratio={data.trust.score / 100} /> : null}
                        {!view.trustBad && view.trustFixes.length === 0 ? (
                          <Text variant="callout" secondary>{t("brandMode.dashboard.trustFine")}</Text>
                        ) : (
                          <View style={{ gap: 8 }}>
                            <Text variant="caption" secondary>{t("brandMode.dashboard.trustFix")}</Text>
                            {(view.trustFixes.length === 0 ? [null] : view.trustFixes).map((f, idx) => (
                              <Text key={idx} variant="callout">{f === null ? t("brandMode.dashboard.trustFixGeneric") : (locale === "ar" ? f.cure?.ar : f.cure?.en) ?? t("brandMode.dashboard.trustFixGeneric")}</Text>
                            ))}
                          </View>
                        )}
                      </Card>
                    </View>
                  </Reveal>
                );
              case "health":
                return (
                  <Reveal key={key} index={i}>
                    <Section title={t("brandMode.dashboard.healthTitle")}>
                      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                        <HealthChip label={t("brandMode.dashboard.healthScore")} value={data.health.score === null ? null : localizeDigits(String(Math.round(data.health.score)), locale)} />
                        <HealthChip label={t("brandMode.dashboard.healthDispatch")} value={pct(data.health.dispatchOnTimeBp)} />
                        <HealthChip label={t("brandMode.dashboard.healthCancel")} value={pct(data.health.cancellationBp)} />
                        <HealthChip label={t("brandMode.dashboard.healthReturn")} value={pct(data.health.returnBp)} />
                      </View>
                    </Section>
                  </Reveal>
                );
            }
          })}

          <Button title={t("brandMode.common.backToShopping")} variant="ghost" icon="storefront-outline" onPress={() => router.replace("/(tabs)")} testID="brand-to-shopping" />
        </>
      ) : null}
    </Screen>
  );
}

function Section(props: { title: string; actionLabel?: string | undefined; onAction?: (() => void) | undefined; children: ReactNode }) {
  return (
    <View style={{ gap: 12 }}>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <Text variant="quote" accessibilityRole="header" style={{ flexShrink: 1 }}>{props.title}</Text>
        {props.actionLabel !== undefined && props.onAction !== undefined ? (
          <PressScale onPress={props.onAction} accessibilityRole="button" accessibilityLabel={props.actionLabel} hitSlop={8} innerStyle={{ minHeight: 44, justifyContent: "center" }}>
            <Text variant="callout" weight="500" secondary accessibilityRole="none">{props.actionLabel}</Text>
          </PressScale>
        ) : null}
      </View>
      {props.children}
    </View>
  );
}

function KpiCell(props: { tile: KpiTile }) {
  const { t } = useTranslation();
  const { locale } = useBrand();
  const { tile } = props;
  const label = t(tile.key === "sales" ? "brandMode.dashboard.salesToday" : tile.key === "orders" ? "brandMode.dashboard.ordersToday" : "brandMode.dashboard.kpiAwaiting");
  const cur = t("brandMode.common.egp");
  const value: string | null = tile.key === "sales"
    ? (tile.metric.kind === "value" ? formatAmount(tile.metric.value, locale) : null)
    : (tile.metric.kind === "value" ? localizeDigits(String(tile.metric.value), locale) : null);
  return (
    <Card variant="outlined" style={{ flex: 1, paddingHorizontal: 12, paddingVertical: 14, gap: 6, minHeight: 96 }}>
      <View accessible accessibilityLabel={`${label}: ${value === null ? t("brandMode.common.notEnoughData") : tile.key === "sales" ? `${value} ${cur}` : value}`} style={{ gap: 6 }}>
        <Text variant="caption" secondary numberOfLines={2} accessibilityRole="none">{label}</Text>
        {value !== null ? (
          <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "baseline", columnGap: 4 }}>
            <Text variant="title1" numeric accessibilityRole="none">{value}</Text>
            {tile.key === "sales" ? <Text variant="caption" secondary accessibilityRole="none">{cur}</Text> : null}
          </View>
        ) : (
          <Text variant="callout" secondary accessibilityRole="none">{t("brandMode.common.notEnoughData")}</Text>
        )}
      </View>
    </Card>
  );
}

function Stat(props: { label: string; value: string | null }) {
  const { t } = useTranslation();
  return (
    <View style={{ flex: 1, gap: 4 }} accessible accessibilityLabel={`${props.label}: ${props.value ?? t("brandMode.common.notEnoughData")}`}>
      <Text variant="caption" secondary accessibilityRole="none">{props.label}</Text>
      {props.value !== null ? <Text variant="quote" numeric accessibilityRole="none">{props.value}</Text> : <Text variant="callout" secondary accessibilityRole="none">{t("brandMode.common.notEnoughData")}</Text>}
    </View>
  );
}

function HealthChip(props: { label: string; value: string | null }) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  return (
    <View accessible accessibilityLabel={`${props.label}: ${props.value ?? t("brandMode.common.notEnoughData")}`} style={{ minHeight: 44, paddingHorizontal: 14, paddingVertical: 8, borderRadius: radius.md, backgroundColor: colors.fill, justifyContent: "center", gap: 2 }}>
      <Text variant="caption" secondary accessibilityRole="none">{props.label}</Text>
      <Text variant="callout" weight="600" numeric secondary={props.value === null} accessibilityRole="none">{props.value ?? t("brandMode.common.notEnoughData")}</Text>
    </View>
  );
}

function Thumb(props: { size: number }) {
  const { colors } = useTheme();
  return (
    <View style={{ width: props.size, height: props.size, borderRadius: radius.md, backgroundColor: colors.fill, alignItems: "center", justifyContent: "center" }}>
      <Icon name="shirt-outline" size={24} color="textSecondary" />
    </View>
  );
}

function Chip(props: { tone: "urgent" | "calm"; label: string; icon?: "time-outline" | undefined }) {
  const { colors } = useTheme();
  const urgent = props.tone === "urgent";
  return (
    <View style={{ alignSelf: "flex-start", flexDirection: "row", alignItems: "center", gap: 6, minHeight: 28, paddingHorizontal: 10, borderRadius: radius.pill, backgroundColor: urgent ? tint(colors.danger, "1F") : colors.fill }}>
      {props.icon !== undefined ? <Icon name={props.icon} size={14} color={urgent ? "danger" : "textSecondary"} /> : null}
      <Text variant="caption" weight="500" color={urgent ? "danger" : "textSecondary"} numeric accessibilityRole="none">{props.label}</Text>
    </View>
  );
}

/** Server-time countdown leaf: owns its own tick so the rest of the screen does not re-render every 15 s. */
function CountdownChip(props: { acceptByMs: number }) {
  const { t } = useTranslation();
  const { clock, locale } = useBrand();
  const now = useTick(15_000);
  const sla = slaCountdown(props.acceptByMs, serverNow(clock, now));
  const tone = countdownTone(sla.remainingMs);
  const n = (v: number) => localizeDigits(String(v), locale);
  const label = countdownLabel(sla);
  const text = label.kind === "closed" ? t("brandMode.dashboard.slaBreached")
    : label.kind === "minutes" ? t("brandMode.dashboard.acceptWithinMin", { minutes: n(label.minutes) })
    : t("brandMode.dashboard.acceptWithin", { hours: n(label.hours), minutes: n(label.minutes) });
  return <Chip tone={tone === "urgent" ? "urgent" : "calm"} icon="time-outline" label={text} />;
}

function ActionCard(props: { order: BrandOrder; price: string; buyer: string; canAccept: boolean; busy: boolean; onAccept: () => void; onReview: () => void }) {
  const { t } = useTranslation();
  const o = props.order;
  return (
    <Card variant="elevated" style={{ gap: 14 }} >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }} testID={`dashboard-order-${o.id}`}>
        <Thumb size={56} />
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <Text variant="body" weight="500" numberOfLines={1}>{o.lines[0]?.title ?? o.id}</Text>
          <Text variant="caption" secondary numberOfLines={1}>{props.buyer}</Text>
        </View>
        <Text variant="callout" weight="600" numeric>{props.price}</Text>
      </View>
      <CountdownChip acceptByMs={o.acceptByMs} />
      <View style={{ flexDirection: "row", gap: 10 }}>
        {props.canAccept ? <View style={{ flex: 1 }}><Button title={t("brandMode.dashboard.accept")} onPress={props.onAccept} loading={props.busy} testID={`dashboard-accept-${o.id}`} /></View> : null}
        <View style={{ flex: 1 }}><Button title={t("brandMode.dashboard.review")} variant="secondary" onPress={props.onReview} testID={`dashboard-review-${o.id}`} /></View>
      </View>
    </Card>
  );
}

function DashboardSkeleton() {
  const { t } = useTranslation();
  return (
    <View style={{ gap: GAP }} accessibilityLabel={t("common.loading")}>
      <View style={{ flexDirection: "row", gap: 10 }}>
        <Skeleton height={96} width="31%" /><Skeleton height={96} width="31%" /><Skeleton height={96} width="31%" />
      </View>
      <View style={{ gap: 12 }}>
        <Skeleton height={28} width="55%" />
        <Skeleton height={176} radius={radius.lg} /><Skeleton height={176} radius={radius.lg} />
      </View>
      <Skeleton height={140} radius={radius.lg} />
    </View>
  );
}
