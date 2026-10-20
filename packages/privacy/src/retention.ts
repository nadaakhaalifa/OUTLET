import { z } from 'zod';
import { RetentionError } from './errors.js';
import { addMonths } from './ports.js';

export const RETENTION_CATEGORIES = [
  'orders_invoices',
  'kyc',
  'analytics_events',
  'measurements',
  'support_chats',
  'raw_webhooks',
] as const;
export type RetentionCategory = (typeof RETENTION_CATEGORIES)[number];

export const RetentionPeriodSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('months'), months: z.number().int().positive() }).strict(),
  /** Anchored to contract end rather than record creation. */
  z.object({ kind: z.literal('after_contract_end_months'), months: z.number().int().positive() }).strict(),
  z.object({ kind: z.literal('until_deletion') }).strict(),
]);
export type RetentionPeriod = z.infer<typeof RetentionPeriodSchema>;

export const RetentionRuleSchema = z
  .object({
    category: z.enum(RETENTION_CATEGORIES),
    period: RetentionPeriodSchema,
    afterExpiry: z.enum(['delete', 'aggregate', 'pseudonymize']),
    /** Nightly purge job metric name. */
    purgeMetric: z.string().min(1),
    /** True when the period is a placeholder pending counsel confirmation. */
    verifyBeforeLaunch: z.boolean(),
    note: z.string().optional(),
  })
  .strict();
export type RetentionRule = z.infer<typeof RetentionRuleSchema>;
export type RetentionSchedule = readonly RetentionRule[];

/** Spec B1 defaults. Tax-law and KYC periods are assumptions: VERIFY BEFORE LAUNCH. */
export const DEFAULT_RETENTION_SCHEDULE: RetentionSchedule = [
  {
    category: 'orders_invoices',
    period: { kind: 'months', months: 84 },
    afterExpiry: 'delete',
    purgeMetric: 'privacy_purge_orders_invoices_total',
    verifyBeforeLaunch: true,
    note: 'Tax-law period; spec says assume 5-7 years, 7 used as the conservative upper bound.',
  },
  {
    category: 'kyc',
    period: { kind: 'after_contract_end_months', months: 60 },
    afterExpiry: 'delete',
    purgeMetric: 'privacy_purge_kyc_total',
    verifyBeforeLaunch: true,
    note: 'Contract + 5 years.',
  },
  {
    category: 'analytics_events',
    period: { kind: 'months', months: 25 },
    afterExpiry: 'aggregate',
    purgeMetric: 'privacy_purge_analytics_events_total',
    verifyBeforeLaunch: false,
  },
  {
    category: 'measurements',
    period: { kind: 'until_deletion' },
    afterExpiry: 'delete',
    purgeMetric: 'privacy_purge_measurements_total',
    verifyBeforeLaunch: false,
  },
  {
    category: 'support_chats',
    period: { kind: 'months', months: 24 },
    afterExpiry: 'delete',
    purgeMetric: 'privacy_purge_support_chats_total',
    verifyBeforeLaunch: false,
  },
  {
    category: 'raw_webhooks',
    period: { kind: 'months', months: 84 },
    afterExpiry: 'pseudonymize',
    purgeMetric: 'privacy_purge_raw_webhooks_total',
    verifyBeforeLaunch: true,
    note: 'Financial, 7y per spec.',
  },
];

export function parseRetentionSchedule(input: unknown): RetentionSchedule {
  const r = z.array(RetentionRuleSchema).safeParse(input);
  if (!r.success) throw new RetentionError(`Invalid retention schedule: ${r.error.message}`);
  const seen = new Set<string>();
  for (const rule of r.data) {
    if (seen.has(rule.category)) throw new RetentionError(`Duplicate category ${rule.category}`);
    seen.add(rule.category);
  }
  return r.data;
}

export function ruleFor(schedule: RetentionSchedule, category: RetentionCategory): RetentionRule {
  const rule = schedule.find((r) => r.category === category);
  if (rule === undefined) throw new RetentionError(`No retention rule for ${category}`);
  return rule;
}

/**
 * When the record becomes eligible for its after-expiry action. `null` means it
 * is kept until the data subject deletes it. contractEndedAt is required for
 * contract-anchored rules.
 */
export function retentionExpiry(
  rule: RetentionRule,
  createdAt: string,
  contractEndedAt?: string,
): string | null {
  switch (rule.period.kind) {
    case 'until_deletion':
      return null;
    case 'months':
      return addMonths(createdAt, rule.period.months);
    case 'after_contract_end_months':
      if (contractEndedAt === undefined) throw new RetentionError('contractEndedAt required');
      return addMonths(contractEndedAt, rule.period.months);
  }
}
