import { sql, type Kysely } from "kysely";
import { z } from "zod";
import { SUBSCRIPTION_STATES, type PlusPlan, type PlusSubscription } from "../domain/bridge";
import type {
  ClientAction,
  CommitResult,
  EntitlementRow,
  IdPort,
  InvoiceRecord,
  PlusEvent,
  SavingsRow,
  SignupRecord,
  SubscriptionChange,
  SubscriptionStore,
} from "../domain/ports";

/** Raw SQL with Zod validated rows, as in the reviews and wishlists adapters. */
export type PlusDb = Kysely<Record<string, never>>;

const Int = z.string().regex(/^-?\d+$/);
const Ms = Int.transform((s) => Number(s));
const Big = Int.transform((s) => BigInt(s));
const Interval = z.enum(["month", "year"]);

const PlanRow = z.object({
  id: z.string(),
  code: z.string(),
  billing_interval: Interval,
  price: Big,
  version: z.number().int(),
  active: z.boolean(),
  trial_days: z.number().int(),
  effective_ms: Ms,
  notified_ms: Ms.nullable(),
});

const SubRow = z.object({
  id: z.string(),
  user_id: z.string(),
  plan_id: z.string(),
  plan_code: z.string(),
  plan_version: z.number().int(),
  billing_interval: Interval,
  status: z.enum(SUBSCRIPTION_STATES),
  period_start_ms: Ms,
  period_end_ms: Ms,
  trial_end_ms: Ms.nullable(),
  cancel_ms: Ms.nullable(),
  paused_ms: Ms.nullable(),
  paused_until_ms: Ms.nullable(),
  grace_ms: Ms.nullable(),
  failed_ms: Ms.nullable(),
  dunning_attempts: z.number().int(),
  cycle: z.number().int(),
  next_ms: Ms.nullable(),
  pending_plan_code: z.string().nullable(),
  reminder_ms: Ms.nullable(),
  psp_token_ref: z.string(),
  created_ms: Ms,
  version: z.number().int(),
});

const InvoiceRow = z.object({
  id: z.string(),
  subscription_id: z.string(),
  user_id: z.string(),
  cycle: z.number().int(),
  attempt: z.number().int(),
  kind: z.enum(["first", "renewal", "dunning", "upgrade"]),
  amount: Big,
  vat: Big,
  credit_applied: Big,
  net_recognition: Big,
  periods_total: z.number().int(),
  periods_recognised: z.number().int(),
  period_start_ms: Ms,
  status: z.enum(["PAID", "FAILED", "REFUNDED"]),
  psp_provider: z.string().nullable(),
  psp_ref: z.string().nullable(),
  issued_ms: Ms,
  charged_ms: Ms.nullable(),
  refunded_ms: Ms.nullable(),
});

const EntRow = z.object({
  user_id: z.string(),
  source_subscription_id: z.string(),
  entitlement_group: z.enum(["commerce_benefits", "app_features"]),
  entitlement_key: z.string(),
  from_ms: Ms,
  to_ms: Ms,
});

const SavingsRowSchema = z.object({
  id: z.string(),
  user_id: z.string(),
  order_group_id: z.string(),
  benefit: z.string(),
  amount_saved: Big,
  created_ms: Ms,
  reversed_ms: Ms.nullable(),
});

const ClientActionSchema = z.union([
  z.object({ type: z.literal("redirect"), url: z.string() }),
  z.object({ type: z.literal("sdk"), token: z.string() }),
]);

const SignupRow = z.object({
  id: z.string(),
  user_id: z.string(),
  plan_id: z.string(),
  charge_key: z.string(),
  token_ref: z.string(),
  device_id: z.string().nullable(),
  amount: Big,
  status: z.enum(["PENDING", "COMPLETED", "FAILED"]),
  psp_ref: z.string().nullable(),
  client_action: z.unknown(),
  subscription_id: z.string().nullable(),
  created_ms: Ms,
  updated_ms: Ms,
});

