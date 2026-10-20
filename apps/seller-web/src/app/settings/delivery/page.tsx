import { DynamicForm } from "../../../components/DynamicForm";
import { ErrorNotice } from "../../../components/ErrorNotice";
import { formatDateTime } from "../../../lib/format";
import { canWriteSettings, settingsCtx } from "../../../page-settings";
import { profileValues } from "../../../view-models/store-settings";
import { saveProfileAction, saveVacationAction } from "../../actions-onboarding";

export default async function DeliveryPage() {
  const c = await settingsCtx();
  if (!c.ok) return c.node;
  const { api, scope, t, locale } = c;
  const r = await api.profile(scope.storeId);
  if (!r.ok) return <ErrorNotice error={r.error} locale={locale} />;
  const p = r.value.data;
  const v = profileValues(p);
  const writable = canWriteSettings(scope.role);
  return (
    <section aria-labelledby="dl-h">
      <h1 id="dl-h">{t("ob.delivery.title")}</h1>
      <p className="zm-lead">{t("ob.delivery.lead")}</p>
      {writable ? null : <p role="status" className="zm-notice">{t("ob.set.readOnly")}</p>}
      <DynamicForm
        action={saveProfileAction} locale={locale} hidden={{ section: "delivery", expectedVersion: String(p.version) }}
        submitLabel={t("common.save")} nextPath="/settings/delivery" disabled={!writable}
        fields={[{ name: "threshold", label: t("ob.delivery.threshold"), type: "text", inputMode: "decimal", dir: "ltr", value: v.threshold, required: true, hint: t("ob.delivery.thresholdHint"), disabled: !writable }]}
      />
      <h2>{t("ob.vacation.title")}</h2>
      <p className="zm-hint">{t("ob.vacation.lead")}</p>
      {p.vacation.enabled && p.vacation.until !== null ? <p role="status" className="zm-ok">{t("ob.vacation.active", { date: formatDateTime(p.vacation.until, locale) })}</p> : null}
      <DynamicForm
        action={saveVacationAction} locale={locale} submitLabel={t("common.save")} nextPath="/settings/delivery" disabled={!writable}
        fields={[
          { name: "enabled", label: t("ob.vacation.enable"), type: "checkbox", checked: p.vacation.enabled, disabled: !writable },
          { name: "until", label: t("ob.vacation.until"), type: "datetime-local", dir: "ltr", hint: t("ob.vacation.untilHint"), disabled: !writable },
          { name: "etaExtraDays", label: t("ob.vacation.eta"), type: "number", inputMode: "numeric", dir: "ltr", value: String(p.vacation.eta_extra_days), hint: t("ob.vacation.etaHint"), disabled: !writable },
        ]}
      />
    </section>
  );
}
