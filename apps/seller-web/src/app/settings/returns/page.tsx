import { DynamicForm } from "../../../components/DynamicForm";
import { ErrorNotice } from "../../../components/ErrorNotice";
import { canWriteSettings, settingsCtx } from "../../../page-settings";
import { profileValues } from "../../../view-models/store-settings";
import { saveProfileAction } from "../../actions-onboarding";

export default async function ReturnsPage() {
  const c = await settingsCtx();
  if (!c.ok) return c.node;
  const { api, scope, t, locale } = c;
  const r = await api.profile(scope.storeId);
  if (!r.ok) return <ErrorNotice error={r.error} locale={locale} />;
  const p = r.value.data;
  const v = profileValues(p);
  const min = p.return_policy.statutory_minimum;
  const writable = canWriteSettings(scope.role);
  return (
    <section aria-labelledby="rp-h">
      <h1 id="rp-h">{t("ob.returns.title")}</h1>
      <p className="zm-lead">{t("ob.returns.lead", { com: min.change_of_mind_days, def: min.defect_days })}</p>
      {writable ? null : <p role="status" className="zm-notice">{t("ob.set.readOnly")}</p>}
      <DynamicForm
        action={saveProfileAction} locale={locale} hidden={{ section: "returns", expectedVersion: String(p.version) }}
        submitLabel={t("common.save")} nextPath="/settings/returns" disabled={!writable}
        fields={[
          { name: "changeOfMindDays", label: t("ob.returns.com"), type: "number", inputMode: "numeric", dir: "ltr", value: v.changeOfMindDays, required: true, hint: t("ob.returns.minHint", { n: min.change_of_mind_days }), disabled: !writable },
          { name: "defectDays", label: t("ob.returns.def"), type: "number", inputMode: "numeric", dir: "ltr", value: v.defectDays, required: true, hint: t("ob.returns.minHint", { n: min.defect_days }), disabled: !writable },
          { name: "policyAr", label: t("ob.returns.textAr"), type: "textarea", value: v.policyAr, maxLength: 4000, disabled: !writable },
          { name: "policyEn", label: t("ob.returns.textEn"), type: "textarea", value: v.policyEn, maxLength: 4000, hint: t("ob.set.arFirst"), disabled: !writable },
        ]}
      />
    </section>
  );
}
