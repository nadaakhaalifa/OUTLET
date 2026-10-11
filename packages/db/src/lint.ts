/**
 * Migration linter (spec T3: expand/contract only).
 * A heuristic text scanner, not a SQL parser: it strips comments, string
 * literals and dollar-quoted bodies, splits statements, and applies rules.
 * Suppress a finding with `-- lint-allow: <rule-id> <reason>` inside the
 * statement's leading comments. A reason is mandatory.
 */
export type RuleId =
  | 'drop-column'
  | 'rename-column'
  | 'rename-table'
  | 'drop-table'
  | 'drop-schema'
  | 'drop-constraint-or-index'
  | 'alter-column-type'
  | 'not-null-without-default'
  | 'set-not-null'
  | 'index-not-concurrent'
  | 'truncate'
  | 'delete-without-where'
  | 'update-without-where'
  | 'missing-allow-reason';

export interface LintFinding {
  readonly rule: RuleId;
  readonly line: number;
  readonly message: string;
  readonly statement: string;
}

export interface LintOptions {
  /** Tables big enough that a non-concurrent index build blocks writes. */
  readonly largeTables?: readonly string[];
}

export const DEFAULT_LARGE_TABLES: readonly string[] = [
  'postings', 'journal_entries', 'outbox_events', 'inbox_processed', 'audit_log',
  'orders', 'order_items', 'sessions', 'consent_records', 'events',
];

interface Stmt { text: string; line: number; allow: Map<string, string>; badAllow: boolean }

/** Replace comments (kept separately), strings and dollar-quoted bodies with blanks, preserving offsets. */
const split = (sql: string): Stmt[] => {
  const out: Stmt[] = [];
  let cur = '';
  let curLine = 1;
  let line = 1;
  let allow = new Map<string, string>();
  let badAllow = false;
  let started = false;
  const push = (): void => {
    if (cur.trim().length > 0) out.push({ text: cur.trim(), line: curLine, allow, badAllow });
    cur = '';
    allow = new Map();
    badAllow = false;
    started = false;
  };
  const begin = (): void => { if (!started) { started = true; curLine = line; } };
  let i = 0;
  while (i < sql.length) {
    const c = sql[i] as string;
    const rest = sql.slice(i);
    if (c === '-' && sql[i + 1] === '-') {
      const end = sql.indexOf('\n', i);
      const comment = sql.slice(i, end === -1 ? sql.length : end);
      const m = /^--\s*lint-allow:\s*([a-z-]+)\s*(.*)$/.exec(comment);
      if (m && m[1] !== undefined) {
        const reason = (m[2] ?? '').trim();
        if (reason.length === 0) badAllow = true;
        else allow.set(m[1], reason);
      }
      i = end === -1 ? sql.length : end;
      continue;
    }
    if (c === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      const stop = end === -1 ? sql.length : end + 2;
      line += (sql.slice(i, stop).match(/\n/g) ?? []).length;
      i = stop;
      continue;
    }
    if (c === "'") {
      begin();
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === "'" && sql[j + 1] === "'") j += 2;
        else if (sql[j] === "'") break;
        else j += 1;
      }
      line += (sql.slice(i, j + 1).match(/\n/g) ?? []).length;
      cur += "''";
      i = j + 1;
      continue;
    }
    const dq = /^\$([A-Za-z_]*)\$/.exec(rest);
    if (c === '$' && dq) {
      begin();
      const tag = dq[0];
      const end = sql.indexOf(tag, i + tag.length);
      const stop = end === -1 ? sql.length : end + tag.length;
      line += (sql.slice(i, stop).match(/\n/g) ?? []).length;
      cur += '$$';
      i = stop;
      continue;
    }
    if (c === ';') { push(); i += 1; continue; }
    if (c === '\n') line += 1;
    if (!/\s/.test(c)) begin();
    cur += c;
    i += 1;
  }
  push();
  return out;
};

