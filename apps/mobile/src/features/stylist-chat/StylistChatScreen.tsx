import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { View } from "react-native";
import { useTranslation } from "react-i18next";
import { radius, spacing } from "@outlet/ui-tokens";
import { Banner, Button, Card, Chip, Divider, Eyebrow, Icon, ListRow, PressScale, Reveal, Screen, Skeleton, StickyBar, SwitchRow, Text, TextField, useTheme } from "../../ui";
import { OfflineBanner, StateScreen } from "../../components/states";
import { getFeaturePorts } from "../../state/ports";
import { reasonOf, type AiFailureReason } from "../ai-failure";
import { formatMoney, type DisplayLocale } from "../money-display";
import { addOutcome, type AddOutcome, type OutfitBagPort } from "../stylist/model";
import {
  actionForOption, appendMessages, checkInput, chatOutfitView, eraseAll, failureView, historyStep, optionLabel, quotaHint, sortSessions, turnToMessage,
  type ChatAction, type ChatBlock, type ChatLang, type ChatMessage, type ChatOption, type ChatOutfit, type ChatPort, type ChatSession, type ChipTopic,
} from "./model";

type Money = (minor: bigint) => string;

const STARTERS = ["wedding", "work", "date", "eid"] as const;

function dayLabel(ms: number, lang: ChatLang): string {
  try {
    return new Date(ms).toLocaleDateString(lang === "en" ? "en-GB" : "ar-EG", { day: "numeric", month: "short" });
  } catch {
    return new Date(ms).toISOString().slice(0, 10);
  }
}

function FailureStrip(props: { reason: AiFailureReason; onRetry?: (() => void) | undefined; onStructured?: (() => void) | undefined }) {
  const { t } = useTranslation();
  const v = failureView(props.reason);
  return (
    <View style={{ gap: spacing.sm }}>
      <Banner tone={v.tone} message={t(`aiFailure.${props.reason}`)} />
      <View style={{ flexDirection: "row", gap: spacing.md, flexWrap: "wrap" }}>
        {v.retry && props.onRetry !== undefined ? <Button title={t("common.retry")} variant="secondary" fullWidth={false} onPress={props.onRetry} /> : null}
        {v.offerStructured && props.onStructured !== undefined ? <Button title={t("stylistChat.useStructured")} variant="secondary" fullWidth={false} onPress={props.onStructured} /> : null}
      </View>
    </View>
  );
}

function OutfitBlockCard(props: {
  n: number;
  o: ChatOutfit;
  money: Money;
  busy: boolean;
  outcome: AddOutcome | null;
  onAdd: () => void;
}) {
  const { t } = useTranslation();
  const v = chatOutfitView(props.o);
  return (
    <Card variant="elevated" style={{ gap: spacing.sm }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "baseline" }}>
        <Eyebrow>{t("stylist.outfitHeading", { n: props.n })}</Eyebrow>
        <Text variant="title2" numeric>{props.money(v.total)}</Text>
      </View>
      {props.o.outfit.items.map((i) => {
        const live = props.o.live[i.skuId];
        const gone = live !== undefined && !live.available;
        return (
          <View key={i.skuId} style={{ flexDirection: "row", justifyContent: "space-between", gap: spacing.md, opacity: gone ? 0.5 : 1 }}>
            <Text variant="callout" style={{ flex: 1 }}>{i.title !== "" ? i.title : t(`stylist.slotName.${i.slot}`)}</Text>
            <Text variant="callout" numeric>{gone ? t("stylistChat.unavailable") : props.money(live?.currentPrice ?? i.unitPrice)}</Text>
          </View>
        );
      })}
      {v.changed.length > 0 ? <Text variant="caption" secondary>{t("stylistChat.priceChanged")}</Text> : null}
      {!props.o.complete
        ? props.o.outfit.missing.map((m) => (
            <Text key={m.slot} variant="caption" secondary>{t("stylist.partialMissing", { amount: props.money(m.shortfall), slot: t(`stylist.slot.${m.slot}`) })}</Text>
          ))
        : null}
      {props.outcome?.kind === "added" ? <Banner tone="success" message={t("stylist.added")} /> : null}
      {props.outcome !== null && props.outcome.kind !== "added" ? (
        <Banner tone="warning" message={t(props.outcome.kind === "partial" ? "stylist.addedPartial" : "stylist.addFailed")} />
      ) : null}
      {/* Add to bag is always an explicit tap, through the same outfit flow as the structured stylist. */}
      <Button
        title={t(props.busy ? "stylist.adding" : "stylist.addAll")}
        variant="secondary"
        loading={props.busy}
        disabled={props.busy || !v.addable}
        onPress={props.onAdd}
      />
    </Card>
  );
}

