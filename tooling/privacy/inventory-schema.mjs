// Schema and semantic rules for docs/privacy/data_inventory.yaml (spec B1, T6).
// Pure functions only: no file or network access here, so tests stay hermetic.
import { z } from 'zod';

export const PII_CLASSES = ['P0', 'P1', 'P2', 'P3'];
export const LAWFUL_BASES = ['consent', 'contract', 'legal_obligation', 'legitimate_interest'];
// The nine consent purposes named in spec B1 (consent_records).
export const CONSENT_PURPOSES = [
  'marketing_push',
  'marketing_whatsapp',
  'marketing_email',
  'analytics',
  'personalization',
  'budget_insights',
  'measurements',
  'location_precise',
  'cross_border_ml',
];
export const RESIDENCY = ['in_country', 'approved_region', 'global_ok', 'device_only'];
export const ENCRYPTION = [
  'field_envelope',
  'blind_index_hmac',
  'one_way_hash',
  'psp_tokenized',
  'device_secure_storage',
  'not_persisted',
  'none',
];
export const SELLER_VISIBILITY = ['none', 'masked', 'aggregate_k50', 'full'];
export const EXTERNAL_LLM = ['never', 'consent_and_licence'];
export const ON_ERASURE = ['delete', 'pseudonymize', 'retain_legal', 'not_personal'];
export const DATA_SUBJECTS = [
  'shopper',
  'visitor',
  'seller_representative',
  'creator',
  'gift_recipient',
  'staff',
  'courier_agent',
  'minor_profile',
];
export const DPA_STATUSES = ['unknown', 'requested', 'in_negotiation', 'signed', 'not_required'];
export const RETENTION_TRIGGERS = [
  'collection',
  'account_deletion',
  'order_close',
  'contract_end',
  'delivery_or_return_closure',
  'return_closure',
  'event_date',
  'expiry',
  'user_deletes',
  'consent_withdrawn',
  'rolling_window',
  'catalog_lifecycle',
  'not_stored',
];
export const RETENTION_AFTER = [
  'delete',
  'anonymize',
  'aggregate',
  'pseudonymize',
  'erase_or_pseudonymize',
  'revoke_access',
  'none',
];
export const PROCESSOR_CATEGORIES = [
  'cloud',
  'edge',
  'psp',
  'bnpl',
  'courier',
  'sms',
  'whatsapp_bsp',
  'email',
  'push',
  'llm_vendor',
  'analytics',
  'error_monitoring',
  'identity_provider',
  'kyc_verifier',
  'attestation',
  'seller',
];

const id = z.string().regex(/^[a-z][a-z0-9_]*$/, 'must be snake_case');
const text = z.string().min(1);

const taggable = {
  purpose: z.array(id).min(1).optional(),
  lawful_basis: z.enum(LAWFUL_BASES).optional(),
  consent_purpose: z.enum(CONSENT_PURPOSES).optional(),
  retention: id.optional(),
  processors: z.array(id).optional(),
  residency: z.enum(RESIDENCY).optional(),
  seller_visibility: z.enum(SELLER_VISIBILITY).optional(),
  external_llm: z.enum(EXTERNAL_LLM).optional(),
  on_erasure: z.enum(ON_ERASURE).optional(),
  dsar_export: z.boolean().optional(),
};

const defaultsSchema = z.strictObject({ ...taggable, verify: z.boolean().optional() });

const fieldSchema = z.strictObject({
  ...taggable,
  name: id,
  pii_class: z.enum(PII_CLASSES),
  encryption: z.enum(ENCRYPTION),
  verify: z.boolean().optional(),
  note: text.optional(),
});

const tableSchema = z.strictObject({
  name: id,
  spec_ref: text,
  source: z.enum(['spec_named', 'derived']),
  storage: z.enum(['platform_db', 'processor_hosted', 'device_only']).default('platform_db'),
  data_subjects: z.array(z.enum(DATA_SUBJECTS)).min(1),
  description: text.optional(),
  defaults: defaultsSchema.optional(),
  forbidden_importers: z.array(id).optional(),
  fields: z.array(fieldSchema).min(1),
});

const periodSchema = z.strictObject({
  value: z.number().int().positive(),
  unit: z.enum(['hours', 'days', 'months', 'years']),
});

