// Scenario 5 (spec 7, 21 acceptance): webhook replay storm. Every event id is sent REPLAYS times (default 5) from many
// VUs concurrently, some with a tampered body (must be 4xx, never applied). Expected end state (verified by
// the post-run checks in docs/engineering/load-testing.md against GET /v1/admin/order-groups/{id}): each order group paid exactly once,
// ledger postings per event == 1, payment_events_raw rows == unique event ids.
// Signature scheme is VERIFY BEFORE LAUNCH per adapter: this uses the `sandbox` provider code (X-Signature: hex HMAC-SHA256
// over the raw body). Adjust in lib if the adapter differs.
import http from "k6/http";
import crypto from "k6/crypto";
import { check } from "k6";
import { Counter } from "k6/metrics";
import { BASE_URL, manifest } from "./lib.js";

const accepted = new Counter("webhook_accepted");
const badSigRejected = new Counter("webhook_bad_sig_rejected");
const badSigAccepted = new Counter("webhook_bad_sig_accepted");
const REPLAYS = Number(__ENV.REPLAYS || 5);
const SECRET = __ENV.WEBHOOK_SECRET || "";

export const options = {
  scenarios: {
    storm: {
      executor: "shared-iterations",
      vus: Number(__ENV.VUS || 200),
      iterations: Number(__ENV.EVENTS || 5000) * REPLAYS,
      maxDuration: "15m",
    },
  },
  thresholds: {
    webhook_bad_sig_accepted: ["count==0"],
    "http_req_duration{name:webhook}": ["p(95)<500"],
    http_req_failed: ["rate<0.001"],
    // 5xx would be a replay-handling bug; duplicates must be 200 (already processed)
    "http_req_duration{status:500}": ["count==0"],
  },
};

export default function () {
  if (SECRET === "") throw new Error("WEBHOOK_SECRET is required");
  const m = manifest[0];
  const n = __ITER % Number(__ENV.EVENTS || 5000); // event index; each repeats REPLAYS times
  const og = m.webhookTargets[n % m.webhookTargets.length];
  const body = JSON.stringify({
    id: `evt_load_${m.runId}_${n}`,
    type: "payment.succeeded",
    order_group_id: og.orderGroupId,
    amount: og.amount,
    currency: "EGP",
    created: Math.floor(Date.now() / 1000),
  });
  const tamper = __ITER % 17 === 0;
  const sig = crypto.hmacSHA256(SECRET, tamper ? body + " " : body, "hex");
  const res = http.post(`${BASE_URL}/v1/webhooks/sandbox`, body, {
    headers: { "Content-Type": "application/json", "X-Signature": sig },
    tags: { name: "webhook" },
  });
  if (tamper) {
    if (res.status >= 400 && res.status < 500) badSigRejected.add(1);
    else badSigAccepted.add(1);
  } else {
    accepted.add(check(res, { "2xx": (r) => r.status >= 200 && r.status < 300 }) ? 1 : 0);
  }
}
