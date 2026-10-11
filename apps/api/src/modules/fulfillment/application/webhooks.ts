import {
  applyTracking,
  matchCodLine,
  money,
  shipmentMachine,
  type CodMatchStatus,
  type ShipmentState,
} from "../domain/bridge";
import type {
  CourierBinding,
  CourierSecretsPort,
  FulfillmentMetrics,
  FulfillmentRepository,
  OutboxEvent,
  ParsedCourierWebhook,
  RemittanceLineRecord,
  RemittanceRecord,
  ShipmentEventRecord,
  ShipmentRecord,
  ShipmentUpdate,
} from "../domain/ports";
import type { Clock, IdGenerator } from "../../../platform/ports";
import { eventsForTransitions, shipmentPayload } from "./events";

const MAX_CAS_RETRIES = 3;
const FUTURE_CLAMP_MS = 24 * 60 * 60 * 1000;

export interface WebhookDeps {
  readonly repo: FulfillmentRepository;
  readonly couriers: ReadonlyMap<string, CourierBinding>;
  readonly secrets: CourierSecretsPort;
  readonly metrics: FulfillmentMetrics;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

export type WebhookResult =
  | { readonly kind: "ok"; readonly duplicate: boolean }
  | { readonly kind: "unsupported_courier" }
  | { readonly kind: "too_large" }
  /** Bad or missing signature, or a timestamp outside the window. Nothing is stored. */
  | { readonly kind: "rejected" }
  | { readonly kind: "bad_payload" }
  /** Version conflicts exhausted retries: the courier should redeliver. */
  | { readonly kind: "conflict" };

const OUTCOME = { ok: "APPLIED", stale: "IGNORED_STALE", invalid_transition: "IGNORED_INVALID" } as const;

/**
 * Inbound courier webhooks (spec 21): verify HMAC and timestamp over the raw body, store the raw
 * delivery with dedup by (courier, event id), normalize, and apply to the shipment through the
 * shared state machine. Replaying a delivery changes nothing.
 */
export class IngestCourierWebhook {
  constructor(private readonly deps: WebhookDeps) {}

  async execute(input: {
    readonly courier: string;
    readonly rawBody: string;
    readonly headers: Readonly<Record<string, string | undefined>>;
  }): Promise<WebhookResult> {
    const { couriers, secrets, metrics, clock } = this.deps;
    const binding = couriers.get(input.courier);
    if (binding === undefined) return { kind: "unsupported_courier" };
    if (Buffer.byteLength(input.rawBody, "utf8") > binding.webhook.maxBodyBytes) return { kind: "too_large" };
    const nowMs = clock.nowMs();
    const verdict = binding.webhook.verify(
      { rawBody: input.rawBody, headers: input.headers },
      await secrets.webhookSecrets(input.courier),
      nowMs,
    );
    if (verdict !== "ok") {
      metrics.increment("fulfillment_webhook_total", { courier: input.courier, outcome: "rejected_signature" });
      return { kind: "rejected" };
    }
    const parsed = binding.webhook.parse(input.rawBody);
    if (parsed.kind === "invalid") {
      metrics.increment("fulfillment_webhook_total", { courier: input.courier, outcome: "invalid" });
      return { kind: "bad_payload" };
    }
    return this.process(input.courier, parsed, input.rawBody, nowMs);
  }

  /** Re-applies facts that arrived before their AWB was stored. Safe to call repeatedly. */
  async rematchUnmatched(courier: string, awb: string): Promise<void> {
    const binding = this.deps.couriers.get(courier);
    if (binding === undefined) return;
    const held = await this.deps.repo.listUnmatchedRaw(courier, awb);
    for (const h of held) {
      const parsed = binding.webhook.parse(h.body);
      if (parsed.kind !== "tracking") continue;
      await this.applyTracking(courier, parsed, this.deps.clock.nowMs());
    }
  }

