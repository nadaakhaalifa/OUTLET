import { useCallback, useEffect, useMemo, useState } from "react";
import { View } from "react-native";
import { useTranslation } from "react-i18next";
import { spacing } from "@outlet/ui-tokens";
import { Banner, Button, Card, Divider, EmptyState, ErrorState, LoadingState, Screen, SwitchRow, Text, TextField } from "../../ui";
import { formatMoney, localizeDigits, type DisplayLocale } from "../money-display";
import { opt } from "../search/optional";
import { Chip } from "../search/Chip";
import { parseBudgetEgp } from "../search/model";
import {
  WISHLIST_INTENTS, buildList, replaceList, validateDraft, wishlistsFailureState,
  type NewWishlistDraft, type Wishlist, type WishlistIntent, type WishlistsPort, type WishlistsScreenState,
} from "./model";
import { getFeaturePorts } from "../../state/ports";

const HOUR = 3_600_000;

function ListCard(props: { list: Wishlist; port: WishlistsPort; nowMs: number; money: (m: bigint) => string; num: (n: number) => string; onChange: (l: Wishlist) => void; onError: () => void; onReload: () => void }) {
  const { t } = useTranslation();
  const v = buildList(props.list, props.nowMs);
  const l = props.list;
  const guard = async (f: () => Promise<void>) => {
    try {
      await f();
      props.onReload();
    } catch {
      props.onError();
    }
  };
  return (
    <Card>
      <Text variant="heading">{l.title}</Text>
      <Text variant="caption" secondary>{t(`wishlists.intent.${l.intent}`)}</Text>
      {l.recipientNickname !== null ? <Text variant="caption" secondary>{t("wishlists.recipient", { name: l.recipientNickname, occasion: l.occasion ?? "" })}</Text> : null}
      {l.targetDate !== null ? <Text variant="caption" secondary>{t("wishlists.targetDate", { date: l.targetDate })}</Text> : null}
      {v.budgetLeft !== null && l.budget !== null ? (
        <Text secondary>
          {v.budgetLeft >= 0n
            ? t("wishlists.budgetLeft", { left: props.money(v.budgetLeft), budget: props.money(l.budget) })
            : t("wishlists.budgetOver", { over: props.money(-v.budgetLeft), budget: props.money(l.budget) })}
        </Text>
      ) : null}
      {l.items.length === 0 ? <Text secondary>{t("wishlists.itemsEmpty")}</Text> : null}
      {v.items.map(({ item, action, priceMoved }) => (
        <View key={item.id} style={{ gap: spacing.xs }}>
          <Text>{item.title}</Text>
          {item.status === "delisted" ? (
            <>
              <Text variant="caption" secondary>{t("wishlists.delisted")}</Text>
              <Button variant="secondary" title={t("wishlists.findSimilar")} accessibilityLabel={t("wishlists.findSimilarName", { title: item.title })} onPress={() => undefined} />
            </>
          ) : (
            <>
              <Text variant="caption" secondary>
                {priceMoved === "same" || item.currentPrice === null
                  ? t("wishlists.priceSame", { amount: props.money(item.addedPrice) })
                  : t(priceMoved === "lower" ? "wishlists.priceLower" : "wishlists.priceHigher", { was: props.money(item.addedPrice), now: props.money(item.currentPrice) })}
              </Text>
              {action.kind === "buy" ? <Button title={t("wishlists.buy")} accessibilityLabel={t("wishlists.buyName", { title: item.title })} onPress={() => undefined} /> : null}
              {action.kind === "remindTomorrow" ? (
                <Button variant="secondary" title={t("wishlists.remindTomorrow")} accessibilityLabel={t("wishlists.remindTomorrowName", { title: item.title })} onPress={() => void guard(() => props.port.startCoolOff(l.id, item.id, props.nowMs))} />
              ) : null}
              {action.kind === "waiting" ? <Text variant="caption" secondary>{t("wishlists.coolOffWaiting", { hours: props.num(Math.max(1, Math.ceil(action.remainingMs / HOUR))) })}</Text> : null}
            </>
          )}
        </View>
      ))}
      <Divider />
      {v.canCoolOff ? (
        <>
          <SwitchRow label={t("wishlists.coolOff")} value={l.coolOffEnabled} onValueChange={(on) => void guard(() => props.port.setCoolOff(l.id, on))} />
          <Text variant="caption" secondary>{t("wishlists.coolOffHelp")}</Text>
        </>
      ) : null}
      {v.shareActive && l.share !== null ? (
        <>
          <Text variant="caption" secondary>{t("wishlists.shareActive")}</Text>
          <Text>{l.share.url}</Text>
          <Button variant="secondary" title={t("wishlists.shareRevoke")} accessibilityLabel={t("wishlists.shareRevokeName", { title: l.title })} onPress={() => void guard(() => props.port.revokeShare(l.id))} />
        </>
      ) : (
        <>
          <Text variant="caption" secondary>{t("wishlists.shareHelp")}</Text>
          <Button variant="secondary" title={t("wishlists.shareCreate")} accessibilityLabel={t("wishlists.shareCreateName", { title: l.title })} onPress={() => void guard(async () => { await props.port.createShare(l.id, null); })} />
        </>
      )}
    </Card>
  );
}