function OptionRow(props: { options: readonly ChatOption[]; lang: ChatLang; disabled: boolean; onPick: (o: ChatOption) => void }) {
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.sm }}>
      {props.options.map((o) => (
        <Chip key={o.id} label={optionLabel(o, props.lang)} disabled={props.disabled} onPress={() => props.onPick(o)} />
      ))}
    </View>
  );
}

function AssistantMessage(props: {
  m: ChatMessage;
  lang: ChatLang;
  live: boolean;
  money: Money;
  busyOutfit: string | null;
  outcomes: Readonly<Record<string, AddOutcome>>;
  onAdd: (outfitId: string) => void;
  onOption: (kind: "chip" | "quick", o: ChatOption, topic?: ChipTopic) => void;
}) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  let n = 0;
  return (
    <View style={{ gap: spacing.md }}>
      {props.m.source === "rules" ? <Text variant="caption" secondary>{t("stylistChat.sourceRules")}</Text> : null}
      {props.m.blocks.map((b: ChatBlock, idx) => {
        if (b.kind === "text") {
          return b.refusal ? (
            <View key={idx} style={{ flexDirection: "row", gap: spacing.sm, borderStartWidth: 2, borderStartColor: colors.hairline, paddingStart: spacing.md }}>
              <Icon name="hand-left-outline" size={18} color="textSecondary" />
              <View style={{ flex: 1, gap: 2 }}>
                <Eyebrow secondary>{t("stylistChat.refusalLabel")}</Eyebrow>
                <Text>{b.text}</Text>
              </View>
            </View>
          ) : (
            <Text key={idx} variant="lede">{b.text}</Text>
          );
        }
        if (b.kind === "chips") {
          return <OptionRow key={idx} options={b.options} lang={props.lang} disabled={!props.live} onPick={(o) => props.onOption("chip", o, b.topic)} />;
        }
        if (b.kind === "quick") {
          return <OptionRow key={idx} options={b.options} lang={props.lang} disabled={!props.live} onPick={(o) => props.onOption("quick", o)} />;
        }
        return (
          <View key={idx} style={{ gap: spacing.lg }}>
            {b.outfits.map((o) => {
              n += 1;
              return <OutfitBlockCard key={o.outfit.id} n={n} o={o} money={props.money} busy={props.busyOutfit === o.outfit.id} outcome={props.outcomes[o.outfit.id] ?? null} onAdd={() => props.onAdd(o.outfit.id)} />;
            })}
          </View>
        );
      })}
    </View>
  );
}

function ThreadSkeleton(props: { label: string }) {
  return (
    <View accessibilityRole="progressbar" accessibilityLabel={props.label} style={{ gap: spacing.md, paddingTop: spacing.lg }}>
      <Skeleton width="70%" height={22} />
      <Skeleton width="100%" height={72} radius={radius.lg} />
    </View>
  );
}

type SessionsLoad =
  | { status: "loading" }
  | { status: "error"; reason: AiFailureReason }
  | { status: "ready"; sessions: readonly ChatSession[]; historyEnabled: boolean };

