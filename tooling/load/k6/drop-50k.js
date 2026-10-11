// Scenario 1 (spec 16 acceptance): 50k VUs on a 500-unit drop SKU.
// Flow per VU: join queue -> poll status until admitted (token) -> POST /v1/checkout (reserve) -> payment webhook is
// simulated by the sandbox PSP -> poll order group. Assertions are END-STATE and must be checked after the run with
// the post-run checks in docs/engineering/load-testing.md; in-run thresholds cover latency and counters.
// NOTE: /v1/drops/{id}/queue* is specified in docs/specs/phase2/07-drops-waiting-room.md, not yet in openapi.yaml.
import http from "k6/http";
import { check, sleep } from "k6";
import { Counter, Rate, Trend } from "k6/metrics";
import { BASE_URL, authHeaders, idemKey, manifest } from "./lib.js";

const admitted = new Counter("drop_admitted");
const reserved = new Counter("drop_reserved");
const soldOut = new Counter("drop_sold_out");
const checkoutOk = new Rate("drop_checkout_success");
const reserveMs = new Trend("drop_checkout_ms", true);
const admitRank = new Trend("drop_admit_rank");

const VUS = Number(__ENV.VUS || 50000);
export const options = {
  scenarios: {
    drop: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: __ENV.RAMP || "60s", target: VUS },
        { duration: __ENV.HOLD || "5m", target: VUS },
        { duration: "30s", target: 0 },
      ],
      gracefulRampDown: "30s",
    },
  },
  thresholds: {
    // spec 16: checkout success during drops >= 99% (of admitted users that reached payment, excluding sold-out)
    drop_checkout_success: ["rate>=0.99"],
    // T8 reserve p95; checkout includes PSP intent creation so we use the looser end-to-end figure here
    drop_checkout_ms: ["p(95)<1500"],
    http_req_failed: ["rate<0.01"],
    // a 5xx is never acceptable: sold-out must be a clean 409/422 business error
    "http_req_duration{status:500}": ["count==0"],
  },
};

export default function () {
  const m = manifest[0];
  const dropId = m.drop.id;
  const h = (k) => authHeaders(__VU, { "Idempotency-Key": k });

  const join = http.post(`${BASE_URL}/v1/drops/${dropId}/queue`, "{}", { headers: h(idemKey("join")), tags: { name: "queue_join" } });
  if (!check(join, { "joined 2xx": (r) => r.status >= 200 && r.status < 300 })) return;

  let token = null;
  for (let i = 0; i < 600 && token === null; i += 1) {
    const s = http.get(`${BASE_URL}/v1/drops/${dropId}/queue/status`, { headers: authHeaders(__VU), tags: { name: "queue_status" } });
    const b = s.json();
    if (b && b.state === "admitted" && b.token) {
      token = b.token;
      admitted.add(1);
      if (typeof b.rank === "number") admitRank.add(b.rank);
    } else if (b && b.state === "sold_out") {
      soldOut.add(1);
      return;
    }
    sleep(1);
  }
  if (token === null) return;

  const body = JSON.stringify({
    quote_id: m.drop.quoteIds[(__VU - 1) % m.drop.quoteIds.length],
    address_id: m.addressId,
    payment_method: "card",
    expected_total: m.drop.expectedTotal,
  });
  const res = http.post(`${BASE_URL}/v1/checkout`, body, {
    headers: Object.assign(h(idemKey("checkout")), { "X-Admission-Token": token }),
    tags: { name: "checkout" },
  });
  reserveMs.add(res.timings.duration);
  const ok = res.status === 200 || res.status === 201 || res.status === 202;
  const businessSoldOut = res.status === 409 || res.status === 422;
  if (businessSoldOut) soldOut.add(1);
  else checkoutOk.add(ok);
  if (ok) reserved.add(1);
}

export function handleSummary(data) {
  return { "tooling/load/.data/drop-50k-summary.json": JSON.stringify(data, null, 2) };
}
