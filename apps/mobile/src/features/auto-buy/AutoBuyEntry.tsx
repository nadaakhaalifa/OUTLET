import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { View } from "react-native";
import { useTranslation } from "react-i18next";
import { Banner, BottomSheet, Button, Checkbox, Divider, Eyebrow, Radio, SegmentedControl, Skeleton, Text, TextField, useToast } from "../../ui";
import { getFeaturePorts } from "../../state/ports";
import { formatMoney, localizeDigits } from "../money-display";
import { newIdempotencyKey } from "../plus/idempotency";
import type { PlusPort } from "../plus/model";
import {
  EXPIRY_CHOICES_DAYS, isPlusMember, ruleSheetAccess, validateDraft, validateNotify,
  type AutoBuyCapabilities, type AutoBuyMode, type AutoBuyPort, type AutoBuyTerms, type DisplayLocale, type DraftError,
} from "./model";
import { Chip } from "../search/Chip";

type TermsState = { readonly status: "idle" | "loading" | "failed" } | { readonly status: "ready"; readonly terms: AutoBuyTerms };

/**
 * PDP entry: "Notify me at target price" for everyone, plus the auto-buy rule form for Plus members whose session
 * can confirm it. The consent checkbox starts unticked and the mandate text is rendered exactly as the server sent it.
 */