function Sessions(props: { port: ChatPort; lang: ChatLang; onOpen: (id: string | null) => void; onBack: () => void }) {
  const { t } = useTranslation();
  const { port } = props;
  const [load, setLoad] = useState<SessionsLoad>({ status: "loading" });
  const [busy, setBusy] = useState(false);
  const [confirmErase, setConfirmErase] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: "erased"; count: number } | { kind: "failed"; reason: AiFailureReason } | null>(null);

  const reload = useCallback(async () => {
    setLoad({ status: "loading" });
    try {
      const [sessions, settings] = await Promise.all([port.listSessions(), port.getSettings()]);
      setLoad({ status: "ready", sessions: sortSessions(sessions), historyEnabled: settings.historyEnabled });
    } catch (e) {
      setLoad({ status: "error", reason: reasonOf(e) });
    }
  }, [port]);
  useEffect(() => {
    void reload();
  }, [reload]);

  const applyHistory = async (enabled: boolean, erase: boolean) => {
    if (load.status !== "ready") return;
    setBusy(true);
    setConfirmErase(false);
    setNotice(null);
    try {
      let sessions = load.sessions;
      if (erase) {
        const r = await eraseAll(port, sessions);
        setNotice({ kind: "erased", count: r.deleted });
        sessions = r.failed === 0 ? [] : await port.listSessions();
      }
      const s = await port.setHistoryEnabled(enabled);
      setLoad({ status: "ready", sessions, historyEnabled: s.historyEnabled });
    } catch (e) {
      setNotice({ kind: "failed", reason: reasonOf(e) });
    } finally {
      setBusy(false);
    }
  };

  const onToggle = (want: boolean) => {
    if (load.status !== "ready") return;
    if (historyStep(load.historyEnabled, want, load.sessions.length) === "confirmErase") setConfirmErase(true);
    else void applyHistory(want, false);
  };

  const removeOne = async (id: string) => {
    setBusy(true);
    setConfirmDelete(null);
    try {
      await port.deleteSession(id);
      if (load.status === "ready") setLoad({ ...load, sessions: load.sessions.filter((s) => s.id !== id) });
    } catch (e) {
      setNotice({ kind: "failed", reason: reasonOf(e) });
    } finally {
      setBusy(false);
    }
  };

  const hasSessions = load.status === "ready" && load.sessions.length > 0;
  return (
    <Screen title={t("stylistChat.title")} onBack={props.onBack} backLabel={t("common.back")}>
      <Text variant="lede" secondary>{t("stylistChat.aiNote")}</Text>
      <OfflineBanner visible={load.status === "error" && load.reason === "offline"} message={t("common.offlineBanner")} />
      {load.status === "loading" ? <ThreadSkeleton label={t("stylistChat.loading")} /> : null}
      {load.status === "error" ? (
        <StateScreen
          illustration={load.reason === "offline" ? "offline" : "error"}
          title={t(load.reason === "disabled" || load.reason === "quota" ? "stylistChat.pausedTitle" : "stylistChat.errorTitle")}
          description={t(`aiFailure.${load.reason}`)}
          actionTitle={load.reason === "disabled" ? t("stylistChat.useStructured") : t("common.retry")}
          onAction={load.reason === "disabled" ? props.onBack : () => void reload()}
        />
      ) : null}
      {load.status === "ready" ? (
        <>
          {hasSessions ? <Button variant="brand" title={t("stylistChat.newChat")} onPress={() => props.onOpen(null)} /> : null}
          {!hasSessions ? (
            <StateScreen illustration="stylistSparkle" title={t("stylistChat.emptyTitle")} description={t("stylistChat.emptyBody")} actionTitle={t("stylistChat.newChat")} onAction={() => props.onOpen(null)} />
          ) : null}
          {notice?.kind === "erased" ? <Banner tone="success" message={t("stylistChat.erased", { count: notice.count })} /> : null}
          {notice?.kind === "failed" ? <Banner tone="error" message={t(`aiFailure.${notice.reason}`)} /> : null}
          {hasSessions ? (
            <View>
              <Eyebrow>{t("stylistChat.sessionsHeading")}</Eyebrow>
              <Divider />
              {load.sessions.map((s, i) => (
                <Reveal key={s.id} index={i}>
                  {confirmDelete === s.id ? (
                    <View style={{ paddingVertical: spacing.md, gap: spacing.sm }}>
                      <Text>{t("stylistChat.deleteConfirm")}</Text>
                      <View style={{ flexDirection: "row", gap: spacing.md }}>
                        <Button title={t("stylistChat.deleteYes")} variant="secondary" fullWidth={false} disabled={busy} onPress={() => void removeOne(s.id)} />
                        <Button title={t("common.cancel")} variant="ghost" fullWidth={false} onPress={() => setConfirmDelete(null)} />
                      </View>
                      <Divider />
                    </View>
                  ) : (
                    <ListRow
                      title={t("stylistChat.sessionRow", { date: dayLabel(s.updatedAtMs, props.lang) })}
                      subtitle={t(s.historyEnabled ? "stylistChat.sessionSaved" : "stylistChat.sessionNotSaved")}
                      divider
                      onPress={() => props.onOpen(s.id)}
                      trailing={
                        <PressScale onPress={() => setConfirmDelete(s.id)} accessibilityRole="button" accessibilityLabel={t("stylistChat.deleteChat")} innerStyle={{ minHeight: 44, minWidth: 44, alignItems: "center", justifyContent: "center" }}>
                          <Icon name="trash-outline" size={19} color="textSecondary" />
                        </PressScale>
                      }
                    />
                  )}
                </Reveal>
              ))}
            </View>
          ) : null}
          <View style={{ gap: spacing.sm }}>
            <Eyebrow>{t("stylistChat.historyHeading")}</Eyebrow>
            <SwitchRow label={t("stylistChat.historyTitle")} value={load.historyEnabled} disabled={busy} onValueChange={onToggle} />
            <Text variant="caption" secondary>{t(load.historyEnabled ? "stylistChat.historyOnHelp" : "stylistChat.historyOffHelp")}</Text>
            {confirmErase ? (
              <View style={{ gap: spacing.sm, paddingTop: spacing.sm }}>
                <Text variant="headline">{t("stylistChat.eraseTitle")}</Text>
                <Text variant="callout" secondary>{t("stylistChat.eraseBody", { count: load.sessions.length })}</Text>
                <Button title={t("stylistChat.eraseAndOff")} variant="secondary" disabled={busy} onPress={() => void applyHistory(false, true)} />
                <Button title={t("stylistChat.offKeep")} variant="secondary" disabled={busy} onPress={() => void applyHistory(false, false)} />
                <Button title={t("common.cancel")} variant="ghost" onPress={() => setConfirmErase(false)} />
              </View>
            ) : null}
          </View>
        </>
      ) : null}
    </Screen>
  );
}

