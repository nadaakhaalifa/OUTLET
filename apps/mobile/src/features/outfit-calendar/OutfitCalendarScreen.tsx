import { useCallback, useEffect, useMemo, useState } from "react";
import { View } from "react-native";
import { useRouter } from "expo-router";
import { useTranslation } from "react-i18next";
import { spacing } from "@outlet/ui-tokens";
import { Banner, Button, Card, Chip, Divider, Eyebrow, ListRow, Reveal, Screen, Skeleton, SwitchRow, Text, TextField } from "../../ui";
import { OfflineBanner, StateScreen } from "../../components/states";
import { getFeaturePorts } from "../../state/ports";
import { reasonOf, type AiFailureReason } from "../ai-failure";
import { formatMoney, type DisplayLocale } from "../money-display";
import {
  EVENT_KINDS, SEASONS, canAddEvent, daysBetween, deliveryNotice, quickDates, splitEvents, todayCairo, validateDraft, worstDelivery,
  type AddGapResult, type CalendarEvent, type CalendarPort, type DraftErrors, type EventKind, type GapOutfit, type GapResult, type Season,
} from "./model";

type Lang = "ar" | "en";
type Money = (minor: bigint) => string;

function dateText(localDate: string, lang: Lang): string {
  try {
    return new Date(`${localDate}T12:00:00Z`).toLocaleDateString(lang === "en" ? "en-GB" : "ar-EG", { weekday: "short", day: "numeric", month: "long", timeZone: "UTC" });
  } catch {
    return localDate;
  }
}

function ListSkeleton(props: { label: string }) {
  return (
    <View accessibilityRole="progressbar" accessibilityLabel={props.label} style={{ gap: spacing.lg, paddingTop: spacing.lg }}>
      {[0, 1, 2].map((i) => (
        <View key={i} style={{ gap: spacing.xs }}>
          <Skeleton width="50%" height={22} />
          <Skeleton width="70%" height={14} />
        </View>
      ))}
    </View>
  );
}

function DeliveryLine(props: { outfits: readonly GapOutfit[]; lang: Lang }) {
  const { t } = useTranslation();
  const n = deliveryNotice(worstDelivery(props.outfits.map((o) => o.delivery)));
  if (n.kind === "mayNotArrive") {
    return <Banner tone="warning" message={n.orderBy !== null ? t("outfitCalendar.mayNotArrive", { date: dateText(n.orderBy, props.lang) }) : t("outfitCalendar.mayNotArriveNoDate")} />;
  }
  return <Text variant="caption" secondary>{t(n.kind === "estimate" ? "outfitCalendar.deliveryEstimate" : "outfitCalendar.deliveryUnknown")}</Text>;
}

function GapCard(props: { n: number; o: GapOutfit; money: Money; busy: boolean; result: AddGapResult | null; failed: AiFailureReason | null; onAdd: () => void }) {
  const { t } = useTranslation();
  const { o } = props;
  return (
    <Card variant="elevated" style={{ gap: spacing.sm }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "baseline" }}>
        <Eyebrow>{t("stylist.outfitHeading", { n: props.n })}</Eyebrow>
        <Text variant="title2" numeric>{props.money(o.total)}</Text>
      </View>
      {o.ownedSlots.length > 0 ? <Text variant="caption" secondary>{t("outfitCalendar.ownedSlots", { slots: o.ownedSlots.map((s) => t(`stylist.slotName.${s}`)).join(", ") })}</Text> : null}
      {o.outfit.items.map((i) => (
        <View key={i.skuId} style={{ flexDirection: "row", justifyContent: "space-between", gap: spacing.md }}>
          <Text variant="callout" style={{ flex: 1 }}>{i.title !== "" ? i.title : t(`stylist.slotName.${i.slot}`)}</Text>
          <Text variant="callout" numeric>{props.money(i.unitPrice)}</Text>
        </View>
      ))}
      {o.missing.map((m) => (
        <Text key={m.slot} variant="caption" secondary>{t("stylist.partialMissing", { amount: props.money(m.shortfall), slot: t(`stylist.slot.${m.slot}`) })}</Text>
      ))}
      {props.result !== null ? (
        <Banner
          tone={props.result.added || props.result.alreadyAdded ? (props.result.unavailable > 0 || props.result.priceChanges > 0 ? "warning" : "success") : "warning"}
          message={t(props.result.alreadyAdded ? "outfitCalendar.gapAlready" : props.result.added ? "outfitCalendar.gapAdded" : "outfitCalendar.gapNone")}
        />
      ) : null}
      {props.failed !== null ? <Banner tone="error" message={t(`aiFailure.${props.failed}`)} /> : null}
      <Button title={t(props.busy ? "stylist.adding" : "outfitCalendar.addGap")} variant="secondary" loading={props.busy} disabled={props.busy || o.outfit.items.length === 0} onPress={props.onAdd} />
    </Card>
  );
}