const retentionSchema = z.strictObject({
  description: text,
  period: periodSchema.nullable(),
  trigger: z.enum(RETENTION_TRIGGERS),
  after: z.enum(RETENTION_AFTER),
  purge_job: id,
  purge_metric: text,
  source: z.enum(['spec', 'proposed']),
  spec_ref: text.optional(),
  verify: z.boolean(),
  note: text.optional(),
});

const processorSchema = z.strictObject({
  name: text,
  category: z.enum(PROCESSOR_CATEGORIES),
  candidates: z.array(text),
  role: z.enum(['processor', 'independent_controller', 'joint_controller', 'unknown']),
  location: text,
  dpa_status: z.enum(DPA_STATUSES),
  dpa_evidence: text.optional(),
  sub_processors: z.enum(['unknown', 'listed']),
  transfer_tia: z.enum(['unknown', 'required', 'not_required']),
  contract_status: z.enum(['not_started', 'in_progress', 'signed']),
  spec_ref: text,
  verify: z.boolean(),
  note: text.optional(),
});

const purposeSchema = z.strictObject({
  title: text,
  description: text,
});

export const inventorySchema = z.strictObject({
  inventory_version: z.literal(1),
  last_reviewed: z.iso.date(),
  status: z.enum(['DRAFT_NOT_REVIEWED_BY_COUNSEL', 'REVIEWED']),
  consent_purposes: z.array(z.enum(CONSENT_PURPOSES)),
  purposes: z.record(id, purposeSchema),
  processors: z.record(id, processorSchema),
  retention: z.record(id, retentionSchema),
  tables: z.array(tableSchema).min(1),
});

const PRIVATE = new Set(['P2', 'P3']);

function zodIssues(error) {
  return error.issues.map((i) => {
    const p = i.path.map((seg) => (typeof seg === 'number' ? `[${seg}]` : `.${seg}`)).join('');
    return `schema${p}: ${i.message}`;
  });
}

/**
 * Resolve effective tags for every field (field overrides table defaults).
 * pii_class and encryption are never defaulted: they must be set on each field.
 */
function resolve(inv) {
  const resolved = [];
  const problems = [];
  for (const table of inv.tables) {
    const d = table.defaults ?? {};
    for (const f of table.fields) {
      const path = `${table.name}.${f.name}`;
      const pick = (key, fallback) => f[key] ?? d[key] ?? fallback;
      const cls = f.pii_class;
      const eff = {
        table: table.name,
        name: f.name,
        path,
        pii_class: cls,
        encryption: f.encryption,
        purpose: pick('purpose'),
        lawful_basis: pick('lawful_basis'),
        consent_purpose: pick('consent_purpose'),
        retention: pick('retention'),
        processors: pick('processors'),
        residency: pick('residency'),
        seller_visibility: pick('seller_visibility', 'none'),
        external_llm: pick('external_llm', 'never'),
        on_erasure: pick('on_erasure', PRIVATE.has(cls) ? undefined : 'not_personal'),
        dsar_export: pick('dsar_export', PRIVATE.has(cls)),
        verify: (f.verify ?? d.verify) === true,
        note: f.note,
        source: table.source,
        storage: table.storage,
        data_subjects: table.data_subjects,
        spec_ref: table.spec_ref,
      };
      for (const key of ['purpose', 'lawful_basis', 'retention', 'processors', 'residency', 'on_erasure']) {
        if (eff[key] === undefined) problems.push(`untagged field ${path}: missing ${key}`);
      }
      resolved.push(eff);
    }
  }
  return { resolved, problems };
}