function Thread(props: {
  port: ChatPort;
  outfitBag: OutfitBagPort;
  lang: ChatLang;
  sessionId: string | null;
  money: Money;
  onBack: () => void;
  onStructured: () => void;
}) {
  const { t } = useTranslation();
  const { port } = props;
  const { colors } = useTheme();
  const [sessionId, setSessionId] = useState<string | null>(props.sessionId);
  const [messages, setMessages] = useState<readonly ChatMessage[]>([]);
  const [loading, setLoading] = useState(props.sessionId !== null);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<AiFailureReason | null>(null);
  const [remaining, setRemaining] = useState<number | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [busyOutfit, setBusyOutfit] = useState<string | null>(null);
  const [outcomes, setOutcomes] = useState<Readonly<Record<string, AddOutcome>>>({});
  const counter = useRef(0);
  const lastInput = useRef<{ text: string } | { action: ChatAction; label: string } | null>(null);

  useEffect(() => {
    if (props.sessionId === null) return;
    let alive = true;
    port.loadSession(props.sessionId).then(
      (r) => {
        if (!alive) return;
        setMessages(r.messages);
        setLoading(false);
      },
      (e: unknown) => {
        if (!alive) return;
        setFailure(reasonOf(e));
        setLoading(false);
      },
    );
    return () => {
      alive = false;
    };
  }, [port, props.sessionId]);

  const send = async (input: { text: string } | { action: ChatAction; label: string }) => {
    if (sending) return;
    setSending(true);
    setFailure(null);
    lastInput.current = input;
    counter.current += 1;
    const userMsg: ChatMessage = { id: `u-${Date.now()}-${counter.current}`, role: "user", text: "text" in input ? input.text : input.label, blocks: [], source: null };
    setMessages((m) => appendMessages(m, userMsg));
    try {
      let id = sessionId;
      if (id === null) {
        id = (await port.createSession(props.lang)).id;
        setSessionId(id);
      }
      const turn = await port.send(id, "text" in input ? { text: input.text } : { action: input.action }, props.lang);
      setMessages((m) => appendMessages(m, turnToMessage(turn)));
      setRemaining(turn.remainingToday);
      setTruncated(turn.truncated);
    } catch (e) {
      setMessages((m) => m.filter((x) => x.id !== userMsg.id));
      setFailure(reasonOf(e));
    } finally {
      setSending(false);
    }
  };

  const submit = () => {
    const c = checkInput(text);
    if (!c.ok) return;
    setText("");
    void send({ text: c.text });
  };

  const onOption = (kind: "chip" | "quick", o: ChatOption, topic?: ChipTopic) => {
    const a = actionForOption(kind, o.id, topic);
    if (a !== null) void send({ action: a, label: optionLabel(o, props.lang) });
  };

  const add = async (outfitId: string) => {
    setBusyOutfit(outfitId);
    try {
      counter.current += 1;
      const r = await props.outfitBag.addOutfit(outfitId, `chat-${Date.now()}-${counter.current}`);
      setOutcomes((o) => ({ ...o, [outfitId]: addOutcome(r) }));
    } catch {
      setOutcomes((o) => ({ ...o, [outfitId]: { kind: "none", rejected: [] } }));
    } finally {
      setBusyOutfit(null);
    }
  };

  const lastAssistant = (() => {
    for (let i = messages.length - 1; i >= 0; i -= 1) if (messages[i]?.role === "assistant") return messages[i]?.id ?? null;
    return null;
  })();
  const quota = quotaHint(remaining);
  const blocked = failure === "quota" || failure === "disabled";

  return (
    <Screen
      title={t("stylistChat.title")}
      onBack={props.onBack}
      backLabel={t("common.back")}
      footer={
        <StickyBar>
          {quota !== null ? <Text variant="caption" secondary>{t("stylistChat.quotaLeft", { count: quota })}</Text> : null}
          <TextField
            label={t("stylistChat.inputLabel")}
            value={text}
            onChangeText={setText}
            disabled={sending || blocked}
            helper={truncated ? t("stylistChat.truncated") : t("stylistChat.aiLabel")}
          />
          <Button title={t("stylistChat.send")} loading={sending} disabled={sending || blocked || checkInput(text).ok === false} onPress={submit} />
        </StickyBar>
      }
    >
      <Eyebrow>{t("stylistChat.aiLabel")}</Eyebrow>
      {loading ? <ThreadSkeleton label={t("stylistChat.loading")} /> : null}
      {!loading && messages.length === 0 ? (
        <View style={{ gap: spacing.md }}>
          <Text variant="title1" accessibilityRole="header">{t("stylistChat.starterTitle")}</Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.sm }}>
            {STARTERS.map((k) => (
              <Chip key={k} label={t(`stylistChat.starters.${k}`)} disabled={sending || blocked} onPress={() => void send({ text: t(`stylistChat.starters.${k}`) })} />
            ))}
          </View>
        </View>
      ) : null}
      {messages.map((m, i) =>
        m.role === "user" ? (
          <Reveal key={m.id} index={Math.min(i, 3)}>
            <View style={{ alignItems: "flex-end" }}>
              <View style={{ maxWidth: "85%", backgroundColor: colors.sand, borderRadius: radius.lg, paddingVertical: spacing.sm, paddingHorizontal: spacing.md }}>
                <Text variant="callout" color="onSand">{m.text ?? t("stylistChat.notSaved")}</Text>
              </View>
            </View>
          </Reveal>
        ) : (
          <Reveal key={m.id} index={Math.min(i, 3)}>
            <AssistantMessage
              m={m}
              lang={props.lang}
              live={m.id === lastAssistant && !sending && !blocked}
              money={props.money}
              busyOutfit={busyOutfit}
              outcomes={outcomes}
              onAdd={(id) => void add(id)}
              onOption={onOption}
            />
          </Reveal>
        ),
      )}
      {sending ? <ThreadSkeleton label={t("stylistChat.thinking")} /> : null}
      {failure !== null ? (
        <FailureStrip
          reason={failure}
          onStructured={props.onStructured}
          onRetry={
            lastInput.current !== null && !loading
              ? () => {
                  const li = lastInput.current;
                  if (li !== null) void send(li);
                }
              : undefined
          }
        />
      ) : null}
    </Screen>
  );
}