function Detail(props: { port: CalendarPort; event: CalendarEvent; lang: Lang; money: Money; onBack: () => void; onChanged: (e: CalendarEvent) => void; onDeleted: (id: string) => void }) {
  const { t } = useTranslation();
  const { port, event } = props;
  const [gen, setGen] = useState<{ status: "idle" } | { status: "loading" } | { status: "error"; reason: AiFailureReason } | { status: "ready"; result: GapResult }>({ status: "idle" });
  const [busyOutfit, setBusyOutfit] = useState<string | null>(null);
  const [results, setResults] = useState<Readonly<Record<string, AddGapResult>>>({});
  const [failed, setFailed] = useState<Readonly<Record<string, AiFailureReason>>>({});
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<AiFailureReason | null>(null);
  const [busy, setBusy] = useState(false);

  const generate = async () => {
    setGen({ status: "loading" });
    setResults({});
    setFailed({});
    try {
      setGen({ status: "ready", result: await port.generate(event.id, false) });
    } catch (e) {
      setGen({ status: "error", reason: reasonOf(e) });
    }
  };
  const addGap = async (outfitId: string) => {
    setBusyOutfit(outfitId);
    setFailed((f) => Object.fromEntries(Object.entries(f).filter(([k]) => k !== outfitId)));
    try {
      const r = await port.addGap(event.id, outfitId);
      setResults((x) => ({ ...x, [outfitId]: r }));
    } catch (e) {
      setFailed((f) => ({ ...f, [outfitId]: reasonOf(e) }));
    } finally {
      setBusyOutfit(null);
    }
  };
  const setReminders = async (enabled: boolean) => {
    setBusy(true);
    setError(null);
    try {
      props.onChanged(await port.update(event.id, { remindersEnabled: enabled }));
    } catch (e) {
      setError(reasonOf(e));
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    setBusy(true);
    try {
      await port.remove(event.id);
      props.onDeleted(event.id);
    } catch (e) {
      setError(reasonOf(e));
      setBusy(false);
    }
  };

  const days = daysBetween(todayCairo(Date.now()), event.localDate);
  const result = gen.status === "ready" ? gen.result : null;
  return (
    <Screen title={t(`outfitCalendar.kind.${event.kind}`)} onBack={props.onBack} backLabel={t("common.back")}>
      <View style={{ gap: spacing.xs }}>
        <Text variant="title2">{dateText(event.localDate, props.lang)}</Text>
        <Text variant="callout" secondary numeric>
          {`${event.localTime} · ${days > 0 ? t("outfitCalendar.inDays", { count: days }) : days === 0 ? t("outfitCalendar.today") : t("outfitCalendar.past")}`}
        </Text>
        {event.budget !== null ? <Text variant="callout" secondary numeric>{t("outfitCalendar.budgetLine", { amount: props.money(event.budget) })}</Text> : null}
        {event.note !== null ? <Text variant="callout">{event.note}</Text> : null}
      </View>
      <SwitchRow label={t("outfitCalendar.reminders")} value={event.remindersEnabled} disabled={busy} onValueChange={(v) => void setReminders(v)} />
      <Text variant="caption" secondary>{t("outfitCalendar.remindersHint")}</Text>
      {error !== null ? <Banner tone="error" message={t(`aiFailure.${error}`)} /> : null}
      <Divider />
      <Text variant="lede" secondary>{t("outfitCalendar.aiNote")}</Text>
      <Button variant="brand" title={t("outfitCalendar.plan")} loading={gen.status === "loading"} disabled={gen.status === "loading" || days < 0} onPress={() => void generate()} />
      {gen.status === "loading" ? <ListSkeleton label={t("outfitCalendar.planning")} /> : null}
      {gen.status === "error" ? (
        <StateScreen
          illustration={gen.reason === "offline" ? "offline" : "error"}
          title={t(gen.reason === "offline" ? "stylist.offlineTitle" : "outfitCalendar.planFailed")}
          description={t(`aiFailure.${gen.reason}`)}
          actionTitle={t("common.retry")}
          onAction={() => void generate()}
        />
      ) : null}
      {result !== null && result.source === "rules" ? <Banner tone="warning" message={t("stylist.rulesFallback")} /> : null}
      {result !== null && result.ownedOnly ? <Banner tone="success" message={t("outfitCalendar.ownedOnly")} /> : null}
      {result !== null && result.outfits.length === 0 && !result.ownedOnly ? <StateScreen illustration="noResults" title={t("stylist.emptyTitle")} description={t("stylist.emptyBody")} /> : null}
      {result !== null && result.outfits.length > 0 ? <DeliveryLine outfits={result.outfits} lang={props.lang} /> : null}
      {result !== null
        ? result.outfits.map((o, i) => (
            <Reveal key={o.outfit.id} index={i}>
              <GapCard n={i + 1} o={o} money={props.money} busy={busyOutfit === o.outfit.id} result={results[o.outfit.id] ?? null} failed={failed[o.outfit.id] ?? null} onAdd={() => void addGap(o.outfit.id)} />
            </Reveal>
          ))
        : null}
      {result !== null && result.remainingToday !== null && result.remainingToday <= 5 ? <Text variant="caption" secondary>{t("outfitCalendar.quotaLeft", { count: result.remainingToday })}</Text> : null}
      <Divider />
      {confirmDelete ? (
        <View style={{ gap: spacing.sm }}>
          <Text>{t("outfitCalendar.deleteConfirm")}</Text>
          <Button title={t("outfitCalendar.deleteYes")} variant="secondary" disabled={busy} onPress={() => void remove()} />
          <Button title={t("common.cancel")} variant="ghost" onPress={() => setConfirmDelete(false)} />
        </View>
      ) : (
        <Button title={t("outfitCalendar.delete")} variant="secondary" onPress={() => setConfirmDelete(true)} />
      )}
    </Screen>
  );
}

function Form(props: { port: CalendarPort; lang: Lang; today: string; onBack: () => void; onCreated: (e: CalendarEvent) => void }) {
  const { t } = useTranslation();
  const [kind, setKind] = useState<EventKind>("wedding_guest");
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [note, setNote] = useState("");
  const [modest, setModest] = useState(false);
  const [season, setSeason] = useState<Season>("all");
  const [budget, setBudget] = useState("");
  const [reminders, setReminders] = useState(true);
  const [errors, setErrors] = useState<DraftErrors>({});
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<AiFailureReason | null>(null);

  const save = async () => {
    const r = validateDraft({ kind, date, time, note, modest, season, budgetEgp: budget, remindersEnabled: reminders }, props.today);
    if (!r.ok) {
      setErrors(r.errors);
      return;
    }
    setErrors({});
    setBusy(true);
    setFailure(null);
    try {
      props.onCreated(await props.port.create(r.draft));
    } catch (e) {
      setFailure(reasonOf(e));
      setBusy(false);
    }
  };

  return (
    <Screen title={t("outfitCalendar.addTitle")} onBack={props.onBack} backLabel={t("common.back")}>
      <Eyebrow>{t("outfitCalendar.kindHeading")}</Eyebrow>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.sm }}>
        {EVENT_KINDS.map((k) => <Chip key={k} label={t(`outfitCalendar.kind.${k}`)} selected={k === kind} onPress={() => setKind(k)} />)}
      </View>
      {kind === "eid" ? <Text variant="caption" secondary>{t("outfitCalendar.eidHint")}</Text> : null}
      <TextField
        label={t("outfitCalendar.dateLabel")}
        value={date}
        onChangeText={setDate}
        keyboardType="numeric"
        helper={t("outfitCalendar.dateHelper")}
        {...(errors.date !== undefined ? { error: t(errors.date === "past" ? "outfitCalendar.datePast" : "outfitCalendar.dateInvalid") } : {})}
      />
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.sm }}>
        {quickDates(props.today).map((q) => (
          <Chip key={q.days} label={t("outfitCalendar.inDays", { count: q.days })} selected={date === q.date} onPress={() => setDate(q.date)} />
        ))}
      </View>
      <TextField
        label={t("outfitCalendar.timeLabel")}
        value={time}
        onChangeText={setTime}
        helper={t("outfitCalendar.timeHelper")}
        {...(errors.time !== undefined ? { error: t("outfitCalendar.timeInvalid") } : {})}
      />
      <TextField
        label={`${t("stylist.budgetLabel")} (${t("common.currency")})`}
        value={budget}
        onChangeText={setBudget}
        keyboardType="numeric"
        helper={t("outfitCalendar.budgetHelper")}
        {...(errors.budget !== undefined ? { error: t("stylist.budgetInvalid") } : {})}
      />
      <Eyebrow>{t("outfitCalendar.styleHeading")}</Eyebrow>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.sm }}>
        <Chip label={t("stylist.modest")} selected={modest} onPress={() => setModest((m) => !m)} />
        {SEASONS.map((s) => <Chip key={s} label={t(`outfitCalendar.season.${s}`)} selected={s === season} onPress={() => setSeason(s)} />)}
      </View>
      <TextField
        label={t("outfitCalendar.noteLabel")}
        value={note}
        onChangeText={setNote}
        maxLength={200}
        helper={t("outfitCalendar.noteHelper")}
        {...(errors.note !== undefined ? { error: t("outfitCalendar.noteLong") } : {})}
      />
      <SwitchRow label={t("outfitCalendar.reminders")} value={reminders} onValueChange={setReminders} />
      <Text variant="caption" secondary>{t("outfitCalendar.remindersHint")}</Text>
      {failure !== null ? <Banner tone="error" message={t(`aiFailure.${failure}`)} /> : null}
      <Button variant="brand" title={t("outfitCalendar.save")} loading={busy} disabled={busy} onPress={() => void save()} />
    </Screen>
  );
}

