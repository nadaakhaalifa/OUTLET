/** Role choice: the very first screen. "shopper" continues onboarding, "brand" hands off to /brand. */
export const ROLES = ["shopper", "brand"] as const;
export type Role = (typeof ROLES)[number];

export function parseRole(raw: string | null): Role | null {
  return raw === "shopper" || raw === "brand" ? raw : null;
}

/** Persists the choice per device and records it in the onboarding funnel (best effort, never blocks). */
export interface RoleChoicePort {
  load(): Promise<Role | null>;
  choose(role: Role): Promise<void>;
  /** Sends a role queued while signed out. Optional: ports without a funnel have nothing to flush. */
  flushFunnel?(): Promise<void>;
}

export class InMemoryRoleChoicePort implements RoleChoicePort {
  readonly recorded: Role[] = [];
  constructor(private current: Role | null = null) {}
  async load(): Promise<Role | null> {
    return this.current;
  }
  async choose(role: Role): Promise<void> {
    this.current = role;
    this.recorded.push(role);
  }
}

export type EntryRoute = "/welcome-region" | "/role" | "/brand" | "/onboarding/blocked" | "/(tabs)";

export interface EntryFacts {
  readonly blocked: boolean;
  readonly role: Role | null;
  /** True once the first-run region screen was completed on this device (device-local marker). */
  readonly regionChosen: boolean;
}

/**
 * Where the app opens (ADR-0055, spec F1/F1b). The age block always wins, then brand mode. A first launch sees the
 * region screen once, then the entrance page once; every later launch lands on Home, signed in or not. Sign-up state
 * (a session, a half-finished onboarding) never routes a shopper into the sign-up screens: the only place an account
 * is asked for is the Checkout gate.
 */
export function resolveEntry(f: EntryFacts): EntryRoute {
  if (f.blocked) return "/onboarding/blocked";
  if (f.role === "brand") return "/brand";
  if (!f.regionChosen) return "/welcome-region";
  if (f.role === null) return "/role";
  return "/(tabs)";
}

/** The brand application flow is owned by another module; typed routes do not know it until it lands. */
export const BRAND_ROUTE = "/brand";
