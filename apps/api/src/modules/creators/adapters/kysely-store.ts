import { sql, type Kysely } from "kysely";
import { z } from "zod";
import {
  COMMISSION_STATES,
  CREATOR_STATUSES,
  KYC_STATES,
  LINK_TARGET_TYPES,
  PAYOUT_PREFS,
  UA_CLASSES,
  planRefund,
  planVoid,
  refundedBaseOf,
  transitionCommission,
  type ClickFact,
  type CreatorStatus,
  type PayoutState,
} from "../domain/bridge";
import type {
  AffiliateLink,
  Attribution,
  ClaimResult,
  Commission,
  CreateAccountResult,
  CreatorAccount,
  CreatorEvent,
  CreatorLook,
  CreatorPayout,
  CreatorStore,
  IdPort,
  LinkInsert,
  LookStatus,
  PostingIntent,
  RefundClaim,
  SealedKyc,
  TermsText,
} from "../domain/ports";

/** Raw SQL only, rows validated with Zod (same approach as the referrals adapter). */
export type CreatorDb = Kysely<Record<string, never>>;

const Int = z.string().regex(/^-?\d+$/);
const Ms = Int.transform((s) => Number(s));
const Big = Int.transform((s) => BigInt(s));
const iso = (ms: number): string => new Date(ms).toISOString();

const AccountRow = z.object({
  id: z.string(),
  user_id: z.string(),
  handle: z.string(),
  display_name: z.string(),
  status: z.enum(CREATOR_STATUSES),
  kyc_state: z.enum(KYC_STATES),
  terms_version: z.number().int(),
  terms_ms: Ms,
  payout_pref: z.enum(PAYOUT_PREFS),
  status_reason: z.string().nullable(),
  applied_ms: Ms,
  decided_ms: Ms.nullable(),
});
const ACCOUNT_COLS = sql`id::text as id, user_id::text as user_id, handle, display_name, status, kyc_state,
  terms_version, floor(extract(epoch from terms_accepted_at) * 1000)::text as terms_ms, payout_pref, status_reason,
  floor(extract(epoch from applied_at) * 1000)::text as applied_ms,
  floor(extract(epoch from decided_at) * 1000)::text as decided_ms`;
const toAccount = (raw: unknown): CreatorAccount => {
  const r = AccountRow.parse(raw);
  return {
    id: r.id,
    userId: r.user_id,
    handle: r.handle,
    displayName: r.display_name,
    status: r.status,
    kycState: r.kyc_state,
    termsVersion: r.terms_version,
    termsAcceptedAtMs: r.terms_ms,
    payoutPref: r.payout_pref,
    statusReason: r.status_reason,
    appliedAtMs: r.applied_ms,
    decidedAtMs: r.decided_ms,
  };
};

const LinkRow = z.object({
  id: z.string(),
  creator_id: z.string(),
  target_type: z.enum(LINK_TARGET_TYPES),
  target_id: z.string(),
  slug: z.string(),
  status: z.enum(["ACTIVE", "DISABLED"]),
  created_ms: Ms,
});
const LINK_COLS = sql`id::text as id, creator_id::text as creator_id, target_type, target_id::text as target_id, slug, status,
  floor(extract(epoch from created_at) * 1000)::text as created_ms`;
const toLink = (raw: unknown): AffiliateLink => {
  const r = LinkRow.parse(raw);
  return { id: r.id, creatorId: r.creator_id, targetType: r.target_type, targetId: r.target_id, slug: r.slug, status: r.status, createdAtMs: r.created_ms };
};

const LookRow = z.object({
  id: z.string(),
  creator_id: z.string(),
  title: z.string(),
  status: z.enum(["DRAFT", "PUBLISHED", "TAKEN_DOWN", "ARCHIVED"]),
  takedown_reason: z.string().nullable(),
  created_ms: Ms,
  updated_ms: Ms,
});
const LOOK_COLS = sql`id::text as id, creator_id::text as creator_id, title, status, takedown_reason,
  floor(extract(epoch from created_at) * 1000)::text as created_ms,
  floor(extract(epoch from updated_at) * 1000)::text as updated_ms`;

const AttributionRow = z.object({
  order_group_id: z.string(),
  creator_id: z.string(),
  link_id: z.string(),
  click_id: z.string(),
  click_ms: Ms,
  buyer_user_id: z.string(),
  rate_snapshot: z.object({ defaultBps: z.number(), categoryBps: z.record(z.string(), z.number()) }),
  window_ms: Ms,
  status: z.enum(["ACTIVE", "VOIDED", "HELD"]),
  void_reason: z.string().nullable(),
  hold_reason: z.enum(["identity_unavailable"]).nullable(),
  created_ms: Ms,
});
const ATTR_COLS = sql`order_group_id::text as order_group_id, creator_id::text as creator_id, link_id::text as link_id,
  click_id::text as click_id, floor(extract(epoch from click_at) * 1000)::text as click_ms,
  buyer_user_id::text as buyer_user_id, rate_snapshot, floor(extract(epoch from window_end) * 1000)::text as window_ms,
  status, void_reason, hold_reason, floor(extract(epoch from created_at) * 1000)::text as created_ms`;

const CommissionRow = z.object({
  id: z.string(),
  creator_id: z.string(),
  order_group_id: z.string(),
  order_line_id: z.string(),
  base: Big,
  rate_bps: z.number().int(),
  amount: Big,
  clawed_back: Big,
  refunded_base: Big,
  state: z.enum(COMMISSION_STATES),
  hold_reason: z.enum(["monthly_cap", "creator_not_active"]).nullable(),
  void_reason: z.string().nullable(),
  month_key: z.string(),
  closed_ms: Ms,
  accrued_ms: Ms.nullable(),
  payout_id: z.string().nullable(),
});
const COMMISSION_COLS = sql`id::text as id, creator_id::text as creator_id, order_group_id::text as order_group_id,
  order_line_id::text as order_line_id, base::text as base, rate_bps, amount::text as amount,
  clawed_back::text as clawed_back, refunded_base::text as refunded_base, state, hold_reason, void_reason, month_key,
  floor(extract(epoch from closed_at) * 1000)::text as closed_ms,
  floor(extract(epoch from accrued_at) * 1000)::text as accrued_ms, payout_id::text as payout_id`;
