import { z } from "zod";
import type { ChannelProvider, ProviderMessage, ProviderResult } from "../../../modules/notifications";
import { call, parseOrDrift, RejectedByProviderError, toProviderResult, type HttpDeps } from "./core";

/**
 * Expo Push Service adapter. Endpoints and field names are HAND-AUTHORED from the public Expo docs
 * (docs.expo.dev/push-notifications/sending-notifications). VERIFY BEFORE LAUNCH: every endpoint,
 * the 100-message batch cap, the 1000-id receipt cap and the DeviceNotRegistered detail code.
 */
export const EXPO_SEND_URL = "https://exp.host/--/api/v2/push/send";
export const EXPO_RECEIPTS_URL = "https://exp.host/--/api/v2/push/getReceipts";
export const EXPO_MAX_BATCH = 100;
export const EXPO_MAX_RECEIPT_IDS = 1000;
const VENDOR = "expo_push";

const ticketSchema = z.union([
  z.object({ status: z.literal("ok"), id: z.string().min(1) }),
  z.object({ status: z.literal("error"), message: z.string().optional(), details: z.object({ error: z.string().optional() }).passthrough().optional() }),
]);
const sendResponseSchema = z.object({ data: z.array(ticketSchema) });
const receiptSchema = z.union([
  z.object({ status: z.literal("ok") }),
  z.object({ status: z.literal("error"), message: z.string().optional(), details: z.object({ error: z.string().optional() }).passthrough().optional() }),
]);
const receiptsResponseSchema = z.object({ data: z.record(z.string(), receiptSchema) });

/** The composition implements this over the notifications push token store (token to user lookup, then `deactivate`). */
export interface PushTokenDeactivator {
  deactivateToken(token: string): Promise<void>;
}
export interface PushTicketStore {
  record(tickets: readonly { readonly ticketId: string; readonly token: string }[], atMs: number): Promise<void>;
  /** Tickets recorded at or before `olderThanMs` (Expo asks for receipts about 15 minutes after sending). */
  due(olderThanMs: number, limit: number): Promise<readonly { readonly ticketId: string; readonly token: string }[]>;
  complete(ticketIds: readonly string[]): Promise<void>;
}

export class InMemoryPushTicketStore implements PushTicketStore {
  private readonly rows = new Map<string, { token: string; atMs: number }>();
  async record(tickets: readonly { ticketId: string; token: string }[], atMs: number): Promise<void> {
    for (const t of tickets) this.rows.set(t.ticketId, { token: t.token, atMs });
  }
  async due(olderThanMs: number, limit: number): Promise<readonly { ticketId: string; token: string }[]> {
    return [...this.rows].filter(([, v]) => v.atMs <= olderThanMs).slice(0, limit).map(([ticketId, v]) => ({ ticketId, token: v.token }));
  }
  async complete(ids: readonly string[]): Promise<void> {
    for (const id of ids) this.rows.delete(id);
  }
  get size(): number {
    return this.rows.size;
  }
}

export interface ExpoPushOptions {
  readonly http: HttpDeps;
  /** Optional "enhanced security" access token (Authorization: Bearer). */
  readonly accessToken?: string | undefined;
  readonly deactivator: PushTokenDeactivator;
  readonly tickets: PushTicketStore;
  readonly nowMs: () => number;
}

export class ExpoPushProvider implements ChannelProvider<"push"> {
  readonly code = "expo_push";
  readonly channel = "push" as const;
  constructor(private readonly o: ExpoPushOptions) {}

  private headers(): Record<string, string> {
    const h: Record<string, string> = { Accept: "application/json", "Content-Type": "application/json" };
    if (this.o.accessToken !== undefined) h.Authorization = `Bearer ${this.o.accessToken}`;
    return h;
  }

  async send(message: ProviderMessage & { readonly channel: "push" }): Promise<ProviderResult> {
    try {
      const [r] = await this.sendBatch([message]);
      return r ?? { kind: "failed", code: "provider_drift" };
    } catch (e) {
      return toProviderResult(e);
    }
  }

  /** Chunks into batches of at most 100 and returns one result per input, in order. */
  async sendBatch(messages: readonly (ProviderMessage & { readonly channel: "push" })[]): Promise<readonly ProviderResult[]> {
    const out: ProviderResult[] = [];
    for (let i = 0; i < messages.length; i += EXPO_MAX_BATCH) {
      const chunk = messages.slice(i, i + EXPO_MAX_BATCH);
      const payload = chunk.map((m) => ({
        to: m.to,
        title: m.subject ?? undefined,
        body: m.body,
        sound: "default",
        data: { request_id: m.requestId },
      }));
      // Expo has no idempotency key: only a 429 is retried; 5xx surfaces as unavailable.
      const res = await call(this.o.http, {
        vendor: VENDOR,
        operation: "send",
        url: EXPO_SEND_URL,
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(payload),
        retry: "none",
      });
      if (res.status >= 400) throw new RejectedByProviderError(VENDOR, "send", "other", String(res.status));
      const parsed = parseOrDrift(sendResponseSchema, res.json, VENDOR, "send");
      if (parsed.data.length !== chunk.length) return [...out, ...chunk.map((): ProviderResult => ({ kind: "failed", code: "provider_drift" }))];
      const toRecord: { ticketId: string; token: string }[] = [];
      for (const [idx, t] of parsed.data.entries()) {
        const m = chunk[idx];
        if (m === undefined) continue;
        if (t.status === "ok") {
          toRecord.push({ ticketId: t.id, token: m.to });
          out.push({ kind: "sent", providerRef: t.id });
        } else if (t.details?.error === "DeviceNotRegistered") {
          await this.o.deactivator.deactivateToken(m.to);
          out.push({ kind: "invalid_recipient" });
        } else {
          out.push({ kind: "failed", code: t.details?.error ?? "expo_error" });
        }
      }
      if (toRecord.length > 0) await this.o.tickets.record(toRecord, this.o.nowMs());
    }
    return out;
  }

  /**
   * Polls receipts for tickets older than `minAgeMs` (default 15 min). DeviceNotRegistered
   * deactivates the token. getReceipts is read-only, so 5xx is retried (retry "safe").
   */
  async pollReceipts(minAgeMs = 15 * 60_000, limit = EXPO_MAX_RECEIPT_IDS): Promise<{ readonly checked: number; readonly deactivated: number }> {
    const due = await this.o.tickets.due(this.o.nowMs() - minAgeMs, limit);
    let deactivated = 0;
    for (let i = 0; i < due.length; i += EXPO_MAX_RECEIPT_IDS) {
      const chunk = due.slice(i, i + EXPO_MAX_RECEIPT_IDS);
      const res = await call(this.o.http, {
        vendor: VENDOR,
        operation: "getReceipts",
        url: EXPO_RECEIPTS_URL,
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ ids: chunk.map((c) => c.ticketId) }),
        retry: "safe",
      });
      if (res.status >= 400) throw new RejectedByProviderError(VENDOR, "getReceipts", "other", String(res.status));
      const parsed = parseOrDrift(receiptsResponseSchema, res.json, VENDOR, "getReceipts");
      const done: string[] = [];
      for (const c of chunk) {
        const r = parsed.data[c.ticketId];
        if (r === undefined) continue; // not ready yet: keep the ticket
        done.push(c.ticketId);
        if (r.status === "error" && r.details?.error === "DeviceNotRegistered") {
          await this.o.deactivator.deactivateToken(c.token);
          deactivated++;
        }
      }
      await this.o.tickets.complete(done);
    }
    return { checked: due.length, deactivated };
  }
}
