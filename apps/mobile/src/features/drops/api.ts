import { ApiError, dataOf, type schemas } from "../../services/api-client";
import { guard, ms, pick, toPortError, type AdapterContext } from "../../services/wire";
import type { DropSnapshot, DropsPort, DropState, DropType, QueueStatus, RejectReason } from "./model";

const TYPE: Readonly<Record<schemas.PublicDropDetail["type"], DropType>> = {
  public: "public", members_only: "members", flash_hour: "flash", mystery_box: "mystery", price_ladder: "ladder", last_chance: "lastChance",
};
const POLL_MS = 2_000;

function stateOf(d: schemas.PublicDropDetail): DropState {
  if (d.paused) return "paused";
  const s = d.state.toLowerCase().replace(/[_\s-]/g, "");
  switch (s) {
    case "earlyaccess": return "earlyAccess";
    case "live": return "live";
    case "soldout": return "soldOut";
    case "ended": case "archived": return "ended";
    default: return "scheduled";
  }
}

function rejection(e: ApiError): RejectReason | null {
  const c = `${e.code ?? ""} ${e.problem.type}`;
  if (c.includes("limit")) return "perUserLimit";
  if (c.includes("member")) return "membersOnly";
  if (c.includes("sold")) return "soldOut";
  if (c.includes("paused")) return "paused";
  if (c.includes("not-live") || c.includes("not_live") || c.includes("not-started")) return "notLive";
  if (c.includes("age")) return "underAge";
  return null;
}

/** /v1/drops/*. The poll interval is not on the wire (gap): 2 s. The server clock comes from `server_time`. */
export class ApiDropsPort implements DropsPort {
  constructor(private readonly ctx: AdapterContext) {}

  getDrop(id: string): Promise<DropSnapshot | null> {
    return guard(async () => {
      try {
        const d = dataOf(await this.ctx.client.getPublicDrop({ path: { id } }));
        const store = dataOf(await this.ctx.client.getStore({ path: { storeId: d.store_id } }));
        return {
          id: d.id,
          title: d.title,
          storeName: pick(store.name, this.ctx.locale()),
          type: TYPE[d.type],
          state: stateOf(d),
          startsAtMs: ms(d.starts_at),
          earlyAccessAtMs: d.early_access_at !== null ? ms(d.early_access_at) : null,
          endsAtMs: ms(d.ends_at),
          perUserLimit: d.limits.per_user,
          remainingStock: d.social_proof.remaining,
          serverNowMs: ms(d.server_time),
        };
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) return null;
        throw e;
      }
    });
  }

  async join(id: string, idempotencyKey: string): Promise<QueueStatus> {
    try {
      const j = dataOf(await this.ctx.client.joinDropQueue({ path: { dropId: id }, headers: { "X-Device-Id": await this.ctx.deviceId() } }, { idempotencyKey }));
      if (j.state === "admitted") return this.status(id);
      return { state: "waiting", position: j.position, etaSeconds: null, pollAfterMs: POLL_MS };
    } catch (e) {
      if (e instanceof ApiError) {
        const reason = rejection(e);
        if (reason !== null) return { state: "rejected", reason };
      }
      throw toPortError(e);
    }
  }

  status(id: string): Promise<QueueStatus> {
    return guard(async () => {
      const s = dataOf(await this.ctx.client.getDropQueueStatus({ path: { dropId: id } }));
      if (s.state === "admitted" && s.admission_token !== undefined && s.expires_at !== undefined) {
        return { state: "admitted", token: { value: s.admission_token, expiresAtMs: ms(s.expires_at) }, serverNowMs: this.ctx.nowMs() };
      }
      if (s.state === "waiting") return { state: "waiting", position: s.position ?? null, etaSeconds: s.eta_seconds ?? null, pollAfterMs: POLL_MS };
      return s.admission_expired === true ? { state: "expired" } : { state: "idle" };
    });
  }

  /** There is no leave-queue operation (gap): leaving is local; the server ticket simply expires. */
  async leave(_id: string): Promise<void> {
    return undefined;
  }

  waitlist(id: string, idempotencyKey: string): Promise<void> {
    return guard(async () => {
      dataOf(await this.ctx.client.joinDropWaitlist({ path: { id } }, { idempotencyKey }));
    });
  }
}
