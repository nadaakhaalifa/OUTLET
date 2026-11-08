import { notFound } from "next/navigation";
import type { ResolvedLocale } from "@outlet/i18n";
import { parseSegment } from "./segment";

export type SegmentParams = Promise<{ segment: string }>;

/** Resolves the segment or renders the 404 page. */
export async function requireLocale(params: SegmentParams): Promise<ResolvedLocale> {
  const { segment } = await params;
  const resolved = parseSegment(segment);
  if (resolved === null) notFound();
  return resolved;
}