type Load = { status: "loading" } | { status: "error"; reason: AiFailureReason } | { status: "ready"; events: readonly CalendarEvent[] };
type View_ = { kind: "list" } | { kind: "form" } | { kind: "detail"; id: string };

/** Me > Outfit calendar. */
export function OutfitCalendarScreen(props: { port?: CalendarPort }) {
  const { t, i18n } = useTranslation();
  const router = useRouter();
  const lang: Lang = i18n.language === "en" ? "en" : "ar";
  const locale: DisplayLocale = lang;
  const port = useMemo<CalendarPort>(() => props.port ?? getFeaturePorts().calendar, [props.port]);
  const currency = t("common.currency");
  const money = useCallback<Money>((m) => formatMoney(m, locale, currency), [locale, currency]);
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [view, setView] = useState<View_>({ kind: "list" });
  const [confirmClear, setConfirmClear] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<AiFailureReason | "cleared" | null>(null);
  const today = todayCairo(Date.now());

  const reload = useCallback(async () => {
    setLoad({ status: "loading" });
    try {
      setLoad({ status: "ready", events: await port.list(true) });
    } catch (e) {
      setLoad({ status: "error", reason: reasonOf(e) });
    }
  }, [port]);
  useEffect(() => {
    void reload();
  }, [reload]);

  const events = load.status === "ready" ? load.events : [];
  const replace = (e: CalendarEvent) => setLoad({ status: "ready", events: events.map((x) => (x.id === e.id ? e : x)) });

  if (view.kind === "form") {
    return (
      <Form
        port={port}
        lang={lang}
        today={today}
        onBack={() => setView({ kind: "list" })}
        onCreated={(e) => {
          setLoad({ status: "ready", events: [...events, e] });
          setView({ kind: "detail", id: e.id });
        }}
      />
    );
  }
  if (view.kind === "detail") {
    const ev = events.find((e) => e.id === view.id);
    if (ev !== undefined) {
      return (
        <Detail
          port={port}
          event={ev}
          lang={lang}
          money={money}
          onBack={() => setView({ kind: "list" })}
          onChanged={replace}
          onDeleted={(id) => {
            setLoad({ status: "ready", events: events.filter((x) => x.id !== id) });
            setView({ kind: "list" });
          }}
        />
      );
    }
  }

  const { upcoming, past } = splitEvents(events, today);
  const clear = async () => {
    setBusy(true);
    setConfirmClear(false);
    try {
      await port.clear();
      setLoad({ status: "ready", events: [] });
      setNotice("cleared");
    } catch (e) {
      setNotice(reasonOf(e));
    } finally {
      setBusy(false);
    }
  };
  const row = (e: CalendarEvent, i: number) => (
    <Reveal key={e.id} index={i}>
      <ListRow
        title={t(`outfitCalendar.kind.${e.kind}`)}
        subtitle={`${dateText(e.localDate, lang)} · ${t(`outfitCalendar.status.${e.outfitStatus}`)}`}
        divider
        onPress={() => setView({ kind: "detail", id: e.id })}
      />
    </Reveal>
  );

  return (
    <Screen title={t("outfitCalendar.title")} onBack={() => router.back()} backLabel={t("common.back")}>
      <Text variant="lede" secondary>{t("outfitCalendar.intro")}</Text>
      <OfflineBanner visible={load.status === "error" && load.reason === "offline"} message={t("common.offlineBanner")} />
      {load.status === "loading" ? <ListSkeleton label={t("outfitCalendar.loading")} /> : null}
      {load.status === "error" ? (
        <StateScreen
          illustration={load.reason === "offline" ? "offline" : "error"}
          title={t(load.reason === "offline" ? "stylist.offlineTitle" : "outfitCalendar.errorTitle")}
          description={t(`aiFailure.${load.reason}`)}
          actionTitle={t("common.retry")}
          onAction={() => void reload()}
        />
      ) : null}
      {load.status === "ready" ? (
        <>
          {notice === "cleared" ? <Banner tone="success" message={t("outfitCalendar.cleared")} /> : null}
          {notice !== null && notice !== "cleared" ? <Banner tone="error" message={t(`aiFailure.${notice}`)} /> : null}
          {events.length === 0 ? (
            <StateScreen illustration="emptyWishlist" title={t("outfitCalendar.emptyTitle")} description={t("outfitCalendar.emptyBody")} actionTitle={t("outfitCalendar.add")} onAction={() => setView({ kind: "form" })} />
          ) : (
            <>
              {canAddEvent(events, today) ? (
                <Button variant="brand" title={t("outfitCalendar.add")} onPress={() => setView({ kind: "form" })} />
              ) : (
                <Banner tone="info" message={t("outfitCalendar.limit")} />
              )}
              {upcoming.length > 0 ? (
                <View>
                  <Eyebrow>{t("outfitCalendar.upcoming")}</Eyebrow>
                  <Divider />
                  {upcoming.map(row)}
                </View>
              ) : (
                <Text variant="callout" secondary>{t("outfitCalendar.noUpcoming")}</Text>
              )}
              {past.length > 0 ? (
                <View>
                  <Eyebrow>{t("outfitCalendar.pastHeading")}</Eyebrow>
                  <Divider />
                  {past.map((e, i) => row(e, i + upcoming.length))}
                </View>
              ) : null}
              <Text variant="caption" secondary>{t("outfitCalendar.privacy")}</Text>
              {confirmClear ? (
                <View style={{ gap: spacing.sm }}>
                  <Text>{t("outfitCalendar.clearConfirm")}</Text>
                  <Button title={t("outfitCalendar.clearYes")} variant="secondary" disabled={busy} onPress={() => void clear()} />
                  <Button title={t("common.cancel")} variant="ghost" onPress={() => setConfirmClear(false)} />
                </View>
              ) : (
                <Button title={t("outfitCalendar.clear")} variant="secondary" disabled={busy} onPress={() => setConfirmClear(true)} />
              )}
            </>
          )}
        </>
      ) : null}
    </Screen>
  );
}
