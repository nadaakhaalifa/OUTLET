import type { Queryable } from "@outlet/db";
import { isLocale } from "@outlet/i18n";
import type { Template } from "../domain/render.js";
import type { Category, Channel } from "../domain/types.js";

interface Row {
  code: string;
  channel: Channel;
  locale: string;
  version: number;
  category: Category;
  title: string | null;
  body: string;
  provider_template_name: string | null;
  approval_status: "approved" | "pending" | "rejected";
}

/** Active templates of a market for a code, all channels and locales. */
export const loadTemplates = async (q: Queryable, marketId: string, code: string): Promise<Template[]> => {
  const r = await q.query<Row>(
    `SELECT code, channel, locale, version, category, title, body, provider_template_name, approval_status
       FROM notification_templates WHERE market_id = $1 AND code = $2 AND active`,
    [marketId, code],
  );
  return r.rows.flatMap((x) =>
    isLocale(x.locale)
      ? [{ code: x.code, channel: x.channel, locale: x.locale, version: x.version, category: x.category, title: x.title, body: x.body, providerTemplateName: x.provider_template_name, approvalStatus: x.approval_status }]
      : [],
  );
};