const toCommission = (raw: unknown): Commission => {
  const r = CommissionRow.parse(raw);
  return {
    id: r.id,
    creatorId: r.creator_id,
    orderGroupId: r.order_group_id,
    orderLineId: r.order_line_id,
    base: r.base,
    rateBps: BigInt(r.rate_bps),
    amount: r.amount,
    clawedBack: r.clawed_back,
    refundedBase: r.refunded_base,
    state: r.state,
    holdReason: r.hold_reason,
    voidReason: r.void_reason,
    monthKey: r.month_key,
    closedAtMs: r.closed_ms,
    accruedAtMs: r.accrued_ms,
    payoutId: r.payout_id,
  };
};

const PayoutRow = z.object({
  id: z.string(),
  creator_id: z.string(),
  amount: Big,
  state: z.enum(["SCHEDULED", "ON_HOLD", "APPROVED", "SENT", "SETTLED", "FAILED", "CANCELLED"]),
  hold_reason: z.string().nullable(),
  attempt: z.number().int(),
  provider_ref: z.string().nullable(),
  failure_reason: z.string().nullable(),
  created_by: z.string(),
  created_ms: Ms,
  updated_ms: Ms,
});
const PAYOUT_COLS = sql`id::text as id, creator_id::text as creator_id, amount::text as amount, state, hold_reason, attempt,
  provider_ref, failure_reason, created_by::text as created_by,
  floor(extract(epoch from created_at) * 1000)::text as created_ms,
  floor(extract(epoch from updated_at) * 1000)::text as updated_ms`;
const toPayout = (raw: unknown): CreatorPayout => {
  const r = PayoutRow.parse(raw);
  return {
    id: r.id,
    creatorId: r.creator_id,
    amount: r.amount,
    state: r.state,
    holdReason: r.hold_reason,
    attempt: r.attempt,
    providerRef: r.provider_ref,
    failureReason: r.failure_reason,
    createdBy: r.created_by,
    createdAtMs: r.created_ms,
    updatedAtMs: r.updated_ms,
  };
};

const IntentRow = z.object({
  commission_id: z.string(),
  seq: z.number().int(),
  kind: z.enum(["accrual", "clawback"]),
  amount: Big,
  creator_user_id: z.string(),
  order_group_id: z.string(),
});

/** Outbox payload. Amounts are strings (bigint safe). Ids only: no contact data, no buyer identity. */
const payloadOf = (e: CreatorEvent): Record<string, string | number | boolean> => {
  switch (e.type) {
    case "creator.applied":
    case "creator.approved":
      return { creator_id: e.creatorId };
    case "creator.rejected":
    case "creator.suspended":
      return { creator_id: e.creatorId, reason: e.reason };
    case "affiliate.link_created":
      return { creator_id: e.creatorId, link_id: e.linkId };
    case "affiliate.click_recorded":
      return { creator_id: e.creatorId, link_id: e.linkId, counted: e.counted };
    case "affiliate.clicks_active":
      return { creator_id: e.creatorId, minute_ms: e.minuteMs };
    case "creator.attribution_held":
      return { creator_id: e.creatorId, order_group_id: e.orderGroupId, reason: e.reason };
    case "creator.commission_over_cap":
      return { creator_id: e.creatorId, commission_id: e.commissionId, amount: e.amount.toString(), currency: "EGP" };
    case "creator.order_attributed":
      return { creator_id: e.creatorId, order_group_id: e.orderGroupId };
    case "creator.attribution_voided":
      return { creator_id: e.creatorId, order_group_id: e.orderGroupId, reason: e.reason };
    case "commission.accrued":
    case "commission.clawed_back":
      return { creator_id: e.creatorId, commission_id: e.commissionId, amount: e.amount.toString(), currency: "EGP" };
    case "commission.held":
      return { creator_id: e.creatorId, commission_id: e.commissionId, reason: e.reason };
    case "creator.balance_negative":
      return { creator_id: e.creatorId, owes: e.owes.toString(), currency: "EGP" };
    case "creator_payout.requested":
    case "creator_payout.settled":
      return { creator_id: e.creatorId, payout_id: e.payoutId, amount: e.amount.toString(), currency: "EGP" };
    case "creator_payout.failed":
      return { creator_id: e.creatorId, payout_id: e.payoutId, reason: e.reason };
  }
};

class AttributionInactive extends Error {}

const isUnique = (e: unknown): boolean => typeof e === "object" && e !== null && (e as { code?: unknown }).code === "23505";

/**
 * Postgres adapter. Every method is one transaction under the `system` role (authorization is the
 * policy guard and the owner scoping in the application; RLS stays on for every other role).
 * Events go to outbox_events in the same transaction as the state change. This adapter never
 * touches the ledger: posting intents are rows in commission_postings, posted by the module.
 */
export class KyselyCreatorStore implements CreatorStore {
  constructor(
    private readonly db: CreatorDb,
    private readonly ids: IdPort,
  ) {}

  private async tx<T>(run: (trx: CreatorDb) => Promise<T>): Promise<T> {
    return this.db.transaction().execute(async (trx) => {
      await sql`select set_config('app.role', 'system', true)`.execute(trx);
      return run(trx as unknown as CreatorDb);
    });
  }

  private async outbox(trx: CreatorDb, events: readonly CreatorEvent[]): Promise<void> {
    for (const e of events) {
      const creatorId = "creatorId" in e ? e.creatorId : "";
      await sql`
        insert into outbox_events (id, aggregate_type, aggregate_id, event_type, ordering_key, payload)
        values (${this.ids.uuidV7()}::uuid, 'creator', ${creatorId}::uuid, ${e.type},
                ${`creator:${creatorId}`}, ${JSON.stringify(payloadOf(e))}::jsonb)`.execute(trx);
    }
  }

  async emit(events: readonly CreatorEvent[]): Promise<void> {
    await this.tx((trx) => this.outbox(trx, events));
  }

