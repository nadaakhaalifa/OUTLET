import { sql, type RawBuilder } from "kysely";
import type { PrivacyDb } from "./kysely-store";

/**
 * Where a data subject's rows live, per table. Used by the DSAR exporters and the erasure executor
 * so both always agree on which rows are "this user's". Tables not listed here fall back to a
 * `user_id` column when the table has one; a table with neither is a reported gap, never guessed.
 */
export type Where = (userId: string) => RawBuilder<unknown>;
export type JsonRow = Readonly<Record<string, unknown>>;

export interface TableSpec {
  /** Predicate over the table aliased `t`. */
  readonly where?: Where;
  /** Columns never exported (credentials, hashes, raw provider bodies, other people's ids). */
  readonly omit?: readonly string[];
  /** bytea columns that are field-encrypted, mapped to the AAD the owning module sealed them with. */
  readonly decrypt?: Readonly<Record<string, (row: JsonRow) => string>>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: string): boolean => UUID.test(s);

const eq =
  (col: string): Where =>
  (u) =>
    sql`t.${sql.ref(col)} = ${u}::uuid`;
const ownOrders = (u: string): RawBuilder<unknown> => sql`(select id from seller_orders where user_id = ${u}::uuid)`;
const ownGroups = (u: string): RawBuilder<unknown> => sql`(select id from order_groups where user_id = ${u}::uuid)`;
const ownReturns = (u: string): RawBuilder<unknown> => sql`(select id from returns where user_id = ${u}::uuid)`;
const viaOrders =
  (col: string): Where =>
  (u) =>
    sql`t.${sql.ref(col)} in ${ownOrders(u)}`;

const str = (v: unknown): string => (typeof v === "string" ? v : String(v));
const epochMs = (v: unknown): number => Math.floor(Date.parse(str(v)));

export const TABLE_SPECS: Readonly<Record<string, TableSpec>> = {
  users: { where: eq("id") },
  identities: { omit: ["subject_hash", "subject_ciphertext"] },
  sessions: { omit: ["refresh_hash"] },
  consent_records: { where: (u) => sql`t.subject_type = 'user' and t.subject_id = ${u}::uuid`, omit: ["ip_hash"] },
  // Budget (P3, field-encrypted). AADs mirror the budget module's codec.
  budgets: {
    decrypt: {
      amount: (r) => `budget:${str(r.user_id)}:amount`,
      per_category: (r) => `budget:${str(r.user_id)}:per_category`,
    },
  },
  budget_cycles: {
    decrypt: {
      spent: (r) => `cycle:${str(r.user_id)}:${epochMs(r.cycle_start)}:spent`,
      refunded: (r) => `cycle:${str(r.user_id)}:${epochMs(r.cycle_start)}:refunded`,
      refund_received: (r) => `cycle:${str(r.user_id)}:${epochMs(r.cycle_start)}:refund_received`,
    },
  },
  budget_spend_events: { decrypt: { detail: (r) => `spend:${str(r.user_id)}:${str(r.event_key)}` } },
  installment_commitments: {
    decrypt: { monthly: (r) => `commitment:${str(r.user_id)}:${str(r.source)}:${str(r.provider)}:${epochMs(r.starts_at)}` },
  },
  size_profiles: {
    decrypt: {
      label: (r) => `size_profile:${str(r.user_id)}:${str(r.id)}:label`,
      measurements: (r) => `size_profile:${str(r.user_id)}:${str(r.id)}:measurements`,
      quick_start: (r) => `size_profile:${str(r.user_id)}:${str(r.id)}:quick_start`,
    },
  },
  // Address book (P3, field-encrypted; AAD `address:<id>:<field>` mirrors addresses/codec.ts). Blind indexes are bytea and never exported.
  saved_addresses: {
    decrypt: {
      recipient_name_enc: (r) => `address:${str(r.id)}:recipient`,
      phone_enc: (r) => `address:${str(r.id)}:phone`,
      street_enc: (r) => `address:${str(r.id)}:street`,
      building_enc: (r) => `address:${str(r.id)}:building`,
      floor_enc: (r) => `address:${str(r.id)}:floor`,
      apartment_enc: (r) => `address:${str(r.id)}:apartment`,
      landmark_enc: (r) => `address:${str(r.id)}:landmark`,
      map_pin_enc: (r) => `address:${str(r.id)}:pin`,
    },
  },
  gift_address_tokens: { where: eq("owner_user_id") },
  // Family plans: the owner exports the group; a member exports only their own seat (never other members' rows).
  family_groups: { where: eq("owner_user_id") },
  family_invites: { where: eq("created_by"), omit: ["invitee_phone_hash", "token_hash"] },
  visual_search_usage: { where: (u) => sql`t.subject = ${u}` },
  gift_card_attempts: { where: eq("account_id") },
  gift_cards: {
    where: eq("purchaser_id"),
    omit: ["code_hash"],
    decrypt: {
      recipient_contact: (r) => `gift_card:${str(r.id)}:recipient_contact`,
      message: (r) => `gift_card:${str(r.id)}:message`,
    },
  },
  gift_pots: { where: eq("organiser_id"), omit: ["share_token_hash"] },
  referral_codes: { where: eq("owner_user_id") },
  referrals: { where: (u) => sql`(t.referrer_id = ${u}::uuid or t.referee_id = ${u}::uuid)`, omit: ["referee_device_hashes", "payment_fingerprint_hash"] },
  wishlists: { omit: ["share_token_hash"] },
  // Object keys are capability handles into the private bucket, not subject data: the photo itself is served in-app.
  wardrobe_items: { omit: ["image_ref"] },
  wardrobe_uploads: { omit: ["upload_id"] },
  shipments: {
    where: (u) => sql`(t.seller_order_id in ${ownOrders(u)} or t.seller_order_ids && array(select id from seller_orders where user_id = ${u}::uuid))`,
  },
  courier_events_raw: {
    where: (u) => sql`t.awb in (select awb from shipments where seller_order_id in ${ownOrders(u)} and awb is not null)`,
    omit: ["body"],
  },
  cod_remittance_lines: {
    where: (u) => sql`t.shipment_id in (select id from shipments where seller_order_id in ${ownOrders(u)})`,
  },
  consolidated_shipments: { where: (u) => sql`t.order_group_id in ${ownGroups(u)}` },
  order_buyer_contacts: { where: viaOrders("seller_order_id") },
  order_lines: { where: viaOrders("seller_order_id") },
  order_status_history: { where: viaOrders("seller_order_id"), omit: ["actor_id"] },
  reservation_lines: { where: (u) => sql`t.reservation_id in (select id from reservations where user_id = ${u}::uuid)` },
  checkout_payment_events: { where: (u) => sql`t.order_group_id in ${ownGroups(u)}`, omit: ["body"] },
  payment_methods: { omit: ["psp_token", "fingerprint"] },
  return_disputes: { where: (u) => sql`t.return_id in ${ownReturns(u)}` },
  return_evidence: { where: (u) => sql`t.return_id in ${ownReturns(u)}`, omit: ["uploaded_by_id"] },
  moderation_log: { where: (u) => sql`t.actor_kind = 'user' and t.actor_id = ${u}::uuid` },
  ugc_reports: { where: eq("reporter_id") },
  eta_signed_documents: {
    where: (u) => sql`t.internal_id in (select internal_id from tax_documents where user_id = ${u}::uuid)`,
  },
  notification_push_tokens: { omit: ["token"] },
  ledger_accounts: { where: (u) => sql`t.owner_type = 'user' and t.owner_id = ${u}` },
};