const EPOCH_MS = (col: string) => sql.raw(`floor(extract(epoch from ${col}) * 1000)::text`);
const ts = (ms: number) => sql`to_timestamp(${ms}::double precision / 1000.0)`;
const tsOrNull = (ms: number | null) => (ms === null ? sql`null::timestamptz` : ts(ms));

const PLAN_COLS = sql`id::text as id, code, billing_interval, price::text as price, version::int as version, active,
  trial_days::int as trial_days, ${EPOCH_MS("effective_from")} as effective_ms, ${EPOCH_MS("notified_at")} as notified_ms`;
const SUB_COLS = sql`id::text as id, user_id::text as user_id, plan_id::text as plan_id, plan_code,
  plan_version::int as plan_version, billing_interval, status,
  ${EPOCH_MS("period_start")} as period_start_ms, ${EPOCH_MS("period_end")} as period_end_ms,
  ${EPOCH_MS("trial_end")} as trial_end_ms, ${EPOCH_MS("cancel_at")} as cancel_ms,
  ${EPOCH_MS("paused_at")} as paused_ms, ${EPOCH_MS("paused_until")} as paused_until_ms,
  ${EPOCH_MS("grace_ends_at")} as grace_ms, ${EPOCH_MS("failed_at")} as failed_ms,
  dunning_attempts::int as dunning_attempts, cycle::int as cycle, ${EPOCH_MS("next_action_at")} as next_ms,
  pending_plan_code, ${EPOCH_MS("trial_reminder_sent_at")} as reminder_ms, psp_token_ref,
  ${EPOCH_MS("created_at")} as created_ms, version::int as version`;
const INVOICE_COLS = sql`id::text as id, subscription_id::text as subscription_id, user_id::text as user_id,
  cycle::int as cycle, attempt::int as attempt, kind, amount::text as amount, vat::text as vat,
  credit_applied::text as credit_applied, net_recognition::text as net_recognition,
  periods_total::int as periods_total, periods_recognised::int as periods_recognised,
  ${EPOCH_MS("period_start")} as period_start_ms, status, psp_provider, psp_ref,
  ${EPOCH_MS("issued_at")} as issued_ms, ${EPOCH_MS("charged_at")} as charged_ms,
  ${EPOCH_MS("refunded_at")} as refunded_ms`;
const SIGNUP_COLS = sql`id::text as id, user_id::text as user_id, plan_id::text as plan_id, charge_key, token_ref,
  device_id, amount::text as amount, status, psp_ref, client_action, subscription_id::text as subscription_id,
  ${EPOCH_MS("created_at")} as created_ms, ${EPOCH_MS("updated_at")} as updated_ms`;

const toPlan = (r: z.infer<typeof PlanRow>): PlusPlan => ({
  id: r.id,
  code: r.code,
  interval: r.billing_interval,
  priceMinor: r.price,
  version: r.version,
  active: r.active,
  trialDays: r.trial_days,
  effectiveFromMs: r.effective_ms,
  notifiedAtMs: r.notified_ms,
});

const toSub = (r: z.infer<typeof SubRow>): PlusSubscription => ({
  id: r.id,
  userId: r.user_id,
  planId: r.plan_id,
  planCode: r.plan_code,
  planVersion: r.plan_version,
  interval: r.billing_interval,
  status: r.status,
  periodStartMs: r.period_start_ms,
  periodEndMs: r.period_end_ms,
  trialEndMs: r.trial_end_ms,
  cancelAtMs: r.cancel_ms,
  pausedAtMs: r.paused_ms,
  pausedUntilMs: r.paused_until_ms,
  graceEndsAtMs: r.grace_ms,
  failedAtMs: r.failed_ms,
  dunningAttempts: r.dunning_attempts,
  cycle: r.cycle,
  nextActionAtMs: r.next_ms,
  pendingPlanCode: r.pending_plan_code,
  trialReminderSentAtMs: r.reminder_ms,
  pspTokenRef: r.psp_token_ref,
  createdAtMs: r.created_ms,
  version: r.version,
});

