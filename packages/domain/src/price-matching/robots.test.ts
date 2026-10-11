import { describe, expect, it } from "vitest";
import { ALLOW_ALL, isPathAllowed, parseRobots, robotsFromFetch } from "./robots";
import { BREAKER_CLOSED, BREAKER_THRESHOLD, DomainPacer, backoffMs, breakerCanAttempt, breakerOnFailure } from "./politeness";
import fc from "fast-check";

const UA = "OutletPriceBot/1.0";
const TXT = `
User-agent: *
Disallow: /cart
Disallow: /search?
Allow: /cart/public$
Crawl-delay: 10

User-agent: outletpricebot
Disallow: /private
Allow: /private/ok
Disallow: /*.pdf$
`;

describe("robots.txt", () => {
  it("prefers the most specific agent group and longest match", () => {
    const p = parseRobots(TXT, UA);
    expect(p.crawlDelaySeconds).toBeNull();
    expect(isPathAllowed(p, "/private/secret")).toBe(false);
    expect(isPathAllowed(p, "/private/ok")).toBe(true);
    expect(isPathAllowed(p, "/cart")).toBe(true); // the wildcard group does not apply to us
    expect(isPathAllowed(p, "/files/a.pdf")).toBe(false);
    expect(isPathAllowed(p, "/files/a.pdf?x")).toBe(true);
  });
  it("falls back to the wildcard group with Crawl-delay and Allow-over-Disallow ties", () => {
    const p = parseRobots(TXT, "OtherBot");
    expect(p.crawlDelaySeconds).toBe(10);
    expect(isPathAllowed(p, "/cart/items")).toBe(false);
    expect(isPathAllowed(p, "/cart/public")).toBe(true);
    expect(isPathAllowed(p, "/p/shoe")).toBe(true);
    expect(DomainPacer.gapFor(p.crawlDelaySeconds)).toBe(10_000);
  });
  it("follows RFC 9309 failure semantics", () => {
    expect(isPathAllowed(robotsFromFetch(503, "", UA), "/")).toBe(false);
    expect(isPathAllowed(robotsFromFetch(null, "", UA), "/")).toBe(false);
    expect(isPathAllowed(robotsFromFetch(404, "", UA), "/")).toBe(true);
    expect(isPathAllowed(robotsFromFetch(200, "User-agent: *\nDisallow: /", UA), "/p")).toBe(false);
    expect(isPathAllowed(ALLOW_ALL, "/anything")).toBe(true);
    expect(isPathAllowed(parseRobots("User-agent: *\nDisallow:", UA), "/x")).toBe(true);
  });
});

describe("politeness", () => {
  it("never schedules two requests to a domain closer than the gap (property: <= 12 per rolling minute)", () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 0, max: 20_000 }), { minLength: 1, maxLength: 60 }), (deltas) => {
        const pacer = new DomainPacer();
        let now = 1_000_000;
        const slots: number[] = [];
        for (const d of deltas) {
          now += d;
          slots.push(pacer.reserve("brand.eg", now, 5_000));
        }
        for (let i = 1; i < slots.length; i += 1) expect((slots[i] ?? 0) - (slots[i - 1] ?? 0)).toBeGreaterThanOrEqual(5_000);
        for (const s of slots) expect(slots.filter((t) => t >= s && t < s + 60_000).length).toBeLessThanOrEqual(12);
      }),
    );
  });
  it("domains are independent", () => {
    const p = new DomainPacer();
    expect(p.reserve("a.eg", 0)).toBe(0);
    expect(p.reserve("b.eg", 0)).toBe(0);
    expect(p.reserve("a.eg", 0)).toBe(5_000);
  });
  it("backoff is bounded and breaker opens after the threshold, then cools off", () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: 100 }), fc.double({ min: 0, max: 1, noNaN: true }), (a, u) => {
      const b = backoffMs(a, u);
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThanOrEqual(300_000);
    }));
    let s = BREAKER_CLOSED;
    for (let i = 0; i < BREAKER_THRESHOLD; i += 1) s = breakerOnFailure(s, 1_000);
    expect(breakerCanAttempt(s, 2_000)).toBe(false);
    expect(breakerCanAttempt(s, 1_000 + 6 * 3_600_000)).toBe(true);
  });
});
