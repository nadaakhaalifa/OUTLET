import { createTestDatabaseUpTo } from "@outlet/db";
import { afterAll, describe, expect, it } from "vitest";
import { createPgliteDatabase, type PgliteInstance } from "../../../platform/db";
import { KyselyConsentRepository, type PrivacyDb } from "../../privacy";
import { FakeAttestationCheck, FakeKeyer, InMemoryPlausibilityStore, RecordingCounters, StaticGate, StaticVocabulary } from "../adapters/in-memory";
import { KyselyBatchOutbox, KyselyConsentReader, type IngestDb } from "../adapters/kysely-store";
import { IngestAnalyticsBatch } from "../application/ingest-batch";
import { SHOPPER, T0, batch, viewEvent } from "./harness";

const open: { destroy(): Promise<void> }[] = [];
afterAll(async () => {
  await Promise.all(open.map((d) => d.destroy()));
});

async function setup() {
  const raw = await createTestDatabaseUpTo(11);
  const db: IngestDb = createPgliteDatabase<Record<string, never>>(raw as unknown as PgliteInstance);
  open.push(db);
  await raw.query(`insert into users (id, status) values ($1, 'active')`, [SHOPPER]);
  const consents = new KyselyConsentRepository(db as unknown as PrivacyDb);
  const setConsent = (granted: boolean, atMs: number) =>
    consents.append([{ userId: SHOPPER, purpose: "analytics", version: 1, granted, method: "settings_toggle", at: new Date(atMs).toISOString(), ipHash: "0".repeat(16) }], []);
  const uc = new IngestAnalyticsBatch({
    gate: new StaticGate(true),
    attestation: new FakeAttestationCheck(),
    consent: new KyselyConsentReader(db),
    store: new InMemoryPlausibilityStore(() => T0),
    outbox: new KyselyBatchOutbox(db),
    keyer: new FakeKeyer(),
    vocabulary: new StaticVocabulary(new Set()),
    counters: new RecordingCounters(),
    dedupeKey: new Uint8Array(32).fill(9),
  });
  const rows = async () => (await raw.query<{ t: string; p: Record<string, unknown> }>(`select event_type as t, payload as p from outbox_events`)).rows;
  let n = 0;
  const send = (events = [viewEvent((n += 1), T0 - 1000, "feed", `00000000-0000-4000-b000-${String(n).padStart(12, "0")}`)]) =>
    uc.execute({ userId: SHOPPER, attestation: { platform: "ios", token: "ok:d" }, body: batch(T0, events), nowMs: T0, batchId: `00000000-0000-4000-8000-${String(900 + n).padStart(12, "0")}` });
  return { setConsent, send, rows };
}

describe("ingest against the real consent projection and outbox (PGlite)", () => {
  it("no consent row means not consented: accepted 0 and no outbox row", async () => {
    const s = await setup();
    expect(await s.send()).toEqual({ accepted: 0, duplicates: 0, rejected: 0 });
    expect(await s.rows()).toEqual([]);
  });

  it("M4: grant, accept, withdraw through the privacy consent repository, and the very next batch is accepted 0", async () => {
    const s = await setup();
    await s.setConsent(true, T0 - 10_000);
    expect((await s.send()).accepted).toBe(1);
    const rows = await s.rows();
    expect(rows.map((r) => r.t)).toEqual(["analytics.client_batch"]);
    expect(JSON.stringify(rows)).not.toContain(SHOPPER);
    await s.setConsent(false, T0 - 500);
    expect((await s.send()).accepted).toBe(0);
    expect(await s.rows()).toHaveLength(1);
    await s.setConsent(true, T0 - 100); // a later re-grant applies at once too
    expect((await s.send()).accepted).toBe(1);
    expect(await s.rows()).toHaveLength(2);
  });
});
