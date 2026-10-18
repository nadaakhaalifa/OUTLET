import Link from "next/link";
import { ErrorNotice } from "../../components/ErrorNotice";
import { getOnboarding, resolveStore } from "../../onboarding-context";
import { checklistVM } from "../../view-models/onboarding-checklist";

export default async function OnboardingPage() {
  const { api, t, locale } = await getOnboarding();
  if (api === null) return <ErrorNotice kind="not_configured" locale={locale} />;
  const s = await resolveStore(api);
  if (s.unauthorized) return <ErrorNotice error={{ kind: "unauthorized" }} locale={locale} />;
  if (s.offline) return <ErrorNotice error={{ kind: "offline" }} locale={locale} />;
  if (s.scope === null) return <ErrorNotice kind="no_store" locale={locale} />;
  const c = await api.checklist();
  if (!c.ok) return <ErrorNotice error={c.error} locale={locale} />;
  const vm = checklistVM(c.value.data, s.scope.role);
  return (
    <section aria-labelledby="ob-h" className="zm-set">
      <h1 id="ob-h">{t("ob.check.title")}</h1>
      <p className="zm-lead">{t("ob.check.lead")}</p>
      <p role="status">{t("ob.check.progress", { done: vm.doneCount, total: vm.total })}</p>
      <div className="zm-bar-progress">
        <progress max={100} value={vm.percent} aria-label={t("ob.check.progressLabel")} />
      </div>
      {vm.readyToPublish ? <p className="zm-ok">{t("ob.check.ready")}</p> : <p className="zm-hint">{t("ob.check.remaining", { n: vm.requiredRemaining })}</p>}
      {vm.rows.length === 0 ? <p role="status" className="zm-notice">{t("state.empty")}</p> : (
        <ol className="zm-list">
          {vm.rows.map((r) => (
            <li key={r.code} className="zm-check-row">
              <span className="zm-mark" data-done={r.done} aria-hidden="true">{r.done ? "✓" : ""}</span>
              <div>
                <p><strong>{t(r.titleKey)}</strong>{r.requiredForPublish ? null : <span className="zm-tag"> · {t("ob.check.optional")}</span>}</p>
                <p className="zm-hint">{t(r.bodyKey)}</p>
                {r.done ? null : r.actionable ? null : <p className="zm-hint">{t("ob.check.ownerOnly")}</p>}
              </div>
              <div>
                <span className="vh">{r.done ? t("ob.check.done") : t("ob.check.todo")}</span>
                {r.done || !r.actionable ? null : <Link className="zm-btn" href={r.href}>{t("ob.check.go")}</Link>}
              </div>
            </li>
          ))}
        </ol>
      )}
      {vm.next === null ? null : <p><Link className="zm-btn primary" href={vm.next.href}>{t("ob.check.next")}</Link></p>}
    </section>
  );
}
