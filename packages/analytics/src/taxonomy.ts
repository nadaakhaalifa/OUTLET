import { analyticsEvents, ANALYTICS_EVENT_NAMES } from "./analytics-events";
import { domainEvents, DOMAIN_EVENT_NAMES } from "./domain-events";
import { RETENTION_POLICIES } from "./retention";
import { z } from "zod";

/** Renders `name: type` for every property of a strict object schema, `?` marks optional. Used to build the taxonomy doc. */
function describeShape(shape: z.ZodRawShape): string {
  return Object.entries(shape)
    .map(([key, schema]) => `\`${key}${z.safeParse(schema, undefined).success ? "?" : ""}\``)
    .join(", ");
}

function classOf(classes: Readonly<Record<string, string>>): string {
  return Object.entries(classes)
    .map(([k, c]) => `${k}=${c}`)
    .join(", ");
}

/**
 * Markdown tables for docs/analytics/event-taxonomy.md, generated from the catalog so the doc cannot
 * drift silently. Returns two blocks: analytics events and domain events.
 */
export function renderTaxonomyTables(): { readonly analytics: string; readonly domain: string; readonly retention: string } {
  const a = [
    "| Event | Owner | Origin | Purpose required | Properties | PII class per property | Retention | Spec |",
    "|---|---|---|---|---|---|---|---|",
    ...ANALYTICS_EVENT_NAMES.map((n) => {
      const d = analyticsEvents[n];
      return `| \`${n}\` | ${d.owner} | ${d.origin} | \`${d.purpose}\` | ${describeShape(d.shape)} | ${classOf(d.classes)} | \`${d.retention}\` | ${d.specRef} |`;
    }),
  ].join("\n");

  const dom = [
    "| Event | Version | Aggregate | Owner | Payload | PII class per field | Max class | Purpose | Record retention | Analytics mirror | Spec |",
    "|---|---|---|---|---|---|---|---|---|---|---|",
    ...DOMAIN_EVENT_NAMES.map((n) => {
      const d = domainEvents[n];
      const mirror = "analyticsMirror" in d ? `\`${d.analyticsMirror}\`` : "none";
      return `| \`${n}\` | ${d.version} | ${d.aggregate} | ${d.owner} | ${describeShape(d.shape)} | ${classOf(d.classes)} | ${d.piiClass} | \`${d.purpose}\` | \`${d.recordRetention}\` | ${mirror} | ${d.specRef} |`;
    }),
  ].join("\n");

  const ret = [
    "| Retention id | Meaning | Verify before launch |",
    "|---|---|---|",
    ...Object.entries(RETENTION_POLICIES).map(([id, p]) => `| \`${id}\` | ${p.description} | ${p.verify ? "yes" : "no"} |`),
  ].join("\n");

  return { analytics: a, domain: dom, retention: ret };
}