export function AutoBuyEntry(props: {
  productId: string;
  skuId: string | null;
  sizeLabel: string | null;
  title: string;
  price: bigint;
  port?: AutoBuyPort;
  plus?: PlusPort;
  now?: () => number;
}) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const locale: DisplayLocale = i18n.language === "en" ? "en" : "ar";
  const port = useMemo<AutoBuyPort>(() => props.port ?? getFeaturePorts().autoBuy, [props.port]);
  const plusPort = useMemo<PlusPort>(() => props.plus ?? getFeaturePorts().plus, [props.plus]);
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState(0);
  const [caps, setCaps] = useState<AutoBuyCapabilities | null>(null);
  const [plus, setPlus] = useState<boolean | null>(null);
  const [terms, setTerms] = useState<TermsState>({ status: "idle" });
  const [targetText, setTargetText] = useState("");
  const [maxText, setMaxText] = useState("");
  const [expiryDays, setExpiryDays] = useState<number>(EXPIRY_CHOICES_DAYS[0] ?? 30);
  const [mode, setMode] = useState<AutoBuyMode>("notifyConfirm");
  // Never pre-ticked (spec B1 / A2): the shopper has to tick it for this exact mandate version.
  const [agreed, setAgreed] = useState(false);
  const [showErrors, setShowErrors] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState<"alert" | "rule" | null>(null);
  const key = useRef<string | null>(null);

  const currency = t("common.currency");
  const money = (m: bigint) => formatMoney(m, locale, currency);
  const num = (n: number) => localizeDigits(String(n), locale);

  const access = ruleSheetAccess(plus, caps);
  const showRuleTab = access.kind === "full" || access.kind === "stepUp";

  const loadTerms = useCallback(async () => {
    setTerms({ status: "loading" });
    try {
      setTerms({ status: "ready", terms: await port.terms(locale) });
    } catch {
      setTerms({ status: "failed" });
    }
  }, [port, locale]);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    void port.capabilities().then((c) => { if (alive) setCaps(c); }, () => { if (alive) setCaps(null); });
    void plusPort.load().then((s) => { if (alive) setPlus(isPlusMember(s.membership)); }, () => { if (alive) setPlus(null); });
    return () => { alive = false; };
  }, [open, port, plusPort]);

  useEffect(() => {
    if (open && tab === 1 && access.kind === "full" && terms.status === "idle") void loadTerms();
  }, [open, tab, access.kind, terms.status, loadTerms]);

  const reset = () => {
    setTargetText(""); setMaxText(""); setAgreed(false); setShowErrors(false); setProblem(null); setDone(null); setMode("notifyConfirm");
    key.current = null;
  };
  const close = () => { setOpen(false); reset(); setTerms({ status: "idle" }); };

  const errorText = (e: DraftError): string => t(`autoBuy.error.${e}`, { price: money(props.price) });
  const notifyCheck = validateNotify(targetText, props.price, props.skuId);
  const draftCheck = validateDraft({
    targetText, maxText, currentPrice: props.price, expiryDays, consent: agreed,
    terms: terms.status === "ready" ? terms.terms : null, skuId: props.skuId, sizeLabel: props.sizeLabel,
    mode, savedCard: caps?.savedCard ?? null, nowMs: (props.now ?? Date.now)(), locale,
  });
  const targetError = (errs: readonly DraftError[]) => errs.find((e) => e === "targetInvalid" || e === "targetNotBelowPrice");
  const maxError = (errs: readonly DraftError[]) => errs.find((e) => e === "maxInvalid" || e === "maxBelowTarget");

  const submitAlert = async () => {
    setShowErrors(true);
    if (!notifyCheck.ok || props.skuId === null) return;
    setBusy(true);
    setProblem(null);
    key.current ??= newIdempotencyKey();
    try {
      await port.notifyAtTarget(props.productId, props.skuId, notifyCheck.target, key.current);
      key.current = null;
      setDone("alert");
      toast.show(t("autoBuy.alertSaved"), "success");
    } catch {
      setProblem(t("autoBuy.actionFailed"));
    } finally {
      setBusy(false);
    }
  };

  const submitRule = async () => {
    setShowErrors(true);
    if (!draftCheck.ok) return;
    setBusy(true);
    setProblem(null);
    key.current ??= newIdempotencyKey();
    try {
      const out = await port.create(draftCheck.draft, key.current);
      if (out.kind === "created") {
        key.current = null;
        setDone("rule");
        toast.show(t("autoBuy.ruleArmed"), "success");
      } else if (out.kind === "termsStale") {
        key.current = null;
        setAgreed(false);
        setProblem(t("autoBuy.termsChanged"));
        await loadTerms();
      } else {
        key.current = null;
        setProblem(t(`autoBuy.refused.${out.reason}`));
      }
    } catch {
      setProblem(t("autoBuy.actionFailed"));
    } finally {
      setBusy(false);
    }
  };

  const errs = !draftCheck.ok ? draftCheck.errors : [];
  const tErr = showErrors ? targetError(errs) : undefined;
  const mErr = showErrors ? maxError(errs) : undefined;
  const notifyErr = showErrors && !notifyCheck.ok ? notifyCheck.error : undefined;
  const sizeHint = props.skuId === null;

  return (
    <>
      <Button variant="ghost" icon="notifications-outline" title={t("autoBuy.entry")} onPress={() => setOpen(true)} />
      <BottomSheet visible={open} onClose={close} title={t("autoBuy.sheetTitle")} closeLabel={t("common.close")} maxHeightRatio={0.9}>
        {done !== null ? (
          <View style={{ gap: 12 }}>
            <Banner tone="success" message={t(done === "rule" ? "autoBuy.doneRule" : "autoBuy.doneAlert")} />
            <Button variant="secondary" title={t("common.close")} onPress={close} />
          </View>
        ) : (
          <View style={{ gap: 14 }}>
            <Text variant="callout" secondary>{t("autoBuy.itemLine", { title: props.title, size: props.sizeLabel ?? t("autoBuy.noSize"), price: money(props.price) })}</Text>
            {sizeHint ? <Banner tone="info" message={t("autoBuy.pickSize")} /> : null}
            {showRuleTab ? (
              <SegmentedControl options={[t("autoBuy.tab.notify"), t("autoBuy.tab.rule")]} index={tab} onChange={(i) => { setTab(i); setShowErrors(false); setProblem(null); key.current = null; }} />
            ) : null}
            {problem !== null ? <Banner tone="error" message={problem} /> : null}

            {tab === 0 || !showRuleTab ? (
              <View style={{ gap: 12 }}>
                <Text variant="callout" secondary>{t("autoBuy.notifyExplain")}</Text>
                <TextField
                  label={t("autoBuy.targetLabel", { currency })}
                  value={targetText}
                  keyboardType="numeric"
                  onChangeText={setTargetText}
                  helper={t("autoBuy.targetHelper", { price: money(props.price) })}
                  {...(notifyErr !== undefined ? { error: errorText(notifyErr) } : {})}
                />
                {access.kind === "notifyOnly" && access.why === "notPlus" ? <Text variant="caption" secondary>{t("autoBuy.plusOnlyNote")}</Text> : null}
                {access.kind === "notifyOnly" && access.why === "disabled" ? <Text variant="caption" secondary>{t("autoBuy.pausedNote")}</Text> : null}
                <Button variant="brand" title={t("autoBuy.notifyAction")} loading={busy} disabled={busy || sizeHint} onPress={() => void submitAlert()} />
              </View>
            ) : access.kind === "stepUp" ? (
              <View style={{ gap: 10 }}>
                <Eyebrow color="plus">{t("autoBuy.plusEyebrow")}</Eyebrow>
                <Banner tone="info" message={t("autoBuy.stepUp")} />
              </View>
            ) : (
              <View style={{ gap: 14 }}>
                <Eyebrow color="plus">{t("autoBuy.plusEyebrow")}</Eyebrow>
                <Text variant="callout" secondary>{t("autoBuy.ruleIntro")}</Text>
                <TextField
                  label={t("autoBuy.targetLabel", { currency })}
                  value={targetText}
                  keyboardType="numeric"
                  onChangeText={setTargetText}
                  helper={t("autoBuy.targetHelper", { price: money(props.price) })}
                  {...(tErr !== undefined ? { error: errorText(tErr) } : {})}
                />
                <TextField
                  label={t("autoBuy.maxLabel", { currency })}
                  value={maxText}
                  keyboardType="numeric"
                  onChangeText={setMaxText}
                  helper={t("autoBuy.maxHelper")}
                  {...(mErr !== undefined ? { error: errorText(mErr) } : {})}
                />
                <View style={{ gap: 8 }}>
                  <Eyebrow>{t("autoBuy.expiryHeading")}</Eyebrow>
                  <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                    {EXPIRY_CHOICES_DAYS.map((d) => (
                      <Chip key={d} role="radio" label={t("autoBuy.expiryDays", { days: num(d) })} selected={expiryDays === d} onPress={() => setExpiryDays(d)} />
                    ))}
                  </View>
                </View>

                <View style={{ gap: 8 }}>
                  <Eyebrow>{t("autoBuy.modeHeading")}</Eyebrow>
                  {access.kind === "full" && access.offerUnattended ? (
                    <View style={{ gap: 4 }}>
                      <Radio label={t("autoBuy.mode.notifyConfirm")} selected={mode === "notifyConfirm"} onPress={() => setMode("notifyConfirm")} />
                      <Radio label={t("autoBuy.mode.unattended")} selected={mode === "unattended"} onPress={() => setMode("unattended")} />
                    </View>
                  ) : null}
                  <Text variant="callout" secondary>{t(mode === "unattended" ? "autoBuy.explain.unattended" : "autoBuy.explain.notifyConfirm", { card: caps?.savedCard?.label ?? "" })}</Text>
                </View>

                <Divider />
                {terms.status === "loading" || terms.status === "idle" ? (
                  <View accessibilityRole="progressbar" accessibilityLabel={t("autoBuy.termsLoading")} style={{ gap: 8 }}><Skeleton height={12} /><Skeleton height={12} width="80%" /><Skeleton height={12} width="60%" /></View>
                ) : null}
                {terms.status === "failed" ? (
                  <View style={{ gap: 8 }}>
                    <Banner tone="warning" message={t("autoBuy.termsUnavailable")} />
                    <Button variant="secondary" title={t("common.retry")} onPress={() => void loadTerms()} />
                  </View>
                ) : null}
                {terms.status === "ready" ? (
                  <View style={{ gap: 8 }}>
                    <Eyebrow>{t("autoBuy.mandateHeading", { version: num(terms.terms.version) })}</Eyebrow>
                    <Text variant="callout" selectable>{terms.terms.text}</Text>
                  </View>
                ) : null}
                <Divider />
                <Checkbox label={t("autoBuy.consent")} value={agreed} onValueChange={setAgreed} disabled={terms.status !== "ready"} />
                {showErrors && errs.includes("consentMissing") ? <Text variant="caption" color="danger">{t("autoBuy.error.consentMissing")}</Text> : null}
                <Button variant="brand" title={t("autoBuy.armAction")} loading={busy} disabled={busy || sizeHint || terms.status !== "ready"} onPress={() => void submitRule()} />
                <Text variant="caption" secondary>{t("autoBuy.cancelAnytime")}</Text>
              </View>
            )}
          </View>
        )}
      </BottomSheet>
    </>
  );
}
