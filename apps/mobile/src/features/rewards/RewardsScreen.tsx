import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { View } from "react-native";
import { useRouter } from "expo-router";
import { useTranslation } from "react-i18next";
import { Illustration } from "../../art";
import { Banner, Button, Divider, EmptyState, ErrorState, Eyebrow, Reveal, Screen, Skeleton, Text } from "../../ui";
import { Section } from "../account-ui";
import { formatMoney, localizeDigits, type DisplayLocale } from "../money-display";
import {
  canConvert, gameViews, percentText, rewardsFailureState, sortedExpiring,
  type GameInfo, type OddsRow, type PlayOutcome, type RewardsPort, type RewardsScreenState,
} from "./model";
import { getFeaturePorts } from "../../state/ports";

export function RewardsScreen(props: { port?: RewardsPort; newKey?: () => string }) {
  const { t, i18n } = useTranslation();
  const router = useRouter();
  const locale: DisplayLocale = i18n.language === "en" ? "en" : "ar";
  const port = useMemo<RewardsPort>(() => props.port ?? getFeaturePorts().rewards, [props.port]);
  const counter = useRef(0);
  const newKey = props.newKey ?? (() => `rw-${Date.now()}-${(counter.current += 1)}`);
  const currency = t("common.currency");
  const money = (m: bigint) => formatMoney(m, locale, currency);
  const num = (n: number) => localizeDigits(String(n), locale);
  const dateOf = (ms: number) => new Intl.DateTimeFormat(locale === "ar" ? "ar-EG" : "en-GB", { dateStyle: "medium", timeZone: "Africa/Cairo" }).format(new Date(ms));
  const dateTimeOf = (ms: number) => new Intl.DateTimeFormat(locale === "ar" ? "ar-EG" : "en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "Africa/Cairo" }).format(new Date(ms));

  const [state, setState] = useState<RewardsScreenState>({ status: "loading" });
  const [msg, setMsg] = useState<"converted" | "convertFailed" | "playFailed" | null>(null);
  const [outcome, setOutcome] = useState<PlayOutcome | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);

  const load = useCallback(async () => {
    setState({ status: "loading" });
    try {
      setState({ status: "ready", snapshot: await port.load() });
    } catch (e) {
      setState(rewardsFailureState(e));
    }
  }, [port]);
  useEffect(() => { void load(); }, [load]);

  const convert = async (count: number) => {
    setMsg(null);
    try {
      await port.convert(count, newKey());
      setMsg("converted");
      setState({ status: "ready", snapshot: await port.load() });
    } catch {
      setMsg("convertFailed");
    }
  };

  const play = async (g: GameInfo) => {
    setMsg(null);
    setOutcome(null);
    setPlaying(g.game);
    try {
      setOutcome(await port.play(g.game, g.oddsVersion, newKey()));
      setState({ status: "ready", snapshot: await port.load() });
    } catch {
      setMsg("playFailed");
    } finally {
      setPlaying(null);
    }
  };

  const prize = (o: OddsRow) =>
    o.kind === "coins" ? t("rewards.oddsPrizeCoins", { count: num(o.coins) }) : o.kind === "voucher" ? t("rewards.oddsPrizeVoucher") : t("rewards.oddsPrizeNothing");

  const s = state.status === "ready" ? state.snapshot : null;
  const games = s !== null ? gameViews(s) : [];
  const expiring = s !== null ? sortedExpiring(s.expiring) : [];

  return (
    <Screen title={t("rewards.title")} onBack={() => router.back()} backLabel={t("common.back")}>
      {state.status === "loading" ? (
        <View accessibilityRole="progressbar" accessibilityLabel={t("rewards.loading")} style={{ gap: 16 }}>
          <Skeleton width={110} height={12} />
          <Skeleton width="50%" height={56} />
          <Skeleton height={44} radius={14} />
        </View>
      ) : null}
      {state.status === "error" ? (
        <ErrorState
          offline={state.offline}
          title={t(state.offline ? "rewards.offlineTitle" : "rewards.errorTitle")}
          description={t(state.offline ? "rewards.offlineBody" : "rewards.errorBody")}
          retryTitle={t("common.retry")}
          onRetry={() => void load()}
        />
      ) : null}
      {s !== null && s.coinBalance === 0 && expiring.length === 0 ? <EmptyState illustration={<Illustration name="success" size={96} />} title={t("rewards.emptyTitle")} description={t("rewards.emptyBody")} /> : null}
      {s !== null ? (
        <>
          <Reveal index={0}><View style={{ gap: 8, paddingVertical: 8 }}>
            <Eyebrow>{t("rewards.coinsLabel")}</Eyebrow>
            <Text variant="hero" numeric accessibilityRole="header">{num(s.coinBalance)}</Text>
            <Text variant="caption" secondary>{t("rewards.convertNote", { amount: money(s.coinValue) })}</Text>
            {canConvert(s) ? (
              <Button
                variant="brand"
                title={t("rewards.convert")}
                accessibilityLabel={t("rewards.convertName", { count: num(s.coinBalance) })}
                onPress={() => void convert(s.coinBalance)}
              />
            ) : null}
            {msg === "converted" ? <Banner tone="info" message={t("rewards.converted")} /> : null}
            {msg === "convertFailed" ? <Banner tone="error" message={t("rewards.convertFailed")} /> : null}
            <Divider />
            <Eyebrow>{t("rewards.expiringHeading")}</Eyebrow>
            {expiring.length === 0 ? <Text secondary>{t("rewards.noExpiring")}</Text> : null}
            {expiring.map((e) => (
              <Text key={e.expiresAtMs}>{t("rewards.expiringLine", { count: num(e.count), date: dateOf(e.expiresAtMs) })}</Text>
            ))}
          </View></Reveal>

          <Section title={t("rewards.tierHeading")}>
            <Text variant="title2" weight="600">{t("rewards.tierCurrent", { tier: t(`rewards.tier.${s.tier.tier}`) })}</Text>
            <Text secondary>
              {s.tier.nextTier !== null && s.tier.remainingToNext !== null
                ? t("rewards.tierProgress", { amount: money(s.tier.remainingToNext), tier: t(`rewards.tier.${s.tier.nextTier}`) })
                : t("rewards.tierTop")}
            </Text>
            <Text variant="caption" secondary>{t("rewards.tierNote")}</Text>
          </Section>

          {games.length > 0 ? (
            <Section title={t("rewards.gamesHeading")}>
              <Text variant="caption" secondary>{t("rewards.gameFree")}</Text>
              {games.map((g) => {
                if (g.kind === "hidden") return null;
                const name = t(`rewards.game.${g.info.game}`);
                return (
                  <View key={g.info.game} style={{ gap: 6 }}>
                    <Text variant="headline">{name}</Text>
                    <Text variant="caption" secondary>{t("rewards.oddsHeading", { version: g.info.oddsVersion })}</Text>
                    {g.info.odds.map((o, i) => (
                      <Text key={i}>{t("rewards.oddsLine", { prize: prize(o), percent: localizeDigits(percentText(o.basisPoints), locale) })}</Text>
                    ))}
                    {g.kind === "playable" ? (
                      <Button
                        title={t(playing === g.info.game ? "rewards.playing" : "rewards.play")}
                        accessibilityLabel={t("rewards.playName", { game: name })}
                        loading={playing === g.info.game}
                        disabled={playing !== null}
                        onPress={() => void play(g.info)}
                      />
                    ) : (
                      <Text secondary>{g.nextAtMs !== null ? t("rewards.nextPlay", { date: dateTimeOf(g.nextAtMs) }) : t("rewards.unavailable")}</Text>
                    )}
                  </View>
                );
              })}
              {outcome !== null ? (
                <Banner
                  tone="info"
                  message={
                    outcome.kind === "nothing"
                      ? t("rewards.playNothing")
                      : t("rewards.playWon", { prize: outcome.kind === "coins" ? t("rewards.oddsPrizeCoins", { count: num(outcome.coins) }) : t("rewards.oddsPrizeVoucher") })
                  }
                />
              ) : null}
              {msg === "playFailed" ? <Banner tone="error" message={t("rewards.playFailed")} /> : null}
            </Section>
          ) : null}
        </>
      ) : null}
    </Screen>
  );
}
