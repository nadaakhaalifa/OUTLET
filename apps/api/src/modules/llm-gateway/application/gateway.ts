import { createHash } from "node:crypto";
import { CostBreaker } from "../domain/breaker";
import { detectInjection, NEUTRALISED } from "../domain/injection";
import { defaultRegistry, type PromptRegistry } from "../domain/prompts";
import { renderEnvelope } from "../domain/render";
import { scrubPii } from "../domain/scrub";
import {
  DEFAULT_GATEWAY_CONFIG,
  type AuditOutcome,
  type AuditStore,
  type DataField,
  type FlagPort,
  type GatewayCachePort,
  type GatewayConfig,
  type GatewayRequest,
  type GatewayResult,
  type LlmProviderPort,
  type PromptTemplate,
  type TokenUsageStore,
  type UnavailableReason,
} from "../domain/types";

export interface GatewayClock {
  nowMs(): number;
}
export interface GatewayIds {
  uuidV7(): string;
}

export interface GatewayDeps {
  readonly provider: LlmProviderPort;
  readonly audit: AuditStore;
  readonly usage: TokenUsageStore;
  readonly cache: GatewayCachePort;
  readonly flags: FlagPort;
  readonly clock: GatewayClock;
  readonly ids: GatewayIds;
  readonly config?: GatewayConfig;
  readonly registry?: PromptRegistry;
}

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

/** Canonical JSON with sorted keys so equal filters hash equally. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
    .join(",")}}`;
}

/** Rough token estimate used for budgeting before the call (provider counts replace it after). */
export const estimateTokens = (text: string): number => Math.ceil(text.length / 3);

const TIMEOUT = Symbol("timeout");

const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/**
 * llm-gateway (T12). Every model call in the system goes through `run`. It never throws for
 * expected failures: callers receive `unavailable` and use their rule-based fallback.
 *
 * Order of checks (cheapest, safest first): master switch, kill switch, prompt registry, residency
 * (P2/P3 refused), injection and scrub, breaker, cache, per-user token budget, provider call,
 * schema validation, caller acceptance check, accounting and audit.
 */
export class LlmGateway {
  private readonly cfg: GatewayConfig;
  private readonly registry: PromptRegistry;
  private readonly breaker: CostBreaker;

  constructor(private readonly d: GatewayDeps) {
    this.cfg = d.config ?? DEFAULT_GATEWAY_CONFIG;
    this.registry = d.registry ?? defaultRegistry();
    this.breaker = new CostBreaker({
      failureThreshold: this.cfg.breakerFailureThreshold,
      openMs: this.cfg.breakerOpenMs,
      costCapMicrosPerHour: this.cfg.globalCostCapMicrosPerHour,
    });
  }

  /** Visible for dashboards and tests. */
  breakerState(): "closed" | "open" | "half_open" {
    return this.breaker.state(this.d.clock.nowMs());
  }

  promptHash(p: PromptTemplate<unknown>): string {
    return sha256(`${p.id}@${p.version}\n${p.system}`);
  }

  private async audit(p: PromptTemplate<unknown>, outcome: AuditOutcome, model: string, tin: number, tout: number, latency: number): Promise<void> {
    await this.d.audit.record({
      id: this.d.ids.uuidV7(),
      feature: p.feature,
      promptId: `${p.id}@${p.version}`,
      promptHash: this.promptHash(p),
      model,
      tokensIn: tin,
      tokensOut: tout,
      latencyMs: latency,
      outcome,
      atMs: this.d.clock.nowMs(),
    });
  }

  private no<T>(reason: UnavailableReason): GatewayResult<T> {
    return { kind: "unavailable", reason };
  }

