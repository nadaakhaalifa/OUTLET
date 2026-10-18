import Link from "next/link";
import { DynamicForm, type FieldSpec } from "../../components/DynamicForm";
import { ErrorNotice } from "../../components/ErrorNotice";
import { formatDate } from "../../lib/format";
import { getOnboarding } from "../../onboarding-context";
import { STATUS_KEY } from "../../view-models/application-status";
import { startApplicationAction } from "../actions-onboarding";

export default async function ApplyIndex() {
  const { api, t, locale } = await getOnboarding();
  if (api === null) return <ErrorNotice kind="not_configured" locale={locale} />;
  const list = await api.listApplications();
  if (!list.ok) return <ErrorNotice error={list.error} locale={locale} />;
  const fields: FieldSpec[] = [
    { name: "kind", label: t("ob.apply.kind"), type: "select", required: true, options: [{ value: "local", label: t("ob.apply.kind.local") }, { value: "global", label: t("ob.apply.kind.global") }], hint: t("ob.apply.kindHint") },
    { name: "country", label: t("ob.apply.country"), type: "text", dir: "ltr", maxLength: 2, hint: t("ob.apply.countryHint"), autoComplete: "country" },
    { name: "brandName", label: t("ob.apply.brandName"), type: "text", required: true, maxLength: 120 },
  ];
  const items = list.value.data.items;
  return (
    <section aria-labelledby="apply-h">
      <h1 id="apply-h">{t("ob.apply.title")}</h1>
      <p className="zm-lead">{t("ob.apply.lead")}</p>
      {items.length === 0 ? null : (
        <>
          <h2>{t("ob.apply.yours")}</h2>
          <ul className="zm-list">
            {items.map((a) => (
              <li key={a.id}>
                <Link className="zm-link" href={`/apply/${a.id}`}><span dir="auto">{a.brand_name}</span></Link>
                {" · "}<span className="zm-tag">{t(STATUS_KEY[a.status])}</span>
                {" · "}<span className="zm-hint">{formatDate(a.updated_at, locale)}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      <h2>{t("ob.apply.new")}</h2>
      <DynamicForm action={startApplicationAction} fields={fields} submitLabel={t("ob.apply.start")} locale={locale} nextPath="/apply" />
    </section>
  );
}
