import { describe, expect, it } from "vitest";
import { HmacSnapshotSigner, UnconfiguredSnapshotSigner, buildSnapshot, snapshotSignerFromEnv, verifySnapshotChain } from "../src/index.js";
import type { SignedSnapshot, SnapshotPayload } from "../src/index.js";

const key = (n: number): Uint8Array => new Uint8Array(32).fill(n);
const signer = (id = "k1", n = 7): HmacSnapshotSigner => new HmacSnapshotSigner(key(n), id);
const payload = (day: string, prev: SignedSnapshot | null): SnapshotPayload => ({
  market: "EG", day, totals: { EGP: "0", USD: "0" }, chain_head: "a".repeat(64), verified_through_seq: "10",
  previous_snapshot_digest: prev?.digest ?? null, previous_signature_key_id: prev?.key_id ?? null,
});
const chain = async (n: number, s = signer()): Promise<SignedSnapshot[]> => {
  const out: SignedSnapshot[] = [];
  for (let i = 0; i < n; i += 1) out.push(await buildSnapshot(payload(`2030-01-0${String(i + 1)}`, out[i - 1] ?? null), s));
  return out;
};

describe("snapshot signing", () => {
  it("round trips and a chain verifies", async () => {
    const c = await chain(4);
    expect(c[0]?.signed).toBe(true);
    expect(c[1]?.previous_digest).toBe(c[0]?.digest);
    expect(await verifySnapshotChain(c, signer())).toEqual({ ok: true, checked: 4, unsigned: 0, firstBreak: null });
  });

  it.each([
    ["market", (p: SnapshotPayload) => ({ ...p, market: "SA" })],
    ["day", (p: SnapshotPayload) => ({ ...p, day: "2031-01-01" })],
    ["totals", (p: SnapshotPayload) => ({ ...p, totals: { ...p.totals, EGP: "1" } })],
    ["chain_head", (p: SnapshotPayload) => ({ ...p, chain_head: "b".repeat(64) })],
    ["verified_through_seq", (p: SnapshotPayload) => ({ ...p, verified_through_seq: "11" })],
    ["previous_snapshot_digest", (p: SnapshotPayload) => ({ ...p, previous_snapshot_digest: "c".repeat(64) })],
    ["previous_signature_key_id", (p: SnapshotPayload) => ({ ...p, previous_signature_key_id: "zz" })],
  ])("tampering with %s is detected", async (_n, mutate) => {
    const c = await chain(3);
    const mid = c[1]!;
    const bad = [c[0]!, { ...mid, payload: mutate(mid.payload) }, c[2]!];
    const r = await verifySnapshotChain(bad, signer());
    expect(r.ok).toBe(false);
    expect(r.firstBreak?.reason).toBe("digest_mismatch");
  });

  it("a recomputed digest without the key fails the signature; a swapped digest fails the digest check", async () => {
    const c = await chain(2);
    const forged = await buildSnapshot({ ...(c[1]!).payload, totals: { EGP: "5" } }, signer("k1", 9));
    expect((await verifySnapshotChain([c[0]!, forged], signer())).firstBreak?.reason).toBe("signature_invalid");
    expect((await verifySnapshotChain([{ ...(c[0]!), digest: "d".repeat(64) }], signer())).firstBreak?.reason).toBe("digest_mismatch");
  });

  it("detects a chain break (removed or replaced predecessor)", async () => {
    const c = await chain(4);
    expect((await verifySnapshotChain([c[0]!, c[2]!, c[3]!], signer())).firstBreak).toEqual({ day: "2030-01-03", reason: "previous_digest_mismatch" });
    const other = await buildSnapshot({ ...payload("2030-01-02", c[0] ?? null), totals: { EGP: "0", USD: "1" } }, signer());
    const r = await verifySnapshotChain([c[0]!, other, c[2]!], signer());
    expect(r.firstBreak).toEqual({ day: "2030-01-03", reason: "previous_digest_mismatch" });
  });

  it("key rotation: a set of verifiers accepts old and new key ids; an unknown key is a break", async () => {
    const old = await chain(2, signer("k1", 1));
    const next = await buildSnapshot(payload("2030-01-03", old[1] ?? null), signer("k2", 2));
    const all = [...old, next];
    expect((await verifySnapshotChain(all, [signer("k1", 1), signer("k2", 2)])).ok).toBe(true);
    expect((await verifySnapshotChain(all, signer("k2", 2))).firstBreak?.reason).toBe("unknown_key");
    const swapped = { ...next, payload: { ...next.payload, previous_signature_key_id: "k9" } };
    expect((await verifySnapshotChain([old[0]!, old[1]!, swapped], [signer("k1", 1), signer("k2", 2)])).ok).toBe(false);
  });

  it("the unconfigured signer yields an unsigned snapshot with a reason, never a signature", async () => {
    const reasons: string[] = [];
    const s = await buildSnapshot(payload("2030-01-01", null), new UnconfiguredSnapshotSigner(), (r) => reasons.push(r));
    expect(s).toMatchObject({ signature: null, signed: false, key_id: null });
    expect(reasons).toEqual(["unconfigured"]);
    const r = await verifySnapshotChain([s], new UnconfiguredSnapshotSigner());
    expect(r).toMatchObject({ ok: true, unsigned: 1 });
    expect((await verifySnapshotChain([s], new UnconfiguredSnapshotSigner(), { requireSigned: true })).firstBreak?.reason).toBe("unsigned");
  });

  it("env parsing: unset is unconfigured, partial / bad base64 / short key / bad id throw without echoing the key", () => {
    expect(snapshotSignerFromEnv({})).toBeInstanceOf(UnconfiguredSnapshotSigner);
    const good = Buffer.alloc(32, 3).toString("base64");
    expect(snapshotSignerFromEnv({ LEDGER_SNAPSHOT_HMAC_KEY: good, LEDGER_SNAPSHOT_KEY_ID: "k1" }).keyId()).toBe("k1");
    expect(() => snapshotSignerFromEnv({ LEDGER_SNAPSHOT_HMAC_KEY: good })).toThrow(/together/);
    expect(() => snapshotSignerFromEnv({ LEDGER_SNAPSHOT_KEY_ID: "k1" })).toThrow(/together/);
    expect(() => snapshotSignerFromEnv({ LEDGER_SNAPSHOT_HMAC_KEY: "not base64!!", LEDGER_SNAPSHOT_KEY_ID: "k1" })).toThrow(/base64/);
    const shortKey = Buffer.alloc(8, 1).toString("base64");
    try { snapshotSignerFromEnv({ LEDGER_SNAPSHOT_HMAC_KEY: shortKey, LEDGER_SNAPSHOT_KEY_ID: "k1" }); expect.unreachable(); } catch (e) { expect(String(e)).not.toContain(shortKey); }
    expect(() => snapshotSignerFromEnv({ LEDGER_SNAPSHOT_HMAC_KEY: good, LEDGER_SNAPSHOT_KEY_ID: "bad id" })).toThrow(/key id/);
  });

  it("the key never appears in the stored snapshot", async () => {
    const k = Buffer.alloc(32, 5);
    const s = await buildSnapshot(payload("2030-01-01", null), new HmacSnapshotSigner(k, "k1"));
    const json = JSON.stringify(s);
    expect(json).not.toContain(k.toString("base64"));
    expect(json).not.toContain(k.toString("hex"));
  });
});
