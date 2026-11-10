import { createTranslator } from "@outlet/i18n";
import { ConsoleFrame } from "../../../../components/ConsoleFrame";
import { DpoView } from "../../../../components/DpoView";
import { ProblemBanner } from "../../../../components/ProblemBanner";
import { load } from "../../../../lib/load";
import { BreachPage, ConsentStats, PrivacyPage, TransferPage } from "../../../../lib/schemas";
import { requireLocale, type SegmentParams } from "../../../../lib/segment-page";

export default async function DpoPage({ params }: { params: SegmentParams }) {
  const resolved = await requireLocale(params);
  const t = createTranslator(resolved.locale);
  const m = resolved.marketId;
  const [requests, consent, breaches, transfers] = await Promise.all([
    load(PrivacyPage, m, "privacy/requests"), load(ConsentStats, m, "privacy/consent-stats"), load(BreachPage, m, "privacy/breaches"), load(TransferPage, m, "privacy/transfer-register"),
  ]);
  const failed = !requests.ok ? requests : !consent.ok ? consent : !breaches.ok ? breaches : !transfers.ok ? transfers : null;
  return (
    <ConsoleFrame resolved={resolved} section="dpo">
      <h1 className="pageTitle">{t("admin.dpo.title")}</h1>
      <p className="lead">{t("admin.dpo.lead")}</p>
      {failed !== null ? <ProblemBanner t={t} code={failed.code} status={failed.status} /> : requests.ok && consent.ok && breaches.ok && transfers.ok ? (
        <DpoView t={t} locale={resolved.locale} now={new Date()} requests={requests.data.items} consent={consent.data} breaches={breaches.data.items} transfers={transfers.data.items} />
      ) : null}
    </ConsoleFrame>
  );
}
