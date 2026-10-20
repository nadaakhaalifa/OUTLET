import type {
  AuditRecord,
  AuditStore,
  FlagPort,
  GatewayCachePort,
  LlmProviderPort,
  ProviderRequest,
  ProviderResponse,
  TokenUsageStore,
} from "../domain/types";

/** Scriptable provider. Records every request so tests can assert exactly what would leave. */
export class FakeLlmProvider implements LlmProviderPort {
  readonly calls: ProviderRequest[] = [];
  /** Returns the raw model text. Default: an empty object (invalid for every schema). */
  respond: (req: ProviderRequest) => string | Promise<string> = () => "{}";
  failWith: Error | null = null;
  tokensIn = 30;
  tokensOut = 20;
  hang = false;

  async complete(req: ProviderRequest): Promise<ProviderResponse> {
    this.calls.push(req);
    if (this.hang) return new Promise<ProviderResponse>(() => undefined);
    if (this.failWith !== null) throw this.failWith;
    return { text: await this.respond(req), model: req.model, tokensIn: this.tokensIn, tokensOut: this.tokensOut };
  }
}

export class InMemoryAuditStore implements AuditStore {
  readonly rows: AuditRecord[] = [];
  async record(r: AuditRecord): Promise<void> {
    this.rows.push(r);
  }
  async list(feature: string, limit: number): Promise<readonly AuditRecord[]> {
    return this.rows
      .filter((r) => r.feature === feature)
      .sort((a, b) => b.atMs - a.atMs || (a.id < b.id ? 1 : -1))
      .slice(0, limit);
  }
}

export class InMemoryTokenUsage implements TokenUsageStore {
  private readonly m = new Map<string, number>();
  private key = (u: string, d: string, f: string): string => `${u}|${d}|${f}`;
  async used(userId: string, day: string, feature: string): Promise<number> {
    return this.m.get(this.key(userId, day, feature)) ?? 0;
  }
  async add(userId: string, day: string, feature: string, tokens: number): Promise<void> {
    const k = this.key(userId, day, feature);
    this.m.set(k, (this.m.get(k) ?? 0) + tokens);
  }
}

export class InMemoryGatewayCache implements GatewayCachePort {
  private readonly m = new Map<string, { v: string; exp: number }>();
  constructor(private readonly nowMs: () => number) {}
  async get(key: string): Promise<string | null> {
    const e = this.m.get(key);
    if (e === undefined || e.exp <= this.nowMs()) return null;
    return e.v;
  }
  async set(key: string, value: string, ttlMs: number): Promise<void> {
    this.m.set(key, { v: value, exp: this.nowMs() + ttlMs });
  }
}

export class StaticFlags implements FlagPort {
  constructor(private readonly on: ReadonlySet<string> = new Set()) {}
  async isEnabled(key: string): Promise<boolean> {
    return this.on.has(key);
  }
}
