/** Shared brand-mode glue: session context, async loading with an offline cache, and small presentational pieces. */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { View } from "react-native";
import Animated, { Easing, useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { useTranslation } from "react-i18next";
import { Banner, Button, Card, EmptyState, ErrorState, Eyebrow, Reveal, Skeleton, Text, useTheme } from "../../ui";
import { formatMoney, type DisplayLocale } from "../money-display";
import { afterFailure, failureOf, serverClock, type BrandAccount, type BrandFailure, type BrandPort, type LoadState, type ServerClock } from "./model";
import { getBrandPort } from "./state";

export interface BrandSession {
  readonly port: BrandPort;
  readonly account: BrandAccount;
  readonly clock: ServerClock;
  /** Call with the server's `now` when a payload arrives; countdowns then use server time. */
  readonly syncClock: (serverNowMs: number) => void;
  readonly locale: DisplayLocale;
}
const Ctx = createContext<BrandSession | null>(null);
export function useBrand(): BrandSession {
  const v = useContext(Ctx);
  if (v === null) throw new Error("useBrand outside BrandSessionProvider");
  return v;
}

/** Last good values survive tab switches and offline refreshes (memory only; cleared with the app process). */
const cache = new Map<string, unknown>();
let lastPort: BrandPort | null = null;
export function clearBrandCache(): void { cache.clear(); }

export function useLoad<T>(key: string, loader: () => Promise<T>): { state: LoadState<T>; reload: () => void; reloading: boolean } {
  const [state, setState] = useState<LoadState<T>>(() => (cache.has(key) ? { status: "ready", data: cache.get(key) as T, stale: true } : { status: "loading" }));
  const [reloading, setReloading] = useState(false);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;
  const run = useCallback(async (silent: boolean) => {
    if (silent) setReloading(true);
    try {
      const data = await loaderRef.current();
      cache.set(key, data);
      setState({ status: "ready", data, stale: false });
    } catch (e) {
      setState((prev) => afterFailure(prev, failureOf(e)));
    } finally {
      setReloading(false);
    }
  }, [key]);
  useEffect(() => { void run(false); }, [run]);
  return { state, reload: () => { void run(true); }, reloading };
}

export function BrandSessionProvider(props: { children: ReactNode }) {
  const { i18n } = useTranslation();
  const locale: DisplayLocale = i18n.language === "en" ? "en" : "ar";
  const port = useMemo(() => {
    const p = getBrandPort();
    if (p !== lastPort) { cache.clear(); lastPort = p; } // a different brand (e.g. the dev demo brand) must not see the previous one's cached lists
    return p;
  }, []);
  const [account, setAccount] = useState<BrandAccount | null>(null);
  const [failure, setFailure] = useState<BrandFailure | null>(null);
  const [clock, setClock] = useState<ServerClock>({ offsetMs: 0 });
  const load = useCallback(() => {
    setFailure(null);
    port.account().then(setAccount, (e: unknown) => { setFailure(failureOf(e)); });
  }, [port]);
  useEffect(load, [load]);
  const syncClock = useCallback((serverNowMs: number) => { setClock(serverClock(serverNowMs, Date.now())); }, []);
  if (account === null) return <SessionGate failure={failure} onRetry={load} />;
  return <Ctx.Provider value={{ port, account, clock, syncClock, locale }}>{props.children}</Ctx.Provider>;
}

function SessionGate(props: { failure: BrandFailure | null; onRetry: () => void }) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  if (props.failure === null) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.background, padding: 20, paddingTop: 96, gap: 16 }}>
        <Skeleton height={36} width="60%" /><Skeleton height={120} /><Skeleton height={120} />
      </View>
    );
  }
  return (
    <View style={{ flex: 1, backgroundColor: colors.background, justifyContent: "center", padding: 20 }}>
      {props.failure === "forbidden" ? (
        <EmptyState title={t("brandMode.common.noBrandTitle")} description={t("brandMode.common.noBrandBody")} />
      ) : (
        <ErrorState offline={props.failure === "offline"} title={t(props.failure === "offline" ? "brandMode.common.offlineTitle" : "brandMode.common.errorTitle")}
          description={t(props.failure === "offline" ? "brandMode.common.offlineBody" : "brandMode.common.errorBody")} retryTitle={t("brandMode.common.retry")} onRetry={props.onRetry} />
      )}
    </View>
  );
}

export function useMoney(): (minor: bigint) => string {
  const { t } = useTranslation();
  const { locale } = useBrand();
  const cur = t("brandMode.common.egp");
  return useCallback((m: bigint) => formatMoney(m, locale, cur), [locale, cur]);
}

