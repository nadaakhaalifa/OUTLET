/** robots.txt parser (RFC 9309 subset): groups, Allow/Disallow with * and $, longest match wins, Crawl-delay. */

export interface RobotsRule {
  readonly allow: boolean;
  readonly pattern: string;
}
export interface RobotsPolicy {
  readonly rules: readonly RobotsRule[];
  /** Seconds, from Crawl-delay; null when absent. */
  readonly crawlDelaySeconds: number | null;
  /** True when the whole site is off limits (5xx / unreachable robots.txt, RFC 9309 2.3.1.4). */
  readonly disallowAll: boolean;
}

export const ALLOW_ALL: RobotsPolicy = { rules: [], crawlDelaySeconds: null, disallowAll: false };
export const DISALLOW_ALL: RobotsPolicy = { rules: [], crawlDelaySeconds: null, disallowAll: true };
const MAX_ROBOTS_BYTES = 500 * 1024;

interface Group {
  readonly agents: string[];
  readonly rules: RobotsRule[];
  crawlDelay: number | null;
}

export function parseRobots(text: string, userAgentToken: string): RobotsPolicy {
  const groups: Group[] = [];
  let current: Group | null = null;
  let lastWasAgent = false;
  for (const rawLine of text.slice(0, MAX_ROBOTS_BYTES).split(/\r?\n/)) {
    const line = (rawLine.split("#")[0] ?? "").trim();
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (key === "user-agent") {
      if (current === null || !lastWasAgent) {
        current = { agents: [], rules: [], crawlDelay: null };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (current === null) continue;
    if (key === "allow" || key === "disallow") {
      if (value !== "") current.rules.push({ allow: key === "allow", pattern: value });
    } else if (key === "crawl-delay") {
      const n = Number(value);
      if (Number.isFinite(n) && n >= 0 && n <= 3_600) current.crawlDelay = n;
    }
  }
  const ua = userAgentToken.toLowerCase();
  // The most specific (longest) agent token contained in our UA wins; "*" is the fallback.
  let best: Group | null = null;
  let bestLen = -1;
  for (const g of groups) {
    for (const a of g.agents) {
      const len = a === "*" ? 0 : ua.includes(a) ? a.length : -1;
      if (len > bestLen) {
        best = g;
        bestLen = len;
      }
    }
  }
  if (best === null) return ALLOW_ALL;
  return { rules: best.rules, crawlDelaySeconds: best.crawlDelay, disallowAll: false };
}

/** RFC 9309: 2xx parse; 4xx = no restrictions; 5xx or unreachable = complete disallow. */
export function robotsFromFetch(status: number | null, body: string, userAgentToken: string): RobotsPolicy {
  if (status === null || status >= 500) return DISALLOW_ALL;
  if (status >= 200 && status < 300) return parseRobots(body, userAgentToken);
  return ALLOW_ALL;
}

function patternToRegex(p: string): RegExp {
  const anchored = p.endsWith("$");
  const body = (anchored ? p.slice(0, -1) : p).replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*+/g, ".*");
  return new RegExp(`^${body}${anchored ? "$" : ""}`);
}

export function isPathAllowed(policy: RobotsPolicy, pathAndQuery: string): boolean {
  if (policy.disallowAll) return false;
  let bestLen = -1;
  let allowed = true;
  for (const r of policy.rules) {
    if (!patternToRegex(r.pattern).test(pathAndQuery)) continue;
    const len = r.pattern.length;
    if (len > bestLen || (len === bestLen && r.allow)) {
      bestLen = len;
      allowed = r.allow;
    }
  }
  return allowed;
}
