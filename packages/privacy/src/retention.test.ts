import { describe, expect, it } from 'vitest';
import { RETENTION_CATEGORIES, DEFAULT_RETENTION_SCHEDULE, parseRetentionSchedule, retentionExpiry, ruleFor } from './retention.js';

describe('retention', () => {
  it('default schedule covers every category once and validates', () => {
    expect(parseRetentionSchedule(DEFAULT_RETENTION_SCHEDULE)).toHaveLength(RETENTION_CATEGORIES.length);
    expect(() => parseRetentionSchedule([...DEFAULT_RETENTION_SCHEDULE, DEFAULT_RETENTION_SCHEDULE[0]])).toThrow();
  });
  it('computes expiries', () => {
    const s = DEFAULT_RETENTION_SCHEDULE;
    expect(retentionExpiry(ruleFor(s, 'analytics_events'), '2026-01-31T00:00:00.000Z')).toBe('2028-02-29T00:00:00.000Z');
    expect(retentionExpiry(ruleFor(s, 'support_chats'), '2026-10-10T00:00:00.000Z')).toBe('2028-10-10T00:00:00.000Z');
    expect(retentionExpiry(ruleFor(s, 'measurements'), '2026-10-10T00:00:00.000Z')).toBeNull();
    expect(retentionExpiry(ruleFor(s, 'kyc'), '2020-01-01T00:00:00.000Z', '2026-10-10T00:00:00.000Z')).toBe('2031-10-10T00:00:00.000Z');
    expect(() => retentionExpiry(ruleFor(s, 'kyc'), '2020-01-01T00:00:00.000Z')).toThrow();
  });
  it('flags unverified legal periods', () => {
    expect(ruleFor(DEFAULT_RETENTION_SCHEDULE, 'orders_invoices').verifyBeforeLaunch).toBe(true);
  });
});