function semanticRules(inv, resolved) {
  const errors = [];
  const warnings = [];

  const tableNames = new Set();
  for (const t of inv.tables) {
    if (tableNames.has(t.name)) errors.push(`duplicate table ${t.name}`);
    tableNames.add(t.name);
    const seen = new Set();
    for (const f of t.fields) {
      if (seen.has(f.name)) errors.push(`duplicate field ${t.name}.${f.name}`);
      seen.add(f.name);
    }
    if (t.storage === 'device_only') {
      for (const f of t.fields) {
        if ((f.residency ?? t.defaults?.residency) !== 'device_only') {
          errors.push(`${t.name}.${f.name}: table storage is device_only so residency must be device_only`);
        }
      }
    }
  }

  const declared = new Set(inv.consent_purposes);
  for (const p of CONSENT_PURPOSES) {
    if (!declared.has(p)) errors.push(`consent_purposes is missing "${p}" required by spec B1`);
  }

  // A table that holds budget_insights data may not be importable by promotions or ads (spec section 12 privacy).
  const budgetTables = new Set(
    resolved.filter((r) => r.consent_purpose === 'budget_insights').map((r) => r.table),
  );
  for (const t of inv.tables) {
    if (!budgetTables.has(t.name)) continue;
    const fi = new Set(t.forbidden_importers ?? []);
    for (const m of ['promotions', 'ads']) {
      if (!fi.has(m)) errors.push(`table ${t.name} holds budget_insights data and must list "${m}" in forbidden_importers`);
    }
  }

  for (const r of resolved) {
    const at = r.path;
    for (const pid of r.purpose ?? []) {
      if (!inv.purposes[pid]) errors.push(`${at}: unknown purpose "${pid}"`);
    }
    if (r.retention && !inv.retention[r.retention]) errors.push(`${at}: unknown retention "${r.retention}"`);
    for (const pr of r.processors ?? []) {
      if (!inv.processors[pr]) errors.push(`${at}: unknown processor "${pr}"`);
    }
    if (r.lawful_basis === 'consent' && !r.consent_purpose) {
      errors.push(`${at}: lawful_basis consent requires consent_purpose`);
    }
    if (r.lawful_basis !== 'consent' && r.consent_purpose) {
      errors.push(`${at}: consent_purpose set but lawful_basis is ${r.lawful_basis}`);
    }
    if (r.lawful_basis === 'legitimate_interest' && !r.verify) {
      errors.push(`${at}: legitimate_interest availability under PDPL is unverified, so verify must be true`);
    }
    if (r.pii_class === 'P3' && r.encryption === 'none') {
      errors.push(`${at}: P3 must be field-encrypted, hashed, tokenized or not persisted (encryption none)`);
    }
    if (r.pii_class === 'P3' && r.residency === 'global_ok') {
      errors.push(`${at}: P3 may not have residency global_ok`);
    }
    if (PRIVATE.has(r.pii_class) && r.residency === 'global_ok') {
      errors.push(`${at}: ${r.pii_class} may not have residency global_ok`);
    }
    if (r.encryption === 'not_persisted' && r.residency !== 'device_only') {
      errors.push(`${at}: encryption not_persisted requires residency device_only`);
    }
    if (r.residency === 'device_only' && !['device_secure_storage', 'not_persisted'].includes(r.encryption)) {
      errors.push(`${at}: residency device_only requires device_secure_storage or not_persisted`);
    }
    if (r.pii_class === 'P3' && r.external_llm !== 'never') {
      errors.push(`${at}: P3 must have external_llm never (spec T12 LLM02)`);
    }
    if (r.seller_visibility === 'aggregate_k50' && PRIVATE.has(r.pii_class)) {
      errors.push(`${at}: aggregate_k50 visibility is only for non-personal aggregates (P0/P1)`);
    }
    if (r.pii_class === 'P3' && r.seller_visibility === 'full' && r.table !== 'delivery_snapshots') {
      errors.push(`${at}: P3 may be fully visible to sellers only through the delivery snapshot`);
    }
    if (PRIVATE.has(r.pii_class) && r.dsar_export === false && !r.note) {
      errors.push(`${at}: ${r.pii_class} field excluded from DSAR export needs a note explaining why`);
    }
    if (r.pii_class === 'P0' && r.processors && r.processors.length === 0 && r.storage === 'platform_db') {
      warnings.push(`${at}: platform_db field with no processors (cloud hosting is normally listed)`);
    }
  }

  for (const [rid, r] of Object.entries(inv.retention)) {
    if (r.source === 'proposed' && r.period !== null && !r.verify) {
      errors.push(`retention ${rid}: proposed periods are not in the spec and must set verify true`);
    }
    if (r.period === null && !['account_deletion', 'user_deletes', 'consent_withdrawn', 'not_stored', 'catalog_lifecycle', 'expiry'].includes(r.trigger)) {
      errors.push(`retention ${rid}: null period needs an event trigger that ends it`);
    }
  }

  for (const [pid, p] of Object.entries(inv.processors)) {
    if (p.dpa_status === 'signed' && !p.dpa_evidence) {
      errors.push(`processor ${pid}: dpa_status signed requires dpa_evidence`);
    }
    if (p.dpa_status === 'unknown' && !p.verify) {
      errors.push(`processor ${pid}: unknown DPA status must set verify true`);
    }
  }

  // Unused registry entries are suspicious but not fatal.
  const usedProc = new Set(resolved.flatMap((r) => r.processors ?? []));
  for (const pid of Object.keys(inv.processors)) {
    if (!usedProc.has(pid)) warnings.push(`processor ${pid} is not referenced by any field`);
  }
  const usedRet = new Set(resolved.map((r) => r.retention));
  for (const rid of Object.keys(inv.retention)) {
    if (!usedRet.has(rid)) warnings.push(`retention ${rid} is not referenced by any field`);
  }
  const usedPurp = new Set(resolved.flatMap((r) => r.purpose ?? []));
  for (const pid of Object.keys(inv.purposes)) {
    if (!usedPurp.has(pid)) warnings.push(`purpose ${pid} is not referenced by any field`);
  }
  const usedConsent = new Set(resolved.map((r) => r.consent_purpose).filter(Boolean));
  for (const c of CONSENT_PURPOSES) {
    if (!usedConsent.has(c)) warnings.push(`consent purpose ${c} is not referenced by any field`);
  }

  return { errors, warnings };
}

