import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadMigrations, loadReservedVersions, splitStatements } from './runner';

const dirWith = async (files: Record<string, string>): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'mig-'));
  for (const [n, c] of Object.entries(files)) await writeFile(join(dir, n), c);
  return dir;
};

describe('migration sequence with RESERVED numbers', () => {
  it('skips a reserved number without a gap error', async () => {
    const dir = await dirWith({ '0001_a.sql': 'select 1;', '0003_c.sql': 'select 3;', RESERVED: '# wip\n2\n' });
    expect((await loadMigrations(dir)).map((f) => f.version)).toEqual([1, 3]);
  });
  it('rejects a reserved number that exists as a file', async () => {
    const dir = await dirWith({ '0001_a.sql': 'select 1;', '0002_b.sql': 'select 2;', RESERVED: '2\n' });
    await expect(loadMigrations(dir)).rejects.toThrow(/listed in RESERVED but exists/);
  });
  it('rejects an unreserved gap and a malformed RESERVED line', async () => {
    await expect(loadMigrations(await dirWith({ '0001_a.sql': 'x;', '0003_c.sql': 'x;' }))).rejects.toThrow(/expected migration 0002/);
    await expect(loadReservedVersions(await dirWith({ RESERVED: 'abc\n' }))).rejects.toThrow(/invalid line/);
  });
});

describe('splitStatements edge cases', () => {
  it('handles unterminated comments and dollar quotes, and comment-only pieces', () => {
    expect(splitStatements('select 1; -- trailing')).toEqual(['select 1']);
    expect(splitStatements('do $$ begin; end $$; select $x')).toEqual(['do $$ begin; end $$', 'select $x']);
    expect(splitStatements("select 'a;b'; select 2")).toEqual(["select 'a;b'", 'select 2']);
  });
});
