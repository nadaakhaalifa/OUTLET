import { describe, expect, it } from 'vitest';
import { loadMigrations, loadReservedVersions } from './runner';

describe('reserved migration numbers', () => {
  it('only tolerates numbers that are actually unfilled', async () => {
    await expect(loadMigrations()).resolves.toBeDefined();
  });

  it('must be empty in CI: reservations are only for work in progress', async () => {
    if (process.env['CI'] === undefined) return;
    expect([...(await loadReservedVersions())]).toEqual([]);
  });
});
