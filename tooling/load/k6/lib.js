// Shared helpers for the k6 scenarios. Plain k6 JS modules (no bundler).
// Environment (all via `k6 run -e NAME=value`):
//   BASE_URL        API origin, required for a real run (default http://localhost:3000, staging only)
//   TOKENS_FILE     JSON array of shopper bearer tokens produced by tooling/load/seed.mjs (default ./.data/tokens.json)
//   MANIFEST_FILE   seed manifest produced by seed.mjs (default ./.data/seed.json)
//   WEBHOOK_SECRET  HMAC secret of the staging PSP sandbox adapter (webhook-replay.js only)
// Safety: refuses to run against a host that looks like production.
import { SharedArray } from "k6/data";
import { fail } from "k6";

export const BASE_URL = (__ENV.BASE_URL || "http://localhost:3000").replace(/\/$/, "");
if (/(^|\.)(api|www)\.(z-?outlet|haul)\.[a-z]+$/i.test(BASE_URL.replace(/^https?:\/\//, ""))) {
  fail("Refusing to load-test a production-looking host: " + BASE_URL);
}

export const tokens = new SharedArray("tokens", () => JSON.parse(open(__ENV.TOKENS_FILE || "./.data/tokens.json")));
export const manifest = new SharedArray("manifest", () => [JSON.parse(open(__ENV.MANIFEST_FILE || "./.data/seed.json"))]);

/** UUIDv7-shaped idempotency key: 48-bit ms timestamp + random tail. Unique per call. */
export function idemKey() {
  const hex = (n) => {
    let o = "";
    for (let i = 0; i < n; i += 1) o += Math.floor(Math.random() * 16).toString(16);
    return o;
  };
  const t = Date.now().toString(16).padStart(12, "0");
  return `${t.slice(0, 8)}-${t.slice(8, 12)}-7${hex(3)}-${"89ab"[Math.floor(Math.random() * 4)]}${hex(3)}-${hex(12)}`;
}

export function authHeaders(vu, extra) {
  const tok = tokens[(vu - 1) % tokens.length];
  return Object.assign(
    { Authorization: "Bearer " + tok, "Content-Type": "application/json", "X-Load-Test": "1" },
    extra || {},
  );
}

/** Thresholds shared by every scenario; individual scripts add their own. SLOs from spec T8. */
export const SLO = {
  checkoutSuccess: "rate>=0.995",
  reserveP95Ms: 150,
  searchP95Ms: 150,
  readP95Ms: 300,
  paymentConfirmP95Ms: 5000,
};
