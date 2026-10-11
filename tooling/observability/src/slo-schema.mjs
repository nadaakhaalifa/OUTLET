// Schema for infra/observability/slos/slos.yaml. Zod at the file boundary.
import { z } from 'zod';
import { windowToHours, resolveTiers } from './burn-rate.mjs';

const ID = z.string().regex(/^[a-z][a-z0-9-]*$/);
const WINDOW = z.string().regex(/^[1-9][0-9]*[mhd]$/);
const SEVERITY = z.enum(['page', 'ticket']);
const PROM_METRIC = z.string().regex(/^[a-zA-Z_:][a-zA-Z0-9_:]*$/);
// Label matcher body such as: route="/v1/products",method="GET". May be empty.
const SELECTOR = z.string().regex(/^[^{}]*$/).default('');

export const JOURNEYS = [
  'checkout',
  'reservation',
  'payments',
  'api',
  'search',
  'mobile',
  'refunds',
  'reconciliation',
];

const base = {
  id: ID,
  title: z.string().min(3),
  journey: z.enum(JOURNEYS),
  specRow: z.string().min(1),
  owner: z.string().min(1),
  runbook: z.string().regex(/^docs\/runbooks\/[a-z0-9-]+\.md$/),
  dashboard: z.string().regex(/^[a-z]+$/),
  objective: z.number().min(0).max(1),
  verifyNote: z.string().optional(),
};

const ratio = z
  .object({
    ...base,
    kind: z.literal('ratio'),
    sli: z.object({
      description: z.string().min(10),
      bad: z.string().min(5),
      total: z.string().min(5),
    }),
    minEventsPerWindow: z.number().int().nonnegative(),
    slowSeverity: SEVERITY,
    alertOnAbsent: z.boolean().default(false),
  })
  .strict();

const latency = z
  .object({
    ...base,
    kind: z.literal('latency'),
    sli: z.object({
      description: z.string().min(10),
      histogram: PROM_METRIC,
      selector: SELECTOR,
      thresholdSeconds: z.number().positive(),
      percentile: z.number().gt(0).lt(1),
    }),
    minEventsPerWindow: z.number().int().nonnegative(),
    slowSeverity: SEVERITY,
    alertOnAbsent: z.boolean().default(false),
  })
  .strict();

const zeroGauge = z
  .object({
    ...base,
    kind: z.literal('zero_gauge'),
    sli: z.object({
      description: z.string().min(10),
      gauge: z.string().min(5),
    }),
    alerts: z
      .array(z.object({ for: WINDOW, severity: SEVERITY }))
      .min(1),
  })
  .strict();

export const SloSchema = z.discriminatedUnion('kind', [ratio, latency, zeroGauge]);

export const TierSchema = z.object({
  name: z.enum(['fast', 'slow']),
  long: WINDOW,
  short: WINDOW,
  budgetFraction: z.number().gt(0).lte(1),
  for: WINDOW,
});

export const SloFileSchema = z
  .object({
    version: z.literal(1),
    period: WINDOW,
    tiers: z.array(TierSchema).length(2),
    slos: z.array(SloSchema).min(1),
  })
  .strict();

/** Semantic rules the shape alone cannot express. Returns a list of problems (empty = ok). */
export function semanticProblems(file) {
  const problems = [];
  const ids = new Set();
  for (const slo of file.slos) {
    if (ids.has(slo.id)) problems.push(`duplicate SLO id ${slo.id}`);
    ids.add(slo.id);
    if (slo.kind === 'zero_gauge') continue;
    if (slo.objective <= 0 || slo.objective >= 1) {
      problems.push(`${slo.id}: objective must be strictly between 0 and 1`);
      continue;
    }
    if (slo.kind === 'latency' && Math.abs(slo.objective - slo.sli.percentile) > 1e-9) {
      problems.push(
        `${slo.id}: latency objective ${slo.objective} must equal the percentile ${slo.sli.percentile}`,
      );
    }
    const periodHours = windowToHours(file.period);
    for (const tier of resolveTiers({ objective: slo.objective, periodHours, tiers: file.tiers })) {
      if (tier.threshold >= 1) {
        problems.push(
          `${slo.id}: ${tier.name} tier threshold ${tier.threshold} >= 1, so it could never fire`,
        );
      }
    }
  }
  return problems;
}

export function parseSloFile(raw) {
  const file = SloFileSchema.parse(raw);
  const problems = semanticProblems(file);
  if (problems.length > 0) {
    throw new Error(`Invalid SLO file:\n- ${problems.join('\n- ')}`);
  }
  return file;
}
