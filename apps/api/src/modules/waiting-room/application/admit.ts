import { mayAdmit } from "../domain/bridge";
import { QueueUnavailableError, type SwitchKey } from "../domain/ports";
import { admissionWindow } from "./admission";
import type { WaitingRoomDeps } from "./shared";

export interface AdmitReport {
  readonly dropId: string;
  readonly admitted: number;
  readonly abandoned: number;
  readonly rejected: number;
  readonly paused: boolean;
}

interface Pacing {
  lastMs: number;
  carry: number;
}
interface Pending {
  readonly dropId: string;
  readonly ticketId: string;
  readonly expiresAtMs: number;
}

/**
 * Sweeper: runs every second per drop. Admits at `admit_per_sec` (fractional carry, bounded burst),
 * strictly FIFO, re-checks the Plus entitlement during early access, expires stale heartbeats.
 * Idempotent: a repeated tick with no elapsed time admits nobody.
 */
export class AdmitFromQueue {
  private readonly pacing = new Map<string, Pacing>();
  private pending: Pending[] = [];

  constructor(private readonly d: WaitingRoomDeps) {}

  async runAll(): Promise<readonly AdmitReport[]> {
    const out: AdmitReport[] = [];
    for (const id of await this.d.gate.activeDropIds()) out.push(await this.run(id));
    return out;
  }

  async run(dropId: string): Promise<AdmitReport> {
    const { gate, queue, store, switches, entitlements, clock, ids, cfg } = this.d;
    const none = (paused: boolean): AdmitReport => ({ dropId, admitted: 0, abandoned: 0, rejected: 0, paused });
    const now = clock.nowMs();
    const drop = await gate.get(dropId);
    if (drop === null) return none(true);
    try {
      await this.releaseExpired(now);
      let abandoned = 0;
      for (const t of await queue.expire(dropId, now)) {
        abandoned++;
        await store.recordEnded(
          { ticketId: t.id, dropId, userId: t.userId, deviceHash: t.deviceHash, joinedAtMs: t.joinedAtMs, state: "abandoned", atMs: now },
          [{ type: "queue.abandoned", dropId, ticketId: t.id, reason: "heartbeat" }],
        );
      }
      const keys: SwitchKey[] = ["drops_all", "waiting_room", `drop_type_${drop.type}`];
      if (drop.type === "mystery_box") keys.push("mystery_box");
      for (const k of keys) if (!(await switches.allowed(k))) return { ...none(true), abandoned };
      if (!mayAdmit(drop)) {
        this.pacing.delete(dropId);
        return { ...none(true), abandoned };
      }

      const p = this.pacing.get(dropId) ?? { lastMs: now - 1000, carry: 0 };
      const budget = Math.min(
        drop.admitPerSec * cfg.maxBurstSeconds,
        p.carry + (drop.admitPerSec * Math.max(0, now - p.lastMs)) / 1000,
      );
      const n = Math.floor(budget);
      this.pacing.set(dropId, { lastMs: now, carry: budget - n });
      if (n < 1) return { ...none(false), abandoned };

      let rejected = 0;
      if (drop.state === "EARLY_ACCESS") {
        // Plus lapse during early access is re-checked at admission, not only at join.
        for (let round = 0; round < 5; round++) {
          let lapsed = 0;
          for (const t of await queue.peek(dropId, n)) {
            if (await entitlements.hasEarlyAccess(t.userId)) continue;
            lapsed++;
            if ((await queue.reject(dropId, t.id, now)) !== null) {
              await store.recordEnded(
                { ticketId: t.id, dropId, userId: t.userId, deviceHash: t.deviceHash, joinedAtMs: t.joinedAtMs, state: "rejected", atMs: now },
                [{ type: "queue.abandoned", dropId, ticketId: t.id, reason: "rejected" }],
              );
            }
          }
          rejected += lapsed;
          if (lapsed === 0) break;
        }
      }

      const admitted = await queue.admit(dropId, n, now);
      const w = admissionWindow(now);
      for (const t of admitted) {
        const jti = ids.uuidV7();
        await store.recordAdmission(
          {
            jti,
            ticketId: t.id,
            dropId,
            userId: t.userId,
            deviceHash: t.deviceHash,
            joinedAtMs: t.joinedAtMs,
            issuedAtMs: w.issuedAtMs,
            expiresAtMs: w.expiresAtMs,
            usedAtMs: null,
          },
          [{ type: "queue.admitted", dropId, ticketId: t.id, waitedMs: Math.max(0, now - t.joinedAtMs) }],
        );
        this.pending.push({ dropId, ticketId: t.id, expiresAtMs: w.expiresAtMs });
      }
      return { dropId, admitted: admitted.length, abandoned, rejected, paused: false };
    } catch (e) {
      if (e instanceof QueueUnavailableError) return none(true); // Redis down: drops pause, nothing else changes
      throw e;
    }
  }

  /** After the token window the account and device may queue again (back of the line). */
  private async releaseExpired(now: number): Promise<void> {
    const keep: Pending[] = [];
    for (const p of this.pending) {
      if (now >= p.expiresAtMs) await this.d.queue.finish(p.dropId, p.ticketId);
      else keep.push(p);
    }
    this.pending = keep;
  }
}