/** Error body for every tab: offline, expired session (re-auth), forbidden role, unsupported-in-app, generic. */
export function FailureView(props: { failure: BrandFailure; onRetry: () => void; onReauth?: (() => void) | undefined; onOpenSellerCenter?: (() => void) | undefined }) {
  const { t } = useTranslation();
  const f = props.failure;
  if (f === "session_expired") {
    return <EmptyState title={t("brandMode.common.sessionTitle")} description={t("brandMode.common.sessionBody")} actionTitle={t("brandMode.common.sessionAction")} onAction={props.onReauth ?? props.onRetry} />;
  }
  if (f === "forbidden") return <EmptyState title={t("brandMode.common.forbiddenTitle")} description={t("brandMode.common.forbiddenBody")} />;
  if (f === "unsupported") {
    return <EmptyState title={t("brandMode.common.unsupportedTitle")} description={t("brandMode.common.unsupportedBody")} actionTitle={props.onOpenSellerCenter ? t("brandMode.common.openSellerCenter") : undefined} onAction={props.onOpenSellerCenter} />;
  }
  const offline = f === "offline";
  return (
    <ErrorState offline={offline} title={t(offline ? "brandMode.common.offlineTitle" : "brandMode.common.errorTitle")}
      description={t(offline ? "brandMode.common.offlineBody" : f === "conflict" ? "brandMode.common.conflictBody" : "brandMode.common.errorBody")}
      retryTitle={t("brandMode.common.retry")} onRetry={props.onRetry} />
  );
}

export function StaleBanner(props: { visible: boolean }) {
  const { t } = useTranslation();
  return props.visible ? <Banner tone="info" message={t("brandMode.common.staleNotice")} /> : null;
}

/** Kept for call-site compatibility: renders nothing. The development note lives in the DevBadge sheet. */
export function DevBanner() {
  return null;
}

/** A labelled figure in serif numerals. `null` renders "Not enough data" with the hint, never a zero. */
export function Figure(props: { label: string; value: string | null; hint?: string | undefined; size?: "xl" | "lg" | "md" }) {
  const { t } = useTranslation();
  const variant = props.size === "xl" ? "display" : props.size === "md" ? "quote" : "title1";
  return (
    <View style={{ flex: 1, gap: 4 }} accessible accessibilityLabel={`${props.label}: ${props.value ?? t("brandMode.common.notEnoughData")}`}>
      <Eyebrow secondary>{props.label}</Eyebrow>
      {props.value !== null ? (
        <Text variant={variant} numeric accessibilityRole="none">{props.value}</Text>
      ) : (
        <Text variant="callout" secondary accessibilityRole="none">{t("brandMode.common.notEnoughData")}</Text>
      )}
      {props.hint !== undefined ? <Text variant="caption" secondary accessibilityRole="none">{props.hint}</Text> : null}
    </View>
  );
}

export function Hairline() {
  const { colors } = useTheme();
  return <View style={{ height: 1, backgroundColor: colors.hairline }} />;
}

/** Slim progress rule that glides to its value (upload progress, SLA). Transform only; Reduce Motion jumps. */
export function ProgressRule(props: { ratio: number; height?: number; tone?: "ink" | "onImage" }) {
  const { colors, isRTL, reduceMotion } = useTheme();
  const h = props.height ?? 4;
  const r = Math.min(1, Math.max(0, props.ratio));
  const width = useSharedValue(0);
  const p = useSharedValue(reduceMotion ? r : 0);
  useEffect(() => {
    p.value = reduceMotion ? r : withTiming(r, { duration: 320, easing: Easing.bezier(0.22, 1, 0.36, 1) });
  }, [r, reduceMotion, p]);
  const sign = isRTL ? 1 : -1;
  const fill = useAnimatedStyle(() => ({ transform: [{ translateX: sign * (1 - p.value) * width.value }] }));
  const onImage = props.tone === "onImage";
  return (
    <View
      onLayout={(e) => { width.value = e.nativeEvent.layout.width; }}
      style={{ height: h, borderRadius: h, overflow: "hidden", backgroundColor: onImage ? colors.glassTint : colors.fill }}
    >
      <Animated.View style={[{ height: h, width: "100%", borderRadius: h, backgroundColor: onImage ? colors.onImage : colors.brand }, fill]} />
    </View>
  );
}

export function Block(props: { eyebrow: string; children: ReactNode; index?: number | undefined; action?: { label: string; onPress: () => void } | undefined }) {
  return (
    <Reveal index={props.index ?? 0}>
      <Card variant="elevated" style={{ gap: 14 }}>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
          <Text variant="headline" weight="600" accessibilityRole="header">{props.eyebrow}</Text>
          {props.action !== undefined ? <Button title={props.action.label} variant="ghost" fullWidth={false} onPress={props.action.onPress} /> : null}
        </View>
        {props.children}
      </Card>
    </Reveal>
  );
}
