import { describe, expect, it } from "vitest";
import { createIdGenerator, nodeCsprng } from "../../platform";
import {
  AdmitFromQueue,
  AdmissionVerifier,
  DEFAULT_WAITING_ROOM_CONFIG,
  FakeAttestation,
  FakeBotScore,
  FakeEntitlements,
  FakeSecrets,
  FakeSwitches,
  InMemoryAdmissionStore,
  InMemoryQueue,
  JoinQueue,
  QueueStatus,
  type AdmissionRecord,
  type WaitingRoomDeps,
  type WaitingRoomEvent,
  jwtAdmissionCodec,
} from "../waiting-room";
import {
  AdvanceDrops,
  ClaimDropUnits,
  DEFAULT_DROPS_CONFIG,
  DropGate,
  FakeDropSwitches,
  FakeSocialSignals,
  InMemoryDropInventory,
  InMemoryDropStore,
  InMemorySoldOutFlags,
  ReleaseDropUnits,
  ReserveDropUnits,
  type DropDeps,
} from "./index";
import { drops } from "@outlet/domain";

const { fifoDeviation } = drops;

const T0 = 1_800_000_000_000;
const U = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const DROP_ID = U(1);
const SKU = U(7001);

/** Seeded PRNG so the simulation is reproducible (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class RecordingRoomStore extends InMemoryAdmissionStore {
  readonly fresh: AdmissionRecord[] = [];
  override async recordAdmission(r: AdmissionRecord, events: readonly WaitingRoomEvent[]): Promise<void> {
    const had = this.admissions.has(r.jti);
    await super.recordAdmission(r, events);
    if (!had) this.fresh.push(r);
  }
}

function shuffle<T>(a: T[], r: () => number): T[] {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [a[i], a[j]] = [a[j] as T, a[i] as T];
  }
  return a;
}

describe("drop load simulation (spec 16 acceptance, k6 shape, deterministic)", () => {
  it("50k virtual users on a 500-unit drop: zero oversell, <= 500 claimed, FIFO within 1%", async () => {
    const USERS = 50_000;
    const UNITS = 500;
    const clock = { ms: T0, nowMs() { return this.ms; } };
    const ids = createIdGenerator(clock, nodeCsprng);
    const rand = rng(20261011);

    const dropStore = new InMemoryDropStore();
    const inventory = new InMemoryDropInventory();
    const flags = new InMemorySoldOutFlags(() => clock.nowMs());
    const room = new RecordingRoomStore();
    const secrets = new FakeSecrets();
    const verifier = new AdmissionVerifier(secrets, room, clock, jwtAdmissionCodec);
    const gate = new DropGate(dropStore, flags, clock, DEFAULT_DROPS_CONFIG.preQueueMs);
    const queue = new InMemoryQueue();

    await dropStore.insert(
      {
        id: DROP_ID,
        storeId: U(9001),
        type: "public",
        state: "LIVE",
        title: "Grand opening mega drop",
        startsAtMs: T0 - 1000,
        earlyAccessAtMs: null,
        endsAtMs: T0 + 3_600_000,
        items: [{ skuId: SKU, stockCap: UNITS, pricePiastres: 99_900n }],
        limits: { perUser: 1, perDevice: 1 },
        ladder: [],
        mystery: null,
        admitPerSec: 200,
        paused: false,
        createdAtMs: T0 - 10_000,
        updatedAtMs: T0 - 10_000,
        version: 1,
      },
      [],
    );
    await inventory.setCap(DROP_ID, SKU, UNITS);

    const roomDeps: WaitingRoomDeps = {
      queue,
      gate,
      store: room,
      codec: jwtAdmissionCodec,
      secrets,
      bot: new FakeBotScore(),
      attest: new FakeAttestation(),
      entitlements: new FakeEntitlements(),
      switches: new FakeSwitches(),
      clock,
      ids,
      cfg: DEFAULT_WAITING_ROOM_CONFIG,
    };
    const dropDeps: DropDeps = {
      store: dropStore,
      inventory,
      flags,
      signals: new FakeSocialSignals(),
      switches: new FakeDropSwitches(),
      verifier,
      clock,
      ids,
      cfg: DEFAULT_DROPS_CONFIG,
    };
    const join = new JoinQueue(roomDeps);
    const admit = new AdmitFromQueue(roomDeps);
    const status = new QueueStatus(roomDeps);
    const reserve = new ReserveDropUnits(dropDeps);
    const release = new ReleaseDropUnits(dropDeps);
    const claim = new ClaimDropUnits(dropDeps);
    const advance = new AdvanceDrops(dropDeps);

    const joinIndex = new Map<string, number>(); // user id -> arrival order
    const waiting = new Set<string>();
    const outcomes = { claimed: 0, released: 0, abandoned: 0, soldOut: 0, other: 0 };
    let arrivals = 0;
    const order = shuffle(Array.from({ length: USERS }, (_, i) => i + 10), rand);
    const admissionOrder: number[] = [];

    for (let tick = 0; tick < 400; tick++) {
      // Arrivals: the whole crowd hits the room at the opening second (a flash drop).
      if (tick === 0) {
        for (let k = 0; k < USERS; k++) {
          const n = order[arrivals++];
          if (n === undefined) break;
          const r = await join.execute({ userId: U(n), dropId: DROP_ID, deviceId: `device-${n}-abcdefgh`, attestToken: "attest" });
          if (r.kind === "queued") {
            joinIndex.set(U(n), joinIndex.size);
            waiting.add(U(n));
          }
        }
      }
      // Heartbeats keep waiting users in the queue (30 s TTL, 1 s ticks).
      const now = clock.nowMs();
      if (!(await queue.size(DROP_ID).then((s) => s === 0))) {
        for (const u of waiting) await queue.heartbeat(DROP_ID, u, now);
      }

      await admit.run(DROP_ID);
      const admitted = room.fresh.splice(0);
      for (const a of admitted) {
        waiting.delete(a.userId);
        const idx = joinIndex.get(a.userId);
        if (idx !== undefined) admissionOrder.push(idx);
      }

      // Admitted shoppers act concurrently: most buy, some pay and fail, some wander off.
      await Promise.all(
        shuffle([...admitted], rand).map(async (a) => {
          const roll = rand();
          if (roll < 0.15) {
            outcomes.abandoned++;
            return;
          }
          const s = await status.execute({ userId: a.userId, dropId: DROP_ID });
          if (s.kind !== "admitted") {
            outcomes.other++;
            return;
          }
          const n = Number(a.userId.slice(-12));
          const r = await reserve.execute({
            dropId: DROP_ID,
            userId: a.userId,
            deviceId: `device-${n}-abcdefgh`,
            admissionToken: s.token,
            lines: [{ skuId: SKU, qty: 1 }],
          });
          if (r.kind === "sold_out") {
            outcomes.soldOut++;
            return;
          }
          if (r.kind !== "reserved") {
            outcomes.other++;
            return;
          }
          const line = r.lines[0];
          if (line === undefined) return;
          if (roll < 0.25) {
            await release.execute(line.reservationId); // payment failed
            outcomes.released++;
          } else {
            await claim.execute(line.reservationId, DROP_ID);
            outcomes.claimed++;
          }
        }),
      );

      clock.ms += 1000;
      await advance.run();
      if ((await dropStore.get(DROP_ID))?.state === "SOLD_OUT") break;
    }

    expect(joinIndex.size).toBe(USERS);
    const snap = await inventory.snapshot(DROP_ID, SKU);
    const final = await dropStore.get(DROP_ID);

    // zero oversell, never more than the stock cap claimed
    expect(snap.claimed).toBeLessThanOrEqual(UNITS);
    expect(snap.claimed + snap.reserved).toBeLessThanOrEqual(UNITS);
    expect(snap.claimed).toBe(UNITS);
    expect(inventory.claimedLog).toHaveLength(snap.claimed);
    expect(new Set(inventory.claimedLog).size).toBe(inventory.claimedLog.length);
    expect(outcomes.claimed).toBe(snap.claimed);
    expect(final?.state).toBe("SOLD_OUT");

    // every admission is unique and belongs to exactly one account
    const jtis = new Set<string>();
    const users = new Set<string>();
    for (const a of room.admissions.values()) {
      expect(jtis.has(a.jti)).toBe(false);
      jtis.add(a.jti);
      expect(users.has(a.userId)).toBe(false);
      users.add(a.userId);
    }
    // limits held: one unit per user
    for (const a of room.admissions.values()) {
      expect((await dropStore.purchased(DROP_ID, SKU, a.userId, "x")).byUser).toBeLessThanOrEqual(1);
    }
    // FIFO: admission order follows arrival order within 1%
    expect(admissionOrder.length).toBeGreaterThanOrEqual(UNITS);
    expect(fifoDeviation(admissionOrder)).toBeLessThanOrEqual(0.01);
    // the sold-out pre-filter is a hint, and the room refuses new joins after sold out
    const late = await join.execute({ userId: U(USERS + 100), dropId: DROP_ID, deviceId: "device-late-abcdefgh", attestToken: "a" });
    expect(late).toEqual({ kind: "refused", code: "sold_out" });
    expect(outcomes.other).toBe(0);
  }, 120_000);
});
