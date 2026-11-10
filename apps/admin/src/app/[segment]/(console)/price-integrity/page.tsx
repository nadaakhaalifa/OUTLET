import { createTranslator } from "@outlet/i18n";
import { ConsoleFrame } from "../../../../components/ConsoleFrame";
import { PriceView } from "../../../../components/PriceView";
import { ProblemBanner } from "../../../../components/ProblemBanner";
import { load } from "../../../../lib/load";
import { EnforcementPage, FindingPage, PriceTrust } from "../../../../lib/schemas";
import { requireLocale, type SegmentParams } from "../../../../lib/segment-page";

const MAX_TRUST_STORES = 20;

export default async function PriceIntegrityPage({ params }: { params: SegmentParams }) {
  const resolved = await requireLocale(params);
  const t = createTranslator(resolved.locale);
  const m = resolved.marketId;
  const [actions, findings] = await Promise.all([load(EnforcementPage, m, "price-integrity/enforcement-actions"), load(FindingPage, m, "price-integrity/findings")]);
  const failed = !actions.ok ? actions : !findings.ok ? findings : null;
  // Trust scores are per store; the contract has no store list, so we show the stores that appear in the log above.
  const storeIds = actions.ok && findings.ok ? [...new Set([...actions.data.items.map((a) => a.store_id), ...findings.data.items.map((f) => f.store_id)])].slice(0, MAX_TRUST_STORES) : [];
  const trust = (await Promise.all(storeIds.map((id) => load(PriceTrust, m, `price-integrity/stores/${id}/trust`)))).flatMap((r) => (r.ok ? [r.data] : []));
  return (
    <ConsoleFrame resolved={resolved} section="price">
      <h1 className="pageTitle">{t("admin.price.title")}</h1>
      <p className="lead">{t("admin.price.lead")}</p>
      {failed !== null ? <ProblemBanner t={t} code={failed.code} status={failed.status} /> : actions.ok && findings.ok ? <PriceView t={t} locale={resolved.locale} actions={actions.data.items} trust={trust} findings={findings.data.items} /> : null}
    </ConsoleFrame>
  );
}
