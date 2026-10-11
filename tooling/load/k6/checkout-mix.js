// Scenario 2 (T9, T8): checkout success >= 99.5% under 20x baseline mix.
// BASELINE_RPS is the measured steady-state checkout arrival rate (default 5 rps placeholder: replace from prod telemetry).
// Mix (default): browse 70%, bag edit 15%, checkout 15% of iterations; payment methods card 55 / cod 25 / wallet 10 / fawry 10.
// Success = placement accepted; user-declined (402/422 with code payment_declined) excluded per T8 SLI definition.
import http from "k6/http";
import { check } from "k6";
import { Rate, Trend } from "k6/metrics";
import { BASE_URL, SLO, authHeaders, idemKey, manifest } from "./lib.js";

const BASELINE_RPS = Number(__ENV.BASELINE_RPS || 5);
const MULT = Number(__ENV.MULT || 20);
const success = new Rate("checkout_success");
const confirmMs = new Trend("checkout_ms", true);

export const options = {
  scenarios: {
    mix: {
      executor: "ramping-arrival-rate",
      startRate: BASELINE_RPS,
      timeUnit: "1s",
      preAllocatedVUs: Number(__ENV.PRE_VUS || 500),
      maxVUs: Number(__ENV.MAX_VUS || 5000),
      stages: [
        { target: BASELINE_RPS, duration: "2m" },
        { target: BASELINE_RPS * MULT, duration: "5m" },
        { target: BASELINE_RPS * MULT, duration: __ENV.HOLD || "20m" },
        { target: BASELINE_RPS, duration: "3m" },
      ],
    },
  },
  thresholds: {
    checkout_success: [SLO.checkoutSuccess],
    "http_req_duration{name:search}": [`p(95)<${SLO.searchP95Ms}`],
    "http_req_duration{name:read}": [`p(95)<${SLO.readP95Ms}`],
    checkout_ms: ["p(95)<2000"],
    http_req_failed: ["rate<0.005"],
  },
};

const METHODS = ["card", "card", "card", "card", "card", "cod", "cod", "wallet", "fawry", "card"];

export default function () {
  const m = manifest[0];
  const r = Math.random();
  const hdr = authHeaders(__VU);
  if (r < 0.7) {
    http.get(`${BASE_URL}/v1/search?q=${encodeURIComponent(m.searchTerms[__ITER % m.searchTerms.length])}&limit=24`, { headers: hdr, tags: { name: "search" } });
    http.get(`${BASE_URL}/v1/products/${m.productIds[__ITER % m.productIds.length]}`, { headers: hdr, tags: { name: "read" } });
    return;
  }
  if (r < 0.85) {
    http.get(`${BASE_URL}/v1/cart`, { headers: hdr, tags: { name: "read" } });
    return;
  }
  const quote = http.post(`${BASE_URL}/v1/checkout/quote`, JSON.stringify({ address_id: m.addressId, payment_method: "card" }), {
    headers: Object.assign({}, hdr, { "Idempotency-Key": idemKey("quote") }),
    tags: { name: "quote" },
  });
  if (quote.status !== 200) {
    success.add(false);
    return;
  }
  const q = quote.json();
  const res = http.post(
    `${BASE_URL}/v1/checkout`,
    JSON.stringify({ quote_id: q.id, address_id: m.addressId, payment_method: METHODS[__ITER % METHODS.length], expected_total: q.total }),
    { headers: Object.assign({}, hdr, { "Idempotency-Key": idemKey("checkout") }), tags: { name: "checkout" } },
  );
  confirmMs.add(res.timings.duration);
  const declined = res.status === 402 || (res.status === 422 && String(res.body).indexOf("payment_declined") >= 0);
  if (!declined) success.add(check(res, { "checkout accepted": (x) => x.status >= 200 && x.status < 300 }));
}
