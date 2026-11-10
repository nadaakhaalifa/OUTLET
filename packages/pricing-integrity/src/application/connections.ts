import { createHash, randomBytes } from "node:crypto";
import { isIP } from "node:net";
import type { Queryable } from "@outlet/db";
import type { DnsPort, DomainVerifierPort, OAuthPort } from "./ports.js";
import { assertSafeTarget } from "./ssrf.js";
import { asStore, emit, WatchError } from "./watch-env.js";
import type { WatchEnv } from "./watch-env.js";

export type ChannelType = "shopify" | "woocommerce" | "feed" | "website" | "meta_commerce";
export interface ConnectInput {
  readonly storeId: string;
  readonly userId: string;
  readonly type: ChannelType;
  readonly domain: string;
  readonly consentAcceptanceId: string;
  readonly verifyMethod?: "dns_txt" | "meta_tag" | "file";
}
export interface ConnectionView {
  readonly id: string;
  readonly domain: string;
  readonly type: ChannelType;
  readonly status: string;
  readonly verifiedAt: Date | null;
}
const sha256 = (s: string): Buffer => createHash("sha256").update(s).digest();
const DOMAIN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const DENY_SUFFIX = [".local", ".internal", ".localhost", ".lan", ".corp", ".home"];
/** Read-only scopes only: a write scope is refused (spec 2.1). */
const READ_ONLY = /^(read_|products\/update$|orders\/read$)/;

interface Row { id: string; domain: string; type: ChannelType; status: string; verified_at: Date | string | null; verify_method: string; verify_token_hash: Buffer | Uint8Array | null }
const view = (r: Row): ConnectionView => ({ id: r.id, domain: r.domain, type: r.type, status: r.status, verifiedAt: r.verified_at === null ? null : new Date(r.verified_at) });

export class ChannelConnectionService {
  constructor(private readonly env: WatchEnv, private readonly ports: { dns: DnsPort; verifier: DomainVerifierPort; oauth: OAuthPort }) {}

  /** Creates a PENDING connection and returns the one-time verification token (only its hash is stored). Idempotent per (store, domain). */
  async connect(i: ConnectInput): Promise<ConnectionView & { readonly verificationToken?: string }> {
    const domain = i.domain.trim().toLowerCase();
    if (isIP(domain) !== 0 || /^[0-9.]+$/.test(domain) || !DOMAIN.test(domain) || DENY_SUFFIX.some((s) => domain.endsWith(s))) throw new WatchError("invalid", "invalid domain");
    await assertSafeTarget(`https://${domain}/`, { dns: this.ports.dns, allowedDomains: [domain] });
    const oauth = i.type === "shopify" || i.type === "woocommerce";
    const method = oauth ? "oauth" : (i.verifyMethod ?? "dns_txt");
    const token = `outletnk-verify=${randomBytes(24).toString("hex")}`;
    return asStore(this.env, i.storeId, i.userId, async (tx) => {
      const existing = await tx.query<Row>("SELECT id, domain, type, status, verified_at, verify_method, verify_token_hash FROM channel_connections WHERE store_id = $1 AND domain = $2", [i.storeId, domain]);
      const ex = existing.rows[0];
      if (ex !== undefined) return view(ex);
      const id = this.env.newId();
      const now = this.env.now();
      await tx.query(
        `INSERT INTO channel_connections (id, store_id, market_id, type, domain, base_url, verify_method, verify_token_hash, status, consent_acceptance_id, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', $9, $10, $10)`,
        [id, i.storeId, this.env.marketId, i.type, domain, `https://${domain}/`, method, oauth ? null : sha256(token), i.consentAcceptanceId, now],
      );
      return { id, domain, type: i.type, status: "pending", verifiedAt: null, ...(oauth ? {} : { verificationToken: token }) };
    });
  }

  private async load(tx: Queryable, storeId: string, id: string): Promise<Row> {
    const r = await tx.query<Row>("SELECT id, domain, type, status, verified_at, verify_method, verify_token_hash FROM channel_connections WHERE id = $1 AND store_id = $2", [id, storeId]);
    const row = r.rows[0];
    if (row === undefined) throw new WatchError("not_found", "channel connection not found");
    return row;
  }