function NewListForm(props: { onCreate: (d: NewWishlistDraft) => Promise<void> }) {
  const { t } = useTranslation();
  const [intent, setIntent] = useState<WishlistIntent>("need");
  const [title, setTitle] = useState("");
  const [nickname, setNickname] = useState("");
  const [occasion, setOccasion] = useState("");
  const [budgetText, setBudgetText] = useState("");
  const [date, setDate] = useState("");
  const [errors, setErrors] = useState<readonly string[]>([]);
  const submit = async () => {
    const budget = budgetText.trim().length === 0 ? null : parseBudgetEgp(budgetText);
    const draft: NewWishlistDraft = {
      intent, title, targetDate: date.trim().length === 0 ? null : date.trim(),
      budget: budgetText.trim().length > 0 && budget === null ? 0n : budget,
      recipientNickname: intent === "gift" ? nickname : null, occasion: intent === "gift" ? occasion : null,
    };
    const e = validateDraft(draft);
    setErrors(e);
    if (e.length === 0) {
      await props.onCreate(draft);
      setTitle(""); setNickname(""); setOccasion(""); setBudgetText(""); setDate("");
    }
  };
  const err = (k: string) => (errors.includes(k) ? t(`wishlists.error.${k}`) : undefined);
  return (
    <Card>
      <Text variant="heading">{t("wishlists.newHeading")}</Text>
      <View accessibilityRole="radiogroup" accessibilityLabel={t("wishlists.intentPicker")} style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.sm }}>
        {WISHLIST_INTENTS.map((i) => (
          <Chip key={i} role="radio" label={t(`wishlists.intent.${i}`)} selected={i === intent} onPress={() => setIntent(i)} />
        ))}
      </View>
      <TextField label={t("wishlists.titleLabel")} value={title} onChangeText={setTitle} {...opt("error", err("titleRequired") ?? err("titleTooLong"))} />
      {intent === "gift" ? (
        <>
          <TextField label={t("wishlists.nicknameLabel")} value={nickname} onChangeText={setNickname} {...opt("error", err("nicknameRequired"))} />
          <TextField label={t("wishlists.occasionLabel")} value={occasion} onChangeText={setOccasion} {...opt("error", err("occasionRequired"))} />
        </>
      ) : null}
      <TextField label={t("wishlists.budgetLabel")} value={budgetText} onChangeText={setBudgetText} keyboardType="numeric" {...opt("error", err("budgetInvalid"))} />
      <TextField label={t("wishlists.dateLabel")} helper={t("wishlists.dateHelper")} value={date} onChangeText={setDate} {...opt("error", err("dateInvalid"))} />
      <Button title={t("wishlists.create")} onPress={() => void submit()} />
    </Card>
  );
}

export function WishlistsScreen(props: { port?: WishlistsPort; now?: () => number }) {
  const { t, i18n } = useTranslation();
  const locale: DisplayLocale = i18n.language === "en" ? "en" : "ar";
  const port = useMemo<WishlistsPort>(() => props.port ?? getFeaturePorts().wishlists, [props.port]);
  const [state, setState] = useState<WishlistsScreenState>({ status: "loading" });
  const [actionFailed, setActionFailed] = useState(false);
  const currency = t("common.currency");
  const money = (m: bigint) => formatMoney(m, locale, currency);
  const num = (n: number) => localizeDigits(String(n), locale);

  const load = useCallback(async (silent = false) => {
    if (!silent) setState({ status: "loading" });
    try {
      setState({ status: "ready", lists: await port.list() });
    } catch (e) {
      setState(wishlistsFailureState(e));
    }
  }, [port]);
  useEffect(() => { void load(); }, [load]);

  const create = async (d: NewWishlistDraft) => {
    setActionFailed(false);
    try {
      await port.create(d);
      await load(true);
    } catch {
      setActionFailed(true);
    }
  };

  const nowMs = (props.now ?? Date.now)();
  return (
    <Screen>
      <Text variant="title">{t("wishlists.title")}</Text>
      {state.status === "loading" ? <LoadingState label={t("wishlists.loading")} /> : null}
      {state.status === "error" ? (
        <ErrorState
          offline={state.offline}
          title={t(state.offline ? "wishlists.offlineTitle" : "wishlists.errorTitle")}
          description={t(state.offline ? "wishlists.offlineBody" : "wishlists.errorBody")}
          retryTitle={t("common.retry")}
          onRetry={() => void load()}
        />
      ) : null}
      {actionFailed ? <Banner tone="error" message={t("wishlists.actionFailed")} /> : null}
      {state.status === "ready" ? (
        <>
          {state.lists.length === 0 ? <EmptyState title={t("wishlists.emptyTitle")} description={t("wishlists.emptyBody")} /> : null}
          {state.lists.map((l) => (
            <ListCard
              key={l.id}
              list={l}
              port={port}
              nowMs={nowMs}
              money={money}
              num={num}
              onChange={(n) => setState({ status: "ready", lists: replaceList(state.lists, n) })}
              onError={() => setActionFailed(true)}
              onReload={() => { setActionFailed(false); void load(true); }}
            />
          ))}
          <NewListForm onCreate={create} />
        </>
      ) : null}
      {typeof __DEV__ !== "undefined" && __DEV__ ? <Banner tone="info" message={t("common.devFixtureBackend")} /> : null}
    </Screen>
  );
}
