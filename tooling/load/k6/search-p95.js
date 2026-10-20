// Scenario 4 (T8, spec 4): search p95 < 150 ms; rate limit is 30 requests / 10 s per user so we spread over many tokens.
import http from "k6/http";
import { check } from "k6";
import { Rate } from "k6/metrics";
import { BASE_URL, SLO, authHeaders, manifest } from "./lib.js";

const empty = new Rate("search_no_result");
export const options = {
  scenarios: {
    search: {
      executor: "constant-arrival-rate",
      rate: Number(__ENV.RPS || 300),
      timeUnit: "1s",
      duration: __ENV.DURATION || "5m",
      preAllocatedVUs: 200,
      maxVUs: 2000,
    },
  },
  thresholds: {
    "http_req_duration{name:search}": [`p(95)<${SLO.searchP95Ms}`],
    search_no_result: ["rate<0.08"], // spec 4 metric
    http_req_failed: ["rate<0.005"],
    checks: ["rate>0.995"],
  },
};

export default function () {
  const terms = manifest[0].searchTerms; // include Arabic, Franco-Arabic, mixed script and Eastern numerals
  const q = terms[(__ITER + __VU) % terms.length];
  const res = http.get(`${BASE_URL}/v1/search?q=${encodeURIComponent(q)}&limit=24`, { headers: authHeaders(__VU), tags: { name: "search" } });
  check(res, { "200": (r) => r.status === 200 });
  try {
    const b = res.json();
    empty.add(!b.items || b.items.length === 0);
  } catch {
    empty.add(true);
  }
}