  // ---- accounts
  async getByUser(userId: string) {
    return this.tx(async (trx) => {
      const r = await sql<unknown>`select ${ACCOUNT_COLS} from creator_accounts where user_id = ${userId}::uuid`.execute(trx);
      return r.rows[0] === undefined ? null : toAccount(r.rows[0]);
    });
  }
  async getById(id: string) {
    return this.tx(async (trx) => {
      const r = await sql<unknown>`select ${ACCOUNT_COLS} from creator_accounts where id = ${id}::uuid`.execute(trx);
      return r.rows[0] === undefined ? null : toAccount(r.rows[0]);
    });
  }
  async getByHandle(handle: string) {
    return this.tx(async (trx) => {
      const r = await sql<unknown>`select ${ACCOUNT_COLS} from creator_accounts where handle = ${handle}`.execute(trx);
      return r.rows[0] === undefined ? null : toAccount(r.rows[0]);
    });
  }
  async listByStatus(status: CreatorStatus, limit: number) {
    return this.tx(async (trx) => {
      const r = await sql<unknown>`select ${ACCOUNT_COLS} from creator_accounts where status = ${status}
        order by applied_at, id limit ${limit}`.execute(trx);
      return r.rows.map(toAccount);
    });
  }
  async createAccount(a: CreatorAccount, kyc: SealedKyc, events: readonly CreatorEvent[]): Promise<CreateAccountResult> {
    try {
      return await this.tx(async (trx) => {
        const ex = await sql<unknown>`select 1 as one from creator_accounts where user_id = ${a.userId}::uuid`.execute(trx);
        if (ex.rows.length > 0) return { kind: "exists" } as const;
        const h = await sql<unknown>`select 1 as one from creator_accounts where handle = ${a.handle}`.execute(trx);
        if (h.rows.length > 0) return { kind: "handle_taken" } as const;
        const idUse = await sql<unknown>`select 1 as one from creator_kyc
          where national_id_hash = ${Buffer.from(kyc.nationalIdHash)}`.execute(trx);
        if (idUse.rows.length > 0) return { kind: "identity_in_use" } as const;
        await sql`
          insert into creator_accounts (id, user_id, handle, display_name, status, kyc_state, terms_version,
            terms_accepted_at, payout_pref, applied_at)
          values (${a.id}::uuid, ${a.userId}::uuid, ${a.handle}, ${a.displayName}, ${a.status}, ${a.kycState},
            ${a.termsVersion}, ${iso(a.termsAcceptedAtMs)}::timestamptz, ${a.payoutPref}, ${iso(a.appliedAtMs)}::timestamptz)`.execute(trx);
        await sql`
          insert into creator_kyc (creator_id, key_id, legal_name_enc, national_id_enc, national_id_hash, payout_iban_enc,
            payout_name_enc, tax_id_enc, tax_form_enc, submitted_at)
          values (${a.id}::uuid, ${kyc.keyId}, ${Buffer.from(kyc.legalNameEnc)}, ${Buffer.from(kyc.nationalIdEnc)},
            ${Buffer.from(kyc.nationalIdHash)},
            ${kyc.payoutIbanEnc === null ? null : Buffer.from(kyc.payoutIbanEnc)},
            ${kyc.payoutNameEnc === null ? null : Buffer.from(kyc.payoutNameEnc)},
            ${kyc.taxIdEnc === null ? null : Buffer.from(kyc.taxIdEnc)},
            ${kyc.taxFormEnc === null ? null : Buffer.from(kyc.taxFormEnc)},
            ${iso(a.appliedAtMs)}::timestamptz)`.execute(trx);
        await this.outbox(trx, events);
        return { kind: "created" } as const;
      });
    } catch (e) {
      if (isUnique(e)) return { kind: "handle_taken" };
      throw e;
    }
  }
  async decide(i: Parameters<CreatorStore["decide"]>[0]) {
    return this.tx(async (trx) => {
      const r = await sql<unknown>`
        update creator_accounts set status = ${i.status}, kyc_state = ${i.kycState}, status_reason = ${i.reason},
          decided_at = ${iso(i.nowMs)}::timestamptz, updated_at = ${iso(i.nowMs)}::timestamptz
        where id = ${i.creatorId}::uuid returning ${ACCOUNT_COLS}`.execute(trx);
      if (r.rows[0] === undefined) return null;
      await sql`update creator_kyc set reviewed_at = ${iso(i.nowMs)}::timestamptz, reviewed_by = ${i.reviewerId}::uuid,
        review_reason = ${i.reason} where creator_id = ${i.creatorId}::uuid`.execute(trx);
      await this.outbox(trx, i.events);
      return toAccount(r.rows[0]);
    });
  }
  async setPayoutPref(creatorId: string, pref: (typeof PAYOUT_PREFS)[number], nowMs: number) {
    return this.tx(async (trx) => {
      const r = await sql<unknown>`update creator_accounts set payout_pref = ${pref}, updated_at = ${iso(nowMs)}::timestamptz
        where id = ${creatorId}::uuid returning 1 as one`.execute(trx);
      return r.rows.length > 0;
    });
  }

  // ---- links
  async insertLink(link: AffiliateLink, events: readonly CreatorEvent[]): Promise<LinkInsert> {
    return this.tx(async (trx) => {
      const dup = await sql<unknown>`select ${LINK_COLS} from affiliate_links
        where creator_id = ${link.creatorId}::uuid and target_type = ${link.targetType}
          and target_id = ${link.targetId}::uuid and status = 'ACTIVE'`.execute(trx);
      if (dup.rows[0] !== undefined) return { kind: "exists", link: toLink(dup.rows[0]) } as const;
      const slug = await sql<unknown>`select 1 as one from affiliate_links where slug = ${link.slug}`.execute(trx);
      if (slug.rows.length > 0) return { kind: "slug_taken" } as const;
      await sql`insert into affiliate_links (id, creator_id, target_type, target_id, slug, status, created_at)
        values (${link.id}::uuid, ${link.creatorId}::uuid, ${link.targetType}, ${link.targetId}::uuid, ${link.slug},
          'ACTIVE', ${iso(link.createdAtMs)}::timestamptz)`.execute(trx);
      await this.outbox(trx, events);
      return { kind: "created", link } as const;
    });
  }
  async listLinks(creatorId: string) {
    return this.tx(async (trx) => {
      const r = await sql<unknown>`select ${LINK_COLS} from affiliate_links where creator_id = ${creatorId}::uuid
        order by created_at desc, id`.execute(trx);
      return r.rows.map(toLink);
    });
  }
  async getLink(id: string) {
    return this.tx(async (trx) => {
      const r = await sql<unknown>`select ${LINK_COLS} from affiliate_links where id = ${id}::uuid`.execute(trx);
      return r.rows[0] === undefined ? null : toLink(r.rows[0]);
    });
  }
  async findLinkBySlug(slug: string) {
    return this.tx(async (trx) => {
      const r = await sql<unknown>`select ${LINK_COLS} from affiliate_links where slug = ${slug}`.execute(trx);
      return r.rows[0] === undefined ? null : toLink(r.rows[0]);
    });
  }
  async disableLink(creatorId: string, linkId: string, nowMs: number) {
    return this.tx(async (trx) => {
      const r = await sql<unknown>`update affiliate_links set status = 'DISABLED', disabled_at = ${iso(nowMs)}::timestamptz
        where id = ${linkId}::uuid and creator_id = ${creatorId}::uuid and status = 'ACTIVE' returning 1 as one`.execute(trx);
      return r.rows.length > 0;
    });
  }
  async disableLinksOf(creatorId: string, nowMs: number) {
    return this.tx(async (trx) => {
      const r = await sql<unknown>`update affiliate_links set status = 'DISABLED', disabled_at = ${iso(nowMs)}::timestamptz
        where creator_id = ${creatorId}::uuid and status = 'ACTIVE' returning 1 as one`.execute(trx);
      return r.rows.length;
    });
  }

