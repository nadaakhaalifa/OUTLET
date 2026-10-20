import { useEffect, useState } from "react";
import { Linking, View } from "react-native";
import { useTranslation } from "react-i18next";
import { Banner, Button, Card, Checkbox, Divider, Eyebrow, Icon, Text, TextField, useTheme } from "../../../ui";
import { CopyField, ErrorNote, FlowScreen, copyText } from "../components";
import { useAction, useBrandApply } from "../context";
import { useFlowNav } from "../nav";
import { isValidOtp, stepProgress, toLatinDigits, type TotpEnrolment } from "../model";

type Phase = "choose" | "totp" | "recovery" | "done" | "assert";

/** Strong factor: passkey when the build supports it, otherwise authenticator app, with recovery codes shown once. */
export function FactorScreen() {
  const { t } = useTranslation();
  const { spacing } = useTheme();
  const s = useBrandApply();
  const nav = useFlowNav();
  const act = useAction();
  const [phase, setPhase] = useState<Phase>(s.needsAssert ? "assert" : s.strongFactor ? "done" : "choose");
  const [passkeyOk, setPasskeyOk] = useState<boolean | null>(null);
  const [totp, setTotp] = useState<TotpEnrolment | null>(null);
  const [code, setCode] = useState("");
  const [saved, setSaved] = useState(false);
  useEffect(() => { s.rememberStep("factor"); }, [s.rememberStep]);
  useEffect(() => { void s.kit.passkey.isSupported().then(setPasskeyOk, () => setPasskeyOk(false)); }, [s.kit.passkey]);

  const finish = () => {
    s.setSession({ strongFactor: true, needsAssert: false });
    // A returning brand lands on its status once submitted, otherwise where the draft left off.
    if (s.app !== null && s.app.status !== "DRAFT") nav.replace("status");
    else nav.next("factor");
  };

  const startTotp = () => void act.run(async () => { setTotp(await s.kit.port.totpEnrol()); setCode(""); setPhase("totp"); });
  const confirmTotp = () => void act.run(async () => { await s.kit.port.totpConfirm(toLatinDigits(code).trim()); s.setSession({ strongFactor: true }); setPhase("recovery"); });
  const assert = () => void act.run(async () => { await s.kit.port.totpAssert(toLatinDigits(code).trim()); finish(); });
  const passkey = () => void act.run(async () => {
    const o = await s.kit.port.passkeyOptions();
    const credential = await s.kit.passkey.create(o.publicKey);
    await s.kit.port.passkeyRegister({ challengeId: o.challengeId, credential });
    s.setSession({ strongFactor: true });
    setPhase("done");
  });

  const codeField = <TextField label={t("brandApply.factor.code")} value={code} onChangeText={(v) => setCode(toLatinDigits(v).replace(/[^0-9]/g, "").slice(0, 6))} keyboardType="numeric" maxLength={6} autoFocus testID="brand-factor-code" />;

  if (phase === "assert") {
    return (
      <FlowScreen eyebrow={t("brandApply.factor.eyebrow")} title={t("brandApply.factor.assertTitle")} body={t("brandApply.factor.assertBody")} onBack={nav.back}
        footer={<Button title={t("brandApply.factor.assertAction")} loading={act.busy} disabled={!isValidOtp(code)} onPress={assert} testID="brand-factor-assert" />}>
        {codeField}
        <ErrorNote code={act.error} />
      </FlowScreen>
    );
  }

  if (phase === "recovery" && totp !== null) {
    return (
      <FlowScreen eyebrow={t("brandApply.factor.eyebrow")} title={t("brandApply.factor.recoveryTitle")} body={t("brandApply.factor.recoveryBody")}
        footer={<Button title={t("brandApply.factor.recoveryDone")} disabled={!saved} onPress={() => { setTotp(null); finish(); }} testID="brand-factor-recovery-continue" />}>
        <Card variant="elevated" style={{ flexDirection: "row", flexWrap: "wrap", gap: 0 }}>
          {totp.recoveryCodes.map((c) => (
            <View key={c} style={{ width: "50%", paddingVertical: spacing.md }}>
              <Text variant="callout" numeric selectable style={{ writingDirection: "ltr", /* physical-direction: Latin code, always read left to right */ textAlign: "left", letterSpacing: 1.2 }}>{c}</Text>
            </View>
          ))}
        </Card>
        <Button variant="secondary" icon="copy-outline" title={t("brandApply.factor.recoveryCopyAll")} onPress={() => void copyText(totp.recoveryCodes.join("\n"))} />
        <Checkbox label={t("brandApply.factor.recoverySaved")} value={saved} onValueChange={setSaved} />
      </FlowScreen>
    );
  }

  if (phase === "totp" && totp !== null) {
    return (
      <FlowScreen eyebrow={t("brandApply.factor.eyebrow")} title={t("brandApply.factor.totpTitle")} onBack={() => setPhase("choose")}
        footer={<Button title={t("brandApply.factor.confirm")} loading={act.busy} disabled={!isValidOtp(code)} onPress={confirmTotp} testID="brand-factor-confirm" />}>
        <Text secondary>{t("brandApply.factor.totpStep1")}</Text>
        <Button variant="secondary" icon="open-outline" title={t("brandApply.factor.openApp")} onPress={() => void Linking.openURL(totp.otpauthUri).catch(() => undefined)} />
        <CopyField label={t("brandApply.factor.keyLabel")} value={totp.secret} copyLabel={t("brandApply.common.copy")} />
        <Text secondary>{t("brandApply.factor.totpStep2")}</Text>
        {codeField}
        <ErrorNote code={act.error} />
      </FlowScreen>
    );
  }

  if (phase === "done") {
    return (
      <FlowScreen eyebrow={t("brandApply.factor.eyebrow")} title={t("brandApply.factor.enrolledTitle")} body={t("brandApply.factor.enrolledBody")} progress={stepProgress("factor", nav.steps)}
        footer={<Button title={t("brandApply.common.continue")} onPress={finish} />}>
        <Icon name="shield-checkmark-outline" size={40} />
      </FlowScreen>
    );
  }

  return (
    <FlowScreen eyebrow={t("brandApply.factor.eyebrow")} title={t("brandApply.factor.title")} body={t("brandApply.factor.why")} progress={stepProgress("factor", nav.steps)} onBack={nav.back}>
      <Divider />
      {passkeyOk === true ? (
        <View style={{ gap: spacing.md }}>
          <View style={{ gap: spacing.xs }}>
            <Eyebrow secondary>{t("brandApply.factor.passkeyTitle")}</Eyebrow>
            <Text secondary>{t("brandApply.factor.passkeyBody")}</Text>
          </View>
          <Button title={t("brandApply.factor.passkeyAction")} icon="finger-print-outline" loading={act.busy} onPress={passkey} />
          <Divider />
        </View>
      ) : passkeyOk === false ? <Banner tone="info" message={t("brandApply.factor.passkeyUnsupported")} /> : null}
      <View style={{ gap: spacing.md }}>
        <Eyebrow secondary>{t("brandApply.factor.totpTitle")}</Eyebrow>
        <Button variant={passkeyOk === true ? "secondary" : "primary"} title={t("brandApply.factor.start")} icon="keypad-outline" loading={act.busy} onPress={startTotp} testID="brand-factor-start-totp" />
      </View>
      <ErrorNote code={act.error} />
    </FlowScreen>
  );
}