/**
 * Validate a parsed inventory object.
 * @returns {{ok: boolean, errors: string[], warnings: string[], inventory: object|null, resolved: object[]}}
 */
export function validateInventory(raw) {
  const parsed = inventorySchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, errors: zodIssues(parsed.error), warnings: [], inventory: null, resolved: [] };
  }
  const inventory = parsed.data;
  const { resolved, problems } = resolve(inventory);
  const { errors, warnings } = semanticRules(inventory, resolved);
  const all = [...problems, ...errors];
  return { ok: all.length === 0, errors: all, warnings, inventory, resolved };
}

const requiredSchema = z.strictObject({
  must_exist: z.array(z.string().regex(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/)),
  constraints: z.array(
    z.strictObject({
      path: z.string(),
      pii_class: z.enum(PII_CLASSES).optional(),
      encryption: z.enum(ENCRYPTION).optional(),
      residency: z.enum(RESIDENCY).optional(),
      seller_visibility: z.enum(SELLER_VISIBILITY).optional(),
      external_llm: z.enum(EXTERNAL_LLM).optional(),
      lawful_basis: z.enum(LAWFUL_BASES).optional(),
      consent_purpose: z.enum(CONSENT_PURPOSES).optional(),
      reason: text,
    }),
  ),
});

/** Check that fields the spec names exist and meet spec-mandated constraints. */
export function checkRequired(resolved, rawRequired) {
  const parsed = requiredSchema.safeParse(rawRequired);
  if (!parsed.success) return zodIssues(parsed.error).map((e) => `required-fields ${e}`);
  const byPath = new Map(resolved.map((r) => [r.path, r]));
  const errors = [];
  for (const p of parsed.data.must_exist) {
    if (!byPath.has(p)) errors.push(`spec-named field ${p} is missing from the inventory`);
  }
  for (const c of parsed.data.constraints) {
    const r = byPath.get(c.path);
    if (!r) {
      errors.push(`constrained field ${c.path} is missing from the inventory`);
      continue;
    }
    for (const key of ['pii_class', 'encryption', 'residency', 'seller_visibility', 'external_llm', 'lawful_basis', 'consent_purpose']) {
      if (c[key] !== undefined && r[key] !== c[key]) {
        errors.push(`${c.path}: ${key} is ${r[key]} but must be ${c[key]} (${c.reason})`);
      }
    }
  }
  return errors;
}

/** Compare a list of real "table.column" names against the inventory; untagged columns fail. */
export function checkColumns(resolved, columns) {
  const parsed = z.array(z.string().regex(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/)).safeParse(columns);
  if (!parsed.success) return { errors: zodIssues(parsed.error).map((e) => `columns ${e}`), stale: [] };
  const tagged = new Set(resolved.map((r) => r.path));
  const actual = new Set(parsed.data);
  const errors = parsed.data.filter((c) => !tagged.has(c)).map((c) => `untagged column ${c}: add it to data_inventory.yaml`);
  const stale = [...tagged].filter((p) => !actual.has(p));
  return { errors, stale };
}