  // ---- looks
  private async itemsOf(trx: CreatorDb, lookId: string): Promise<string[]> {
    const r = await sql<{ product_id: string }>`select product_id::text as product_id from creator_look_items
      where look_id = ${lookId}::uuid order by position`.execute(trx);
    return r.rows.map((x) => x.product_id);
  }
  private toLook(raw: unknown, productIds: readonly string[]): CreatorLook {
    const r = LookRow.parse(raw);
    return {
      id: r.id,
      creatorId: r.creator_id,
      title: r.title,
      status: r.status as LookStatus,
      takedownReason: r.takedown_reason,
      productIds,
      createdAtMs: r.created_ms,
      updatedAtMs: r.updated_ms,
    };
  }
  private async writeItems(trx: CreatorDb, look: CreatorLook): Promise<void> {
    await sql`delete from creator_look_items where look_id = ${look.id}::uuid`.execute(trx);
    for (const [i, p] of look.productIds.entries()) {
      await sql`insert into creator_look_items (look_id, position, product_id)
        values (${look.id}::uuid, ${i}, ${p}::uuid)`.execute(trx);
    }
  }
  async insertLook(look: CreatorLook) {
    await this.tx(async (trx) => {
      await sql`insert into creator_looks (id, creator_id, title, status, takedown_reason, created_at, updated_at)
        values (${look.id}::uuid, ${look.creatorId}::uuid, ${look.title}, ${look.status}, ${look.takedownReason},
          ${iso(look.createdAtMs)}::timestamptz, ${iso(look.updatedAtMs)}::timestamptz)`.execute(trx);
      await this.writeItems(trx, look);
    });
  }
  async listLooks(creatorId: string) {
    return this.tx(async (trx) => {
      const r = await sql<unknown>`select ${LOOK_COLS} from creator_looks where creator_id = ${creatorId}::uuid
        order by updated_at desc, id`.execute(trx);
      const out: CreatorLook[] = [];
      for (const row of r.rows) {
        const id = LookRow.parse(row).id;
        out.push(this.toLook(row, await this.itemsOf(trx, id)));
      }
      return out;
    });
  }
  async getLook(id: string) {
    return this.tx(async (trx) => {
      const r = await sql<unknown>`select ${LOOK_COLS} from creator_looks where id = ${id}::uuid`.execute(trx);
      if (r.rows[0] === undefined) return null;
      return this.toLook(r.rows[0], await this.itemsOf(trx, id));
    });
  }
  async updateLook(look: CreatorLook) {
    await this.tx(async (trx) => {
      await sql`update creator_looks set title = ${look.title}, status = ${look.status},
        takedown_reason = ${look.takedownReason}, updated_at = ${iso(look.updatedAtMs)}::timestamptz
        where id = ${look.id}::uuid`.execute(trx);
      await this.writeItems(trx, look);
    });
  }

  // ---- clicks
  async countedClicksSince(creatorId: string, ipHash: string, sinceMs: number) {
    return this.tx(async (trx) => {
      const r = await sql<{ n: string }>`select count(*)::text as n from affiliate_clicks
        where creator_id = ${creatorId}::uuid and ip_hash = ${ipHash} and counted
          and ts >= ${iso(sinceMs)}::timestamptz`.execute(trx);
      return Number(r.rows[0]?.n ?? "0");
    });
  }
  async clickCountsSince(i: Parameters<CreatorStore["clickCountsSince"]>[0]) {
    return this.tx(async (trx) => {
      const r = await sql<Record<string, string>>`
        select
          count(*) filter (where counted and creator_id = ${i.creatorId}::uuid and ip_hash = ${i.ipHash})::text as ip,
          count(*) filter (where counted and device_hash = ${i.deviceHash})::text as device,
          count(*) filter (where counted and link_id = ${i.linkId}::uuid)::text as link
        from affiliate_clicks where ts >= ${iso(i.hourSinceMs)}::timestamptz
          and (device_hash = ${i.deviceHash} or link_id = ${i.linkId}::uuid
               or (creator_id = ${i.creatorId}::uuid and ip_hash = ${i.ipHash}))`.execute(trx);
      const d = await sql<{ n: string }>`select count(*)::text as n from affiliate_clicks
        where device_hash = ${i.deviceHash} and link_id = ${i.linkId}::uuid
          and ts >= ${iso(i.dedupeSinceMs)}::timestamptz`.execute(trx);
      const m = await sql<{ n: string }>`select count(*)::text as n from affiliate_clicks
        where creator_id = ${i.creatorId}::uuid and ts >= ${iso(i.minuteSinceMs)}::timestamptz`.execute(trx);
      const row = r.rows[0] ?? {};
      return {
        ip: Number(row.ip ?? "0"),
        device: Number(row.device ?? "0"),
        link: Number(row.link ?? "0"),
        duplicate: Number(d.rows[0]?.n ?? "0") > 0,
        creatorThisMinute: Number(m.rows[0]?.n ?? "0"),
      };
    });
  }
  async maintainClickPartitions(i: { readonly nowMs: number; readonly monthsAhead: number; readonly retainMonths: number }) {
    return this.tx(async (trx) => {
      const r = await sql<{ created: number; dropped: number; deleted_rows: string }>`
        select created, dropped, deleted_rows::text as deleted_rows
        from creators_maintain_click_partitions(${iso(i.nowMs)}::timestamptz, ${i.monthsAhead}::int, ${i.retainMonths}::int)`.execute(trx);
      const row = r.rows[0];
      return { created: row?.created ?? 0, dropped: row?.dropped ?? 0, deletedRows: Number(row?.deleted_rows ?? "0") };
    });
  }
  async insertClick(click: ClickFact & { ipHash: string }, events: readonly CreatorEvent[]) {
    await this.tx(async (trx) => {
      await sql`insert into affiliate_clicks (id, link_id, creator_id, ts, device_hash, ip_hash, ua_class, counted)
        values (${click.id}::uuid, ${click.linkId}::uuid, ${click.creatorId}::uuid, ${iso(click.atMs)}::timestamptz,
          ${click.deviceHash}, ${click.ipHash}, ${click.uaClass}, ${click.counted})`.execute(trx);
      await this.outbox(trx, events);
    });
  }
  async clicksForDevices(deviceHashes: readonly string[], sinceMs: number, untilMs: number) {
    if (deviceHashes.length === 0) return [];
    return this.tx(async (trx) => {
      const r = await sql<unknown>`
        select id::text as id, link_id::text as link_id, creator_id::text as creator_id,
          floor(extract(epoch from ts) * 1000)::text as at_ms, device_hash, counted, ua_class
        from affiliate_clicks
        where device_hash = any(${deviceHashes as string[]}) and ts >= ${iso(sinceMs)}::timestamptz
          and ts <= ${iso(untilMs)}::timestamptz
        order by ts desc, id desc limit 500`.execute(trx);
      const Row = z.object({
        id: z.string(), link_id: z.string(), creator_id: z.string(), at_ms: Ms, device_hash: z.string(),
        counted: z.boolean(), ua_class: z.enum(UA_CLASSES),
      });
      return r.rows.map((raw): ClickFact => {
        const c = Row.parse(raw);
        return { id: c.id, linkId: c.link_id, creatorId: c.creator_id, atMs: c.at_ms, deviceHash: c.device_hash, counted: c.counted, uaClass: c.ua_class };
      });
    });
  }
  async clickStats(creatorId: string, sinceMs: number) {
    return this.tx(async (trx) => {
      const r = await sql<{ total: string; counted: string }>`
        select count(*)::text as total, count(*) filter (where counted)::text as counted
        from affiliate_clicks where creator_id = ${creatorId}::uuid and ts >= ${iso(sinceMs)}::timestamptz`.execute(trx);
      return { total: Number(r.rows[0]?.total ?? "0"), counted: Number(r.rows[0]?.counted ?? "0") };
    });
  }

