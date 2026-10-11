# Spec: fulfillment (courier port, Bosta-style adapter, tracking, COD records), Phase 1 wave 3

Status: DRAFT for review · Spec refs: master prompt §21 (Fulfillment and logistics), §20.1 (order states), §20.7 (COD controls), §22 (returns windows), §T3, §T5 (API7, API10), §T4 (COD clearing, out of scope here), A2, A3 · Grounding: `docs/data-model/fulfillment.md`, `docs/api/openapi.yaml` operations `createSellerShipment`, `getSellerShipment`, `getSellerShipmentLabel`, `receiveCourierWebhook` · ADR-0018 (vocabulary: tested code wins).

## Scope and hard limits

In scope: `CourierPort`, a Bosta-style adapter exercised only against a recorded-fixture fake, shipment creation, AWB queue with retry, tracking webhook ingestion, delivery attempts and RTO, `delivered_at` stamping, COD remittance records.

Out of scope until the owner's F-1 money-design checkpoint: no PSP call, no ledger posting (`cod_clearing:{courier}` is never touched), no payout, no refund execution. COD remittances are RECORDS and a state transition only. The `RECONCILE` transition of the shipment machine is left to the later reconciliation job.

No live courier API is called anywhere. Every endpoint, payload field, status code, signature scheme and remittance rule below that concerns Bosta is an assumption and is tagged **VERIFY BEFORE LAUNCH** (§21: "VERIFY the Bosta API endpoints, webhooks, COD remittance cycle and fees in the contract and sandbox"). Rows for the verify register are listed at the end.

