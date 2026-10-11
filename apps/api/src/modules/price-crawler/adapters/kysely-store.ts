import { sql, type Kysely } from "kysely";
import { z } from "zod";
import { cohenKappaMilli, type EvidenceGate } from "../domain/matching";
import type {
  ChannelRecord,
  ConfigChange,
  CrawlEvent,
  CrawlStore,
  IncidentRecord,
  MatchRecord,
  MatchingConfigRecord,
  SnapshotRecord,
  TargetRecord,
} from "../domain/ports";

export type CrawlDb = Kysely<Record<string, never>>;
export interface IdPort {
  uuidV7(): string;
}

const Int = z.string().regex(/^-?\d+$/);
const Ms = Int.transform((s) => Number(s));
const MsN = Int.transform((s) => Number(s)).nullable();
const Big = Int.transform((s) => BigInt(s));
const EPOCH = (col: string) => sql.raw(`floor(extract(epoch from ${col}) * 1000)::text`);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const iso = (ms: number): string => new Date(ms).toISOString();
const isoN = (ms: number | null): string | null => (ms === null ? null : iso(ms));

const TargetRow = z.object({
  id: z.string(),
  store_id: z.string(),
  domain: z.string(),
  kind: z.enum(["seller", "brand_rrp"]),
  status: z.enum(["pending_verification", "verified", "unreachable", "blocked", "revoked"]),
  method: z.enum(["dns_txt", "file"]),
  token_hash: z.string(),
  consent_ms: Ms,
  verified_ms: MsN,
  robots_txt: z.string().nullable(),
  robots_status: z.number().int().nullable(),
  robots_ms: MsN,
  failures: z.number().int(),
  opened_ms: MsN,
  etag: z.string().nullable(),
});
const TARGET_COLS = sql`id::text as id, store_id::text as store_id, domain, kind, status,
  verification_method as method, verification_token_hash as token_hash, ${EPOCH("consent_at")} as consent_ms,
  ${EPOCH("verified_at")} as verified_ms, robots_txt, robots_status, ${EPOCH("robots_fetched_at")} as robots_ms,
  breaker_failures as failures, ${EPOCH("breaker_opened_at")} as opened_ms, last_etag as etag`;
const toTarget = (raw: unknown): TargetRecord => {
  const r = TargetRow.parse(raw);
  return {
    id: r.id,
    storeId: r.store_id,
    domain: r.domain,
    kind: r.kind,
    status: r.status,
    verificationMethod: r.method,
    verificationTokenHash: r.token_hash,
    consentAtMs: r.consent_ms,
    verifiedAtMs: r.verified_ms,
    robotsTxt: r.robots_txt,
    robotsStatus: r.robots_status,
    robotsFetchedAtMs: r.robots_ms,
    breakerFailures: r.failures,
    breakerOpenedAtMs: r.opened_ms,
    lastEtag: r.etag,
  };
};

const ChannelRow = z.object({
  id: z.string(),
  store_id: z.string(),
  kind: z.enum(["shopify", "woocommerce", "odoo", "google_sheets", "crawler"]),
  status: z.enum(["active", "revoked", "error"]),
  token_ref: z.string(),
  kms_key_ref: z.string(),
  target_id: z.string().nullable(),
  created_ms: Ms,
  revoked_ms: MsN,
});
const CHANNEL_COLS = sql`id::text as id, store_id::text as store_id, kind, status, token_ref, kms_key_ref,
  target_id::text as target_id, ${EPOCH("created_at")} as created_ms, ${EPOCH("revoked_at")} as revoked_ms`;
const toChannel = (raw: unknown): ChannelRecord => {
  const r = ChannelRow.parse(raw);
  return {
    id: r.id,
    storeId: r.store_id,
    kind: r.kind,
    status: r.status,
    tokenRef: r.token_ref,
    kmsKeyRef: r.kms_key_ref,
    targetId: r.target_id,
    createdAtMs: r.created_ms,
    revokedAtMs: r.revoked_ms,
  };
};

const SnapRow = z.object({
  id: z.string(),
  target_id: z.string(),
  store_id: z.string(),
  sku_ref: z.string(),
  price: Big,
  available: z.boolean(),
  dom_hash: z.string(),
  etag: z.string().nullable(),
  fetched_ms: Ms,
});
const SNAP_COLS = sql`id::text as id, target_id::text as target_id, store_id::text as store_id, sku_ref,
  price_amount::text as price, available, dom_hash, etag, ${EPOCH("fetched_at")} as fetched_ms`;
const toSnap = (raw: unknown): SnapshotRecord => {
  const r = SnapRow.parse(raw);
  return { id: r.id, targetId: r.target_id, storeId: r.store_id, skuRef: r.sku_ref, priceAmount: r.price, available: r.available, domHash: r.dom_hash, etag: r.etag, fetchedAtMs: r.fetched_ms };
};

