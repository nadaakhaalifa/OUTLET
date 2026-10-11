import Link from "next/link";
import type { Translator } from "../i18n";

export function Pager({ nextCursor, href, t }: { nextCursor: string | null; href: string; t: Translator }) {
  if (nextCursor === null) return null;
  return (
    <p>
      <Link className="btn" href={`${href}?cursor=${encodeURIComponent(nextCursor)}`}>{t("common.loadMore")}</Link>
    </p>
  );
}