const toInvoice = (r: z.infer<typeof InvoiceRow>): InvoiceRecord => ({
  id: r.id,
  subscriptionId: r.subscription_id,
  userId: r.user_id,
  cycle: r.cycle,
  attempt: r.attempt,
  kind: r.kind,
  amountMinor: r.amount,
  vatMinor: r.vat,
  creditAppliedMinor: r.credit_applied,
  netRecognitionMinor: r.net_recognition,
  periodsTotal: r.periods_total,
  periodsRecognised: r.periods_recognised,
  periodStartMs: r.period_start_ms,
  status: r.status,
  provider: r.psp_provider,
  pspRef: r.psp_ref,
  issuedAtMs: r.issued_ms,
  chargedAtMs: r.charged_ms,
  refundedAtMs: r.refunded_ms,
});

const toSignup = (r: z.infer<typeof SignupRow>): SignupRecord => {
  const action = ClientActionSchema.safeParse(r.client_action);
  return {
    id: r.id,
    userId: r.user_id,
    planId: r.plan_id,
    chargeKey: r.charge_key,
    tokenRef: r.token_ref,
    deviceId: r.device_id,
    amountMinor: r.amount,
    status: r.status,
    pspRef: r.psp_ref,
    clientAction: action.success ? (action.data as ClientAction) : null,
    subscriptionId: r.subscription_id,
    createdAtMs: r.created_ms,
    updatedAtMs: r.updated_ms,
  };
};

/** Outbox payload: ids, enums, counters and money as strings only. No names, no contact data. */
function aggregateOf(e: PlusEvent): { type: string; id: string } {
  switch (e.type) {
    case "plus.plan_published":
      return { type: "plus_plan", id: e.planId };
    case "plus.benefit_used":
    case "plus.benefit_reversed":
      return { type: "plus_benefit", id: e.orderGroupId };
    default:
      return { type: "plus_subscription", id: e.subscriptionId };
  }
}

class Abort extends Error {
  constructor(readonly result: CommitResult) {
    super(result);
  }
}

const isUnique = (e: unknown, name: string): boolean => e instanceof Error && e.message.includes(name);

/**
 * Postgres adapter. One transaction per method under the `system` role (authorization is the
 * policy guard; RLS stays on for every other role). Outbox rows are written in the same
 * transaction as the state change.
 */
export class KyselySubscriptionStore implements SubscriptionStore {
  constructor(
    private readonly db: PlusDb,
    private readonly ids: IdPort,
  ) {}

  private async tx<T>(run: (trx: PlusDb) => Promise<T>): Promise<T> {
    return this.db.transaction().execute(async (trx) => {
      await sql`select set_config('app.role', 'system', true)`.execute(trx);
      return run(trx as unknown as PlusDb);
    });
  }

  private async read<T>(query: ReturnType<typeof sql>, row: z.ZodType<T>): Promise<T[]> {
    const r = await query.execute(this.db);
    return z.array(row).parse(r.rows);
  }

  private async emit(trx: PlusDb, events: readonly PlusEvent[]): Promise<void> {
    for (const e of events) {
      const agg = aggregateOf(e);
      const { type: _t, ...payload } = e;
      await sql`
        insert into outbox_events (id, aggregate_type, aggregate_id, event_type, ordering_key, payload)
        values (${this.ids.uuidV7()}::uuid, ${agg.type}, ${agg.id}::uuid, ${e.type},
                ${`${agg.type}:${agg.id}`}, ${JSON.stringify(payload)}::jsonb)`.execute(trx);
    }
  }

  async listPlanVersions(code?: string): Promise<readonly PlusPlan[]> {
    const rows = await this.read(
      code === undefined
        ? sql`select ${PLAN_COLS} from plans order by code, version`
        : sql`select ${PLAN_COLS} from plans where code = ${code} order by version`,
      PlanRow,
    );
    return rows.map(toPlan);
  }

  async getPlan(id: string): Promise<PlusPlan | null> {
    const rows = await this.read(sql`select ${PLAN_COLS} from plans where id = ${id}::uuid`, PlanRow);
    return rows[0] === undefined ? null : toPlan(rows[0]);
  }