const MatchRow = z.object({
  id: z.string(),
  sku_id: z.string(),
  store_id: z.string(),
  target_id: z.string(),
  external_ref: z.string(),
  method: z.enum(["gtin", "seller_sku", "image_hash", "embedding", "image_and_embedding"]),
  raw_bp: z.number().int(),
  conf_bp: z.number().int(),
  cap_reason: z.string().nullable(),
  model_version: z.string(),
  gate: z.enum(["live", "shadow", "rejected"]),
  scored_ms: Ms,
});
const MATCH_COLS = sql`id::text as id, sku_id::text as sku_id, store_id::text as store_id, target_id::text as target_id,
  external_ref, method, raw_bp, conf_bp, cap_reason, model_version, gate, ${EPOCH("scored_at")} as scored_ms`;
const toMatch = (raw: unknown): MatchRecord => {
  const r = MatchRow.parse(raw);
  return { id: r.id, skuId: r.sku_id, storeId: r.store_id, targetId: r.target_id, externalRef: r.external_ref, method: r.method, rawBp: r.raw_bp, confBp: r.conf_bp, capReason: r.cap_reason, modelVersion: r.model_version, gate: r.gate, scoredAtMs: r.scored_ms };
};

const aggregateOf = (e: CrawlEvent): { type: string; id: string } => {
  switch (e.type) {
    case "crawl_target.verified":
    case "channel_snapshot.ingested":
      return { type: "crawl_target", id: e.targetId };
    case "product_match.scored":
      return { type: "product_match", id: e.matchId };
    case "channel.token_revoked":
      return { type: "channel_connection", id: e.channelId };
    case "matching_config.changed":
      return { type: "matching_config", id: e.changeId };
    case "crawl.incident":
      return { type: "crawl_incident", id: e.incidentId };
  }
};
const payloadOf = (e: CrawlEvent): Record<string, string | boolean> => {
  switch (e.type) {
    case "crawl_target.verified":
      return { target_id: e.targetId, store_id: e.storeId };
    case "channel_snapshot.ingested":
      return { target_id: e.targetId, store_id: e.storeId, snapshot_id: e.snapshotId };
    case "product_match.scored":
      return { match_id: e.matchId, sku_id: e.skuId, store_id: e.storeId, gate: e.gate };
    case "channel.token_revoked":
      return { channel_id: e.channelId, store_id: e.storeId };
    case "matching_config.changed":
      return { change_id: e.changeId, shadow_only: e.shadowOnly };
    case "crawl.incident":
      return { incident_id: e.incidentId, kind: e.kind };
  }
};

/** Postgres adapter: one transaction per method under the `system` role; outbox in the same tx. */
export class KyselyCrawlStore implements CrawlStore {
  constructor(
    private readonly db: CrawlDb,
    private readonly ids: IdPort,
  ) {}

  private async tx<T>(run: (trx: CrawlDb) => Promise<T>): Promise<T> {
    return this.db.transaction().execute(async (trx) => {
      await sql`select set_config('app.role', 'system', true)`.execute(trx);
      return run(trx as unknown as CrawlDb);
    });
  }

  private async emit(trx: CrawlDb, events: readonly CrawlEvent[]): Promise<void> {
    for (const e of events) {
      const agg = aggregateOf(e);
      await sql`
        insert into outbox_events (id, aggregate_type, aggregate_id, event_type, ordering_key, payload)
        values (${this.ids.uuidV7()}::uuid, ${agg.type}, ${agg.id}::uuid, ${e.type},
                ${`${agg.type}:${agg.id}`}, ${JSON.stringify(payloadOf(e))}::jsonb)`.execute(trx);
    }
  }

  async insertTarget(t: TargetRecord) {
    return this.tx(async (trx) => {
      const ins = await sql`
        insert into crawl_targets (id, store_id, domain, kind, status, verification_method, verification_token_hash, consent_at, verified_at)
        values (${t.id}::uuid, ${t.storeId}::uuid, ${t.domain}, ${t.kind}, ${t.status}, ${t.verificationMethod},
                ${t.verificationTokenHash}, ${iso(t.consentAtMs)}::timestamptz, ${isoN(t.verifiedAtMs)}::timestamptz)
        on conflict (store_id, domain) do nothing returning id`.execute(trx);
      if (ins.rows.length > 0) return { kind: "created" as const, target: t };
      const r = await sql<unknown>`select ${TARGET_COLS} from crawl_targets where store_id = ${t.storeId}::uuid and domain = ${t.domain}`.execute(trx);
      return { kind: "exists" as const, target: toTarget(r.rows[0]) };
    });
  }

  async getTarget(id: string) {
    if (!UUID.test(id)) return null;
    return this.tx(async (trx) => {
      const r = await sql<unknown>`select ${TARGET_COLS} from crawl_targets where id = ${id}::uuid`.execute(trx);
      return r.rows[0] === undefined ? null : toTarget(r.rows[0]);
    });
  }