  async run<T>(req: GatewayRequest<T>): Promise<GatewayResult<T>> {
    const p = req.prompt;
    if (!this.cfg.enabled) return this.no("disabled");
    if (!this.registry.has(p)) return this.no("unknown_prompt");
    let flagOn: boolean;
    try {
      flagOn = await this.d.flags.isEnabled(p.killSwitch);
    } catch {
      flagOn = false; // fail closed
    }
    if (!flagOn) return this.no("kill_switch");

    // Residency (ADR-0025 / B1): P2 and P3 never leave without consent AND a licence.
    const sensitive = req.fields.some((f) => f.dataClass === "P2" || f.dataClass === "P3");
    if (sensitive && !(req.crossBorderConsent && this.cfg.transferLicensed)) {
      await this.audit(p, "blocked", this.cfg.model, 0, 0, 0);
      return this.no("residency");
    }

    const neutralised: string[] = [];
    const prepared: DataField[] = [];
    for (const f of req.fields) {
      let value = scrubPii(f.value).text;
      if (f.trust === "untrusted" && detectInjection(value).flagged) {
        if (f.required === true) {
          await this.audit(p, "blocked", this.cfg.model, 0, 0, 0);
          return this.no("injection");
        }
        value = NEUTRALISED;
        neutralised.push(f.name);
      }
      prepared.push({ ...f, value });
    }

    const now = this.d.clock.nowMs();
    if (!this.breaker.allow(now)) return this.no("breaker_open");

    const cacheKey = sha256(`${p.id}@${p.version}|${canonicalJson(req.cacheKeyInput)}`);
    const hit = await this.d.cache.get(cacheKey);
    if (hit !== null) {
      const parsed = p.output.safeParse(JSON.parse(hit));
      if (parsed.success && (req.accept === undefined || req.accept(parsed.data))) {
        await this.audit(p, "cached", this.cfg.model, 0, 0, 0);
        return { kind: "ok", value: parsed.data, cached: true, tokensIn: 0, tokensOut: 0, neutralisedFields: neutralised };
      }
    }

    const data = renderEnvelope(prepared);
    const estimate = estimateTokens(p.system) + estimateTokens(data) + p.maxOutputTokens;
    const day = dayOf(now);
    const used = await this.d.usage.used(req.userId, day, p.feature);
    if (used + estimate > this.cfg.dailyTokensPerUser) return this.no("budget_exceeded");

    const started = this.d.clock.nowMs();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let raw;
    try {
      const timeout = new Promise<typeof TIMEOUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMEOUT), p.timeoutMs);
      });
      const r = await Promise.race([
        this.d.provider.complete({ model: this.cfg.model, system: p.system, data, maxOutputTokens: p.maxOutputTokens, timeoutMs: p.timeoutMs }),
        timeout,
      ]);
      if (r === TIMEOUT) {
        this.breaker.failure(this.d.clock.nowMs());
        await this.audit(p, "timeout", this.cfg.model, 0, 0, p.timeoutMs);
        return this.no("timeout");
      }
      raw = r;
    } catch {
      this.breaker.failure(this.d.clock.nowMs());
      await this.audit(p, "provider_error", this.cfg.model, 0, 0, this.d.clock.nowMs() - started);
      return this.no("provider_error");
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }

    const latency = this.d.clock.nowMs() - started;
    const tokens = raw.tokensIn + raw.tokensOut;
    this.breaker.addCost(this.d.clock.nowMs(), tokens * this.cfg.costMicrosPerToken);
    await this.d.usage.add(req.userId, day, p.feature, tokens);

    let json: unknown;
    try {
      json = JSON.parse(raw.text);
    } catch {
      json = undefined;
    }
    const parsed = json === undefined ? null : p.output.safeParse(json);
    if (parsed === null || !parsed.success || (req.accept !== undefined && !req.accept(parsed.data))) {
      this.breaker.failure(this.d.clock.nowMs());
      await this.audit(p, "invalid_output", raw.model, raw.tokensIn, raw.tokensOut, latency);
      return this.no("invalid_output");
    }
    this.breaker.success(this.d.clock.nowMs());
    await this.d.cache.set(cacheKey, JSON.stringify(parsed.data), this.cfg.cacheTtlMs);
    await this.audit(p, "ok", raw.model, raw.tokensIn, raw.tokensOut, latency);
    return { kind: "ok", value: parsed.data, cached: false, tokensIn: raw.tokensIn, tokensOut: raw.tokensOut, neutralisedFields: neutralised };
  }
}
