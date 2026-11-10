import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/**
 * Signs and verifies the daily ledger snapshot digest (master prompt T4: "daily signed snapshot"). The port is the seam between the integrity job and
 * whatever holds the key: `HmacSnapshotSigner` is the interim (a symmetric key in the worker env), a KMS adapter implements `KmsSnapshotSigner` later.
 * Secrets never appear in code, logs or run details: only `keyId()` is ever stored.
 */
export interface SnapshotSignerPort {
  /** Public, non-secret identifier of the signing key; stored per run so the verifier picks the right key (rotation). */
  keyId(): string;
  sign(bytes: Uint8Array): Promise<Uint8Array>;
  verify(bytes: Uint8Array, signature: Uint8Array): Promise<boolean>;
}

/**
 * Contract for the KMS-backed adapter that replaces the HMAC interim (ADR-0016). A later adapter (AWS KMS / GCP KMS, no SDK in this package) implements
 * it with an ASYMMETRIC key (sign in KMS, verify with the exported public key), so the verifier needs only the verify key and the worker never holds
 * key material. `keyId()` is the KMS key version id: rotating the key changes it, old runs keep their own key id. Nothing implements it yet.
 */
export interface KmsSnapshotSigner extends SnapshotSignerPort {
  /** Verify-only handle for auditors and the weekly chain check: same `verify`, no `sign`. */
  readonly verifyOnly: Pick<SnapshotSignerPort, "keyId" | "verify">;
}

export class SnapshotSignerUnconfiguredError extends Error {
  constructor() {
    super("ledger snapshot signer is not configured (LEDGER_SNAPSHOT_HMAC_KEY / LEDGER_SNAPSHOT_KEY_ID)");
    this.name = "SnapshotSignerUnconfiguredError";
  }
}

/** Fail-closed signer (ADR-0029): never produces a signature, never verifies one. The job stores the run unsigned and warns. */
export class UnconfiguredSnapshotSigner implements SnapshotSignerPort {
  keyId(): string { throw new SnapshotSignerUnconfiguredError(); }
  sign(): Promise<Uint8Array> { return Promise.reject(new SnapshotSignerUnconfiguredError()); }
  verify(): Promise<boolean> { return Promise.resolve(false); }
}

export const MIN_HMAC_KEY_BYTES = 32;
const KEY_ID = /^[A-Za-z0-9._:-]{1,64}$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export const decodeBase64Strict = (s: string): Uint8Array | null => (s.length > 0 && BASE64.test(s) ? new Uint8Array(Buffer.from(s, "base64")) : null);