  async savePlan(p: PlusPlan, events: readonly PlusEvent[]): Promise<"ok" | "exists"> {
    try {
      await this.tx(async (trx) => {
        await sql`
          insert into plans (id, code, billing_interval, price, version, active, trial_days, effective_from, notified_at)
          values (${p.id}::uuid, ${p.code}, ${p.interval}, ${p.priceMinor.toString()}::bigint, ${p.version}, ${p.active},
                  ${p.trialDays}, ${ts(p.effectiveFromMs)}, ${tsOrNull(p.notifiedAtMs)})
          on conflict (id) do update set active = excluded.active, notified_at = excluded.notified_at`.execute(trx);
        await this.emit(trx, events);
      });
      return "ok";
    } catch (e) {
      if (isUnique(e, "plans_code_version_uq")) return "exists";
      throw e;
    }
  }

  async getSubscription(id: string): Promise<PlusSubscription | null> {
    const rows = await this.read(sql`select ${SUB_COLS} from subscriptions where id = ${id}::uuid`, SubRow);
    return rows[0] === undefined ? null : toSub(rows[0]);
  }

  async getLiveByUser(userId: string): Promise<PlusSubscription | null> {
    const rows = await this.read(
      sql`select ${SUB_COLS} from subscriptions where user_id = ${userId}::uuid and status <> 'EXPIRED' limit 1`,
      SubRow,
    );
    return rows[0] === undefined ? null : toSub(rows[0]);
  }

  async getLatestByUser(userId: string): Promise<PlusSubscription | null> {
    const rows = await this.read(
      sql`select ${SUB_COLS} from subscriptions where user_id = ${userId}::uuid
          order by (status <> 'EXPIRED') desc, created_at desc, id desc limit 1`,
      SubRow,
    );
    return rows[0] === undefined ? null : toSub(rows[0]);
  }

  async listDue(nowMs: number, limit: number): Promise<readonly PlusSubscription[]> {
    const rows = await this.read(
      sql`select ${SUB_COLS} from subscriptions
          where status <> 'EXPIRED' and next_action_at is not null and next_action_at <= ${ts(nowMs)}
          order by next_action_at, id limit ${limit}`,
      SubRow,
    );
    return rows.map(toSub);
  }

  async listLiveByPlanCode(code: string): Promise<readonly PlusSubscription[]> {
    const rows = await this.read(
      sql`select ${SUB_COLS} from subscriptions where status <> 'EXPIRED' and plan_code = ${code} order by id`,
      SubRow,
    );
    return rows.map(toSub);
  }

  async claimedTrialKeys(keyHashes: readonly string[]): Promise<ReadonlySet<string>> {
    if (keyHashes.length === 0) return new Set();
    const r = await sql`select person_key_hash from trial_claims where person_key_hash = any(${[...keyHashes]}::text[])`.execute(
      this.db,
    );
    const rows = z.array(z.object({ person_key_hash: z.string() })).parse(r.rows);
    return new Set(rows.map((x) => x.person_key_hash));
  }

  async getInvoice(id: string): Promise<InvoiceRecord | null> {
    const rows = await this.read(sql`select ${INVOICE_COLS} from subscription_invoices where id = ${id}::uuid`, InvoiceRow);
    return rows[0] === undefined ? null : toInvoice(rows[0]);
  }

  async latestPaidInvoice(subscriptionId: string): Promise<InvoiceRecord | null> {
    const rows = await this.read(
      sql`select ${INVOICE_COLS} from subscription_invoices
          where subscription_id = ${subscriptionId}::uuid and status in ('PAID', 'REFUNDED')
          order by issued_at desc, cycle desc, attempt desc limit 1`,
      InvoiceRow,
    );
    return rows[0] === undefined ? null : toInvoice(rows[0]);
  }

  async listInvoices(subscriptionId: string): Promise<readonly InvoiceRecord[]> {
    const rows = await this.read(
      sql`select ${INVOICE_COLS} from subscription_invoices where subscription_id = ${subscriptionId}::uuid
          order by cycle, attempt`,
      InvoiceRow,
    );
    return rows.map(toInvoice);
  }