  private async process(
    courier: string,
    parsed: Exclude<ParsedCourierWebhook, { kind: "invalid" }>,
    rawBody: string,
    nowMs: number,
  ): Promise<WebhookResult> {
    const { repo, ids, metrics } = this.deps;
    const raw = await repo.recordRaw({
      id: ids.uuidV7(),
      courierCode: courier,
      courierEventId: parsed.courierEventId,
      awb: parsed.kind === "tracking" ? parsed.awb : null,
      body: rawBody,
      receivedAtMs: nowMs,
    });
    if (raw === "duplicate") {
      metrics.increment("fulfillment_webhook_total", { courier, outcome: "duplicate" });
      return { kind: "ok", duplicate: true };
    }
    if (parsed.kind === "cod_remitted") return this.recordRemittance(courier, parsed, nowMs);
    if (parsed.tracking === null) {
      await repo.markRaw(courier, parsed.courierEventId, "IGNORED_UNKNOWN_STATUS", nowMs);
      metrics.increment("fulfillment_webhook_total", { courier, outcome: "unknown_status" });
      return { kind: "ok", duplicate: false };
    }
    return this.applyTracking(courier, parsed, nowMs);
  }

  private async applyTracking(
    courier: string,
    parsed: Extract<ParsedCourierWebhook, { kind: "tracking" }>,
    nowMs: number,
  ): Promise<WebhookResult> {
    const { repo, ids, metrics } = this.deps;
    const kind = parsed.tracking;
    if (kind === null) return { kind: "ok", duplicate: false };
    for (let i = 0; i < MAX_CAS_RETRIES; i += 1) {
      const shipment = await repo.findByAwb(courier, parsed.awb);
      if (shipment === null) {
        await repo.markRaw(courier, parsed.courierEventId, "UNMATCHED", nowMs);
        metrics.increment("fulfillment_webhook_total", { courier, outcome: "unmatched" });
        return { kind: "ok", duplicate: false };
      }
      // A courier clock far in the future would stamp a bogus delivered_at; clamp to receipt time.
      const occurredAtMs = parsed.occurredAtMs > nowMs + FUTURE_CLAMP_MS ? nowMs : parsed.occurredAtMs;
      const outcome = applyTracking(
        {
          state: shipment.state,
          attemptsMade: shipment.attemptsMade,
          cod: shipment.codAmount !== null,
          pickedUpAtMs: shipment.pickedUpAtMs,
          deliveredAtMs: shipment.deliveredAtMs,
        },
        { courierEventId: parsed.courierEventId, kind, occurredAtMs, reasonCode: parsed.reasonCode },
      );
      const applied = outcome.kind === "applied";
      const reachedDelivered = applied && outcome.next.state === "DELIVERED";
      const next: ShipmentRecord = applied
        ? {
            ...shipment,
            state: outcome.next.state,
            attemptsMade: outcome.next.attemptsMade,
            pickedUpAtMs: outcome.next.pickedUpAtMs,
            deliveredAtMs: outcome.next.deliveredAtMs,
            codStatus: reachedDelivered && shipment.codStatus === "PENDING" ? "COLLECTED" : shipment.codStatus,
            version: shipment.version + 1,
          }
        : shipment;
      const event: ShipmentEventRecord = {
        id: ids.uuidV7(),
        shipmentId: shipment.id,
        courierEventId: parsed.courierEventId,
        kind,
        outcome: OUTCOME[outcome.kind === "applied" ? "ok" : outcome.reason],
        fromStatus: shipment.state,
        toStatus: next.state,
        reasonCode: parsed.reasonCode,
        occurredAtMs,
        recordedAtMs: nowMs,
      };
      const outbox: OutboxEvent[] = applied
        ? eventsForTransitions(
            outcome.steps.map((s) => s.to),
            next,
            () => ids.uuidV7(),
          )
        : [];
      const r = await repo.applyTracking({
        shipmentId: shipment.id,
        expectedVersion: shipment.version,
        next,
        event,
        courierCode: courier,
        outbox,
      });
      if (r === "version_conflict") continue;
      if (r === "duplicate_event") {
        metrics.increment("fulfillment_webhook_total", { courier, outcome: "duplicate" });
        return { kind: "ok", duplicate: true };
      }
      metrics.increment("fulfillment_webhook_total", {
        courier,
        outcome: applied ? "applied" : outcome.kind === "ignored" ? outcome.reason : "applied",
      });
      return { kind: "ok", duplicate: false };
    }
    return { kind: "conflict" };
  }