export interface ColumnInfo {
  readonly type: string;
  readonly nullable: boolean;
  /** character_maximum_length, or null when unbounded. */
  readonly maxLength: number | null;
}
export interface SchemaSnapshot {
  readonly tables: ReadonlyMap<string, ReadonlyMap<string, ColumnInfo>>;
  /** Tables guarded by the append-only trigger (forbid_mutation): evidence that is never rewritten. */
  readonly immutable: ReadonlySet<string>;
}

/** Loads the public schema once per instance (tables and columns change only with a deploy). */
export class SchemaCatalog {
  private cached: Promise<SchemaSnapshot> | null = null;
  constructor(private readonly db: PrivacyDb) {}

  load(): Promise<SchemaSnapshot> {
    this.cached ??= this.read();
    return this.cached;
  }

  private async read(): Promise<SchemaSnapshot> {
    const cols = await sql<{ t: string; c: string; ty: string; n: string; ml: number | null }>`
      select table_name as t, column_name as c, data_type as ty, is_nullable as n, character_maximum_length as ml
      from information_schema.columns where table_schema = 'public'`.execute(this.db);
    const tables = new Map<string, Map<string, ColumnInfo>>();
    for (const r of cols.rows) {
      const m = tables.get(r.t) ?? new Map<string, ColumnInfo>();
      m.set(r.c, { type: r.ty, nullable: r.n === "YES", maxLength: r.ml });
      tables.set(r.t, m);
    }
    const imm = await sql<{ t: string }>`
      select distinct c.relname as t from pg_trigger g
      join pg_class c on c.oid = g.tgrelid join pg_proc p on p.oid = g.tgfoid
      where p.proname = 'forbid_mutation' and not g.tgisinternal`.execute(this.db);
    return { tables, immutable: new Set(imm.rows.map((r) => r.t)) };
  }
}

/** The subject predicate for a table, or undefined when the table cannot be attributed to a user. */
export function locatorFor(table: string, columns: ReadonlyMap<string, ColumnInfo>): Where | undefined {
  const spec = TABLE_SPECS[table];
  if (spec?.where !== undefined) return spec.where;
  return columns.has("user_id") ? eq("user_id") : undefined;
}

/** Runs `fn` in a system-role transaction (RLS), optionally read-only. */
export async function inSystemTx<T>(db: PrivacyDb, readOnly: boolean, fn: (trx: PrivacyDb) => Promise<T>): Promise<T> {
  return db.transaction().execute(async (trx) => {
    await sql`select set_config('app.role', 'system', true)`.execute(trx);
    if (readOnly) await sql`set transaction read only`.execute(trx);
    return fn(trx as unknown as PrivacyDb);
  });
}
