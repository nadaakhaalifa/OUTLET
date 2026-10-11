// Scenario 3 (T8): reserve p95 < 150 ms.
// Reserve happens inside POST /v1/checkout (saga step 2). The authoritative SLI is the server-side `reserve` timing
// emitted in the Server-Timing header (`reserve;dur=<ms>`) and the outlet_reserve_duration_seconds histogram. This
// script reads the header when present and ALSO bounds the end-to-end checkout latency as a coarse guard.
// Contention: VUs hammer a small set of hot SKUs (HOT_SKUS) to exercise SKIP LOCKED paths.
import http from "k6/http";
import { Trend, Counter } from "k6/metrics";
import { BASE_URL, SLO, authHeaders, idemKey, manifest } from "./lib.js";

const reserveDur = new Trend("reserve_server_ms", true);
const noHeader = new Counter("reserve_no_server_timing");

export const options = {
  scenarios: {
    reserve: {
      executor: "constant-arrival-rate",
      rate: Number(__ENV.RPS || 200),
      timeUnit: "1s",
      duration: __ENV.DURATION || "5m",
      preAllocatedVUs: 300,
      maxVUs: 3000,
    },
  },
  thresholds: {
    reserve_server_ms: [`p(95)<${SLO.reserveP95Ms}`],
    // header must actually be present, otherwise the threshold above is vacuous
    reserve_no_server_timing: ["count==0"],
    "http_req_duration{name:checkout}": ["p(95)<1000"],
  },
};

export default function () {
  const m = manifest[0];
  const hdr = authHeaders(__VU, { "Idempotency-Key": idemKey("reserve") });
  const sku = m.hotSkuQuotes[__ITER % m.hotSkuQuotes.length];
  const res = http.post(
    `${BASE_URL}/v1/checkout`,
    JSON.stringify({ quote_id: sku.quoteId, address_id: m.addressId, payment_method: "card", expected_total: sku.total }),
    { headers: hdr, tags: { name: "checkout" } },
  );
  const st = res.headers["Server-Timing"] || res.headers["server-timing"] || "";
  const mm = /reserve;dur=([0-9.]+)/.exec(st);
  if (mm) reserveDur.add(Number(mm[1]));
  else noHeader.add(1);
}
