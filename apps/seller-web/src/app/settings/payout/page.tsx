import { DynamicForm } from "../../../components/DynamicForm";
import { ErrorNotice } from "../../../components/ErrorNotice";
import { formatDateTime } from "../../../lib/format";
import { settingsCtx } from "../../../page-settings";
import { payoutVM } from "../../../view-models/store-settings";
import { savePayoutAction } from "../../actions-onboarding";

export default async function PayoutPage() {
  const c = await settingsCtx();
  if (!c.ok) return c.node;
  const { api, scope, t, locale } = c;
  if (scope.role !== "owner" && scope.role !== "finance" && scope.role !== "manager") return <ErrorNotice kind="forbidden" locale={locale} />;
  const [acct, hist] = await Promise.all([api.payoutAccount(scope.storeId), api.payoutHistory(scope.storeId)]);
  if (!acct.ok) return <ErrorNotice error={acct.error} locale={locale} />;
  const vm = payoutVM(acct.value.data, Date.now());
  const canWrite = scope.role === "owner" || scope.role === "finance";
  return (
    <section aria-labelledby="po-h">
      <h1 id="po-h">{t("ob.payout.title")}</h1>
      <p className="zm-lead">{t("ob.payout.lead")}</p>
      {!vm.configured ? <p role="status" className="zm-notice">{t("ob.payout.none")}</p> : (
        <dl className="zm-notice">
          <dt className="zm-tag">{t("ob.payout.current")}</dt>
          <dd dir="ltr"><code>{vm.masked}</code></dd>
          <dt className="zm-tag">{t("ob.payout.nameMatch")}</dt>
          <dd>{vm.nameMatch === "match" ? t("ob.payout.match", { score: vm.score ?? 0 }) : t("ob.payout.mismatch", { score: vm.score ?? 0 })}</dd>
          {vm.held ? (
            <>
              <dt className="zm-tag">{t("ob.payout.hold")}</dt>
              <dd role="status">{t("ob.payout.holdBody", { hours: vm.holdHoursLeft ?? 48 })}</dd>
            </>
          ) : null}
        </dl>
      )}
      {canWrite ? (
        <>
          <h2>{vm.configured ? t("ob.payout.replace") : t("ob.payout.add")}</h2>
          <p className="zm-hint">{t("ob.payout.holdNotice")}</p>
          <p className="zm-hint">{t("ob.payout.stepUpNotice")}</p>
          <DynamicForm
            action={savePayoutAction} locale={locale} submitLabel={t("ob.payout.save")} nextPath="/settings/payout"
            fields={[
              { name: "iban", label: t("ob.payout.iban"), type: "text", dir: "ltr", required: true, maxLength: 40, autoComplete: "off", hint: t("ob.payout.ibanHint") },
              { name: "holder", label: t("ob.payout.holder"), type: "text", dir: "auto", required: true, maxLength: 300, autoComplete: "off", hint: t("ob.payout.holderHint") },
            ]}
          />
        </>
      ) : <p className="zm-hint">{t("ob.payout.readOnly")}</p>}
      {hist.ok && hist.value.data.items.length > 0 ? (
        <>
          <h2>{t("ob.payout.history")}</h2>
          <ul className="zm-list">
            {hist.value.data.items.map((h, i) => (
              <li key={`${h.at ?? i}-${h.kind}`}>{h.kind.replace(/_/g, " ")} <span className="zm-hint">{h.at === null ? "" : formatDateTime(h.at, locale)}</span></li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}