const norm = (s: string): string => s.replace(/\s+/g, ' ').trim();
const ident = String.raw`(?:"[^"]+"|[a-zA-Z_][a-zA-Z0-9_]*)(?:\.(?:"[^"]+"|[a-zA-Z_][a-zA-Z0-9_]*))?`;
const bare = (s: string): string => (s.split('.').pop() ?? s).replace(/"/g, '').toLowerCase();

export const lintMigration = (sql: string, options: LintOptions = {}): LintFinding[] => {
  const large = new Set((options.largeTables ?? DEFAULT_LARGE_TABLES).map((t) => t.toLowerCase()));
  const findings: LintFinding[] = [];
  // Tables created in this same file are empty, so indexing them is safe.
  const createdHere = new Set<string>();
  for (const m of norm(sql.replace(/--[^\n]*/g, '')).matchAll(new RegExp(String.raw`CREATE TABLE (?:IF NOT EXISTS )?(${ident})`, 'gi'))) createdHere.add(bare(m[1] ?? ''));
  for (const st of split(sql)) {
    const t = norm(st.text);
    const u = t.toUpperCase();
    const hit: Array<[RuleId, string]> = [];
    const add = (rule: RuleId, message: string): void => { hit.push([rule, message]); };

    if (st.badAllow) add('missing-allow-reason', 'lint-allow needs a rule id and a reason');

    if (/^ALTER TABLE /.test(u)) {
      if (/\bDROP COLUMN\b/.test(u)) add('drop-column', 'DROP COLUMN is a contract step; deploy code that stops using it first, then drop in a separate contract migration');
      if (/\bRENAME COLUMN\b/.test(u)) add('rename-column', 'RENAME COLUMN breaks running code; add a new column, backfill, switch, then contract');
      if (/\bRENAME TO\b/.test(u)) add('rename-table', 'RENAME TO breaks running code; use expand/contract with a view or a new table');
      if (/\bDROP CONSTRAINT\b/.test(u)) add('drop-constraint-or-index', 'DROP CONSTRAINT weakens guarantees; justify with lint-allow');
      if (/\bALTER COLUMN\b.*\b(SET DATA TYPE|TYPE)\b/.test(u)) add('alter-column-type', 'changing a column type rewrites the table and breaks readers');
      if (/\bALTER COLUMN\b.*\bSET NOT NULL\b/.test(u)) add('set-not-null', 'SET NOT NULL scans the table under lock; add a NOT VALID check constraint, validate, then set');
      for (const m of t.matchAll(/ADD COLUMN(?: IF NOT EXISTS)? (?:"[^"]+"|\w+) ([^,]*)/gi)) {
        const def = (m[1] ?? '').toUpperCase();
        if (/\bNOT NULL\b/.test(def) && !/\bDEFAULT\b/.test(def) && !/\bGENERATED\b/.test(def)) {
          add('not-null-without-default', 'ADD COLUMN ... NOT NULL without DEFAULT fails on non-empty tables; add nullable, backfill, then constrain');
        }
      }
    }
    if (/^DROP TABLE\b/.test(u)) add('drop-table', 'DROP TABLE destroys data');
    if (/^DROP (SCHEMA|DATABASE)\b/.test(u)) add('drop-schema', 'DROP SCHEMA/DATABASE destroys data');
    if (/^DROP (INDEX|TRIGGER|POLICY)\b/.test(u)) add('drop-constraint-or-index', 'dropping an index, trigger or policy can weaken integrity or performance; justify with lint-allow');
    if (/^TRUNCATE\b/.test(u)) add('truncate', 'TRUNCATE destroys data');
    if (/^DELETE FROM\b/.test(u) && !/\bWHERE\b/.test(u)) add('delete-without-where', 'DELETE without WHERE destroys data');
    if (/^UPDATE\b/.test(u) && !/\bWHERE\b/.test(u)) add('update-without-where', 'UPDATE without WHERE rewrites every row in one transaction; batch the backfill');

    const idx = new RegExp(String.raw`^CREATE (?:UNIQUE )?INDEX (CONCURRENTLY )?(?:IF NOT EXISTS )?(?:${ident} )?ON (?:ONLY )?(${ident})`, 'i').exec(t);
    if (idx && idx[1] === undefined && large.has(bare(idx[2] ?? '')) && !createdHere.has(bare(idx[2] ?? ''))) {
      add('index-not-concurrent', `CREATE INDEX on large table ${bare(idx[2] ?? '')} blocks writes; use CREATE INDEX CONCURRENTLY in a "-- no-transaction" migration`);
    }

    for (const [rule, message] of hit) {
      if (rule === 'missing-allow-reason') { findings.push({ rule, line: st.line, message, statement: t.slice(0, 160) }); continue; }
      if (st.allow.has(rule)) continue;
      findings.push({ rule, line: st.line, message, statement: t.slice(0, 160) });
    }
  }
  return findings;
};
