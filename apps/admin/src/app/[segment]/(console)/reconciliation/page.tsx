import { createTranslator, localeSegment } from "@outlet/i18n";
import { ConsoleFrame } from "../../../../components/ConsoleFrame";
import { ProblemBanner } from "../../../../components/ProblemBanner";
import { ReconView } from "../../../../components/ReconView";
import { load } from "../../../../lib/load";
import { ReconItemPage, ReconRunPage } from "../../../../lib/schemas";
import { requireLocale, type SegmentParams } from "../../../../lib/segment-page";
import { currentProfile } from "../../../../server/admin-get";
import { can } from "../../../../server/session";

export default async function ReconciliationPage({ params, searchParams }: { params: SegmentParams; searchParams: Promise<{ run?: string }> }) {
  const resolved = await requireLocale(params);
  const { run } = await searchParams;
  const t = createTranslator(resolved.locale);
  const base = `/${localeSegment(resolved.marketId, resolved.locale)}`;
  const profile = await currentProfile();
  const runs = await load(ReconRunPage, resolved.marketId, "reconciliation/runs");
  const selected = run !== undefined && /^[0-9a-f-]{36}$/.test(run) ? run : null;
  const items = selected !== null ? await load(ReconItemPage, resolved.marketId, `reconciliation/runs/${selected}/items`) : null;
  const today = new Date().toISOString().slice(0, 10);
  return (
    <ConsoleFrame resolved={resolved} section="recon">
      <h1 className="pageTitle">{t("admin.recon.title")}</h1>
      <p className="lead">{t("admin.recon.lead")}</p>
      {!runs.ok ? <ProblemBanner t={t} code={runs.code} status={runs.status} /> : (
        <>
          {items !== null && !items.ok ? <ProblemBanner t={t} code={items.code} status={items.status} /> : null}
          <ReconView t={t} locale={resolved.locale} market={resolved.marketId} base={base} today={today} runs={runs.data.items} items={items?.ok === true ? items.data.items : null} selectedRun={selected} canRun={profile !== null && can(profile, "ledger.read")} />
        </>
      )}
    </ConsoleFrame>
  );
}
