import { decideBot, joinVerdict } from "../domain/bridge";
import { QueueUnavailableError, type SwitchKey } from "../domain/ports";
import { deviceHash, type WaitingRoomDeps } from "./shared";

export interface JoinInput {
  readonly userId: string;
  readonly dropId: string;
  readonly deviceId: string;
  readonly attestToken: string | null;
}

export type JoinOutcome =
  | { readonly kind: "queued"; readonly ticketId: string; readonly position: number | null; readonly state: "waiting" | "admitted"; readonly resumed: boolean }
  | { readonly kind: "not_found" }
  /** Kill switch, pause, or the queue backend is down: the room fails closed. */
  | { readonly kind: "paused"; readonly reason: "kill_switch" | "drop_paused" | "queue_unavailable" }
  | { readonly kind: "refused"; readonly code: "not_open" | "closed" | "sold_out" | "plus_required" }
  | { readonly kind: "attestation_failed" }
  | { readonly kind: "bot_blocked" }
  | { readonly kind: "challenge_required" }
  | { readonly kind: "device_busy" };

export class JoinQueue {
  constructor(private readonly d: WaitingRoomDeps) {}

  async execute(i: JoinInput): Promise<JoinOutcome> {
    const { gate, queue, store, switches, entitlements, attest, bot, clock, ids, cfg } = this.d;
    const drop = await gate.get(i.dropId);
    if (drop === null) return { kind: "not_found" };

    const keys: SwitchKey[] = ["drops_all", "waiting_room", `drop_type_${drop.type}`];
    if (drop.type === "mystery_box") keys.push("mystery_box");
    for (const k of keys) if (!(await switches.allowed(k))) return { kind: "paused", reason: "kill_switch" };

    const now = clock.nowMs();
    const early = await entitlements.hasEarlyAccess(i.userId);
    const verdict = joinVerdict(drop, now, early, cfg.preQueueMs);
    if (!verdict.ok) {
      if (verdict.code === "paused") return { kind: "paused", reason: "drop_paused" };
      return { kind: "refused", code: verdict.code };
    }
    // Pre-filter only: a stale "sold out" is refused here, but inventory decides purchases.
    if (drop.soldOutHint) return { kind: "refused", code: "sold_out" };

    if (cfg.requireAttest && !(await attest.verify(i.deviceId, i.attestToken))) return { kind: "attestation_failed" };

    const dev = deviceHash(i.deviceId);
    let decision: "allow" | "challenge" | "block";
    try {
      decision = decideBot(await bot.score({ userId: i.userId, deviceHash: dev }), cfg.bot);
    } catch {
      decision = "block"; // scoring unavailable fails closed
    }
    if (decision === "block") return { kind: "bot_blocked" };
    if (decision === "challenge") return { kind: "challenge_required" };

    try {
      const ticketId = ids.uuidV7();
      const r = await queue.join(i.dropId, ticketId, i.userId, dev, now);
      if (r.kind === "device_busy") return { kind: "device_busy" };
      if (r.kind === "existing") {
        const hb = await queue.heartbeat(i.dropId, i.userId, now);
        return {
          kind: "queued",
          ticketId: r.ticket.id,
          position: hb?.position ?? null,
          state: r.ticket.state === "admitted" ? "admitted" : "waiting",
          resumed: true,
        };
      }
      await store.recordJoined(i.dropId, r.ticket.id, [{ type: "queue.joined", dropId: i.dropId, ticketId: r.ticket.id }]);
      return { kind: "queued", ticketId: r.ticket.id, position: await queue.size(i.dropId), state: "waiting", resumed: false };
    } catch (e) {
      if (e instanceof QueueUnavailableError) return { kind: "paused", reason: "queue_unavailable" };
      throw e;
    }
  }
}
