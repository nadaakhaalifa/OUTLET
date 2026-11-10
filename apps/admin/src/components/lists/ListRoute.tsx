import { createTranslator, localeSegment, type MessageKey } from "@outlet/i18n";
import { ConsoleFrame } from "../ConsoleFrame";
import { PageHeader } from "../kit/PageHeader";
import { ProblemBanner } from "../ProblemBanner";
import { DisputeList, FILTERS, parseFilter, PayoutList, RefundList, ReturnList, type ListKind } from "../../lib/lists";
import { load } from "../../lib/load";
import { requireLocale, type SegmentParams } from "../../lib/segment-page";
import { currentProfile } from "../../server/admin-get";
import { can, type SectionId } from "../../server/session";
import { OpsList } from "./OpsList";

const SCHEMA = { refunds: RefundList, payouts: PayoutList, returns: ReturnList, disputes: DisputeList } as const;
const SECTION: Readonly<Record<ListKind, SectionId>> = { refunds: "refunds", payouts: "payouts", returns: "returns", disputes: "disputes" };
export const LIST_PAGE_SIZE = 20;

/** Shared server half of the four list pages: frame (403 banner when the live roles do not allow the section), first keyset page, then the client list that loads the rest. */
export async function ListRoute({ kind, params, searchParams }: { kind: ListKind; params: SegmentParams; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const resolved = await requireLocale(params);
  const t = createTranslator(resolved.locale);
  const raw = (await searchParams)[FILTERS[kind].param];
  const filter = parseFilter(kind, typeof raw === "string" ? raw : undefined);
  const profile = await currentProfile();
  const res = await load(SCHEMA[kind], resolved.marketId, kind, { limit: String(LIST_PAGE_SIZE), ...(filter === undefined ? {} : { [FILTERS[kind].param]: filter }) });
  return (
    <ConsoleFrame resolved={resolved} section={SECTION[kind]}>
      <PageHeader title={t(`admin.${kind}.title` as MessageKey)} description={t(`admin.${kind}.lead` as MessageKey)} />
      {res.ok
        ? <OpsList kind={kind} locale={resolved.locale} market={resolved.marketId} base={`/${localeSegment(resolved.marketId, resolved.locale)}`} initial={res.data} summary={res.data.summary} filter={filter} canWrite={profile !== null && can(profile, "payout.hold")} mayRelease={profile !== null && can(profile, "payout.release")} />
        : <ProblemBanner t={t} code={res.code} status={res.status} />}
    </ConsoleFrame>
  );
}