  // ---- attribution
  private toAttribution(raw: unknown): Attribution {
    const r = AttributionRow.parse(raw);
    return {
      orderGroupId: r.order_group_id,
      creatorId: r.creator_id,
      linkId: r.link_id,
      clickId: r.click_id,
      clickAtMs: r.click_ms,
      buyerUserId: r.buyer_user_id,
      rateSnapshot: r.rate_snapshot,
      windowEndMs: r.window_ms,
      status: r.status,
      voidReason: r.void_reason as Attribution["voidReason"],
      holdReason: r.hold_reason,
      createdAtMs: r.created_ms,
    };
  }
  async getAttribution(orderGroupId: string) {
    return this.tx(async (trx) => {
      const r = await sql<unknown>`select ${ATTR_COLS} from attributions where order_group_id = ${orderGroupId}::uuid`.execute(trx);
      return r.rows[0] === undefined ? null : this.toAttribution(r.rows[0]);
    });
  }
  async insertAttribution(a: Attribution, events: readonly CreatorEvent[]) {
    return this.tx(async (trx) => {
      const r = await sql<unknown>`
        insert into attributions (order_group_id, creator_id, link_id, click_id, click_at, buyer_user_id, rate_snapshot,
          window_end, status, void_reason, hold_reason, created_at)
        values (${a.orderGroupId}::uuid, ${a.creatorId}::uuid, ${a.linkId}::uuid, ${a.clickId}::uuid,
          ${iso(a.clickAtMs)}::timestamptz, ${a.buyerUserId}::uuid, ${JSON.stringify(a.rateSnapshot)}::jsonb,
          ${iso(a.windowEndMs)}::timestamptz, ${a.status}, ${a.voidReason}, ${a.holdReason ?? null}, ${iso(a.createdAtMs)}::timestamptz)
        on conflict (order_group_id) do nothing returning 1 as one`.execute(trx);
      if (r.rows.length === 0) return "exists" as const;
      await this.outbox(trx, events);
      return "inserted" as const;
    });
  }
  async voidAttribution(orderGroupId: string, reason: NonNullable<Attribution["voidReason"]>, events: readonly CreatorEvent[]) {
    await this.tx(async (trx) => {
      await sql`update attributions set status = 'VOIDED', void_reason = ${reason}
        where order_group_id = ${orderGroupId}::uuid`.execute(trx);
      await this.outbox(trx, events);
    });
  }
  async resolveHeldAttribution(a: Attribution, events: readonly CreatorEvent[]) {
    return this.tx(async (trx) => {
      const r = await sql<unknown>`update attributions set status = ${a.status}, void_reason = ${a.voidReason},
          hold_reason = null
        where order_group_id = ${a.orderGroupId}::uuid and status = 'HELD' returning 1 as one`.execute(trx);
      if (r.rows.length === 0) return false;
      await this.outbox(trx, events);
      return true;
    });
  }
  async voidOrderGroup(i: Parameters<CreatorStore["voidOrderGroup"]>[0]) {
    return this.tx(async (trx) => {
      const ex = await sql<{ status: string }>`select status from attributions
        where order_group_id = ${i.orderGroupId}::uuid for update`.execute(trx);
      const st = ex.rows[0]?.status;
      if (st === undefined) return { kind: "not_found" as const };
      if (st === "VOIDED") return { kind: "already_voided" as const };
      await sql`update attributions set status = 'VOIDED', void_reason = ${i.reason}, hold_reason = null
        where order_group_id = ${i.orderGroupId}::uuid`.execute(trx);
      await this.outbox(trx, i.events);
      const cs = await sql<unknown>`select ${COMMISSION_COLS} from commissions
        where order_group_id = ${i.orderGroupId}::uuid order by id for update`.execute(trx);
      const ids: string[] = [];
      let clawedTotal = 0n;
      for (const row of cs.rows) {
        const c = toCommission(row);
        const plan = planVoid(c);
        if (plan.kind === "shrink_held") {
          await sql`update commissions set refunded_base = ${plan.refundedBase.toString()}::bigint,
              amount = ${plan.amount.toString()}::bigint, state = ${transitionCommission("ACCRUING", "VOID")},
              hold_reason = null, void_reason = ${i.reason}, updated_at = now()
            where id = ${c.id}::uuid`.execute(trx);
        } else if (plan.kind === "clawback") {
          const to = plan.full ? transitionCommission(c.state, "CLAWBACK_ALL") : c.state;
          await sql`update commissions set refunded_base = ${plan.refundedBase.toString()}::bigint,
              clawed_back = ${plan.clawedBack.toString()}::bigint, state = ${to}, updated_at = now()
            where id = ${c.id}::uuid`.execute(trx);
          const seq = await sql<{ n: string }>`select count(*)::text as n from commission_postings
            where commission_id = ${c.id}::uuid`.execute(trx);
          await sql`insert into commission_postings (commission_id, seq, kind, amount)
            values (${c.id}::uuid, ${Number(seq.rows[0]?.n ?? "0")}, 'clawback', ${plan.delta.toString()}::bigint)`.execute(trx);
          await this.outbox(trx, [{ type: "commission.clawed_back", creatorId: c.creatorId, commissionId: c.id, amount: plan.delta }]);
          ids.push(c.id);
          clawedTotal += plan.delta;
        }
      }
      return { kind: "voided" as const, commissionIds: ids, clawedBack: clawedTotal };
    });
  }
  async ensureTerms(version: number, texts: readonly TermsText[]) {
    return this.tx(async (trx) => {
      for (const t of texts) {
        await sql`insert into creator_terms (version, locale, body, body_sha256)
          values (${version}, ${t.locale}, ${t.body}, ${t.sha256}) on conflict (version, locale) do nothing`.execute(trx);
        const r = await sql<{ body_sha256: string }>`select body_sha256 from creator_terms
          where version = ${version} and locale = ${t.locale}`.execute(trx);
        if (r.rows[0]?.body_sha256 !== t.sha256) return "mismatch" as const;
      }
      return "ok" as const;
    });
  }
  async attributedBuyers(creatorId: string, limit: number) {
    return this.tx(async (trx) => {
      const r = await sql<{ b: string }>`select buyer_user_id::text as b from attributions
        where creator_id = ${creatorId}::uuid and status = 'ACTIVE' order by created_at desc limit ${limit}`.execute(trx);
      return r.rows.map((x) => x.b);
    });
  }