  async listForRecognition(limit: number): Promise<readonly InvoiceRecord[]> {
    const rows = await this.read(
      sql`select ${INVOICE_COLS} from subscription_invoices
          where status = 'PAID' and periods_recognised < periods_total order by period_start, id limit ${limit}`,
      InvoiceRow,
    );
    return rows.map(toInvoice);
  }

  async getSignup(id: string): Promise<SignupRecord | null> {
    const rows = await this.read(sql`select ${SIGNUP_COLS} from plus_signups where id = ${id}::uuid`, SignupRow);
    return rows[0] === undefined ? null : toSignup(rows[0]);
  }

  async getSignupByChargeKey(key: string): Promise<SignupRecord | null> {
    const rows = await this.read(sql`select ${SIGNUP_COLS} from plus_signups where charge_key = ${key}`, SignupRow);
    return rows[0] === undefined ? null : toSignup(rows[0]);
  }

  async entitlementRows(userId: string): Promise<readonly EntitlementRow[]> {
    const rows = await this.read(
      sql`select user_id::text as user_id, source_subscription_id::text as source_subscription_id,
                 entitlement_group, entitlement_key, ${EPOCH_MS("valid_from")} as from_ms, ${EPOCH_MS("valid_to")} as to_ms
          from entitlements where user_id = ${userId}::uuid order by entitlement_group, entitlement_key`,
      EntRow,
    );
    return rows.map((r) => ({
      userId: r.user_id,
      subscriptionId: r.source_subscription_id,
      group: r.entitlement_group,
      key: r.entitlement_key,
      validFromMs: r.from_ms,
      validToMs: r.to_ms,
    }));
  }

  async addSavings(row: SavingsRow, events: readonly PlusEvent[]): Promise<"added" | "exists"> {
    return this.tx(async (trx) => {
      const r = await sql`
        insert into plus_savings_ledger (id, user_id, order_group_id, benefit, amount_saved, created_at)
        values (${row.id}::uuid, ${row.userId}::uuid, ${row.orderGroupId}::uuid, ${row.benefit},
                ${row.amountSavedMinor.toString()}::bigint, ${ts(row.createdAtMs)})
        on conflict (order_group_id, benefit) do nothing returning id`.execute(trx);
      if (r.rows.length === 0) return "exists" as const;
      await this.emit(trx, events);
      return "added" as const;
    });
  }

  async reverseSavings(
    orderGroupId: string,
    atMs: number,
    events: (userId: string) => readonly PlusEvent[],
  ): Promise<number> {
    return this.tx(async (trx) => {
      const r = await sql`
        update plus_savings_ledger set reversed_at = ${ts(atMs)}
        where order_group_id = ${orderGroupId}::uuid and reversed_at is null returning user_id::text as user_id`.execute(trx);
      const rows = z.array(z.object({ user_id: z.string() })).parse(r.rows);
      for (const row of rows) await this.emit(trx, events(row.user_id));
      return rows.length;
    });
  }

  async benefitUsedSince(userId: string, sinceMs: number): Promise<boolean> {
    const r = await sql`
      select 1 as x from plus_savings_ledger
      where user_id = ${userId}::uuid and reversed_at is null and created_at >= ${ts(sinceMs)} limit 1`.execute(this.db);
    return r.rows.length > 0;
  }

  async listSavings(userId: string, limit: number): Promise<readonly SavingsRow[]> {
    const rows = await this.read(
      sql`select id::text as id, user_id::text as user_id, order_group_id::text as order_group_id, benefit,
                 amount_saved::text as amount_saved, ${EPOCH_MS("created_at")} as created_ms,
                 ${EPOCH_MS("reversed_at")} as reversed_ms
          from plus_savings_ledger where user_id = ${userId}::uuid order by created_at desc, id desc limit ${limit}`,
      SavingsRowSchema,
    );
    return rows.map((r) => ({
      id: r.id,
      userId: r.user_id,
      orderGroupId: r.order_group_id,
      benefit: r.benefit,
      amountSavedMinor: r.amount_saved,
      createdAtMs: r.created_ms,
      reversedAtMs: r.reversed_ms,
    }));
  }

