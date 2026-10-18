import { useCallback, useEffect, useRef, useState } from "react";
import { TextInput, View } from "react-native";
import { useLocalSearchParams, type Href } from "expo-router";
import { useTranslation } from "react-i18next";
import { BottomSheet, Button, Card, EmptyState, Eyebrow, Icon, LoadingState, Reveal, Text, useTheme } from "../../../ui";
import { ErrorNote, FlowScreen, TimelineDot, useDay } from "../components";
import { ApprovalCeremony } from "../ceremony";
import { useAction, useBrandApply } from "../context";
import { useFlowNav } from "../nav";
import { InMemoryBrandApplyPort } from "../fake";
import {
  canOpenDashboard, expectedTime, pickBi, rejectionView, resubmitReady, timeline, validAppealStatement, type AppStatus, type RequestedItem,
} from "../model";

const POLL_MS = 20_000;

/** Home of a brand applicant until approved. Honest: timing comes only from the server's `decision_due_at`. */
export function StatusScreen() {
  const { t } = useTranslation();
  const { colors, spacing, radii } = useTheme();
  const day = useDay();
  const s = useBrandApply();
  const nav = useFlowNav();
  const act = useAction();
  const load = useAction();
  const params = useLocalSearchParams<{ demo?: string }>();
  const [addressed, setAddressed] = useState<ReadonlySet<string>>(new Set());
  const [statement, setStatement] = useState("");
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const demoDone = useRef(false);
  const app = s.app;
  const id = s.draft.draftId ?? app?.id ?? null;
  const portRef = s.kit.port;

  const refresh = useCallback(async () => {
    if (id === null) return;
    const a = await portRef.getApplication(id);
    s.setApp(a);
  }, [id, portRef, s]);

  useEffect(() => {
    if (id === null) return;
    void load.run(async () => {
      if (typeof __DEV__ !== "undefined" && __DEV__ && params.demo !== undefined && !demoDone.current && portRef instanceof InMemoryBrandApplyPort) {
        demoDone.current = true;
        portRef.devSetStatus(id, params.demo as AppStatus);
      }
      await refresh();
    });
  }, [id]);

  const inProgress = app !== null && (app.status === "SUBMITTED" || app.status === "AUTO_CHECKS" || app.status === "IN_REVIEW");
  useEffect(() => {
    if (!inProgress) return;
    const i = setInterval(() => void refresh().catch(() => undefined), POLL_MS);
    return () => clearInterval(i);
  }, [inProgress, refresh]);

  const pull = () => { setRefreshing(true); void refresh().catch(() => undefined).finally(() => setRefreshing(false)); };

  if (app === null) {
    return (
      <FlowScreen eyebrow={t("brandApply.status.eyebrow")} title={t("brandApply.status.title")} onBack={nav.back}>
        {id === null ? (
          <EmptyState title={t("brandApply.status.noApplicationTitle")} description={t("brandApply.status.noApplicationBody", { product: "Z-OUTLET" })} actionTitle={t("brandApply.status.noApplicationStart")} onAction={() => nav.replace("type")} />
        ) : load.error === null ? <LoadingState label={t("brandApply.common.loading")} /> : (
          <View style={{ gap: spacing.md }}><ErrorNote code={load.error} onSignIn={() => nav.replace("account")} /><Button variant="secondary" title={t("brandApply.common.retry")} onPress={() => void load.run(refresh)} /></View>
        )}
      </FlowScreen>
    );
  }

  const tl = timeline(app.status);
  const exp = expectedTime(app, Date.now());
  const rej = rejectionView(app, Date.now());
  const items = app.requestedItems;
  const fixRoute = (i: RequestedItem) => nav.to(i.kind === "document" ? "documents" : i.kind === "domain_verification" ? "website" : "details");
  const headline = t(`brandApply.status.headline.${tl.phase}`, { product: "Z-OUTLET" });
  const approved = canOpenDashboard(app);

  if (approved) {
    return (
      <ApprovalCeremony
        eyebrow={t("brandApply.status.eyebrow")} title={headline} body={t("brandApply.status.approvedBody")}
        cta={t("brandApply.status.openDashboard")} onOpen={() => nav.router.push("/brand-mode" as Href)} testID="brand-open-dashboard"
      />
    );
  }

  const footer = tl.phase === "needs_info" ? (
    <Button title={t("brandApply.status.resubmit")} loading={act.busy} disabled={!resubmitReady(items, addressed)}
      onPress={() => void act.run(async () => { s.setApp(await portRef.resubmit(app.id, { satisfiedCodes: [...addressed] })); setAddressed(new Set()); })} testID="brand-resubmit" />
  ) : tl.phase === "rejected" && rej.canReapplyNow && !rej.canAppeal ? (
    <Button title={t("brandApply.status.startOver")} onPress={() => { s.clearDraft(); nav.replace("type"); }} />
  ) : tl.phase === "draft" ? (
    <Button title={t("brandApply.status.continueDraft")} onPress={() => nav.replace("review")} />
  ) : undefined;

  return (
    <FlowScreen eyebrow={t("brandApply.status.eyebrow")} title={headline} onRefresh={pull} refreshing={refreshing} footer={footer}>
      {tl.phase !== "approved" && tl.phase !== "withdrawn" ? (
        <View accessibilityRole="list">
          {tl.steps.map((st, i) => (
            <Reveal key={st.key} index={i}>
            <View accessible accessibilityLabel={`${t(`brandApply.status.timeline.${st.key}`)}, ${t(`brandApply.status.state.${st.state}`)}`}
              style={{ flexDirection: "row", gap: spacing.lg, minHeight: 56 }}>
              <View style={{ alignItems: "center" }}>
                <TimelineDot state={st.state} />
                {i < tl.steps.length - 1 ? <View style={{ flex: 1, width: 2, borderRadius: 1, backgroundColor: colors.fill, marginVertical: 4 }} /> : null}
              </View>
              <View style={{ flex: 1, paddingBottom: spacing.lg }}>
                <Text variant="headline" color={st.state === "upcoming" ? "textSecondary" : "textPrimary"}>{t(`brandApply.status.timeline.${st.key}`)}</Text>
                <Text variant="caption" secondary>{t(`brandApply.status.state.${st.state}`)}</Text>
              </View>
            </View>
            </Reveal>
          ))}
        </View>
      ) : null}

      {inProgress ? (
        <Text secondary>{exp.kind === "due" ? t("brandApply.status.expected.due", { date: day(exp.iso) }) : t(`brandApply.status.expected.${exp.kind}`)}</Text>
      ) : null}
      {app.submittedAt !== null && inProgress ? <Text variant="caption" secondary>{t("brandApply.status.submittedOn", { date: day(app.submittedAt) })}</Text> : null}

      {tl.phase === "needs_info" ? (
        <View style={{ gap: spacing.md }}>
          <Text secondary>{t("brandApply.status.needsInfoBody")}</Text>
          {items.map((i) => {
            const done = i.satisfied || addressed.has(i.code);
            return (
              <Card key={i.code} variant="elevated" style={{ gap: spacing.sm }}>
                <Eyebrow secondary>{t("brandApply.status.item")}</Eyebrow>
                <Text>{pickBi(i.message, s.lang)}</Text>
                {done ? (
                  <View style={{ flexDirection: "row", gap: spacing.sm, alignItems: "center" }}><Icon name="checkmark-circle" size={20} color="savings" /><Text variant="callout">{t("brandApply.status.addressed")}</Text></View>
                ) : (
                  <View style={{ flexDirection: "row", gap: spacing.sm, flexWrap: "wrap" }}>
                    <Button variant="secondary" fullWidth={false} title={t("brandApply.status.fix")} onPress={() => fixRoute(i)} />
                    {i.kind !== "document" ? <Button variant="ghost" fullWidth={false} title={t("brandApply.common.done")} onPress={() => setAddressed((x) => new Set(x).add(i.code))} /> : null}
                  </View>
                )}
              </Card>
            );
          })}
          {!resubmitReady(items, addressed) ? <Text variant="caption" secondary>{t("brandApply.status.stillOpen")}</Text> : null}
        </View>
      ) : null}

      {tl.phase === "rejected" && app.decision !== null ? (
        <View style={{ gap: spacing.lg }}>
          <View style={{ gap: spacing.xs }}>
            <Eyebrow secondary>{t("brandApply.status.rejectedReason")}</Eyebrow>
            <Text>{pickBi(app.decision.message, s.lang) || t(`brandApply.status.reasons.${app.decision.reasonCode}`)}</Text>
          </View>
          {app.appealUsed ? <Text secondary>{t("brandApply.status.appealUsed")}</Text> : null}
          {rej.canAppeal ? (
            <View style={{ gap: spacing.md }}>
              <Text variant="headline">{t("brandApply.status.appealTitle")}</Text>
              <Text secondary>{t("brandApply.status.appealBody")}</Text>
              {rej.appealUntil !== null ? <Text variant="caption" secondary>{t("brandApply.status.appealUntil", { date: day(rej.appealUntil) })}</Text> : null}
              <TextInput
                value={statement} onChangeText={setStatement} multiline maxLength={2000} accessibilityLabel={t("brandApply.status.appealStatement")}
                placeholder={t("brandApply.status.appealStatement")} placeholderTextColor={colors.textSecondary} textAlignVertical="top"
                style={{ minHeight: 120, borderWidth: 1, borderColor: colors.border, borderRadius: radii.md, backgroundColor: colors.surface, color: colors.textPrimary, padding: spacing.md, fontSize: 16 }}
              />
              <Button title={t("brandApply.status.appealSubmit")} loading={act.busy} disabled={!validAppealStatement(statement)}
                onPress={() => void act.run(async () => { s.setApp(await portRef.appeal(app.id, statement.trim())); })} />
            </View>
          ) : null}
          <Text secondary>{rej.canReapplyNow ? t("brandApply.status.reapplyNow") : t("brandApply.status.reapply", { date: day(rej.reapplyAfter ?? "") })}</Text>
        </View>
      ) : null}

      <ErrorNote code={act.error} onSignIn={() => nav.replace("account")} />

      {app.allowedActions.includes("withdraw") ? <Button variant="ghost" title={t("brandApply.status.withdraw")} onPress={() => setWithdrawOpen(true)} /> : null}
      <Button variant="ghost" icon="refresh-outline" title={t("brandApply.status.refresh")} onPress={pull} />

      <BottomSheet visible={withdrawOpen} onClose={() => setWithdrawOpen(false)} title={t("brandApply.status.withdrawTitle")} closeLabel={t("brandApply.common.cancel")}>
        <View style={{ gap: spacing.md }}>
          <Text secondary>{t("brandApply.status.withdrawBody")}</Text>
          <Button variant="destructive" title={t("brandApply.status.withdrawConfirm")} loading={act.busy}
            onPress={() => void act.run(async () => { s.setApp(await portRef.withdraw(app.id)); setWithdrawOpen(false); })} />
          <Button variant="secondary" title={t("brandApply.status.withdrawKeep")} onPress={() => setWithdrawOpen(false)} />
        </View>
      </BottomSheet>
    </FlowScreen>
  );
}