  async listTargets(storeId: string) {
    if (!UUID.test(storeId)) return [];
    return this.tx(async (trx) => {
      const r = await sql<unknown>`select ${TARGET_COLS} from crawl_targets where store_id = ${storeId}::uuid order by created_at desc, id desc`.execute(trx);
      return r.rows.map(toTarget);
    });
  }

  async listVerifiedTargets(limit: number) {
    return this.tx(async (trx) => {
      const r = await sql<unknown>`select ${TARGET_COLS} from crawl_targets where status = 'verified'
        order by robots_fetched_at nulls first, id limit ${Math.max(1, Math.min(limit, 500))}`.execute(trx);
      return r.rows.map(toTarget);
    });
  }

  async updateTarget(t: TargetRecord, events: readonly CrawlEvent[]) {
    await this.tx(async (trx) => {
      await sql`update crawl_targets set status = ${t.status}, verified_at = ${isoN(t.verifiedAtMs)}::timestamptz,
        robots_txt = ${t.robotsTxt}, robots_status = ${t.robotsStatus}, robots_fetched_at = ${isoN(t.robotsFetchedAtMs)}::timestamptz,
        breaker_failures = ${t.breakerFailures}, breaker_opened_at = ${isoN(t.breakerOpenedAtMs)}::timestamptz,
        last_etag = ${t.lastEtag}, updated_at = now() where id = ${t.id}::uuid`.execute(trx);
      await this.emit(trx, events);
    });
  }

  async verifiedDomains(storeId: string) {
    if (!UUID.test(storeId)) return [];
    return this.tx(async (trx) => {
      const r = await sql<{ domain: string }>`select domain from crawl_targets where store_id = ${storeId}::uuid and status = 'verified'`.execute(trx);
      return r.rows.map((x) => x.domain);
    });
  }

  async insertChannel(c: ChannelRecord) {
    await this.tx(async (trx) => {
      await sql`insert into channel_connections (id, store_id, kind, status, token_ref, kms_key_ref, target_id, created_at)
        values (${c.id}::uuid, ${c.storeId}::uuid, ${c.kind}, ${c.status}, ${c.tokenRef}, ${c.kmsKeyRef},
                ${c.targetId}::uuid, ${iso(c.createdAtMs)}::timestamptz)`.execute(trx);
    });
  }

  async getChannel(id: string) {
    if (!UUID.test(id)) return null;
    return this.tx(async (trx) => {
      const r = await sql<unknown>`select ${CHANNEL_COLS} from channel_connections where id = ${id}::uuid`.execute(trx);
      return r.rows[0] === undefined ? null : toChannel(r.rows[0]);
    });
  }

  async listChannels(storeId: string) {
    if (!UUID.test(storeId)) return [];
    return this.tx(async (trx) => {
      const r = await sql<unknown>`select ${CHANNEL_COLS} from channel_connections where store_id = ${storeId}::uuid order by created_at desc, id desc`.execute(trx);
      return r.rows.map(toChannel);
    });
  }

  async updateChannel(c: ChannelRecord, events: readonly CrawlEvent[]) {
    await this.tx(async (trx) => {
      await sql`update channel_connections set status = ${c.status}, token_ref = ${c.tokenRef},
        revoked_at = ${isoN(c.revokedAtMs)}::timestamptz where id = ${c.id}::uuid`.execute(trx);
      await this.emit(trx, events);
    });
  }

  async latestSnapshot(targetId: string, skuRef: string) {
    if (!UUID.test(targetId)) return null;
    return this.tx(async (trx) => {
      const r = await sql<unknown>`select ${SNAP_COLS} from channel_snapshots
        where target_id = ${targetId}::uuid and sku_ref = ${skuRef} order by fetched_at desc limit 1`.execute(trx);
      return r.rows[0] === undefined ? null : toSnap(r.rows[0]);
    });
  }

  async snapshotsSince(targetId: string, skuRef: string, sinceMs: number) {
    if (!UUID.test(targetId)) return [];
    return this.tx(async (trx) => {
      const r = await sql<unknown>`select ${SNAP_COLS} from channel_snapshots
        where target_id = ${targetId}::uuid and sku_ref = ${skuRef} and fetched_at >= ${iso(sinceMs)}::timestamptz
        order by fetched_at`.execute(trx);
      return r.rows.map(toSnap);
    });
  }

