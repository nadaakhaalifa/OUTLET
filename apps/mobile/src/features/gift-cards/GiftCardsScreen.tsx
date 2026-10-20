import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ScrollView, View } from "react-native";
import { useRouter } from "expo-router";
import { useTranslation } from "react-i18next";
import { spacing } from "@outlet/ui-tokens";
import { HeroArt, Illustration } from "../../art";
import { Banner, Button, Chip, Divider, ErrorState, Eyebrow, PressScale, Reveal, Screen, Skeleton, Text, TextField, useTheme } from "../../ui";
import { Section } from "../account-ui";
import { DESIGN_ART } from "./designs";
import { formatMoney, localizeDigits, type DisplayLocale } from "../money-display";
import { formatCairoDate } from "../plus/model";
import { newIdempotencyKey } from "../plus/idempotency";
import { opt } from "../search/optional";
import {
  DELIVERY_CHANNELS, GIFT_DESIGNS, MAX_CARD_AMOUNT, MIN_CARD_AMOUNT, MIN_CONTRIBUTION,
  buildPurchaseRequest, canSubmitRedeem, parseAmountEgp, canVoid, codeProblem, expiryTerm, giftFailureState, giftVisibility, normaliseCode,
  potProgressPct, redeemStateFrom, validateContribution, validatePot, validatePurchase,
  type DeliveryChannel, type GiftCardsPort, type GiftDesign, type GiftScreenState, type GiftSnapshot, type PurchaseDraft, type RedeemState,
} from "./model";
import { getFeaturePorts } from "../../state/ports";

type Money = (minor: bigint) => string;
type Num = (n: number) => string;

const EMPTY_DRAFT: PurchaseDraft = { design: "birthday", amountText: "", message: "", channel: "inApp", recipientContact: "", scheduleDate: "" };

function DesignPicker(props: { value: GiftDesign; onChange: (d: GiftDesign) => void }) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  return (
    <View style={{ gap: 10 }}>
      <Text secondary>{t("giftCards.purchase.designLabel")}</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} accessibilityRole="radiogroup" accessibilityLabel={t("giftCards.purchase.designLabel")} contentContainerStyle={{ gap: 14 }}>
        {GIFT_DESIGNS.map((d: GiftDesign) => {
          const sel = d === props.value;
          return (
            <PressScale
              key={d}
              onPress={() => props.onChange(d)}
              accessibilityRole="radio"
              accessibilityState={{ selected: sel }}
              accessibilityLabel={t(`giftCards.design.${d}`)}
              innerStyle={{ width: 188, gap: 8, paddingBottom: 6, borderBottomWidth: 2, borderBottomColor: sel ? colors.accent : "transparent" }}
            >
              <View style={{ borderRadius: 18, overflow: "hidden" }}><HeroArt variant={DESIGN_ART[d]} aspect={1.5} /></View>
              <Text variant="eyebrow" secondary={!sel} align="start" accessibilityRole="none">{t(`giftCards.design.${d}`)}</Text>
            </PressScale>
          );
        })}
      </ScrollView>
    </View>
  );
}