  // ---- commissions
  async recordInbox(consumer: string, messageId: string) {
    return this.tx(async (trx) => {
      const r = await sql<unknown>`insert into inbox_processed (consumer, message_id)
        values (${consumer}, ${messageId}::uuid) on conflict do nothing returning 1 as one`.execute(trx);
      return r.rows.length > 0 ? ("recorded" as const) : ("duplicate" as const);
    });
  }

  async claimAccrual(i: Parameters<CreatorStore["claimAccrual"]>[0]): Promise<ClaimResult> {
    try {
      return await this.claimAccrualTx(i);
    } catch (e) {
      if (e instanceof AttributionInactive) return { kind: "attribution_inactive" };
      throw e;
    }
  }

  private async claimAccrualTx(i: Parameters<CreatorStore["claimAccrual"]>[0]): Promise<ClaimResult> {
    const n = i.commission;
    return this.tx(async (trx) => {
      const inbox = await sql<unknown>`insert into inbox_processed (consumer, message_id)
        values (${i.consumer}, ${i.messageId}::uuid) on conflict do nothing returning 1 as one`.execute(trx);
      if (inbox.rows.length === 0) return { kind: "duplicate" } as const;
      // A-3 race guard: the share lock serialises with voidOrderGroup, so an accrual can never land
      // on an attribution that was voided or put on hold after the caller read it.
      const att = await sql<{ status: string }>`select status from attributions
        where order_group_id = ${n.orderGroupId}::uuid for share`.execute(trx);
      if (att.rows[0] !== undefined && att.rows[0].status !== "ACTIVE") {
        // Roll the inbox row back with the transaction so the message is redelivered, not lost.
        throw new AttributionInactive();
      }
      const ex = await sql<unknown>`select ${COMMISSION_COLS} from commissions
        where order_line_id = ${n.orderLineId}::uuid and creator_id = ${n.creatorId}::uuid`.execute(trx);
      if (ex.rows[0] !== undefined) return { kind: "exists", commission: toCommission(ex.rows[0]) } as const;

      let hold: "monthly_cap" | "creator_not_active" | null = null;
      if (!n.creatorActive) hold = "creator_not_active";
      else if (n.amount > n.monthlyCap) hold = "monthly_cap";
      else {
        // Atomic cap: the conditional upsert only advances the counter while it stays under the cap.
        const up = await sql<unknown>`
          insert into creator_monthly_accruals (creator_id, month_key, accrued)
          values (${n.creatorId}::uuid, ${n.monthKey}, ${n.amount.toString()}::bigint)
          on conflict (creator_id, month_key) do update
            set accrued = creator_monthly_accruals.accrued + excluded.accrued
            where creator_monthly_accruals.accrued + excluded.accrued <= ${n.monthlyCap.toString()}::bigint
          returning 1 as one`.execute(trx);
        if (up.rows.length === 0) hold = "monthly_cap";
      }
      const state = hold === null ? "ACCRUED" : "ACCRUING";
      const ins = await sql<unknown>`
        insert into commissions (id, creator_id, order_group_id, order_line_id, base, rate_bps, amount, refunded_base,
          state, hold_reason, month_key, closed_at, accrued_at)
        values (${n.id}::uuid, ${n.creatorId}::uuid, ${n.orderGroupId}::uuid, ${n.orderLineId}::uuid,
          ${n.base.toString()}::bigint, ${Number(n.rateBps)}, ${n.amount.toString()}::bigint,
          ${n.refundedBase.toString()}::bigint, ${state}, ${hold}, ${n.monthKey}, ${iso(n.closedAtMs)}::timestamptz,
          ${state === "ACCRUED" ? iso(n.closedAtMs) : null}::timestamptz)
        returning ${COMMISSION_COLS}`.execute(trx);
      const c = toCommission(ins.rows[0]);
      if (state === "ACCRUED") {
        await sql`insert into commission_postings (commission_id, seq, kind, amount)
          values (${c.id}::uuid, 0, 'accrual', ${c.amount.toString()}::bigint)`.execute(trx);
        await this.outbox(trx, [{ type: "commission.accrued", creatorId: c.creatorId, commissionId: c.id, amount: c.amount }]);
      } else {
        await this.outbox(trx, [{ type: "commission.held", creatorId: c.creatorId, commissionId: c.id, reason: hold ?? "unknown" }]);
      }
      return { kind: "claimed", commission: c } as const;
    });
  }