  async insertSnapshot(s: SnapshotRecord, events: readonly CrawlEvent[]) {
    await this.tx(async (trx) => {
      const day = iso(s.fetchedAtMs).slice(0, 10);
      await sql`select channel_snapshots_ensure_partition(${day}::date)`.execute(trx);
      await sql`insert into channel_snapshots (id, target_id, store_id, sku_ref, price_amount, available, dom_hash, etag, fetched_at, fetched_day)
        values (${s.id}::uuid, ${s.targetId}::uuid, ${s.storeId}::uuid, ${s.skuRef}, ${s.priceAmount.toString()}::bigint,
                ${s.available}, ${s.domHash}, ${s.etag}, ${iso(s.fetchedAtMs)}::timestamptz, ${day}::date)`.execute(trx);
      await this.emit(trx, events);
    });
  }

  async upsertMatch(m: MatchRecord, events: readonly CrawlEvent[]) {
    await this.tx(async (trx) => {
      await sql`insert into product_matches (id, sku_id, store_id, target_id, external_ref, method, raw_bp, conf_bp, cap_reason, model_version, gate, scored_at)
        values (${m.id}::uuid, ${m.skuId}::uuid, ${m.storeId}::uuid, ${m.targetId}::uuid, ${m.externalRef}, ${m.method},
                ${m.rawBp}, ${m.confBp}, ${m.capReason}, ${m.modelVersion}, ${m.gate}, ${iso(m.scoredAtMs)}::timestamptz)
        on conflict (sku_id, target_id, external_ref) do update set method = excluded.method, raw_bp = excluded.raw_bp,
          conf_bp = excluded.conf_bp, cap_reason = excluded.cap_reason, model_version = excluded.model_version,
          gate = excluded.gate, scored_at = excluded.scored_at`.execute(trx);
      await this.emit(trx, events);
    });
  }

  async matchesForSkus(skuIds: readonly string[], gate: EvidenceGate) {
    const ids = skuIds.filter((s) => UUID.test(s));
    if (ids.length === 0) return [];
    return this.tx(async (trx) => {
      const r = await sql<unknown>`select ${MATCH_COLS} from product_matches
        where sku_id = any(${`{${ids.join(",")}}`}::uuid[]) and gate = ${gate}`.execute(trx);
      return r.rows.map(toMatch);
    });
  }

  async matchesForStore(storeId: string, limit: number) {
    if (!UUID.test(storeId)) return [];
    return this.tx(async (trx) => {
      const r = await sql<unknown>`select ${MATCH_COLS} from product_matches where store_id = ${storeId}::uuid
        order by scored_at desc, id desc limit ${Math.max(1, Math.min(limit, 200))}`.execute(trx);
      return r.rows.map(toMatch);
    });
  }

  async getConfig(): Promise<MatchingConfigRecord> {
    return this.tx(async (trx) => {
      const r = await sql<{ tau_bp: number; shadow_only: boolean; version: number }>`select tau_bp, shadow_only, version from matching_config where id = 1`.execute(trx);
      const row = r.rows[0];
      return row === undefined ? { tauBp: 9_200, shadowOnly: true, version: 1 } : { tauBp: row.tau_bp, shadowOnly: row.shadow_only, version: row.version };
    });
  }

  async applyConfigChange(c: ConfigChange, events: readonly CrawlEvent[]) {
    return this.tx(async (trx) => {
      await sql`insert into matching_config_changes (id, old_tau_bp, new_tau_bp, old_shadow, new_shadow, proposed_by, approved_by, reason)
        values (${c.id}::uuid, ${c.oldTauBp}, ${c.newTauBp}, ${c.oldShadow}, ${c.newShadow}, ${c.proposedBy}::uuid, ${c.approvedBy}::uuid, ${c.reason})`.execute(trx);
      const r = await sql<{ tau_bp: number; shadow_only: boolean; version: number }>`update matching_config
        set tau_bp = ${c.newTauBp}, shadow_only = ${c.newShadow}, version = version + 1, updated_at = now()
        where id = 1 returning tau_bp, shadow_only, version`.execute(trx);
      await this.emit(trx, events);
      const row = r.rows[0];
      if (row === undefined) throw new Error("matching_config row missing");
      return { tauBp: row.tau_bp, shadowOnly: row.shadow_only, version: row.version };
    });
  }

  async labelStats() {
    return this.tx(async (trx) => {
      const r = await sql<{ label_a: boolean; label_b: boolean }>`select label_a, label_b from match_labels`.execute(trx);
      return { pairs: r.rows.length, kappaMilli: cohenKappaMilli(r.rows.map((x) => ({ a: x.label_a, b: x.label_b }))) };
    });
  }

  async addIncident(i: IncidentRecord, events: readonly CrawlEvent[]) {
    await this.tx(async (trx) => {
      await sql`insert into crawl_incidents (id, target_id, store_id, kind, host, url_hash, detail)
        values (${i.id}::uuid, ${i.targetId}::uuid, ${i.storeId}::uuid, ${i.kind}, ${i.host}, ${i.urlHash}, ${i.detail})`.execute(trx);
      await this.emit(trx, events);
    });
  }
}
