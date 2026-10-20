import { useEffect, useState } from "react";
import { View } from "react-native";
import { useTranslation } from "react-i18next";
import { Banner, Button, Card, Checkbox, Eyebrow, Icon, Text, useTheme } from "../../../ui";
import { ErrorNote, FlowScreen, useDigits } from "../components";
import { useAction, useBrandApply } from "../context";
import { useFlowNav } from "../nav";
import { buildChecklist, detailsComplete, domainRequired, slotFromServer, stepProgress, submitBlockers, type SubmitBlocker, type Step } from "../model";
import { countryName, findCountry, flagEmoji } from "../countries";

const FIX: Record<SubmitBlocker, Step | null> = { no_strong_factor: "factor", details_incomplete: "details", documents_incomplete: "documents", domain_unverified: "website", not_declared: null };

export function ReviewScreen() {
  const { t } = useTranslation();
  const { colors, spacing } = useTheme();
  const digits = useDigits();
  const s = useBrandApply();
  const nav = useFlowNav();
  const act = useAction();
  const [declared, setDeclared] = useState(false);
  useEffect(() => { s.rememberStep("review"); }, [s.rememberStep]);

  const app = s.app;
  const req = s.requirements;
  const values = app?.values ?? {};
  const slots = Object.fromEntries((app?.documents ?? []).map((d) => [d.requirementCode, slotFromServer(d)]));
  const checklist = req !== null ? buildChecklist(req.documents, slots) : null;
  const domain = values["website_domain"] ?? "";
  const blockers = submitBlockers({
    strongFactor: s.strongFactor && !s.needsAssert,
    detailsOk: req !== null && detailsComplete(req.fields, values),
    checklistComplete: checklist?.complete ?? false,
    domainRequired: domainRequired(req, domain),
    domainVerified: app?.domain?.status === "verified",
    declared,
  });
  const country = findCountry(s.draft.country ?? "");
  const rows: Array<[string, string]> = [
    [t("brandApply.review.brand"), s.draft.brandName ?? app?.brandName ?? ""],
    [t("brandApply.review.kind"), t(s.draft.kind === "global" ? "brandApply.type.global.title" : "brandApply.type.local.title")],
    [t("brandApply.review.country"), country !== undefined ? `${flagEmoji(country.code)} ${countryName(country, s.lang)}` : ""],
    ...(values["legal_name"] !== undefined ? [[t("brandApply.review.legal"), values["legal_name"]] as [string, string]] : []),
    [t("brandApply.review.documents"), digits(t("brandApply.review.docsCount", { count: app?.documents.length ?? 0 }))],
    ...(domain !== "" ? [[t("brandApply.review.website"), domain] as [string, string]] : []),
    [t("brandApply.review.factor"), t(s.strongFactor ? "brandApply.review.factorOn" : "brandApply.review.factorOff")],
  ];

  const submit = () => {
    if (blockers.length > 0 || s.draft.draftId === null) return;
    const id = s.draft.draftId;
    void act.run(async () => { const a = await s.kit.port.submit(id); s.setApp(a); s.patchDraft({ step: "review" }); nav.replace("status"); });
  };

  return (
    <FlowScreen
      eyebrow={t("brandApply.review.eyebrow")} title={t("brandApply.review.title")} body={t("brandApply.review.body")}
      progress={stepProgress("review", nav.steps)} onBack={nav.back}
      footer={<Button title={t("brandApply.review.submit")} loading={act.busy} disabled={blockers.length > 0} onPress={submit} testID="brand-review-submit" />}
    >
      <Card variant="elevated" style={{ paddingVertical: spacing.xs }}>
        {rows.map(([label, value], i) => (
          <View key={label} style={{ gap: spacing.xs, paddingVertical: spacing.md, borderBottomWidth: i < rows.length - 1 ? 1 : 0, borderBottomColor: colors.border }}>
            <Eyebrow secondary>{label}</Eyebrow>
            <Text variant="headline">{value}</Text>
          </View>
        ))}
      </Card>
      <View style={{ gap: spacing.sm }}>
        <Eyebrow secondary>{t("brandApply.review.declarationShort")}</Eyebrow>
        <Checkbox label={t("brandApply.review.declaration")} value={declared} onValueChange={setDeclared} />
      </View>
      {blockers.filter((b) => b !== "not_declared").map((b) => (
        <View key={b} style={{ flexDirection: "row", alignItems: "center", gap: spacing.md }}>
          <Icon name="alert-circle-outline" size={20} color="danger" />
          <View style={{ flex: 1 }}><Text variant="callout">{t(`brandApply.review.blocker.${b}`)}</Text></View>
          {FIX[b] !== null ? <Button variant="ghost" fullWidth={false} title={t("brandApply.review.fix")} onPress={() => { const st = FIX[b]; if (st !== null) nav.to(st); }} /> : null}
        </View>
      ))}
      <ErrorNote code={act.error} onSignIn={() => nav.replace("account")} />
      {app === null ? <Banner tone="warning" message={t("brandApply.errors.not_found")} /> : null}
    </FlowScreen>
  );
}