  async claimRefund(i: Parameters<CreatorStore["claimRefund"]>[0]): Promise<RefundClaim> {
    return this.tx(async (trx) => {
      const inbox = await sql<unknown>`insert into inbox_processed (consumer, message_id)
        values (${i.consumer}, ${i.messageId}::uuid) on conflict do nothing returning 1 as one`.execute(trx);
      if (inbox.rows.length === 0) return { kind: "duplicate" } as const;
      const cur = await sql<unknown>`select ${COMMISSION_COLS} from commissions
        where order_line_id = ${i.orderLineId}::uuid order by created_at limit 1 for update`.execute(trx);
      if (cur.rows[0] === undefined) return { kind: "no_commission" } as const;
      const c = toCommission(cur.rows[0]);
      const plan = planRefund(c, refundedBaseOf(c.base, i.lineGross, i.refundedGross));

      if (plan.kind === "none") {
        await sql`update commissions set refunded_base = ${plan.refundedBase.toString()}::bigint, updated_at = now()
          where id = ${c.id}::uuid`.execute(trx);
        return { kind: "applied", commission: { ...c, refundedBase: plan.refundedBase }, plan } as const;
      }
      if (plan.kind === "shrink_held") {
        const to = plan.void ? transitionCommission("ACCRUING", "VOID") : "ACCRUING";
        await sql`update commissions set refunded_base = ${plan.refundedBase.toString()}::bigint,
            amount = ${plan.amount.toString()}::bigint, state = ${to},
            hold_reason = ${plan.void ? null : c.holdReason}, void_reason = ${plan.void ? "fully_refunded" : null},
            updated_at = now() where id = ${c.id}::uuid`.execute(trx);
        return {
          kind: "applied",
          commission: { ...c, refundedBase: plan.refundedBase, amount: plan.amount, state: to, holdReason: plan.void ? null : c.holdReason },
          plan,
        } as const;
      }
      const to = plan.full ? transitionCommission(c.state, "CLAWBACK_ALL") : c.state;
      await sql`update commissions set refunded_base = ${plan.refundedBase.toString()}::bigint,
          clawed_back = ${plan.clawedBack.toString()}::bigint, state = ${to}, updated_at = now()
        where id = ${c.id}::uuid`.execute(trx);
      const seq = await sql<{ n: string }>`select count(*)::text as n from commission_postings
        where commission_id = ${c.id}::uuid`.execute(trx);
      await sql`insert into commission_postings (commission_id, seq, kind, amount)
        values (${c.id}::uuid, ${Number(seq.rows[0]?.n ?? "0")}, 'clawback', ${plan.delta.toString()}::bigint)`.execute(trx);
      await this.outbox(trx, [{ type: "commission.clawed_back", creatorId: c.creatorId, commissionId: c.id, amount: plan.delta }]);
      return {
        kind: "applied",
        commission: { ...c, refundedBase: plan.refundedBase, clawedBack: plan.clawedBack, state: to },
        plan,
      } as const;
    });
  }

  private toIntent(raw: unknown): PostingIntent {
    const r = IntentRow.parse(raw);
    return { commissionId: r.commission_id, seq: r.seq, kind: r.kind, amount: r.amount, creatorUserId: r.creator_user_id, orderGroupId: r.order_group_id };
  }
  private readonly INTENT_COLS = sql`p.commission_id::text as commission_id, p.seq, p.kind, p.amount::text as amount,
    a.user_id::text as creator_user_id, c.order_group_id::text as order_group_id`;

