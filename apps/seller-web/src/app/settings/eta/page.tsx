import { DynamicForm } from "../../../components/DynamicForm";
import { ErrorNotice } from "../../../components/ErrorNotice";
import { formatDateTime } from "../../../lib/format";
import { canWriteSettings, settingsCtx } from "../../../page-settings";
import { etaStatusKey } from "../../../view-models/store-settings";
import { requestEtaAction } from "../../actions-onboarding";

export default async function EtaPage() {
  const c = await settingsCtx();
  if (!c.ok) return c.node;
  const { api, scope, t, locale } = c;
  const r = await api.etaEnrolment(scope.storeId);
  if (!r.ok) return <ErrorNotice error={r.error} locale={locale} />;
  const e = r.value.data;
  const writable = canWriteSettings(scope.role);
  return (
    <section aria-labelledby="eta-h">
      <h1 id="eta-h">{t("ob.eta.title")}</h1>
      <p className="zm-lead">{t("ob.eta.lead")}</p>
      <dl className="zm-notice">
        <dt className="zm-tag">{t("ob.eta.status")}</dt><dd role="status">{t(etaStatusKey(e))}</dd>
        {e.last_verified_at === null ? null : <><dt className="zm-tag">{t("ob.eta.verifiedAt")}</dt><dd>{formatDateTime(e.last_verified_at, locale)}</dd></>}
        {e.failure_code === null ? null : <><dt className="zm-tag">{t("ob.eta.failure")}</dt><dd><code dir="ltr">{e.failure_code}</code></dd></>}
      </dl>
      <p className="zm-hint">{t("ob.eta.credentialsNote")}</p>
      {writable && e.status !== "verified" ? (
        <DynamicForm action={requestEtaAction} locale={locale} fields={[]} submitLabel={t("ob.eta.request")} nextPath="/settings/eta" />
      ) : null}
    </section>
  );
}