/**
 * Chat inside the Stylist tab: sessions list -> thread. `onBack` returns to the structured stylist (always
 * available: spec P3-07 "user can always switch to the structured stylist").
 */
export function StylistChatScreen(props: { port?: ChatPort; outfitBag?: OutfitBagPort; onBack: () => void }) {
  const { t, i18n } = useTranslation();
  const lang: ChatLang = i18n.language === "en" ? "en" : "ar";
  const locale: DisplayLocale = lang;
  const port = useMemo<ChatPort>(() => props.port ?? getFeaturePorts().stylistChat, [props.port]);
  const outfitBag = props.outfitBag ?? getFeaturePorts().outfitBag;
  const currency = t("common.currency");
  const money = useCallback<Money>((m) => formatMoney(m, locale, currency), [locale, currency]);
  const [view, setView] = useState<{ kind: "sessions" } | { kind: "thread"; id: string | null; n: number }>({ kind: "sessions" });
  if (view.kind === "thread") {
    return (
      <Thread
        key={`${view.id ?? "new"}-${view.n}`}
        port={port}
        outfitBag={outfitBag}
        lang={lang}
        sessionId={view.id}
        money={money}
        onBack={() => setView({ kind: "sessions" })}
        onStructured={props.onBack}
      />
    );
  }
  return <Sessions port={port} lang={lang} onBack={props.onBack} onOpen={(id) => setView({ kind: "thread", id, n: Date.now() })} />;
}
