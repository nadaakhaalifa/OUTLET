#!/usr/bin/env node
// Validates docs/api/openapi.yaml: structural validity (swagger-parser, which
// resolves every $ref) plus Outlet NK contract rules from docs/api/README.md.
// Usage: node tooling/api/validate-openapi.mjs [path-to-openapi.yaml]
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import SwaggerParser from '@apidevtools/swagger-parser';
import { parse } from 'yaml';

const here = dirname(fileURLToPath(import.meta.url));
const file = resolve(process.argv[2] ?? resolve(here, '../../docs/api/openapi.yaml'));

const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];
const WRITE = new Set(['post', 'put', 'patch', 'delete']);
const PII = new Set(['P0', 'P1', 'P2', 'P3']);
const errors = [];
const fail = (where, msg) => errors.push(`${where}: ${msg}`);

const raw = parse(readFileSync(file, 'utf8'));

// 1. Structural validation and $ref resolution.
try {
  await SwaggerParser.validate(structuredClone(raw));
} catch (e) {
  console.error(`openapi: structural validation FAILED\n${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}

if (!String(raw.openapi).startsWith('3.1')) fail('openapi', `expected 3.1.x, got ${raw.openapi}`);

const schemes = raw.components?.securitySchemes ?? {};
const params = raw.components?.parameters ?? {};
const resolveParam = (p) => (p.$ref ? params[p.$ref.split('/').pop()] : p);

const seenIds = new Map();
let opCount = 0;
let writeCount = 0;
let webhookCount = 0;
let publicCount = 0;

for (const [path, item] of Object.entries(raw.paths ?? {})) {
  if (!path.startsWith('/v1/')) fail(path, 'path must start with /v1/');
  for (const method of METHODS) {
    const op = item[method];
    if (!op) continue;
    opCount += 1;
    const where = `${method.toUpperCase()} ${path}`;

    // operationId unique and camelCase
    if (!op.operationId) fail(where, 'missing operationId');
    else {
      if (!/^[a-z][A-Za-z0-9]*$/.test(op.operationId)) fail(where, `operationId ${op.operationId} is not camelCase`);
      if (seenIds.has(op.operationId)) fail(where, `duplicate operationId ${op.operationId} (also ${seenIds.get(op.operationId)})`);
      seenIds.set(op.operationId, where);
    }

    // auth declared at operation level (no silent inheritance)
    if (!Array.isArray(op.security)) fail(where, 'must declare operation-level security (use [] only for public routes)');
    else if (op.security.length === 0) {
      publicCount += 1;
      if (!Array.isArray(op['x-scope']) || op['x-scope'].join() !== 'public') fail(where, 'empty security requires x-scope: [public]');
    } else {
      for (const req of op.security) {
        const keys = Object.keys(req);
        if (keys.length === 0) fail(where, 'empty security requirement object not allowed');
        for (const k of keys) if (!schemes[k]) fail(where, `unknown security scheme ${k}`);
      }
    }

    // vendor extensions
    if (!Array.isArray(op['x-scope']) || op['x-scope'].length === 0 || !op['x-scope'].every((s) => typeof s === 'string' && s.length > 0)) fail(where, 'x-scope must be a non-empty string array');
    if (typeof op['x-idempotent'] !== 'boolean') fail(where, 'x-idempotent must be boolean');
    if (!PII.has(op['x-pii-class'])) fail(where, 'x-pii-class must be one of P0..P3');
    const rl = op['x-rate-limit'];
    if (!Array.isArray(rl) || rl.length === 0) fail(where, 'x-rate-limit must be a non-empty array');
    else for (const r of rl) {
      if (!(Number.isInteger(r.limit) && r.limit > 0 && Number.isInteger(r.window_seconds) && r.window_seconds > 0 && typeof r.key === 'string')) fail(where, 'x-rate-limit entries need integer limit, window_seconds and a key');
      if (!['spec', 'proposed'].includes(r.source)) fail(where, 'x-rate-limit source must be spec or proposed');
    }

    // responses: problem+json errors, 429 present, no 2xx without schema when body expected
    const responses = op.responses ?? {};
    if (!responses['429'] && !responses.default) fail(where, 'must declare 429');
    if (!responses['429']) fail(where, 'missing 429 response');
    if (!responses.default) fail(where, 'missing default Problem+JSON response');
    for (const [code, r] of Object.entries(responses)) {
      if (/^[45]/.test(code) || code === 'default') {
        if (!r.$ref?.startsWith('#/components/responses/')) fail(where, `error response ${code} must reference a shared Problem response`);
      }
    }

    // writes need Idempotency-Key (webhooks use provider event ids instead)
    const ps = (op.parameters ?? []).map(resolveParam);
    const idem = ps.find((p) => p && p.in === 'header' && p.name.toLowerCase() === 'idempotency-key');
    if (WRITE.has(method)) {
      writeCount += 1;
      if (op['x-webhook'] === true) {
        webhookCount += 1;
        if (!op['x-dedup-key']) fail(where, 'webhook must declare x-dedup-key');
        if (!op.security?.some((r) => r.webhookHmac)) fail(where, 'webhook must use webhookHmac security');
      } else {
        if (!idem) fail(where, 'write operation must declare an Idempotency-Key header parameter');
        if (op['x-idempotent'] === true && idem && idem.required !== true) fail(where, 'x-idempotent: true requires Idempotency-Key required: true');
        if (op['x-idempotent'] === false && idem && idem.required === true) fail(where, 'required Idempotency-Key but x-idempotent is false');
      }
      if (op['x-idempotent'] === true && !responses['409']) fail(where, 'idempotent write must declare 409 (in-flight duplicate)');
      if (!responses['422']) fail(where, 'write must declare 422');
    } else if (op['x-idempotent'] === true) {
      fail(where, 'GET cannot be x-idempotent: true');
    }

    // ETag discipline
    if (method === 'get' && op['x-etag']) {
      if (!responses['304']) fail(where, 'x-etag GET must declare 304');
      if (!ps.some((p) => p?.name === 'If-None-Match')) fail(where, 'x-etag GET must accept If-None-Match');
      const ok = Object.entries(responses).find(([c]) => c.startsWith('2'));
      if (!ok?.[1].headers?.ETag) fail(where, 'x-etag GET 2xx must return ETag header');
    }
    if (ps.some((p) => p?.name === 'If-Match')) {
      if (!responses['412']) fail(where, 'If-Match operation must declare 412');
      if (!responses['428']) fail(where, 'If-Match operation must declare 428');
    }

    // success responses expose rate-limit headers
    const okEntry = Object.entries(responses).find(([c]) => c.startsWith('2'));
    if (!okEntry) fail(where, 'no 2xx response');
    else if (!okEntry[1].headers?.['RateLimit-Limit']) fail(where, 'success response must expose RateLimit-* headers');

    // cursor pagination: list responses carry page info; page size max 50
    if (ps.some((p) => p?.name === 'cursor')) {
      const lim = ps.find((p) => p?.name === 'limit');
      if (!lim || lim.schema?.maximum !== 50) fail(where, 'paginated operation must accept limit with maximum 50');
    }

    // mass-assignment guard: request object schemas must be closed
    const body = op.requestBody?.content?.['application/json']?.schema;
    if (body?.$ref) {
      const name = body.$ref.split('/').pop();
      const s = raw.components.schemas[name];
      if (s?.type === 'object' && s.additionalProperties !== false && name !== 'Webhook') fail(where, `request schema ${name} must set additionalProperties: false`);
    }
  }
}

// Money fields never use number/float.
const walk = (node, trail) => {
  if (Array.isArray(node)) return node.forEach((n, i) => walk(n, `${trail}[${i}]`));
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (k === 'properties' && v && typeof v === 'object') {
        for (const [pn, ps] of Object.entries(v)) {
          if (!pn.startsWith('rows_') && /(_amount|price|total|subtotal|balance|fee|vat)$/.test(pn) && ps && typeof ps === 'object' && ['number', 'integer'].includes(ps.type)) {
            fail(trail, `property ${pn} looks like money but is ${ps.type}; use the Money schema`);
          }
        }
      }
      walk(v, `${trail}.${k}`);
    }
  }
};
walk(raw.components.schemas, 'components.schemas');

// Every schema referenced exists is covered by SwaggerParser; report unused schemas as a warning.
const text = readFileSync(file, 'utf8');
const unused = Object.keys(raw.components.schemas).filter((n) => !text.includes(`#/components/schemas/${n}`));
if (unused.length) console.warn(`warning: unused component schemas: ${unused.join(', ')}`);

if (errors.length) {
  console.error(`openapi: ${errors.length} contract violation(s)`);
  for (const e of errors.slice(0, 200)) console.error(`  - ${e}`);
  process.exit(1);
}
console.log(`openapi: OK  ${file}`);
console.log(`  operations: ${opCount}  writes: ${writeCount} (webhooks: ${webhookCount})  public: ${publicCount}  schemas: ${Object.keys(raw.components.schemas).length}`);