  async intentsFor(commissionId: string) {
    return this.tx(async (trx) => {
      const r = await sql<unknown>`select ${this.INTENT_COLS} from commission_postings p
        join commissions c on c.id = p.commission_id join creator_accounts a on a.id = c.creator_id
        where p.commission_id = ${commissionId}::uuid and p.posted_at is null order by p.seq`.execute(trx);
      return r.rows.map((x) => this.toIntent(x));
    });
  }
  async listUnpostedIntents(limit: number) {
    return this.tx(async (trx) => {
      const r = await sql<unknown>`select ${this.INTENT_COLS} from commission_postings p
        join commissions c on c.id = p.commission_id join creator_accounts a on a.id = c.creator_id
        where p.posted_at is null order by p.created_at, p.commission_id, p.seq limit ${limit}`.execute(trx);
      return r.rows.map((x) => this.toIntent(x));
    });
  }
  async markPosted(commissionId: string, seq: number, nowMs: number) {
    return this.tx(async (trx) => {
      const r = await sql`update commission_postings set posted_at = ${iso(nowMs)}::timestamptz
        where commission_id = ${commissionId}::uuid and seq = ${seq} and posted_at is null`.execute(trx);
      return Number(r.numAffectedRows ?? 0n) > 0;
    });
  }
  async listHeld(limit: number) {
    return this.tx(async (trx) => {
      const r = await sql<unknown>`select ${COMMISSION_COLS} from commissions where state = 'ACCRUING'
        order by closed_at, id limit ${limit}`.execute(trx);
      return r.rows.map(toCommission);
    });
  }
  async releaseHeld(commissionId: string, monthKey: string, monthlyCap: bigint) {
    return this.tx(async (trx) => {
      // Lock the held row first, then take room with the SAME conditional upsert as accrual (A-5).
      const cur = await sql<unknown>`select ${COMMISSION_COLS} from commissions
        where id = ${commissionId}::uuid and state = 'ACCRUING' for update`.execute(trx);
      if (cur.rows[0] === undefined) return null;
      const held = toCommission(cur.rows[0]);
      if (held.amount > monthlyCap) return null;
      const up = await sql<unknown>`
        insert into creator_monthly_accruals (creator_id, month_key, accrued)
        values (${held.creatorId}::uuid, ${monthKey}, ${held.amount.toString()}::bigint)
        on conflict (creator_id, month_key) do update
          set accrued = creator_monthly_accruals.accrued + excluded.accrued
          where creator_monthly_accruals.accrued + excluded.accrued <= ${monthlyCap.toString()}::bigint
        returning 1 as one`.execute(trx);
      if (up.rows.length === 0) return null;
      const r = await sql<unknown>`update commissions set state = 'ACCRUED', hold_reason = null, month_key = ${monthKey},
          accrued_at = now(), updated_at = now()
        where id = ${commissionId}::uuid and state = 'ACCRUING' returning ${COMMISSION_COLS}`.execute(trx);
      const c = toCommission(r.rows[0]);
      await sql`insert into commission_postings (commission_id, seq, kind, amount)
        values (${c.id}::uuid, 0, 'accrual', ${c.amount.toString()}::bigint)`.execute(trx);
      await this.outbox(trx, [{ type: "commission.accrued", creatorId: c.creatorId, commissionId: c.id, amount: c.amount }]);
      return c;
    });
  }
  async getCommission(id: string) {
    return this.tx(async (trx) => {
      const r = await sql<unknown>`select ${COMMISSION_COLS} from commissions where id = ${id}::uuid`.execute(trx);
      return r.rows[0] === undefined ? null : toCommission(r.rows[0]);
    });
  }
  async listCommissions(creatorId: string, limit: number, beforeMs: number | null) {
    return this.tx(async (trx) => {
      const before = beforeMs === null ? sql`true` : sql`closed_at < ${iso(beforeMs)}::timestamptz`;
      const r = await sql<unknown>`select ${COMMISSION_COLS} from commissions
        where creator_id = ${creatorId}::uuid and state <> 'VOIDED' and ${before}
        order by closed_at desc, id desc limit ${limit}`.execute(trx);
      return r.rows.map(toCommission);
    });
  }
  async monthAccrued(creatorId: string, monthKey: string) {
    return this.tx(async (trx) => {
      const r = await sql<{ a: string }>`select accrued::text as a from creator_monthly_accruals
        where creator_id = ${creatorId}::uuid and month_key = ${monthKey}`.execute(trx);
      return BigInt(r.rows[0]?.a ?? "0");
    });
  }
  async commissionTotals(creatorId: string) {
    return this.tx(async (trx) => {
      const r = await sql<Record<string, string>>`
        select
          coalesce(sum(amount - clawed_back) filter (where state = 'ACCRUED'), 0)::text as pending,
          coalesce(sum(amount) filter (where state in ('ACCRUED', 'PAID', 'CLAWED_BACK')), 0)::text as accrued,
          coalesce(sum(clawed_back) filter (where state in ('ACCRUED', 'PAID', 'CLAWED_BACK')), 0)::text as clawed_back,
          coalesce(sum(amount - clawed_back) filter (where state = 'PAID'), 0)::text as paid,
          coalesce(sum(amount) filter (where state = 'ACCRUING'), 0)::text as held
        from commissions where creator_id = ${creatorId}::uuid`.execute(trx);
      const row = r.rows[0] ?? {};
      const g = (k: string): bigint => BigInt(row[k] ?? "0");
      return { pending: g("pending"), accrued: g("accrued"), clawedBack: g("clawed_back"), paid: g("paid"), held: g("held") };
    });
  }

  // ---- payouts
  async reservableTotal(creatorId: string) {
    return this.tx(async (trx) => {
      const r = await sql<{ t: string }>`select coalesce(sum(amount - clawed_back), 0)::text as t from commissions
        where creator_id = ${creatorId}::uuid and state = 'ACCRUED' and payout_id is null`.execute(trx);
      return BigInt(r.rows[0]?.t ?? "0");
    });
  }
  async createPayout(i: Parameters<CreatorStore["createPayout"]>[0]) {
    try {
      return await this.tx(async (trx) => {
        const p = i.payout;
        await sql`insert into creator_payouts (id, creator_id, amount, state, created_by, created_at, updated_at)
          values (${p.id}::uuid, ${p.creatorId}::uuid, ${p.amount.toString()}::bigint, ${p.state}, ${p.createdBy}::uuid,
            ${iso(p.createdAtMs)}::timestamptz, ${iso(p.updatedAtMs)}::timestamptz)`.execute(trx);
        await sql`update commissions set payout_id = ${p.id}::uuid, updated_at = now()
          where creator_id = ${p.creatorId}::uuid and state = 'ACCRUED' and payout_id is null`.execute(trx);
        await this.outbox(trx, i.events);
        return "created" as const;
      });
    } catch (e) {
      if (isUnique(e)) return "open_exists" as const;
      throw e;
    }
  }
  async getPayout(id: string) {
    return this.tx(async (trx) => {
      const r = await sql<unknown>`select ${PAYOUT_COLS} from creator_payouts where id = ${id}::uuid`.execute(trx);
      return r.rows[0] === undefined ? null : toPayout(r.rows[0]);
    });
  }
  async listPayouts(f: { creatorId?: string; state?: PayoutState; limit: number }) {
    return this.tx(async (trx) => {
      const byCreator = f.creatorId === undefined ? sql`true` : sql`creator_id = ${f.creatorId}::uuid`;
      const byState = f.state === undefined ? sql`true` : sql`state = ${f.state}`;
      const r = await sql<unknown>`select ${PAYOUT_COLS} from creator_payouts where ${byCreator} and ${byState}
        order by created_at desc, id desc limit ${f.limit}`.execute(trx);
      return r.rows.map(toPayout);
    });
  }
  async transitionPayout(i: Parameters<CreatorStore["transitionPayout"]>[0]) {
    return this.tx(async (trx) => {
      const r = await sql<unknown>`
        update creator_payouts set state = ${i.to},
          hold_reason = ${i.holdReason === undefined ? sql`hold_reason` : sql`${i.holdReason}`},
          attempt = ${i.attempt ?? sql`attempt`},
          provider_ref = ${i.providerRef === undefined ? sql`provider_ref` : sql`${i.providerRef}`},
          failure_reason = ${i.failureReason === undefined ? sql`failure_reason` : sql`${i.failureReason}`},
          updated_at = ${iso(i.nowMs)}::timestamptz
        where id = ${i.id}::uuid and state = ${i.from} returning ${PAYOUT_COLS}`.execute(trx);
      if (r.rows[0] === undefined) return null;
      if (i.to === "SETTLED") {
        await sql`update commissions set state = 'PAID', updated_at = now()
          where payout_id = ${i.id}::uuid and state = 'ACCRUED'`.execute(trx);
      } else if (i.to === "CANCELLED") {
        await sql`update commissions set payout_id = null, updated_at = now() where payout_id = ${i.id}::uuid`.execute(trx);
      }
      await this.outbox(trx, i.events);
      return toPayout(r.rows[0]);
    });
  }
}
