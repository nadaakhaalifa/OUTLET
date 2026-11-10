import { createTranslator } from "@outlet/i18n";
import { AuditView } from "../../../../components/AuditView";
import { ConsoleFrame } from "../../../../components/ConsoleFrame";
import { ProblemBanner } from "../../../../components/ProblemBanner";
import { load } from "../../../../lib/load";
import { AuditPage } from "../../../../lib/schemas";
import { requireLocale, type SegmentParams } from "../../../../lib/segment-page";

type Search = Promise<{ actor_id?: string; action?: string; target_type?: string; from?: string; to?: string }>;

export default async function AuditLogPage({ params, searchParams }: { params: SegmentParams; searchParams: Search }) {
  const resolved = await requireLocale(params);
  const s = await searchParams;
  const filters = { actor_id: s.actor_id ?? "", action: s.action ?? "", target_type: s.target_type ?? "", from: s.from ?? "", to: s.to ?? "" };
  const t = createTranslator(resolved.locale);
  const res = await load(AuditPage, resolved.marketId, "audit-log", { actor_id: filters.actor_id, target_type: filters.target_type, from: filters.from, to: filters.to });
  // `action` is not a contract filter yet, so it narrows the loaded page here.
  const entries = res.ok ? res.data.items.filter((e) => filters.action === "" || e.action.includes(filters.action)) : [];
  return (
    <ConsoleFrame resolved={resolved} section="audit">
      <h1 className="pageTitle">{t("admin.audit.title")}</h1>
      <p className="lead">{t("admin.audit.lead")}</p>
      {res.ok ? <AuditView t={t} locale={resolved.locale} market={resolved.marketId} entries={entries} filters={filters} /> : <ProblemBanner t={t} code={res.code} status={res.status} />}
    </ConsoleFrame>
  );
}
