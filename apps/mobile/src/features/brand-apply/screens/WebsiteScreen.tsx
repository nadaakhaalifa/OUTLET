import { useEffect, useState } from "react";
import { View } from "react-native";
import { useTranslation } from "react-i18next";
import { Banner, Button, Icon, SegmentedControl, Text, TextField, useTheme } from "../../../ui";
import { CopyField, ErrorNote, FlowScreen, useDay } from "../components";
import { useAction, useBrandApply } from "../context";
import { useFlowNav } from "../nav";
import { domainRequired, isEditable, isValidOtp, stepProgress, toLatinDigits, type DomainState } from "../model";

export function WebsiteScreen() {
  const { t } = useTranslation();
  const { spacing } = useTheme();
  const day = useDay();
  const s = useBrandApply();
  const nav = useFlowNav();
  const act = useAction();
  const fixMode = s.app?.status === "NEEDS_INFO";
  const domain = s.app?.values["website_domain"] ?? "";
  const [method, setMethod] = useState<"dns_txt" | "email">("dns_txt");
  const [state, setState] = useState<DomainState | null>(s.app?.domain ?? null);
  const [code, setCode] = useState("");
  const [checked, setChecked] = useState(false);
  const draftId = s.draft.draftId;
  const editable = s.app === null ? true : isEditable(s.app);
  useEffect(() => { if (!fixMode) s.rememberStep("website"); }, [s.rememberStep, fixMode]);

  const start = () => { if (draftId !== null) void act.run(async () => { setState(await s.kit.port.startDomain(draftId, method)); setChecked(false); }); };
  const check = () => { if (draftId !== null) void act.run(async () => { setState(await s.kit.port.confirmDomain(draftId, method === "email" ? toLatinDigits(code).trim() : undefined)); setChecked(true); }); };
  const required = domainRequired(s.requirements, domain);
  const verified = state?.status === "verified";
  const leave = () => { if (fixMode) nav.back(); else { s.patchDraft({ step: "review" }); nav.next("website"); } };

  if (domain === "") {
    return (
      <FlowScreen eyebrow={t("brandApply.website.eyebrow")} title={t("brandApply.website.title")} body={t("brandApply.website.noDomain")} progress={fixMode ? undefined : stepProgress("website", nav.steps)} onBack={nav.back}
        footer={<Button title={t("brandApply.website.skip")} onPress={leave} />} />
    );
  }

  return (
    <FlowScreen
      eyebrow={t("brandApply.website.eyebrow")} title={t("brandApply.website.title")} body={t("brandApply.website.body")}
      progress={fixMode ? undefined : stepProgress("website", nav.steps)} onBack={nav.back}
      footer={<Button title={fixMode ? t("brandApply.common.done") : t("brandApply.common.continue")} disabled={required && !verified} onPress={leave} testID="brand-website-continue" />}
    >
      <CopyField label={t("brandApply.website.domain")} value={domain} copyLabel={t("brandApply.common.copy")} />
      {state === null || state.status === "expired" || state.status === "failed" ? (
        <View style={{ gap: spacing.lg }}>
          <SegmentedControl options={[t("brandApply.website.dnsTitle"), t("brandApply.website.emailTitle")]} index={method === "dns_txt" ? 0 : 1} onChange={(i) => setMethod(i === 0 ? "dns_txt" : "email")} />
          {state?.status === "expired" ? <Banner tone="warning" message={t("brandApply.website.expired")} /> : null}
          {state?.status === "failed" ? <Banner tone="warning" message={t("brandApply.website.failed")} /> : null}
          <Button title={t("brandApply.website.start")} loading={act.busy} disabled={!editable} onPress={start} testID="brand-website-start" />
        </View>
      ) : (
        <View style={{ gap: spacing.md }}>
          {state.method === "dns_txt" ? (
            <>
              <Text variant="caption" secondary>{t("brandApply.website.recordType")}</Text>
              <CopyField label={t("brandApply.website.recordName")} value={state.txtName ?? ""} copyLabel={t("brandApply.common.copy")} />
              <CopyField label={t("brandApply.website.recordValue")} value={state.txtValue ?? ""} copyLabel={t("brandApply.common.copy")} />
            </>
          ) : (
            <>
              <Text secondary>{t("brandApply.website.sentTo", { email: state.emailMasked ?? "" })}</Text>
              <TextField label={t("brandApply.website.code")} value={code} onChangeText={(v) => setCode(toLatinDigits(v).replace(/[^0-9]/g, "").slice(0, 6))} keyboardType="numeric" maxLength={6} />
            </>
          )}
          {state.expiresAt !== undefined && !verified ? <Text variant="caption" secondary>{t("brandApply.website.expires", { date: day(state.expiresAt) })}</Text> : null}
          {verified ? (
            <View style={{ flexDirection: "row", gap: spacing.sm, alignItems: "center" }}><Icon name="checkmark-circle" size={22} color="savings" /><Text variant="headline">{t("brandApply.website.verified")}</Text></View>
          ) : (
            <>
              {checked && state.status === "pending" ? <Banner tone="info" message={t("brandApply.website.pending")} /> : null}
              <Button variant="secondary" title={state.method === "email" ? t("brandApply.website.confirm") : t("brandApply.website.check")} loading={act.busy}
                disabled={state.method === "email" && !isValidOtp(code)} onPress={check} testID="brand-website-check" />
            </>
          )}
        </View>
      )}
      <ErrorNote code={act.error} />
    </FlowScreen>
  );
}