## Flow
1. The seller packs a seller order and calls `POST /v1/seller/shipments` with `seller_order_ids` (exactly one in Phase 1), optional `courier` (default `bosta`) and `parcel`.
2. The server loads the seller order through `SellerOrderPort`, authorizes against the order's store (non-owned or unknown: 404), requires the order to be in a shippable state (`PACKED`; `ACCEPTED` is allowed, since the seller center packs and ships in one click, VERIFY with orders module), and creates a `Shipment` in `LABEL_PENDING` with a server-generated UUIDv7 id. COD amount is the order's unpaid amount at dispatch.
3. In the same transaction an AWB job is enqueued (`courier_awb_jobs`). The response is `201` with status `label_pending`; the seller never waits on the courier.
4. The AWB worker (`AwbWorker.runDue`) claims due jobs and calls `CourierPort.createAwb`, idempotent by the shipment id (`businessReference`). On success the shipment gets its `awb`, moves `LABEL_PENDING -> LABEL_CREATED` (`CREATE_LABEL`) and the label is available. A synchronous best-effort attempt is made at create time so the common case returns `label_ready`.
5. `GET /v1/seller/shipments/{id}/label` fetches the A6 PDF through `CourierPort.getLabel` (not stored by HAUL in this task; signed-URL storage is a later task, see gaps).
6. Courier tracking webhooks arrive at `POST /v1/webhooks/couriers/{courier}`: HMAC and timestamp are verified over the raw body before any parse, the delivery is stored raw and deduplicated by `(courier_code, courier_event_id)`, the payload is normalized to Z-OUTLET tracking kinds and applied to the shipment through the existing `shipmentMachine`.
7. `delivered` stamps `delivered_at` from the courier event time (never the seller's click, never the receipt time) and emits `shipment.delivered`, which the returns module consumes through the `DeliveredAtReader` port to start the 14/30-day windows.
8. COD remittance batches (webhook event `cod_remitted`, or `POST` of a batch through the same signed channel, VERIFY) are stored as `cod_remittances` + `cod_remittance_lines`, matched to shipments by AWB, and a matched COD shipment moves `DELIVERED -> COD_REMITTED` (`REMIT_COD`). No money is posted.

## Rules
- State machine: the existing `shipmentMachine` (`packages/domain/src/state-machine/machines/shipment.ts`) is reused unmodified. States and events are not redefined. `data-model/fulfillment.md` lists different state names (`PICKUP_SCHEDULED`, `DELIVERY_FAILED`, `RTO_IN_TRANSIT`); per ADR-0018 tested code wins and the machine's names are used.
- Tracking normalization (courier statuses to `FulfillmentTrackingKind`): `label_created`, `picked_up`, `in_transit`, `out_for_delivery`, `delivered`, `delivery_failed`, `customer_refused`, `rto_initiated`, `rto_delivered`, `cancelled`, `lost`. Unknown courier statuses are stored raw and acknowledged with `ignored_unknown_status` (never an error, so the courier does not retry forever; a metric counts them).
- Forward-only reducer: a forward kind walks the machine through the intermediate events the courier skipped (for example `delivered` straight after `picked_up` applies `IN_TRANSIT`, `OUT_FOR_DELIVERY`, `DELIVER`). A kind at or behind the current state is ignored as stale. There are no regressions: `in_transit` after `out_for_delivery` is stale, the shipment stays `OUT_FOR_DELIVERY` (departure from the data-model note "explicit allowed regressions", flagged in Decisions).
- Delivery attempts: each `delivery_failed` while `OUT_FOR_DELIVERY` increments `attempts_made` and applies `ATTEMPT_FAILED`. A later `out_for_delivery` applies `RETRY` (guard `attemptsMade < 3`). The third failed attempt immediately applies `INITIATE_RTO` (guard `attemptsMade >= 3`): "3 attempts, then RTO" (§21). A `delivery_failed` received while already `DELIVERY_ATTEMPT_FAILED` is stale (no second count without a new `out_for_delivery`; VERIFY the courier always emits one per attempt).
- `customer_refused` from `OUT_FOR_DELIVERY` applies `CUSTOMER_REFUSED -> RTO_INITIATED` (refusal reason is stored; the COD refusal policy lives in fraud, not here).
- `rto_initiated` pushed by the courier while `DELIVERY_ATTEMPT_FAILED` applies `INITIATE_RTO` with the guard context set to the maximum attempts (the courier's own policy decided exhaustion). From any other state it is `ignored_invalid` and raises an ops alert event.
- `delivered_at` is set once, on the first `DELIVER`, from `occurred_at` of the courier event. It is never overwritten and never earlier than `picked_up_at` is required (a courier clock skew is stored as is and flagged by a metric, VERIFY).
- Out-of-band terminal events: `cancelled` applies `CANCEL` only from `LABEL_PENDING`/`LABEL_CREATED`; `lost` applies `MARK_LOST` from `PICKED_UP`, `IN_TRANSIT`, `OUT_FOR_DELIVERY`, `RTO_INITIATED`. Anything else is `ignored_invalid`.
- Dedup: the first verified delivery of `(courier_code, courier_event_id)` is processed; later deliveries are acknowledged `duplicate: true` and change nothing. A delivery whose first processing crashed (`processing_status = RECEIVED`) is re-processed, and shipment events are unique on `(shipment_id, courier_event_id)`, so re-processing is idempotent.
- Replaying every webhook twice yields identical shipment state, events and counters (property test, `fulfillment.replay.property.test.ts`, and the domain reducer property test).
- Webhook authenticity (adapter `BostaStyleAdapter`, ASSUMED scheme, VERIFY): headers `x-signature` (hex HMAC-SHA256 of `<timestamp>.<raw body>`) and `x-timestamp` (epoch seconds). Secrets come from a rotating list (`CourierSecretsPort`); any current secret verifies. Timestamp tolerance is +/- 5 minutes (§7 webhook rule). Comparison is constant time. Failure is `401` with no detail, never stored, only counted. The raw body is required: the route fails closed (`503 raw_body_unavailable`) if the framework did not preserve it.
- AWB queue (§21 failure handling): exponential backoff with jitter, base 30 s, factor 2, cap 15 min, max 8 attempts, then the job is dead-lettered (`DEAD`), the shipment `label_status = FAILED`, event `courier.awb_dead_lettered` is emitted and the metric `fulfillment_awb_dlq_total{courier}` increments. A permanent rejection (`CourierRejectedError`, for example an unserviceable address) dead-letters on the first attempt. The seller sees `label_pending` meanwhile (and `label_failed` extension once dead, see deviations). A dead job can be re-queued by `AwbWorker.requeue(shipmentId)` (ops tool, not an HTTP route in this task).
- COD: `cod_amount` is fixed at dispatch (unpaid amount of the seller order). A remittance line is matched to the shipment by AWB: `MATCHED` when the collected amount equals `cod_amount`, `AMOUNT_DIFF` otherwise (shipment `cod_status = MISMATCH`, no transition, event `cod_remittance.mismatch`), `UNKNOWN_AWB` when no shipment has the AWB (kept for reconciliation), `NOT_COD` when the shipment is not COD. A remittance is idempotent on `(courier_code, courier_ref)`.
- One live shipment per seller order (unique partial index; `CANCELLED`, `LOST` and `RETURNED_TO_SELLER` shipments may be re-shipped). A second create for the same seller order with a different Idempotency-Key is `409 shipment_exists`.
- Money is bigint piastres (`BIGINT` in Postgres), always with a currency, EGP only.

## Edge cases
- Courier down at create: shipment `label_pending`, `201` still returned, job retried. Courier timeout after the courier created the AWB: the retry carries the same `businessReference`, the courier returns the existing AWB (idempotent), no duplicate AWB (tested against the fake's idempotency).
- Courier returns an AWB already used by another shipment: unique `(courier_code, awb)` violation, the job is dead-lettered as a conflict and flagged (should be impossible).
- Webhook for an unknown AWB: stored raw as `UNMATCHED`, acknowledged `200` (the courier may deliver before our AWB write commits); the worker re-attempts matching for `UNMATCHED` rows when the AWB is saved (`rematchUnmatched`).
- Webhook before the shipment reached `LABEL_CREATED` (race with the AWB write): the reducer walks `CREATE_LABEL` itself.
- Out-of-order duplicates with distinct ids (courier replays history): stale, ignored, state unchanged.
- Seller cancels before pickup: `POST` cancel is not in this task (gap); a courier `cancelled` event is handled.
- Seller on a shipment of another store, a deleted seller order, a non-UUID id: 404, byte-identical bodies.
- Seller order not shippable (`CANCELLED`, `PENDING_PAYMENT`): `422 order_not_shippable`.
- COD seller order with `cod_amount = 0` (fully paid by store credit): `cod = false`.
- Clock skew: webhook timestamp outside +/- 5 min: 401. Event `occurred_at` more than 24 h in the future: clamped to receive time and flagged (stored raw).
- Two webhooks racing for one shipment: optimistic `version`; the loser re-reads and re-applies (up to 3 tries, then `503` so the courier retries).
- Label requested while `label_pending`: `409 label_not_ready`.

## Data
Migration `0022_fulfillment.sql` (expand only). Privacy tags in `docs/privacy/data_inventory.yaml` (tables `shipments`, `shipment_events`, `courier_events_raw`, `courier_awb_jobs`, `cod_remittances`, `cod_remittance_lines`).

| Table | Key columns | Notes |
|---|---|---|
| `shipments` | `id`, `store_id`, `seller_order_id`, `seller_order_ids uuid[]`, `courier_code`, `awb` null, `status`, `attempts_made`, `cod_amount` null, `cod_status`, `label_status`, `parcel_weight_g`, `pieces`, `picked_up_at`, `delivered_at`, `version` | tenant RLS on `store_id` (class B); unique `(courier_code, awb)`; unique `seller_order_id` where status not in (CANCELLED, LOST, RETURNED_TO_SELLER) |
| `shipment_events` | `id`, `seq` identity, `shipment_id`, `courier_event_id`, `kind`, `from_status`, `to_status`, `outcome`, `occurred_at`, `reason_code` | unique `(shipment_id, courier_event_id)`; append-only (`seq` orders equal timestamps); RLS through the shipment's store |
| `courier_events_raw` | `id`, `courier_code`, `courier_event_id`, `body text`, `processing_status`, `received_at` | unique `(courier_code, courier_event_id)`; raw body stored verbatim; system/ops only (class C) |
| `courier_awb_jobs` | `shipment_id` PK, `status` PENDING/DONE/DEAD, `attempts`, `next_attempt_at`, `last_error_code` | worker claims with `FOR UPDATE SKIP LOCKED`; system only |
| `cod_remittances` | `id`, `courier_code`, `courier_ref`, `remittance_date`, `total_amount`, `status` | unique `(courier_code, courier_ref)`; finance/ops read |
| `cod_remittance_lines` | `(remittance_id, awb)`, `shipment_id` null, `collected_amount`, `fee_amount`, `match_status` | |

Deviations from `docs/data-model/fulfillment.md` (reported, data model not edited): `seller_order_ids` is kept as a one-element array plus a scalar `seller_order_id` (junction table deferred to hub consolidation, Phase 2); `shipment_events` and `courier_events_raw` are not partitioned yet (same deferral as the outbox, 0004; partitioning is a later expand migration); `courier_event_dedup` is folded into the unique index on `courier_events_raw`; `signature_ok` is not stored because unverified deliveries are rejected and never persisted (an attacker must not be able to burn event ids or grow storage); the reference tables `couriers`, `courier_coverage`, `courier_service_levels`, `transit_time_stats`, `delivery_attempts`, `proofs_of_delivery`, `shipment_carbon` are not in this task (see gaps).

## API
| Method and path | Auth | Idempotent | Rate limit | Success |
|---|---|---|---|---|
| `POST /v1/seller/shipments` | seller, `store_order` update (owner, manager, warehouse), scope `seller:write` | required Idempotency-Key | 60/min/user | 201 `Shipment` |
| `GET /v1/seller/shipments/{id}` | seller, `store_order` read, scope `seller:read` | n/a | 120/min/user | 200 `Shipment` + ETag |
| `GET /v1/seller/shipments/{id}/label` | seller, `store_order` read | n/a | 120/min/user | 200 `application/pdf` |
| `POST /v1/webhooks/couriers/{courier}` | public route, HMAC + timestamp | dedup by courier event id | 600/min/ip | 200 `WebhookAck` |

Policy mapping note: the policy package has no `store_shipment` resource type, so shipments are authorized as `store_order` (the seller order is the shipment's parent and the roles match the §19 seller role table). Raised in needs.

Errors are Problem+JSON: `validation_failed`, `unauthenticated`, `forbidden`, `not_found`, `shipment_exists`, `order_not_shippable`, `courier_unsupported`, `label_not_ready`, `rate_limited`, `raw_body_unavailable`.

Deviations from the OpenAPI skeleton (reported, `openapi.yaml` not edited): the `Shipment.status` enum has no `cancelled` or `lost`, but the machine has both, so the wire emits `cancelled` and `lost`; `Shipment` also gains `label_status` (`pending|ready|failed`) and `delivered_at`; `courier` enum values `bosta` only in Phase 1.

## Events
Outbox (same transaction as the state change): `shipment.created`, `shipment.label_created`, `shipment.picked_up`, `shipment.delivered` (carries `delivered_at`, consumed by returns and orders), `shipment.delivery_failed`, `shipment.rto_initiated`, `shipment.rto_received`, `shipment.lost`, `shipment.cancelled`, `courier.awb_dead_lettered`, `cod.collected` (shipment delivered with COD), `cod_remittance.matched`, `cod_remittance.mismatch`, `courier.webhook_unmatched`. Payloads hold opaque ids, statuses and timestamps only (no consignee data). Analytics `order_delivered` is emitted by orders from `shipment.delivered`.

## Failure handling
- Courier calls: timeout 10 s, the AWB job retries with the backoff above, max 8, DLQ metric. A per-courier circuit breaker is the courier adapter's job (`CourierUnavailableError` is the only retried error class); the breaker itself is a gap.
- Webhook processing failure after storing raw: the raw row stays `RECEIVED`, the response is `503` so the courier redelivers, and re-processing is idempotent.
- Webhook gap above 48 h: the poller (`CourierPort.track`) backfills; the use case `BackfillTracking` exists, the scheduler is a gap.
- Outbox write failure rolls the whole transition back.

## Security and abuse
- API1/API5 (BOLA/BFLA): every seller route resolves the store from the loaded object, never from the body; missing grant or role: 403, other store's object: 404 (negative tests for each route, plus a cross-tenant test that store B cannot create a shipment for store A's order).
- API4: webhook body capped at 256 KiB by the adapter (`413` above); rate limit per IP.
- API7/API10: the courier payload is untrusted: Zod `strict` schema per event, every field length-capped, unknown status mapped to `ignored_unknown_status`, no URL from the payload is ever fetched, label bytes are not interpreted.
- Replay: timestamp window plus event-id dedup.
- AWBs are courier-assigned, never derived from our ids; the shipment id is a UUIDv7 and is the only identifier a seller can address.
- PII: the courier adapter sends recipient data from `SellerOrderPort` (delivery snapshot) and sets nothing else; logs and events never contain name, phone or address (P2). Raw bodies may contain consignee data (P2) and are retention-bound (`delivery_records`).
- Fake-dispatch abuse: the dispatch SLA is satisfied only by a courier `picked_up` event, which this module exposes as `shipment.picked_up` with `picked_up_at`.

## Metrics
`fulfillment_awb_dlq_total{courier}` (alert at > 0), `fulfillment_awb_pending_age_seconds` (gauge, p95 target < 60 s outside outages), `fulfillment_webhook_total{courier,outcome}` (`applied|duplicate|stale|invalid|unknown_status|unmatched|rejected_signature`), webhook lag (receive time minus event time, p95), delivery success rate, RTO rate, COD remittance match rate. SLI: webhook to state p95 < 5 s.

## Acceptance
- Given a created shipment, when the courier is down, then the response is 201 `label_pending`, the job is retried with growing delays, and after 8 failures the DLQ metric is 1 and `label_status = failed`.
- Given the same webhook set delivered twice (in any interleaving), then shipment state, events, `attempts_made` and `delivered_at` are identical to a single delivery.
- Given three `out_for_delivery` / `delivery_failed` pairs, then the shipment is `RTO_INITIATED` and `attempts_made = 3`.
- Given a `delivered` event at time T, then `delivered_at = T` and `shipment.delivered` carries T; a later `delivered` with another time does not change it.
- Given a webhook with a bad signature, a stale timestamp or a tampered body, then 401 and nothing stored.
- Given a COD shipment remitted with a different amount, then `cod_status = MISMATCH`, no transition, `cod_remittance.mismatch` emitted.
- Seller B reads or creates a shipment for seller A's order: 404; a catalog-only staff member: 403.

## Decisions and VERIFY BEFORE LAUNCH register rows (proposed for `docs/compliance/verify-register.md`)
1. Bosta base URL, authentication, create-delivery endpoint, idempotency semantics of `businessReference`, label endpoint and PDF size A6 (§21, P2 row 11). **VERIFY BEFORE LAUNCH**
2. Bosta webhook signature scheme (header names, algorithm, timestamp format), delivery guarantees, retry policy, event id field and its uniqueness. **VERIFY BEFORE LAUNCH**
3. Bosta state codes and the mapping table (`courier_status_map` is a versioned constant in the adapter, `BOSTA_STATUS_MAP_VERSION`). **VERIFY BEFORE LAUNCH**
4. Courier emits one `out_for_delivery` per attempt and one `delivery_failed` per failed attempt; courier-side RTO policy (number of attempts). **VERIFY BEFORE LAUNCH**
5. COD remittance cycle, batch reference and per-line fee structure, delivery channel (webhook vs file vs API poll). **VERIFY BEFORE LAUNCH** (P2 row 11)
6. Cancel-after-AWB semantics and cut-off (pickup scheduled vs picked up). **VERIFY BEFORE LAUNCH**
7. Relay (masked) phone number support at the courier (§B1 sellers/processors). **VERIFY BEFORE LAUNCH**
8. Proof of delivery (OTP or photo) fields in webhooks (data model rule); stored as a later task.
9. `seller_order` shippable states with the orders module (`ACCEPTED` vs `PACKED`).
10. Whether regressions such as `OUT_FOR_DELIVERY -> IN_TRANSIT` must be applied (data model note) or ignored (this spec, safer for replay determinism).

## COD ledger recognition (F-8 follow-up)

Implemented in `apps/api/src/composition/cod-wiring.ts` (`CodLedgerRecognition`), driven by fulfillment outbox events:

| Event | Ledger | Notes |
|---|---|---|
| `shipment.delivered` (cod) | `order_cod_confirmed:{orderGroupId}` (shared key `orderRecognitionKey(g, "cod")`) | cod_clearing receivable; one entry per group, posted on the first delivered seller order, later deliveries replay as duplicate. Refunds fail closed until it exists. |
| `cod_remittance.matched` / `.mismatch` | `cod_collected:{courier}:{courier_ref}` for the MATCHED lines only (`matched_amount`, `matched_fee` in the payload) | Unmatched lines post nothing and stay a finance ticket. |
| `shipment.rto_initiated` / `rto_received` | nothing | Refusal never recognised revenue; the shopper's COD spend counter is reversed once per seller order (`cod_refused:{sellerOrderId}`). |

VERIFY (VR-F1-01): a multi-store group where one parcel is refused after a sibling was delivered leaves that parcel's receivable in cod_clearing until reconciliation flags the short remittance.