  async totalSavedMinor(userId: string): Promise<bigint> {
    const r = await sql`
      select coalesce(sum(amount_saved), 0)::text as total from plus_savings_ledger
      where user_id = ${userId}::uuid and reversed_at is null`.execute(this.db);
    const rows = z.array(z.object({ total: Big })).parse(r.rows);
    return rows[0]?.total ?? 0n;
  }

  async commit(c: SubscriptionChange): Promise<CommitResult> {
    try {
      return await this.tx(async (trx) => {
        if (c.webhookEvent !== undefined) {
          const w = await sql`
            insert into subscription_webhook_events (provider, event_id)
            values (${c.webhookEvent.provider}, ${c.webhookEvent.eventId})
            on conflict do nothing returning event_id`.execute(trx);
          if (w.rows.length === 0) throw new Abort("duplicate_event");
        }
        if (c.trialClaims !== undefined) {
          for (const k of c.trialClaims.keyHashes) {
            const t = await sql`
              insert into trial_claims (person_key_hash, subscription_id, claimed_at)
              values (${k}, ${c.trialClaims.subscriptionId}::uuid, ${ts(c.trialClaims.atMs)})
              on conflict do nothing returning person_key_hash`.execute(trx);
            if (t.rows.length === 0) throw new Abort("trial_taken");
          }
        }
        if (c.subscription !== undefined) await this.writeSubscription(trx, c.subscription.value, c.subscription.expectedVersion);
        for (const i of c.invoices ?? []) await this.writeInvoice(trx, i);
        if (c.entitlements !== undefined) await this.writeEntitlements(trx, c.entitlements.subscriptionId, c.entitlements.rows);
        if (c.signup !== undefined) await this.writeSignup(trx, c.signup);
        await this.emit(trx, c.events);
        return "ok" as const;
      });
    } catch (e) {
      if (e instanceof Abort) return e.result;
      if (isUnique(e, "subscriptions_one_live_uq")) return "already_subscribed";
      if (isUnique(e, "subscription_invoices_attempt_uq") || isUnique(e, "subscriptions_pkey")) return "conflict";
      throw e;
    }
  }

  private async writeSubscription(trx: PlusDb, s: PlusSubscription, expected: number | null): Promise<void> {
    if (expected === null) {
      await sql`
        insert into subscriptions (id, user_id, plan_id, plan_code, plan_version, billing_interval, status, period_start,
          period_end, trial_end, cancel_at, paused_at, paused_until, grace_ends_at, failed_at, dunning_attempts, cycle,
          next_action_at, pending_plan_code, trial_reminder_sent_at, psp_token_ref, version, created_at, updated_at)
        values (${s.id}::uuid, ${s.userId}::uuid, ${s.planId}::uuid, ${s.planCode}, ${s.planVersion}, ${s.interval},
          ${s.status}, ${ts(s.periodStartMs)}, ${ts(s.periodEndMs)}, ${tsOrNull(s.trialEndMs)}, ${tsOrNull(s.cancelAtMs)},
          ${tsOrNull(s.pausedAtMs)}, ${tsOrNull(s.pausedUntilMs)}, ${tsOrNull(s.graceEndsAtMs)}, ${tsOrNull(s.failedAtMs)},
          ${s.dunningAttempts}, ${s.cycle}, ${tsOrNull(s.nextActionAtMs)}, ${s.pendingPlanCode},
          ${tsOrNull(s.trialReminderSentAtMs)}, ${s.pspTokenRef}, 1, ${ts(s.createdAtMs)}, ${ts(s.createdAtMs)})`.execute(trx);
      return;
    }
    const r = await sql`
      update subscriptions set plan_id = ${s.planId}::uuid, plan_code = ${s.planCode}, plan_version = ${s.planVersion},
        billing_interval = ${s.interval}, status = ${s.status}, period_start = ${ts(s.periodStartMs)},
        period_end = ${ts(s.periodEndMs)}, trial_end = ${tsOrNull(s.trialEndMs)}, cancel_at = ${tsOrNull(s.cancelAtMs)},
        paused_at = ${tsOrNull(s.pausedAtMs)}, paused_until = ${tsOrNull(s.pausedUntilMs)},
        grace_ends_at = ${tsOrNull(s.graceEndsAtMs)}, failed_at = ${tsOrNull(s.failedAtMs)},
        dunning_attempts = ${s.dunningAttempts}, cycle = ${s.cycle}, next_action_at = ${tsOrNull(s.nextActionAtMs)},
        pending_plan_code = ${s.pendingPlanCode}, trial_reminder_sent_at = ${tsOrNull(s.trialReminderSentAtMs)},
        psp_token_ref = ${s.pspTokenRef}, version = version + 1, updated_at = now()
      where id = ${s.id}::uuid and version = ${expected} returning id`.execute(trx);
    if (r.rows.length === 0) throw new Abort("conflict");
  }

