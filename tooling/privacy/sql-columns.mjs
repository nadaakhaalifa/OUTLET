// Minimal CREATE TABLE column extractor for packages/db/migrations (spec B1: CI fails on untagged columns).
// Pure: takes SQL text, returns "table.column" names. It understands the subset of SQL the
// migrations use (CREATE TABLE ... ( col type ..., CONSTRAINT ..., ) and ALTER TABLE ... ADD COLUMN).

const CONSTRAINT_STARTS = new Set([
  'constraint',
  'primary',
  'foreign',
  'unique',
  'check',
  'exclude',
  'like',
  'period',
]);

function stripComments(sql) {
  return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
}

/** Split `body` on commas that are not nested inside parentheses or quotes. */
function splitTopLevel(body) {
  const parts = [];
  let depth = 0;
  let quote = false;
  let cur = '';
  for (const ch of body) {
    if (ch === "'") quote = !quote;
    if (!quote) {
      if (ch === '(') depth += 1;
      if (ch === ')') depth -= 1;
      if (ch === ',' && depth === 0) {
        parts.push(cur);
        cur = '';
        continue;
      }
    }
    cur += ch;
  }
  if (cur.trim().length > 0) parts.push(cur);
  return parts;
}

function unquote(ident) {
  return ident.replace(/^"|"$/g, '').toLowerCase();
}

/**
 * Columns removed by ALTER TABLE ... DROP COLUMN, as "table.column". The caller applies drops after the
 * file's own additions so that a column dropped by a later migration is no longer expected in the inventory.
 * @param {string} sql
 * @returns {string[]}
 */
export function extractDroppedColumns(sql) {
  const clean = sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const out = new Set();
  const alterRe = /alter\s+table\s+(?:only\s+)?(?:if\s+exists\s+)?(?:[a-z0-9_"]+\.)?("?[a-z0-9_]+"?)\s+([^;]*)/gi;
  const dropRe = /^\s*drop\s+column\s+(?:if\s+exists\s+)?("?[a-z0-9_]+"?)/i;
  let m;
  while ((m = alterRe.exec(clean)) !== null) {
    const table = unquote(m[1]);
    for (const clause of splitTopLevel(m[2] ?? '')) {
      const col = dropRe.exec(clause);
      if (col?.[1]) out.add(`${table}.${unquote(col[1])}`);
    }
  }
  return [...out].sort();
}

/**
 * @param {string} sql
 * @returns {string[]} sorted unique "table.column" names
 */
export function extractColumns(sql) {
  const clean = stripComments(sql);
  const found = new Set();

  const createRe = /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:[a-z0-9_"]+\.)?("?[a-z0-9_]+"?)\s*\(/gi;
  let m;
  while ((m = createRe.exec(clean)) !== null) {
    const table = unquote(m[1]);
    let depth = 1;
    let i = createRe.lastIndex;
    const start = i;
    while (i < clean.length && depth > 0) {
      if (clean[i] === '(') depth += 1;
      if (clean[i] === ')') depth -= 1;
      i += 1;
    }
    const body = clean.slice(start, i - 1);
    for (const part of splitTopLevel(body)) {
      const first = part.trim().split(/\s+/)[0];
      if (!first) continue;
      const word = unquote(first);
      if (CONSTRAINT_STARTS.has(word)) continue;
      found.add(`${table}.${word}`);
    }
  }

  // One ALTER TABLE may carry several comma-separated ADD COLUMN clauses; read every one.
  const alterRe = /alter\s+table\s+(?:only\s+)?(?:if\s+exists\s+)?(?:[a-z0-9_"]+\.)?("?[a-z0-9_]+"?)\s+([^;]*)/gi;
  const addRe = /^\s*add\s+column\s+(?:if\s+not\s+exists\s+)?("?[a-z0-9_]+"?)/i;
  while ((m = alterRe.exec(clean)) !== null) {
    const table = unquote(m[1]);
    for (const clause of splitTopLevel(m[2] ?? '')) {
      const col = addRe.exec(clause);
      if (col?.[1]) found.add(`${table}.${unquote(col[1])}`);
    }
  }
  return [...found].sort();
}
