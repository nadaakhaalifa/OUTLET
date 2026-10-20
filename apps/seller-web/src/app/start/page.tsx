import { redirect } from "next/navigation";
import { ErrorNotice } from "../../components/ErrorNotice";
import { getOnboarding } from "../../onboarding-context";
import { routeAfterSignIn } from "../../view-models/onboarding-checklist";

/** Post-sign-in gate: no store -> application; store with open required checklist items -> checklist; else dashboard. */
export default async function StartPage() {
  const { api, locale } = await getOnboarding();
  if (api === null) return <ErrorNotice kind="not_configured" locale={locale} />;
  const me = await api.me();
  if (!me.ok) return <ErrorNotice error={me.error} locale={locale} />;
  const memberships = me.value.data.memberships;
  let apps: { ids: string[]; statuses: ("DRAFT" | "SUBMITTED" | "AUTO_CHECKS" | "IN_REVIEW" | "NEEDS_INFO" | "APPROVED" | "REJECTED" | "SUSPENDED" | "WITHDRAWN")[] } = { ids: [], statuses: [] };
  let checklist = null;
  if (memberships.length === 0) {
    const l = await api.listApplications();
    if (!l.ok) return <ErrorNotice error={l.error} locale={locale} />;
    apps = { ids: l.value.data.items.map((a) => a.id), statuses: l.value.data.items.map((a) => a.status) };
  } else {
    const c = await api.checklist();
    if (c.ok) checklist = c.value.data;
  }
  redirect(routeAfterSignIn({ memberships, applicationStatuses: apps.statuses, applicationIds: apps.ids, checklist }));
}
