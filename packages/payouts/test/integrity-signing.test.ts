import { HmacSnapshotSigner, verifySnapshotChain } from "@outlet/ledger";
import type { SignedSnapshot } from "@outlet/ledger";
import { describe, expect, it } from "vitest";
import { IntegrityJob } from "../src/index.js";
import { buildWorld } from "./fixtures.js";

const D1 = new Date("2030-01-10T01:00:00.000Z");
const D2 = new Date("2030-01-11T01:00:00.000Z");
const D3 = new Date("2030-01-12T01:00:00.000Z");
const KEY = new Uint8Array(32).fill(11);
const KEY_B64 = Buffer.from(KEY).toString("base64");

describe("IntegrityJob signed, chained snapshots", () => {
  it("signs each day, chains it to the previous run, never stores the key, and the weekly pass verifies the chain", async () => {
    const w = await buildWorld();
    try {
      const store = await w.newStore();
      await w.post("store_credit_granted", `sg:${store}`, [["goodwill_expense", 700n], ["store_credit", -700n, store, "goodwill"]]);
      const signer = new HmacSnapshotSigner(KEY, "hmac-1");
      const job = new IntegrityJob({ client: w.worker, currency: "EGP", now: () => D1, signer });
      await job.run("EG", D1);
      await job.run("EG", D2);
      await job.run("EG", D3, "2030-01-12", { full: true });
      const rows = (await w.raw.query<{ details: Record<string, unknown> & { snapshot: SignedSnapshot } }>("SELECT details FROM reconciliation_runs WHERE source = 'ledger_integrity' ORDER BY business_date")).rows;
      const snaps = rows.map((r) => r.details.snapshot);
      expect(snaps.map((s) => [s.signed, s.key_id])).toEqual([[true, "hmac-1"], [true, "hmac-1"], [true, "hmac-1"]]);
      expect(snaps[0]?.previous_digest).toBeNull();
      expect(snaps[1]?.previous_digest).toBe(snaps[0]?.digest);
      expect(snaps[2]?.previous_digest).toBe(snaps[1]?.digest);
      expect(rows[2]?.details.snapshot_chain_ok).toBe(true);
      expect(rows[0]?.details.snapshot_chain_ok).toBeUndefined();
      expect((await verifySnapshotChain(snaps, signer)).ok).toBe(true);
      const all = JSON.stringify(rows);
      expect(all).not.toContain(KEY_B64);
      expect(all).not.toContain(Buffer.from(KEY).toString("hex"));
    } finally {
      await w.close();
    }
  });

  it("a tampered stored run breaks the chain and the weekly pass reports it", async () => {
    const w = await buildWorld();
    try {
      const store = await w.newStore();
      await w.post("store_credit_granted", `tp:${store}`, [["goodwill_expense", 700n], ["store_credit", -700n, store, "goodwill"]]);
      const warns: string[] = [];
      const job = new IntegrityJob({ client: w.worker, currency: "EGP", now: () => D1, signer: new HmacSnapshotSigner(KEY, "hmac-1"), warn: (e) => warns.push(e) });
      await job.run("EG", D1);
      await job.run("EG", D2);
      await w.raw.query("UPDATE reconciliation_runs SET details = jsonb_set(details, '{snapshot,payload,verified_through_seq}', '\"99\"') WHERE business_date = '2030-01-10'");
      await job.run("EG", D3, "2030-01-12", { full: true });
      const d = (await w.raw.query<{ details: { snapshot_chain_ok: boolean; snapshot_chain_break: string } }>("SELECT details FROM reconciliation_runs WHERE business_date = '2030-01-12'")).rows[0]?.details;
      expect(d).toMatchObject({ snapshot_chain_ok: false, snapshot_chain_break: "2030-01-10:digest_mismatch" });
      expect(warns).toContain("ledger_snapshot_chain_broken");
    } finally {
      await w.close();
    }
  });

  it("without a signer the run is stored unsigned (signature null) and warns, still chained by digest", async () => {
    const w = await buildWorld();
    try {
      const store = await w.newStore();
      await w.post("store_credit_granted", `us:${store}`, [["goodwill_expense", 700n], ["store_credit", -700n, store, "goodwill"]]);
      const warns: { e: string; f: Record<string, unknown> }[] = [];
      const job = new IntegrityJob({ client: w.worker, currency: "EGP", now: () => D1, warn: (e, f) => warns.push({ e, f }) });
      await job.run("EG", D1);
      await job.run("EG", D2);
      const snaps = (await w.raw.query<{ details: { snapshot: SignedSnapshot } }>("SELECT details FROM reconciliation_runs ORDER BY business_date")).rows.map((r) => r.details.snapshot);
      expect(snaps.map((s) => [s.signature, s.signed, s.key_id])).toEqual([[null, false, null], [null, false, null]]);
      expect(snaps[1]?.previous_digest).toBe(snaps[0]?.digest);
      expect(warns.map((x) => x.e)).toEqual(["ledger_snapshot_unsigned", "ledger_snapshot_unsigned"]);
      expect(warns[0]?.f).toMatchObject({ reason: "unconfigured", market_id: "EG" });
    } finally {
      await w.close();
    }
  });
});