function Purchase(props: { snap: GiftSnapshot; port: GiftCardsPort; money: Money; num: Num; now: number; onChanged: () => void }) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<PurchaseDraft>(EMPTY_DRAFT);
  const [errors, setErrors] = useState<readonly string[]>([]);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<"created" | "disabled" | "ageGate" | "rateLimited" | "failed" | null>(null);
  const keys = useRef(new Map<string, string>());
  const set = <K extends keyof PurchaseDraft>(k: K, v: PurchaseDraft[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const err = (k: string) => (errors.includes(k) ? t(`giftCards.purchase.error.${k}`) : undefined);
  const term = expiryTerm(props.snap.expiryMonths);

  const submit = async () => {
    const e = validatePurchase(draft, props.snap, props.now);
    setErrors(e);
    setResult(null);
    if (e.length > 0) return;
    const req = buildPurchaseRequest(draft);
    const fp = JSON.stringify({ ...req, amount: req.amount.toString() });
    const key = keys.current.get(fp) ?? newIdempotencyKey();
    keys.current.set(fp, key);
    setBusy(true);
    try {
      const out = await props.port.purchase(req, key);
      setResult(out.kind);
      if (out.kind === "created") {
        keys.current.delete(fp);
        setDraft(EMPTY_DRAFT);
        props.onChanged();
      }
    } catch {
      setResult("failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title={t("giftCards.purchase.heading")}>
            <DesignPicker value={draft.design} onChange={(d) => set("design", d)} />
      <TextField
        label={t("giftCards.purchase.amountLabel", { currency: t("common.currency") })}
        helper={t("giftCards.purchase.amountHelper", { min: props.money(MIN_CARD_AMOUNT), max: props.money(MAX_CARD_AMOUNT) })}
        value={draft.amountText}
        onChangeText={(v) => set("amountText", v)}
        keyboardType="numeric"
        {...opt("error", err("amountInvalid") ?? err("amountTooLow") ?? err("amountTooHigh") ?? err("needsAdult"))}
      />
      <TextField
        label={t("giftCards.purchase.messageLabel")}
        value={draft.message}
        onChangeText={(v) => set("message", v)}
        {...opt("error", err("messageTooLong"))}
      />
      <Text secondary>{t("giftCards.purchase.channelLabel")}</Text>
      <View accessibilityRole="radiogroup" accessibilityLabel={t("giftCards.purchase.channelLabel")} style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.sm }}>
        {DELIVERY_CHANNELS.map((c: DeliveryChannel) => (
          <Chip key={c} label={t(`giftCards.channel.${c}`)} selected={c === draft.channel} onPress={() => set("channel", c)} />
        ))}
      </View>
      {draft.channel !== "inApp" ? (
        <TextField
          label={t(draft.channel === "email" ? "giftCards.purchase.contactEmail" : "giftCards.purchase.contactPhone")}
          value={draft.recipientContact}
          onChangeText={(v) => set("recipientContact", v)}
          keyboardType={draft.channel === "email" ? "email-address" : "phone-pad"}
          {...opt("error", err("contactRequired") ?? err("contactInvalid"))}
        />
      ) : null}
      <TextField
        label={t("giftCards.purchase.scheduleLabel")}
        helper={t("giftCards.purchase.scheduleHelper")}
        value={draft.scheduleDate}
        onChangeText={(v) => set("scheduleDate", v)}
        {...opt("error", err("scheduleInvalid") ?? err("schedulePast") ?? err("scheduleTooFar"))}
      />
      <Text variant="caption" secondary>{t(`giftCards.purchase.expiry.${term.unit}`, { count: props.num(term.count) })}</Text>
      <Text variant="caption" secondary>{t("giftCards.purchase.payNote")}</Text>
      <Text variant="caption" secondary>{t("giftCards.closedLoopNote")}</Text>
      {result !== null && result !== "created" ? <Banner tone="error" message={t(`giftCards.purchase.result.${result}`)} /> : null}
      {result === "created" ? <Banner tone="info" message={t("giftCards.purchase.result.created")} /> : null}
      <Button variant="brand" title={t("giftCards.purchase.submit")} loading={busy} disabled={busy} onPress={() => void submit()} />
    </Section>
  );
}

function Redeem(props: { port: GiftCardsPort; money: Money; num: Num; onChanged: () => void }) {
  const { t } = useTranslation();
  const [code, setCode] = useState("");
  const [state, setState] = useState<RedeemState>({ kind: "idle" });
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const submit = async () => {
    const p = codeProblem(code);
    setProblem(p);
    setFailed(false);
    if (p !== null) return;
    setBusy(true);
    try {
      // A new key per submit: each attempt is distinct and must count against the server limit.
      const out = await props.port.redeem(normaliseCode(code), newIdempotencyKey());
      const next = redeemStateFrom(out);
      setState(next);
      if (next.kind === "success") {
        setCode("");
        props.onChanged();
      }
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  const minutes = state.kind === "locked" && state.retryAfterSeconds !== null ? Math.max(1, Math.ceil(state.retryAfterSeconds / 60)) : null;
  return (
    <Section title={t("giftCards.redeem.heading")}>
      <TextField
        label={t("giftCards.redeem.codeLabel")}
        helper={t("giftCards.redeem.codeHelper")}
        value={code}
        onChangeText={(v) => { setCode(v); setProblem(null); }}
        disabled={state.kind === "locked" || state.kind === "disabled"}
        {...opt("error", problem === null ? undefined : t(`giftCards.redeem.problem.${problem}`))}
      />
      {state.kind === "invalid" ? (
        <Banner
          tone="error"
          message={
            state.remainingAttempts === null
              ? t("giftCards.redeem.invalid")
              : `${t("giftCards.redeem.invalid")} ${t("giftCards.redeem.attemptsLeft", { count: props.num(state.remainingAttempts) })}`
          }
        />
      ) : null}
      {state.kind === "locked" ? (
        <Banner tone="warning" message={minutes === null ? t("giftCards.redeem.lockedGeneric") : t("giftCards.redeem.locked", { minutes: props.num(minutes) })} />
      ) : null}
      {state.kind === "disabled" ? <Banner tone="info" message={t("giftCards.redeem.disabled")} /> : null}
      {state.kind === "success" ? <Banner tone="info" message={t("giftCards.redeem.success", { amount: props.money(state.amount) })} /> : null}
      {failed ? <Banner tone="error" message={t("giftCards.actionFailed")} /> : null}
      <Button title={t("giftCards.redeem.submit")} loading={busy} disabled={busy || !canSubmitRedeem(state, code)} onPress={() => void submit()} />
    </Section>
  );
}

function ProgressBar(props: { pct: number; name: string; value: string }) {
  const { colors } = useTheme();
  return (
    <View
      accessibilityRole="progressbar"
      accessibilityLabel={props.name}
      accessibilityValue={{ min: 0, max: 100, now: props.pct, text: props.value }}
      style={{ height: 4, backgroundColor: colors.hairline, overflow: "hidden" }}
    >
      <View style={{ width: `${props.pct}%`, height: 4, backgroundColor: colors.accent }} />
    </View>
  );
}

function Pots(props: { snap: GiftSnapshot; port: GiftCardsPort; money: Money; num: Num; locale: DisplayLocale; now: number; canCreate: boolean; onChanged: () => void }) {
  const { t } = useTranslation();
  const [title, setTitle] = useState("");
  const [target, setTarget] = useState("");
  const [closes, setCloses] = useState("");
  const [errors, setErrors] = useState<readonly string[]>([]);
  const [amounts, setAmounts] = useState<Readonly<Record<string, string>>>({});
  const [contribErr, setContribErr] = useState<Readonly<Record<string, string>>>({});
  const [failed, setFailed] = useState(false);
  const createKey = useRef<string | null>(null);
  const err = (k: string) => (errors.includes(k) ? t(`giftCards.pots.error.${k}`) : undefined);

  const create = async () => {
    const e = validatePot(target, closes, title, props.now);
    setErrors(e);
    setFailed(false);
    if (e.length > 0) return;
    const amount = parseAmountEgp(target);
    if (amount === null) return;
    createKey.current ??= newIdempotencyKey();
    try {
      await props.port.createPot(amount, closes.trim(), title.trim(), createKey.current);
      createKey.current = null;
      setTitle(""); setTarget(""); setCloses("");
      props.onChanged();
    } catch {
      setFailed(true);
    }
  };

  const contribute = async (potId: string) => {
    const text = amounts[potId] ?? "";
    const problem = validateContribution(text);
    setContribErr((c) => ({ ...c, [potId]: problem ?? "" }));
    setFailed(false);
    if (problem !== null) return;
    const amount = parseAmountEgp(text);
    if (amount === null) return;
    try {
      await props.port.contribute(potId, amount, newIdempotencyKey());
      setAmounts((a) => ({ ...a, [potId]: "" }));
      props.onChanged();
    } catch {
      setFailed(true);
    }
  };

  return (
    <Section title={t("giftCards.pots.heading")}>
      <Text variant="caption" secondary>{t("giftCards.pots.note")}</Text>
      {props.snap.pots.length === 0 ? <Text secondary>{t("giftCards.pots.empty")}</Text> : null}
      {props.snap.pots.map((p) => {
        const pct = potProgressPct(p);
        const problem = contribErr[p.id];
        return (
          <View key={p.id} style={{ gap: spacing.xs }}>
            <Text>{p.title}</Text>
            <ProgressBar
              pct={pct}
              name={t("giftCards.pots.progressName", { title: p.title })}
              value={t("giftCards.pots.progressValue", { raised: props.money(p.raised), target: props.money(p.target) })}
            />
            <Text variant="caption" secondary>
              {`${t("giftCards.pots.progressValue", { raised: props.money(p.raised), target: props.money(p.target) })} . ${t(`giftCards.pots.status.${p.status}`)} . ${t("giftCards.pots.closesOn", { date: formatCairoDate(Date.parse(`${p.closesOn}T12:00:00Z`), props.locale) })}`}
            </Text>
            {p.status === "OPEN" ? (
              <>
                <TextField
                  label={t("giftCards.pots.contributeLabel", { title: p.title })}
                  helper={t("giftCards.pots.contributeHelper", { min: props.money(MIN_CONTRIBUTION) })}
                  value={amounts[p.id] ?? ""}
                  onChangeText={(v) => setAmounts((a) => ({ ...a, [p.id]: v }))}
                  keyboardType="numeric"
                  {...opt("error", problem === undefined || problem === "" ? undefined : t(`giftCards.pots.contributeError.${problem}`))}
                />
                <Button variant="secondary" title={t("giftCards.pots.contribute")} accessibilityLabel={t("giftCards.pots.contributeName", { title: p.title })} onPress={() => void contribute(p.id)} />
              </>
            ) : null}
            <Divider />
          </View>
        );
      })}
      {props.canCreate ? (
        <>
          <Eyebrow color="textPrimary" secondary={false}>{t("giftCards.pots.newHeading")}</Eyebrow>
          <TextField label={t("giftCards.pots.titleLabel")} value={title} onChangeText={setTitle} {...opt("error", err("titleRequired"))} />
          <TextField
            label={t("giftCards.pots.targetLabel", { currency: t("common.currency") })}
            value={target}
            onChangeText={setTarget}
            keyboardType="numeric"
            {...opt("error", err("targetInvalid") ?? err("targetTooLow") ?? err("targetTooHigh"))}
          />
          <TextField
            label={t("giftCards.pots.closesLabel")}
            helper={t("giftCards.purchase.scheduleHelper")}
            value={closes}
            onChangeText={setCloses}
            {...opt("error", err("closesInvalid") ?? err("closesPast"))}
          />
          {failed ? <Banner tone="error" message={t("giftCards.actionFailed")} /> : null}
          <Button title={t("giftCards.pots.create")} onPress={() => void create()} />
        </>
      ) : null}
    </Section>
  );
}

function MyCards(props: { snap: GiftSnapshot; port: GiftCardsPort; money: Money; locale: DisplayLocale; onChanged: () => void }) {
  const { t } = useTranslation();
  const [failed, setFailed] = useState(false);
  const doVoid = async (id: string) => {
    setFailed(false);
    try {
      await props.port.voidCard(id, newIdempotencyKey());
      props.onChanged();
    } catch {
      setFailed(true);
    }
  };
  if (props.snap.cards.length === 0) return null;
  return (
    <Section title={t("giftCards.mine.heading")}>
      {failed ? <Banner tone="error" message={t("giftCards.actionFailed")} /> : null}
      {props.snap.cards.map((c) => (
        <View key={c.id} style={{ gap: spacing.xs }}>
          <Text variant="headline" numeric>{t("giftCards.mine.line", { design: t(`giftCards.design.${c.design}`), last4: c.last4, amount: props.money(c.amount) })}</Text>
          <Text variant="caption" secondary>
            {[
              t(`giftCards.status.${c.status}`),
              c.expiresAt === null ? null : t("giftCards.mine.expires", { date: formatCairoDate(c.expiresAt, props.locale) }),
            ].filter((s): s is string => s !== null).join(" . ")}
          </Text>
          {canVoid(c) ? (
            <Button
              variant="secondary"
              title={t("giftCards.mine.void")}
              accessibilityLabel={t("giftCards.mine.voidName", { last4: c.last4 })}
              onPress={() => void doVoid(c.id)}
            />
          ) : null}
          <Divider />
        </View>
      ))}
    </Section>
  );
}

/**
 * Nothing renders until a load succeeds, and nothing renders at all when both kill switches are off.
 * Dev fixtures only; production wiring replaces the port when the API client lands.
 */
export function GiftCardsScreen(props: { port?: GiftCardsPort; now?: () => number }) {
  const { t, i18n } = useTranslation();
  const router = useRouter();
  const locale: DisplayLocale = i18n.language === "en" ? "en" : "ar";
  const port = useMemo<GiftCardsPort>(() => props.port ?? getFeaturePorts().giftCards, [props.port]);
  const [state, setState] = useState<GiftScreenState>({ status: "loading" });
  const currency = t("common.currency");
  const money = useCallback<Money>((m) => formatMoney(m, locale, currency), [locale, currency]);
  const num = useCallback<Num>((n) => localizeDigits(String(n), locale), [locale]);

  const load = useCallback(async (silent = false) => {
    if (!silent) setState({ status: "loading" });
    try {
      setState({ status: "ready", snapshot: await port.load() });
    } catch (e) {
      setState(giftFailureState(e));
    }
  }, [port]);
  useEffect(() => { void load(); }, [load]);

  const now = (props.now ?? Date.now)();
  if (state.status === "ready") {
    const vis = giftVisibility(state.snapshot.capabilities);
    if (!vis.visible) return null;
    const snap = state.snapshot;
    return (
      <Screen title={t("giftCards.title")} onBack={() => router.back()} backLabel={t("common.back")}>
        <Reveal index={0}><View style={{ alignItems: "center" }}><Illustration name="giftBox" size={96} /></View></Reveal>
        {vis.redeem ? <Redeem port={port} money={money} num={num} onChanged={() => void load(true)} /> : null}
        {vis.purchase ? <Purchase snap={snap} port={port} money={money} num={num} now={now} onChanged={() => void load(true)} /> : null}
        <MyCards snap={snap} port={port} money={money} locale={locale} onChanged={() => void load(true)} />
        {vis.purchase || snap.pots.length > 0 ? (
          <Pots snap={snap} port={port} money={money} num={num} locale={locale} now={now} canCreate={vis.purchase} onChanged={() => void load(true)} />
        ) : null}
      </Screen>
    );
  }
  return (
    <Screen title={t("giftCards.title")} onBack={() => router.back()} backLabel={t("common.back")}>
      {state.status === "loading" ? (
        <View accessibilityRole="progressbar" accessibilityLabel={t("giftCards.loading")} style={{ gap: 14 }}>
          <Skeleton height={140} radius={18} />
          <Skeleton width="60%" height={20} />
          <Skeleton height={48} radius={14} />
        </View>
      ) : null}
      {state.status === "error" ? (
        <ErrorState
          offline={state.offline}
          title={t(state.offline ? "giftCards.offlineTitle" : "giftCards.errorTitle")}
          description={t(state.offline ? "giftCards.offlineBody" : "giftCards.errorBody")}
          retryTitle={t("common.retry")}
          onRetry={() => void load()}
        />
      ) : null}
    </Screen>
  );
}