/** Interim signer: HMAC-SHA256 with a symmetric key. Anyone who can verify can also forge, hence "interim until KMS". The key is held only in this closure. */
export class HmacSnapshotSigner implements SnapshotSignerPort {
  readonly #key: Uint8Array;
  readonly #keyId: string;
  /** @throws Error (message never contains key material) when the key is shorter than 32 bytes or the key id is malformed. */
  constructor(key: Uint8Array, keyId: string) {
    if (key.length < MIN_HMAC_KEY_BYTES) throw new Error(`snapshot HMAC key must be at least ${String(MIN_HMAC_KEY_BYTES)} bytes`);
    if (!KEY_ID.test(keyId)) throw new Error("snapshot key id must match [A-Za-z0-9._:-]{1,64}");
    this.#key = new Uint8Array(key);
    this.#keyId = keyId;
  }
  keyId(): string { return this.#keyId; }
  sign(bytes: Uint8Array): Promise<Uint8Array> { return Promise.resolve(new Uint8Array(createHmac("sha256", this.#key).update(bytes).digest())); }
  verify(bytes: Uint8Array, signature: Uint8Array): Promise<boolean> {
    const expected = createHmac("sha256", this.#key).update(bytes).digest();
    return Promise.resolve(signature.length === expected.length && timingSafeEqual(expected, signature));
  }
}

/** Builds the signer from env values: both unset = Unconfigured (fail closed); one without the other, bad base64, a short key or a bad key id = throws (boot error, no value echoed). */
export const snapshotSignerFromEnv = (env: { readonly LEDGER_SNAPSHOT_HMAC_KEY?: string | undefined; readonly LEDGER_SNAPSHOT_KEY_ID?: string | undefined }): SnapshotSignerPort => {
  const k = env.LEDGER_SNAPSHOT_HMAC_KEY;
  const id = env.LEDGER_SNAPSHOT_KEY_ID;
  if ((k === undefined || k === "") && (id === undefined || id === "")) return new UnconfiguredSnapshotSigner();
  if (k === undefined || k === "" || id === undefined || id === "") throw new Error("LEDGER_SNAPSHOT_HMAC_KEY and LEDGER_SNAPSHOT_KEY_ID must be set together");
  const bytes = decodeBase64Strict(k);
  if (bytes === null) throw new Error("LEDGER_SNAPSHOT_HMAC_KEY must be base64");
  return new HmacSnapshotSigner(bytes, id);
};

/* ---------- snapshot payload, digest, chain ---------- */

/** What the signature covers. All fields are stored on the run so a verifier recomputes the digest without the database. */
export interface SnapshotPayload {
  readonly market: string;
  readonly day: string;
  /** currency -> decimal string total. */
  readonly totals: Readonly<Record<string, string>>;
  /** Last entry hash of a verified chain, or `broken:<entryId>`. */
  readonly chain_head: string;
  /** Decimal chain_seq verified through. */
  readonly verified_through_seq: string;
  readonly previous_snapshot_digest: string | null;
  readonly previous_signature_key_id: string | null;
}

/** Stored in reconciliation_runs.details.snapshot. */
export interface SignedSnapshot {
  readonly payload: SnapshotPayload;
  readonly digest: string;
  /** base64, or null when unsigned. */
  readonly signature: string | null;
  readonly signed: boolean;
  readonly key_id: string | null;
  readonly previous_digest: string | null;
}

/** Canonical JSON: fixed key order, currencies sorted. Hand-built so no JSON.stringify ordering or bigint concerns. */
export const canonicalPayload = (p: SnapshotPayload): string =>
  JSON.stringify({
    market: p.market,
    day: p.day,
    totals: Object.fromEntries(Object.entries(p.totals).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
    chain_head: p.chain_head,
    verified_through_seq: p.verified_through_seq,
    previous_snapshot_digest: p.previous_snapshot_digest,
    previous_signature_key_id: p.previous_signature_key_id,
  });

export const payloadDigest = (p: SnapshotPayload): string => createHash("sha256").update(canonicalPayload(p)).digest("hex");

const digestBytes = (digest: string): Uint8Array => new TextEncoder().encode(digest);

/** Signs `digest` (hex) with the signer; any failure (unconfigured, KMS outage) yields an unsigned snapshot, never a fake signature. `onUnsigned` gets a non-secret reason code. */
export const buildSnapshot = async (payload: SnapshotPayload, signer: SnapshotSignerPort, onUnsigned?: (reason: string) => void): Promise<SignedSnapshot> => {
  const digest = payloadDigest(payload);
  const base = { payload, digest, previous_digest: payload.previous_snapshot_digest };
  try {
    const keyId = signer.keyId();
    const sig = await signer.sign(digestBytes(digest));
    return { ...base, signature: Buffer.from(sig).toString("base64"), signed: true, key_id: keyId };
  } catch (e) {
    onUnsigned?.(e instanceof SnapshotSignerUnconfiguredError ? "unconfigured" : "sign_failed");
    return { ...base, signature: null, signed: false, key_id: null };
  }
};

export interface SnapshotChainResult {
  readonly ok: boolean;
  readonly checked: number;
  /** Unsigned snapshots seen (not a break unless `requireSigned`). */
  readonly unsigned: number;
  readonly firstBreak: { readonly day: string; readonly reason: "digest_mismatch" | "signature_invalid" | "unknown_key" | "unsigned" | "previous_digest_mismatch" | "previous_key_mismatch" | "payload_previous_mismatch" } | null;
}

/**
 * Walks snapshots oldest to newest (the order of `snapshots`): recomputes each digest from the stored payload, checks each signature against the key
 * named by its key_id (any of `signers`, so a rotated key keeps verifying old runs), and that each previous_digest equals its predecessor's digest and
 * previous key id its predecessor's key id. Returns the first break. The first element's own previous link is not checked (window start).
 */
export const verifySnapshotChain = async (snapshots: readonly SignedSnapshot[], signers: SnapshotSignerPort | readonly SnapshotSignerPort[], opts: { readonly requireSigned?: boolean } = {}): Promise<SnapshotChainResult> => {
  const list = Array.isArray(signers) ? (signers as readonly SnapshotSignerPort[]) : [signers as SnapshotSignerPort];
  const byId = new Map<string, SnapshotSignerPort>();
  for (const s of list) { try { byId.set(s.keyId(), s); } catch { /* unconfigured signer has no id */ } }
  let unsigned = 0;
  let prev: SignedSnapshot | null = null;
  let checked = 0;
  const brk = (day: string, reason: NonNullable<SnapshotChainResult["firstBreak"]>["reason"]): SnapshotChainResult => ({ ok: false, checked, unsigned, firstBreak: { day, reason } });
  for (const s of snapshots) {
    const day = s.payload.day;
    checked += 1;
    if (payloadDigest(s.payload) !== s.digest) return brk(day, "digest_mismatch");
    if (s.payload.previous_snapshot_digest !== s.previous_digest) return brk(day, "payload_previous_mismatch");
    if (s.signed) {
      const signer = s.key_id === null ? undefined : byId.get(s.key_id);
      const sigBytes = s.signature === null ? null : decodeBase64Strict(s.signature);
      if (signer === undefined) return brk(day, "unknown_key");
      if (sigBytes === null || !(await signer.verify(digestBytes(s.digest), sigBytes))) return brk(day, "signature_invalid");
    } else {
      unsigned += 1;
      if (opts.requireSigned === true) return brk(day, "unsigned");
    }
    if (prev !== null) {
      if (s.previous_digest !== prev.digest) return brk(day, "previous_digest_mismatch");
      if (s.payload.previous_signature_key_id !== prev.key_id) return brk(day, "previous_key_mismatch");
    }
    prev = s;
  }
  return { ok: true, checked, unsigned, firstBreak: null };
};
