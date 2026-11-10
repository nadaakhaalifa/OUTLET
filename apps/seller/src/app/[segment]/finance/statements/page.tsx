import { createTranslator } from "@outlet/i18n";
import { StatementView } from "../../../../components/finance/StatementView";
import { PageFrame } from "../../../../components/PageFrame";
import { ProblemBanner } from "../../../../components/ProblemBanner";
import { MONTH, Statement, cairoMonth } from "../../../../lib/finance-model";
import { requireLocale, type SegmentParams } from "../../../../lib/segment-page";
import { sellerGet } from "../../../../server/seller-get";

export default async function StatementsPage({ params, searchParams }: { params: SegmentParams; searchParams: Promise<{ month?: string }> }) {
  const resolved = await requireLocale(params);
  const sp = await searchParams;
  const t = createTranslator(resolved.locale);
  const month = sp.month !== undefined && MONTH.test(sp.month) ? sp.month : cairoMonth(new Date());
  const result = await sellerGet(resolved.marketId.toLowerCase(), `finance/statements?month=${month}`);
  const parsed = result.ok ? Statement.safeParse(result.data) : null;
  return (
    <PageFrame resolved={resolved} current="statements">
      <h1 className="pageTitle">{t("seller.finance.statements.title")}</h1>
      <form className="filters" method="get" role="search" aria-label={t("seller.finance.statements.pickerLabel")}>
        <div className="field">
          <label htmlFor="f-month">{t("seller.finance.statements.pick")}</label>
          <input id="f-month" name="month" type="month" defaultValue={month} required pattern="\d{4}-(0[1-9]|1[0-2])" />
        </div>
        <button type="submit" className="btn btnPrimary">{t("seller.finance.statements.view")}</button>
      </form>
      {!result.ok ? <ProblemBanner t={t} code={result.code} status={result.status} /> : null}
      {parsed?.success === true ? <StatementView locale={resolved.locale} statement={parsed.data} /> : null}
      {parsed?.success === false ? <ProblemBanner t={t} code="unknown" status={502} /> : null}
    </PageFrame>
  );
}
