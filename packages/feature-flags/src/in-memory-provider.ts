import type { EvaluationContext, FlagProvider, ResolutionDetails } from "./provider";

type Value = boolean | string | number;

/** Development/test provider. Holds explicit values only; anything absent is FLAG_NOT_FOUND. */
export class InMemoryFlagProvider implements FlagProvider {
  readonly metadata = { name: "outlet-in-memory-dev-fixture" } as const;
  readonly runsOn = "server" as const;
  private readonly values = new Map<string, Value>();

  constructor(initial: Readonly<Record<string, Value>> = {}) {
    for (const [k, v] of Object.entries(initial)) this.values.set(k, v);
  }

  set(key: string, value: Value): void {
    this.values.set(key, value);
  }
  unset(key: string): void {
    this.values.delete(key);
  }

  resolveBooleanEvaluation(key: string, def: boolean, _ctx: EvaluationContext): ResolutionDetails<boolean> {
    return this.resolve(key, def, "boolean");
  }
  resolveStringEvaluation(key: string, def: string, _ctx: EvaluationContext): ResolutionDetails<string> {
    return this.resolve(key, def, "string");
  }
  resolveNumberEvaluation(key: string, def: number, _ctx: EvaluationContext): ResolutionDetails<number> {
    return this.resolve(key, def, "number");
  }

  private resolve<T extends Value>(key: string, def: T, type: "boolean" | "string" | "number"): ResolutionDetails<T> {
    if (!this.values.has(key)) {
      return { value: def, reason: "ERROR", errorCode: "FLAG_NOT_FOUND", errorMessage: `unknown flag ${key}` };
    }
    const v = this.values.get(key);
    if (typeof v !== type) {
      return { value: def, reason: "ERROR", errorCode: "TYPE_MISMATCH", errorMessage: `${key} is not ${type}` };
    }
    return { value: v as T, reason: "STATIC", variant: String(v) };
  }
}