  private async writeInvoice(trx: PlusDb, i: InvoiceRecord): Promise<void> {
    await sql`
      insert into subscription_invoices (id, subscription_id, user_id, cycle, attempt, kind, amount, vat, credit_applied,
        net_recognition, periods_total, periods_recognised, period_start, status, psp_provider, psp_ref, issued_at,
        charged_at, refunded_at)
      values (${i.id}::uuid, ${i.subscriptionId}::uuid, ${i.userId}::uuid, ${i.cycle}, ${i.attempt}, ${i.kind},
        ${i.amountMinor.toString()}::bigint, ${i.vatMinor.toString()}::bigint, ${i.creditAppliedMinor.toString()}::bigint,
        ${i.netRecognitionMinor.toString()}::bigint, ${i.periodsTotal}, ${i.periodsRecognised}, ${ts(i.periodStartMs)},
        ${i.status}, ${i.provider}, ${i.pspRef}, ${ts(i.issuedAtMs)}, ${tsOrNull(i.chargedAtMs)}, ${tsOrNull(i.refundedAtMs)})
      on conflict (id) do update set status = excluded.status, periods_recognised = excluded.periods_recognised,
        psp_provider = excluded.psp_provider, psp_ref = excluded.psp_ref, charged_at = excluded.charged_at,
        net_recognition = excluded.net_recognition, vat = excluded.vat, refunded_at = excluded.refunded_at`.execute(trx);
  }

  private async writeEntitlements(trx: PlusDb, subscriptionId: string, rows: readonly EntitlementRow[]): Promise<void> {
    await sql`delete from entitlements where source_subscription_id = ${subscriptionId}::uuid`.execute(trx);
    for (const r of rows) {
      await sql`
        insert into entitlements (source_subscription_id, user_id, entitlement_group, entitlement_key, valid_from, valid_to)
        values (${r.subscriptionId}::uuid, ${r.userId}::uuid, ${r.group}, ${r.key}, ${ts(r.validFromMs)}, ${ts(r.validToMs)})`.execute(
        trx,
      );
    }
  }

  private async writeSignup(trx: PlusDb, s: SignupRecord): Promise<void> {
    await sql`
      insert into plus_signups (id, user_id, plan_id, charge_key, token_ref, device_id, amount, status, psp_ref,
        client_action, subscription_id, created_at, updated_at)
      values (${s.id}::uuid, ${s.userId}::uuid, ${s.planId}::uuid, ${s.chargeKey}, ${s.tokenRef}, ${s.deviceId},
        ${s.amountMinor.toString()}::bigint, ${s.status}, ${s.pspRef},
        ${s.clientAction === null ? null : JSON.stringify(s.clientAction)}::jsonb, ${s.subscriptionId}::uuid,
        ${ts(s.createdAtMs)}, ${ts(s.updatedAtMs)})
      on conflict (id) do update set status = excluded.status, psp_ref = excluded.psp_ref,
        client_action = excluded.client_action, subscription_id = excluded.subscription_id,
        updated_at = excluded.updated_at`.execute(trx);
  }
}
