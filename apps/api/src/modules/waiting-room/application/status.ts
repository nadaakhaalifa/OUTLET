import { QueueUnavailableError } from "../domain/ports";
import { mintToken } from "./admission";
import type { WaitingRoomDeps } from "./shared";

export type StatusOutcome =
  | { readonly kind: "waiting"; readonly position: number; readonly etaSeconds: number }
  | { readonly kind: "admitted"; readonly token: string; readonly expiresAtMs: number }
  /** Not in the queue (never joined, left, expired or rejected). The caller rejoins at the back. */
  | { readonly kind: "not_queued"; readonly admissionExpired: boolean }
  | { readonly kind: "not_found" }
  | { readonly kind: "paused" };

export class QueueStatus {
  constructor(private readonly d: WaitingRoomDeps) {}

  async execute(i: { readonly userId: string; readonly dropId: string }): Promise<StatusOutcome> {
    const { gate, queue, store, secrets, codec, clock } = this.d;
    const drop = await gate.get(i.dropId);
    if (drop === null) return { kind: "not_found" };
    const now = clock.nowMs();

    // The token is stateless to verify, so an admitted user is served from Postgres even when
    // Redis is down: the user can still buy.
    const admission = await store.latestAdmission(i.dropId, i.userId);
    if (admission !== null && now < admission.expiresAtMs && admission.usedAtMs === null) {
      return { kind: "admitted", token: await mintToken(secrets, codec, admission), expiresAtMs: admission.expiresAtMs };
    }
    let hb;
    try {
      hb = await queue.heartbeat(i.dropId, i.userId, now);
    } catch (e) {
      if (e instanceof QueueUnavailableError) return { kind: "paused" };
      throw e;
    }
    if (hb !== null && hb.ticket.state === "waiting" && hb.position !== null) {
      return { kind: "waiting", position: hb.position, etaSeconds: Math.ceil(hb.position / Math.max(1, drop.admitPerSec)) };
    }
    return { kind: "not_queued", admissionExpired: admission !== null && now >= admission.expiresAtMs };
  }
}