  private async recordRemittance(
    courier: string,
    parsed: Extract<ParsedCourierWebhook, { kind: "cod_remitted" }>,
    nowMs: number,
  ): Promise<WebhookResult> {
    const { repo, ids, metrics } = this.deps;
    for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt += 1) {
      const lines: RemittanceLineRecord[] = [];
      const updates: ShipmentUpdate[] = [];
      const outbox: OutboxEvent[] = [];
      let total = 0n;
      for (const l of parsed.lines) {
        const shipment = await repo.findByAwb(courier, l.awb);
        const match: CodMatchStatus = matchCodLine(
          shipment === null ? null : { expected: shipment.codAmount },
          l.collected,
        );
        total += l.collected.amount;
        lines.push({ awb: l.awb, shipmentId: shipment?.id ?? null, collected: l.collected, fee: l.fee, match });
        if (shipment === null) continue;
        if (match === "MATCHED" && shipment.state === "DELIVERED") {
          const to: ShipmentState = shipmentMachine.transition(shipment.state, "REMIT_COD", {
            cod: true,
            attemptsMade: shipment.attemptsMade,
          });
          updates.push({
            shipmentId: shipment.id,
            expectedVersion: shipment.version,
            next: { ...shipment, state: to, codStatus: "REMITTED", version: shipment.version + 1 },
          });
        } else if (match === "AMOUNT_DIFF") {
          updates.push({
            shipmentId: shipment.id,
            expectedVersion: shipment.version,
            next: { ...shipment, codStatus: "MISMATCH", version: shipment.version + 1 },
          });
        }
      }
      const matched = lines.filter((l) => l.match === "MATCHED").length;
      const status: RemittanceRecord["status"] =
        matched === lines.length ? "MATCHED" : matched === 0 ? "MISMATCH" : "PARTIALLY_MATCHED";
      const remittance: RemittanceRecord = {
        id: ids.uuidV7(),
        courierCode: courier,
        courierRef: parsed.courierRef,
        remittanceDate: parsed.remittanceDate,
        total: money(total),
        status,
        receivedAtMs: nowMs,
        lines,
      };
      const payload = {
        courier,
        courier_ref: parsed.courierRef,
        total_amount: total.toString(),
        lines: lines.length,
        matched,
        // Ledger recognition (cod_collected) clears only what matched; a mismatch is a finance ticket.
        remittance_id: remittance.id,
        matched_amount: lines.filter((l) => l.match === "MATCHED").reduce((a, l) => a + l.collected.amount, 0n).toString(),
        matched_fee: lines.filter((l) => l.match === "MATCHED").reduce((a, l) => a + l.fee.amount, 0n).toString(),
      };
      outbox.push({
        id: ids.uuidV7(),
        type: status === "MATCHED" ? "cod_remittance.matched" : "cod_remittance.mismatch",
        aggregateId: remittance.id,
        payload,
      });
      for (const u of updates) {
        if (u.next.codStatus === "REMITTED") {
          outbox.push({ id: ids.uuidV7(), type: "shipment.cod_remitted", aggregateId: u.shipmentId, payload: shipmentPayload(u.next) });
        }
      }
      const r = await repo.recordRemittance({ remittance, updates, outbox });
      if (r === "version_conflict") continue;
      await repo.markRaw(courier, parsed.courierEventId, "PROCESSED", nowMs);
      metrics.increment("fulfillment_cod_remittance_total", {
        courier,
        outcome: r === "duplicate" ? "duplicate" : status.toLowerCase(),
      });
      return { kind: "ok", duplicate: r === "duplicate" };
    }
    return { kind: "conflict" };
  }
}
