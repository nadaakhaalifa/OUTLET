import { useEffect, useState } from "react";
import { View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { useTranslation } from "react-i18next";
import { Button, SegmentedControl, Text, TextField, useTheme } from "../../../ui";
import { Ticker } from "../../../components/Ticker";
import { ErrorNote, FlowScreen, useDigits } from "../components";
import { useAction, useBrandApply } from "../context";
import { useFlowNav } from "../nav";
import { isValidOtp, normalizePhone, stepProgress, toLatinDigits, validateAccount, type Lang } from "../model";

/** Brand name, phone and email, then the OTP. Also the re-login screen for a returning brand (`?signin=1`). */
export function AccountScreen() {
  const { t } = useTranslation();
  const { spacing } = useTheme();
  const digits = useDigits();
  const s = useBrandApply();
  const nav = useFlowNav();
  const params = useLocalSearchParams<{ signin?: string }>();
  const signIn = params.signin === "1" || s.draft.draftId !== null;
  const [phase, setPhase] = useState<"form" | "otp">("form");
  const [shown, setShown] = useState(false);
  const [challenge, setChallenge] = useState<{ id: string; resendAt: number } | null>(null);
  const [code, setCode] = useState("");
  const [lang, setLang] = useState<Lang>(s.lang);
  const act = useAction();
  useEffect(() => { s.rememberStep("account"); }, [s.rememberStep]);

  const errors = validateAccount(s.account);
  const err = (k: keyof typeof errors) => (shown && errors[k] !== undefined ? t(`brandApply.errors.${errors[k]}`) : undefined);
  const phone = normalizePhone(s.account.phone);

  const send = () => {
    setShown(true);
    if (Object.keys(errors).length > 0) return;
    void act.run(async () => {
      const c = await s.kit.port.requestOtp({ phone, email: s.account.email.trim(), locale: lang });
      setChallenge({ id: c.challengeId, resendAt: Date.now() + c.resendAfter * 1000 });
      setCode("");
      setPhase("otp");
    });
  };

  const verify = () => {
    if (challenge === null || !isValidOtp(code)) return;
    void act.run(async () => {
      const r = await s.kit.port.verifyOtp({ challengeId: challenge.id, code: toLatinDigits(code).trim() });
      s.setSession({ otpVerified: true, strongFactor: r.strongFactorEnrolled, needsAssert: r.strongFactorEnrolled });
      let app = s.app;
      if (s.draft.draftId === null) {
        if (s.draft.kind === null || s.draft.country === null) { nav.replace("type"); return; }
        app = await s.kit.port.createApplication({ kind: s.draft.kind, country: s.draft.country, brandName: s.account.brandName.trim() });
        s.setApp(app);
        s.patchDraft({ draftId: app.id, brandName: s.account.brandName.trim(), step: "factor" });
      } else if (app === null) {
        app = await s.kit.port.getApplication(s.draft.draftId);
        s.setApp(app);
      }
      if (app !== null && app.status !== "DRAFT" && !r.strongFactorEnrolled) { nav.replace("status"); return; }
      nav.next("account");
    });
  };


  if (phase === "otp") {
    return (
      <FlowScreen
        eyebrow={t("brandApply.account.otpEyebrow")} title={t("brandApply.account.otpTitle")}
        body={t("brandApply.account.otpBody", { phone: digits(phone) })}
        onBack={() => setPhase("form")}
        footer={<Button title={t("brandApply.account.verify")} loading={act.busy} disabled={!isValidOtp(code)} onPress={verify} testID="brand-otp-verify" />}
      >
        <TextField label={t("brandApply.account.code")} value={code} onChangeText={(v) => setCode(toLatinDigits(v).replace(/[^0-9]/g, "").slice(0, 6))} keyboardType="numeric" maxLength={6} autoFocus testID="brand-otp-code" />
        <ErrorNote code={act.error} />
        <View style={{ gap: spacing.sm }}>
          <Ticker nowFn={Date.now} render={(now) => {
            const wait = challenge === null ? 0 : Math.max(0, Math.ceil((challenge.resendAt - now) / 1000));
            return <Button variant="ghost" title={wait > 0 ? t("brandApply.account.resendIn", { seconds: digits(String(wait)) }) : t("brandApply.account.resend")} disabled={wait > 0 || act.busy} onPress={send} />;
          }} />
          <Button variant="ghost" title={t("brandApply.account.changeNumber")} onPress={() => setPhase("form")} />
        </View>
      </FlowScreen>
    );
  }

  return (
    <FlowScreen
      eyebrow={t(signIn ? "brandApply.account.signInTitle" : "brandApply.account.eyebrow")}
      title={signIn ? t("brandApply.account.signInTitle") : t("brandApply.account.title")}
      body={signIn ? t("brandApply.account.signInBody") : t("brandApply.account.body")}
      progress={signIn ? undefined : stepProgress("account", nav.steps)}
      onBack={nav.back}
      footer={<Button title={t("brandApply.account.sendCode")} loading={act.busy} onPress={send} testID="brand-account-send" />}
    >
      <TextField label={t("brandApply.account.brandName")} helper={t("brandApply.account.brandNameHelper")} value={s.account.brandName} onChangeText={(v) => s.setAccount({ brandName: v })} error={err("brandName")} disabled={s.draft.draftId !== null} testID="brand-account-name" />
      <TextField label={t("brandApply.account.phone")} helper={t("brandApply.account.phoneHelper")} value={s.account.phone} onChangeText={(v) => s.setAccount({ phone: v })} keyboardType="phone-pad" error={err("phone")} testID="brand-account-phone" />
      <TextField label={t("brandApply.account.email")} value={s.account.email} onChangeText={(v) => s.setAccount({ email: v })} keyboardType="email-address" error={err("email")} testID="brand-account-email" />
      <View style={{ gap: spacing.sm }}>
        <Text variant="caption" secondary>{t("brandApply.account.language")}</Text>
        <SegmentedControl options={["العربية", "English"]} index={lang === "ar" ? 0 : 1} onChange={(i) => setLang(i === 0 ? "ar" : "en")} />
      </View>
      <ErrorNote code={act.error} onSignIn={undefined} />
    </FlowScreen>
  );
}
