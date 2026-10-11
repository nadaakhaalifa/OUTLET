import { useCallback, useEffect, useMemo, useState } from "react";
import { View } from "react-native";
import { useTranslation } from "react-i18next";
import { spacing } from "@outlet/ui-tokens";
import { Banner, Button, Card, Divider, EmptyState, ErrorState, LoadingState, Screen, Text } from "../../ui";
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
    <Screen>
      <Text variant="title">{t("wallet.title")}</Text>
      {state.status === "loading" ? <LoadingState label={t("wallet.loading")} /> : null}
      {state.status === "error" ? (
        <ErrorState
          offline={state.offline}
          title={t(state.offline ? "wallet.offlineTitle" : "wallet.errorTitle")}
          description={t(state.offline ? "wallet.offlineBody" : "wallet.errorBody")}
          retryTitle={t("common.retry")}
          onRetry={() => void load()}
        />
      ) : null}
      {view !== null && view.isEmpty ? <EmptyState title={t("wallet.emptyTitle")} description={t("wallet.emptyBody")} /> : null}
      {view !== null && !view.isEmpty ? (
        <>
          <Card>
            <Text secondary>{t("wallet.totalLabel")}</Text>
            <Text variant="title" accessibilityRole="header">{money(view.total)}</Text>
            <Text variant="caption" secondary>{t("wallet.useNote")}</Text>
          </Card>
          {view.expiringSoon.length > 0 ? (
            <Card>
              <Text variant="heading">{t("wallet.expiringHeading")}</Text>
              {view.expiringSoon.map((l) => (
                <Banner
                  key={l.id}
                  tone="warning"
                  message={t("wallet.expiringLine", { amount: money(l.remaining), kind: t(`wallet.sub.${l.kind}`), date: l.expiresAt === null ? "" : date(l.expiresAt) })}
                />
              ))}
            </Card>
          ) : null}
          <Card>
            <Text variant="heading">{t("wallet.balancesHeading")}</Text>
            {view.subs.map((b) => (
              <View key={b.kind} style={{ gap: spacing.xs }}>
                <Text>{t("wallet.subLine", { kind: t(`wallet.sub.${b.kind}`), amount: money(b.amount) })}</Text>
                <Text variant="caption" secondary>
                  {b.neverExpires ? t("wallet.neverExpires") : t("wallet.nextExpiry", { date: b.nextExpiry === null ? "" : date(b.nextExpiry) })}
                </Text>
              </View>
            ))}
          </Card>
          <Card>
            <Text variant="heading">{t("wallet.txHeading")}</Text>
            {txs.loaded && txs.items.length === 0 ? <Text secondary>{t("wallet.txEmpty")}</Text> : null}
            {txs.items.map((x) => (
              <View key={x.id} style={{ gap: spacing.xs }}>
                <Text>{t("wallet.txLine", { kind: t(`wallet.tx.${x.kind}`), amount: signed(x.amount) })}</Text>
                <Text variant="caption" secondary>{t("wallet.txMeta", { sub: t(`wallet.sub.${x.sub}`), date: date(x.at) })}</Text>
                <Divider />
              </View>
            ))}
            {txLoading ? <LoadingState label={t("wallet.txLoading")} /> : null}
            {txError !== null ? <Banner tone="error" message={t(txError === "offline" ? "wallet.txOffline" : "wallet.txError")} /> : null}
            {canLoadMore(txs) || txError !== null ? (
              <Button
                variant="secondary"
                title={t(txError !== null ? "common.retry" : "wallet.loadMore")}
                disabled={txLoading}
                onPress={() => void loadTx(txError !== null && !txs.loaded ? null : txs.nextCursor)}
              />
            ) : null}
          </Card>
        </>
      ) : null}
      {typeof __DEV__ !== "undefined" && __DEV__ ? <Banner tone="info" message={t("common.devFixtureBackend")} /> : null}
    </Screen>
  );
}
