import { useCallback, useEffect, useMemo, useState } from "react";
import { View } from "react-native";
import { useTranslation } from "react-i18next";
import { useRouter } from "expo-router";
import { Illustration } from "../../art";
import { Banner, Button, Card, Divider, EmptyState, ErrorState, Eyebrow, Reveal, Screen, Skeleton, Text } from "../../ui";
import { formatMoney, type DisplayLocale } from "../money-display";
import { formatCairoDate } from "../plus/model";
import {
  EMPTY_TRANSACTIONS, PortError, appendPage, buildWallet, canLoadMore, walletFailureState,
  type TransactionsState, type WalletPort, type WalletScreenState,
} from "./model";
import { getFeaturePorts } from "../../state/ports";

/** Read only by design: this screen has no top-up, withdraw or transfer control (see model.ts). */
export function WalletScreen(props: { port?: WalletPort }) {
  const { t, i18n } = useTranslation();
  const router = useRouter();
  const locale: DisplayLocale = i18n.language === "en" ? "en" : "ar";
  const port = useMemo<WalletPort>(() => props.port ?? getFeaturePorts().wallet, [props.port]);
  const [state, setState] = useState<WalletScreenState>({ status: "loading" });
  const [txs, setTxs] = useState<TransactionsState>(EMPTY_TRANSACTIONS);
  const [txLoading, setTxLoading] = useState(false);
  const [txError, setTxError] = useState<"offline" | "failed" | null>(null);
  const currency = t("common.currency");
  const money = (m: bigint) => formatMoney(m, locale, currency);
  const signed = (m: bigint) => (m < 0n ? `-${money(-m)}` : `+${money(m)}`);
  const date = (ms: number) => formatCairoDate(ms, locale);

  const loadTx = useCallback(async (cursor: string | null) => {
    setTxLoading(true);
    setTxError(null);
    try {
      const page = await port.transactions(cursor);
      setTxs((s) => appendPage(cursor === null ? EMPTY_TRANSACTIONS : s, page));
    } catch (e) {
      setTxError(e instanceof PortError && e.kind === "offline" ? "offline" : "failed");
    } finally {
      setTxLoading(false);
    }
  }, [port]);

  const load = useCallback(async () => {
    setState({ status: "loading" });
    try {
      setState({ status: "ready", snapshot: await port.load() });
      void loadTx(null);
    } catch (e) {
      setState(walletFailureState(e));
    }
  }, [port, loadTx]);
  useEffect(() => { void load(); }, [load]);

  const view = state.status === "ready" ? buildWallet(state.snapshot) : null;
  return (
    <Screen title={t("wallet.title")} onBack={() => router.back()} backLabel={t("common.back")}>
      {state.status === "loading" ? (
        <View accessibilityRole="progressbar" accessibilityLabel={t("wallet.loading")} style={{ gap: 16 }}>
          <Skeleton width={90} height={12} />
          <Skeleton width="70%" height={56} />
          <Skeleton height={56} />
          <Skeleton height={56} />
        </View>
      ) : null}
      {state.status === "error" ? (
        <ErrorState
          offline={state.offline}
          title={t(state.offline ? "wallet.offlineTitle" : "wallet.errorTitle")}
          description={t(state.offline ? "wallet.offlineBody" : "wallet.errorBody")}
          retryTitle={t("common.retry")}
          onRetry={() => void load()}
        />
      ) : null}
      {view !== null && view.isEmpty ? (
        <EmptyState illustration={<Illustration name="emptyWallet" size={120} />} title={t("wallet.emptyTitle")} description={t("wallet.emptyBody")} />
      ) : null}
      {view !== null && !view.isEmpty ? (
        <>
          <Reveal index={0}>
            <Card variant="elevated" style={{ gap: 6 }}>
              <Eyebrow>{t("wallet.totalLabel")}</Eyebrow>
              <Text variant="hero" numeric accessibilityRole="header">{money(view.total)}</Text>
              <Text variant="callout" secondary>{t("wallet.useNote")}</Text>
            </Card>
          </Reveal>
          {view.expiringSoon.length > 0 ? (
            <Reveal index={1}><View style={{ gap: 8 }}>
              <Eyebrow color="danger" secondary={false}>{t("wallet.expiringHeading")}</Eyebrow>
              {view.expiringSoon.map((l) => (
                <Text key={l.id} variant="callout">
                  {t("wallet.expiringLine", { amount: money(l.remaining), kind: t(`wallet.sub.${l.kind}`), date: l.expiresAt === null ? "" : date(l.expiresAt) })}
                </Text>
              ))}
            </View></Reveal>
          ) : null}
          <Reveal index={2}><View>
            <Eyebrow>{t("wallet.balancesHeading")}</Eyebrow>
            <View style={{ height: 8 }} />
            <Divider />
            {view.subs.map((b) => (
              <View key={b.kind}>
                <View style={{ flexDirection: "row", alignItems: "center", paddingVertical: 14, gap: 12 }}>
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text accessibilityRole="none">{t(`wallet.sub.${b.kind}`)}</Text>
                    <Text variant="caption" secondary accessibilityRole="none">
                      {b.neverExpires ? t("wallet.neverExpires") : t("wallet.nextExpiry", { date: b.nextExpiry === null ? "" : date(b.nextExpiry) })}
                    </Text>
                  </View>
                  <Text variant="headline" numeric accessibilityRole="none">{money(b.amount)}</Text>
                </View>
                <Divider />
              </View>
            ))}
          </View></Reveal>
          <Reveal index={3}><View>
            <Eyebrow>{t("wallet.txHeading")}</Eyebrow>
            <View style={{ height: 8 }} />
            <Divider />
            {txs.loaded && txs.items.length === 0 ? <Text secondary style={{ paddingVertical: 14 }}>{t("wallet.txEmpty")}</Text> : null}
            {txs.items.map((x) => (
              <View key={x.id}>
                <View style={{ flexDirection: "row", alignItems: "center", paddingVertical: 14, gap: 12 }} accessible accessibilityLabel={t("wallet.txLine", { kind: t(`wallet.tx.${x.kind}`), amount: signed(x.amount) })}>
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text accessibilityRole="none">{t(`wallet.tx.${x.kind}`)}</Text>
                    <Text variant="caption" secondary accessibilityRole="none">{t("wallet.txMeta", { sub: t(`wallet.sub.${x.sub}`), date: date(x.at) })}</Text>
                  </View>
                  <Text numeric color={x.amount < 0n ? "textPrimary" : "savings"} accessibilityRole="none">{signed(x.amount)}</Text>
                </View>
                <Divider />
              </View>
            ))}
            {txLoading ? (
              <View accessibilityRole="progressbar" accessibilityLabel={t("wallet.txLoading")} style={{ gap: 12, paddingVertical: 14 }}>
                <Skeleton height={20} />
                <Skeleton width="75%" height={20} />
              </View>
            ) : null}
            {txError !== null ? <Banner tone="error" message={t(txError === "offline" ? "wallet.txOffline" : "wallet.txError")} /> : null}
            {canLoadMore(txs) || txError !== null ? (
              <View style={{ paddingTop: 16 }}>
                <Button
                  variant="secondary"
                  title={t(txError !== null ? "common.retry" : "wallet.loadMore")}
                  disabled={txLoading}
                  onPress={() => void loadTx(txError !== null && !txs.loaded ? null : txs.nextCursor)}
                />
              </View>
            ) : null}
          </View></Reveal>
        </>
      ) : null}
    </Screen>
  );
}