  /** DNS TXT / meta tag / file proof of ownership. An unverified domain is never activated. */
  async verify(storeId: string, userId: string, id: string): Promise<ConnectionView> {
    const r = await asStore(this.env, storeId, userId, async (tx) => {
      const c = await this.load(tx, storeId, id);
      if (c.verify_method === "oauth" || c.verify_token_hash === null) throw new WatchError("invalid", "this connection verifies through OAuth");
      const want = Buffer.from(c.verify_token_hash).toString("hex");
      const seen = await this.ports.verifier.observe(c.domain, c.verify_method as "dns_txt" | "meta_tag" | "file");
      if (!seen.some((v) => sha256(v.trim()).toString("hex") === want)) return c;
      return this.activate(tx, storeId, id, c, { scopes: [], tokenRef: null });
    });
    if ("verifiedAt" in r) return r;
    // The failure event must commit, so it is written after (and outside) the transaction that found nothing to activate.
    await asStore(this.env, storeId, userId, (tx) => emit(this.env, tx, "channel.verification_failed", "channel_connection", id, { store_id: storeId, domain: r.domain }));
    throw new WatchError("unverified", "domain ownership could not be verified");
  }

  /** OAuth counts as proof for Shopify and WooCommerce. The token itself stays in KMS: only its reference is stored. */
  async completeOAuth(storeId: string, userId: string, id: string, code: string): Promise<ConnectionView> {
    return asStore(this.env, storeId, userId, async (tx) => {
      const c = await this.load(tx, storeId, id);
      if (c.type !== "shopify" && c.type !== "woocommerce") throw new WatchError("invalid", "OAuth applies to Shopify and WooCommerce only");
      const t = await this.ports.oauth.exchange(c.type, c.domain, code);
      if (!t.tokenRef.startsWith("kms:")) throw new WatchError("invalid", "token must be a KMS reference");
      if (t.scopes.some((s) => !READ_ONLY.test(s))) {
        await this.ports.oauth.revoke(t.tokenRef);
        throw new WatchError("forbidden", "only read-only scopes are allowed");
      }
      return this.activate(tx, storeId, id, c, { scopes: t.scopes, tokenRef: t.tokenRef });
    });
  }

  private async activate(tx: Queryable, storeId: string, id: string, c: Row, o: { scopes: readonly string[]; tokenRef: string | null }): Promise<ConnectionView> {
    const now = this.env.now();
    await tx.query(
      "UPDATE channel_connections SET status = 'active', verified_at = $3, oauth_token_ref = $4, scopes = $5, next_check_at = $3, updated_at = $3 WHERE id = $1 AND store_id = $2",
      [id, storeId, now, o.tokenRef, [...o.scopes]],
    );
    await emit(this.env, tx, "channel.connected", "channel_connection", id, { store_id: storeId, domain: c.domain, type: c.type });
    return { ...view(c), status: "active", verifiedAt: now };
  }

  /** The seller disconnects (or revokes): all "% off" for the store are removed until it is reconnected (fail closed, see ClaimScorer). */
  async disconnect(storeId: string, userId: string, id: string): Promise<void> {
    await asStore(this.env, storeId, userId, async (tx) => {
      const c = await this.load(tx, storeId, id);
      const ref = await tx.query<{ oauth_token_ref: string | null }>("SELECT oauth_token_ref FROM channel_connections WHERE id = $1", [id]);
      const t = ref.rows[0]?.oauth_token_ref;
      if (t !== null && t !== undefined) await this.ports.oauth.revoke(t);
      await tx.query("UPDATE channel_connections SET status = 'disconnected', oauth_token_ref = NULL, updated_at = $2 WHERE id = $1", [c.id, this.env.now()]);
    });
  }

  async list(storeId: string, userId: string): Promise<readonly ConnectionView[]> {
    return asStore(this.env, storeId, userId, async (tx) => {
      const r = await tx.query<Row>("SELECT id, domain, type, status, verified_at, verify_method, verify_token_hash FROM channel_connections WHERE store_id = $1 ORDER BY created_at", [storeId]);
      return r.rows.map(view);
    });
  }
}
