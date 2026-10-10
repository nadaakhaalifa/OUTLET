import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { spacing } from "@outlet/ui-tokens";
import { Banner, Button, Card, Checkbox, Divider, ErrorState, LoadingState, Screen, SwitchRow, Text } from "../ui";
import { errorKeyFor } from "../features/api-errors";
import { canConfirmDeletion, deletionView, type DeletionView } from "../features/deletion";
import { formatPiastres } from "../features/format";
import { randomUrlSafeId } from "../platform/random";
import { CONSENT_PURPOSES, type ConsentPurpose } from "../workspace";
import { useServices } from "../state/services";
import type { ApiSession } from "../api/port";

type Load =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly key: string }
  | { readonly status: "ready"; readonly deletion: DeletionView; readonly sessions: readonly ApiSession[] };

export default function PrivacyCenter() {
  const { t } = useTranslation();
  const services = useServices();
  const [consents, setConsents] = useState(() => services.consent.view());
  const [pending, setPending] = useState(services.consent.pendingCount);
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [message, setMessage] = useState<string | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(
    () =>
      services.consent.subscribe(() => {
        setConsents(services.consent.view());
        setPending(services.consent.pendingCount);
      }),
    [services],
  );

  const refresh = useCallback(async () => {
    setLoad({ status: "loading" });
    try {
      const [snap, sessions] = await Promise.all([services.api.getDeletionSnapshot(), services.api.listSessions()]);
      if (!snap.ok) return setLoad({ status: "error", key: errorKeyFor(snap.error.code) });
      setLoad({
        status: "ready",
        deletion: deletionView(snap.value),
        sessions: sessions.ok ? sessions.value : [],
      });
    } catch {
      setLoad({ status: "error", key: "errors.generic" });
    }
  }, [services]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const toggle = async (purpose: ConsentPurpose, value: boolean) => {
    // One tap, effective immediately: the controller updates memory before any network call.
    await services.consent.set(purpose, value, "settings_toggle");
    setPending(services.consent.pendingCount);
  };

  const run = async (fn: () => Promise<string | null>) => {
    setBusy(true);
    setMessage(null);
    try {
      setMessage(await fn());
    } catch {
      setMessage(t("errors.generic"));
    } finally {
      setBusy(false);
    }
  };

  const requestExport = () =>
    run(async () => {
      const r = await services.api.requestDataExport({ idempotencyKey: randomUrlSafeId(24) });
      return r.ok ? t("privacy.exportRequested") : t(errorKeyFor(r.error.code));
    });

  const requestDelete = () =>
    run(async () => {
      const r = await services.api.requestAccountDeletion({
        acknowledgedForfeiture: acknowledged,
        idempotencyKey: randomUrlSafeId(24),
      });
      return r.ok ? t("privacy.deleteRequested") : t(errorKeyFor(r.error.code));
    });

  const cancelDelete = () =>
    run(async () => {
      const r = await services.api.cancelAccountDeletion();
      return r.ok ? t("privacy.deleteCancelled") : t(errorKeyFor(r.error.code));
    });

  return (
    <Screen>
      <Text variant="title">{t("privacy.title")}</Text>
      <Text secondary>{t("privacy.intro")}</Text>

      <Text variant="heading">{t("privacy.consentsHeading")}</Text>
      <Text variant="caption" secondary>{t("privacy.consentsHint")}</Text>
      <View style={{ gap: spacing.md }}>
        {CONSENT_PURPOSES.map((purpose) => (
          <Card key={purpose}>
            <SwitchRow
              label={t(`consent.purposes.${purpose}.title`)}
              value={consents[purpose]}
              onValueChange={(v) => void toggle(purpose, v)}
            />
            <Text variant="caption" secondary>{t(`consent.purposes.${purpose}.description`)}</Text>
          </Card>
        ))}
      </View>
      {pending > 0 ? <Banner tone="info" message={t("privacy.syncPending")} /> : null}

      <Divider />
      <Text variant="heading">{t("privacy.exportHeading")}</Text>
      <Text secondary>{t("privacy.exportBody")}</Text>
      <Button title={t("privacy.exportButton")} variant="secondary" onPress={() => void requestExport()} disabled={busy} />

      <Divider />
      <Text variant="heading">{t("privacy.deleteHeading")}</Text>
      {load.status === "loading" ? <LoadingState label={t("common.loading")} /> : null}
      {load.status === "error" ? (
        <ErrorState
          title={t(load.key)}
          retryTitle={t("common.retry")}
          onRetry={() => void refresh()}
          offline={load.key === "errors.offline"}
        />
      ) : null}
      {load.status === "ready" ? (
        <View style={{ gap: spacing.md }}>
          <Text secondary>{t("privacy.deleteIntro")}</Text>
          <Text secondary>{t("privacy.deleteCooling", { days: load.deletion.state === "eligible" ? load.deletion.coolingDays : 14 })}</Text>
          <Text secondary>{t("privacy.deleteLegal")}</Text>
          {load.deletion.state === "blocked" ? (
            <Banner
              tone="warning"
              message={[
                t("privacy.deleteBlockedHeading"),
                ...load.deletion.blockers.map((b) =>
                  t(
                    b.kind === "open_orders"
                      ? "privacy.deleteBlockedOrders"
                      : b.kind === "open_returns"
                        ? "privacy.deleteBlockedReturns"
                        : "privacy.deleteBlockedDisputes",
                    { count: b.count },
                  ),
                ),
              ].join("\n")}
            />
          ) : null}
          {load.deletion.state === "eligible" && load.deletion.forfeitureMinor !== null ? (
            <>
              <Banner
                tone="warning"
                message={t("privacy.deleteForfeiture", {
                  amount: formatPiastres(load.deletion.forfeitureMinor),
                  currency: t("common.currency"),
                })}
              />
              <Checkbox label={t("privacy.deleteAcknowledge")} value={acknowledged} onValueChange={setAcknowledged} />
            </>
          ) : null}
          <Button
            title={t("privacy.deleteButton")}
            variant="destructive"
            onPress={() => void requestDelete()}
            disabled={busy || !canConfirmDeletion(load.deletion, acknowledged)}
          />
          <Button title={t("privacy.deleteCancel")} variant="secondary" onPress={() => void cancelDelete()} disabled={busy} />
        </View>
      ) : null}
      {message !== null ? <Banner tone="info" message={message} /> : null}

      <Divider />
      <Text variant="heading">{t("privacy.sessionsHeading")}</Text>
      <Text secondary>{t("privacy.sessionsPlaceholder")}</Text>
      {load.status === "ready" && load.sessions.length === 0 ? <Text variant="caption" secondary>{t("privacy.sessionsEmpty")}</Text> : null}
      {typeof __DEV__ !== "undefined" && __DEV__ ? <Banner tone="info" message={t("common.devFixtureBackend")} /> : null}
    </Screen>
  );
}
