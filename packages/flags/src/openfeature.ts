import { ErrorCode, StandardResolutionReasons } from "@openfeature/server-sdk";
import type { EvaluationContext, JsonValue, Provider, ResolutionDetails } from "@openfeature/server-sdk";
import type { FlagService } from "./service.js";

const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);

/**
 * OpenFeature server provider over FlagService (boolean flags only; other types are not used).
 * Context mapping: targetingKey -> userId, plus custom fields marketId (required), storeId, deviceId.
 */
export class OutletFlagProvider implements Provider {
  readonly metadata = { name: "outlet-flags" } as const;
  readonly runsOn = "server" as const;

  constructor(private readonly flags: FlagService) {}

  async resolveBooleanEvaluation(flagKey: string, defaultValue: boolean, context: EvaluationContext): Promise<ResolutionDetails<boolean>> {
    const marketId = str(context.marketId);
    if (!marketId) {
      return { value: defaultValue, reason: StandardResolutionReasons.ERROR, errorCode: ErrorCode.INVALID_CONTEXT, errorMessage: "marketId required" };
    }
    const userId = str(context.targetingKey);
    const storeId = str(context.storeId);
    const deviceId = str(context.deviceId);
    const value = await this.flags.isEnabled(
      flagKey,
      { marketId, ...(userId ? { userId } : {}), ...(storeId ? { storeId } : {}), ...(deviceId ? { deviceId } : {}) },
      defaultValue,
    );
    return { value, reason: StandardResolutionReasons.TARGETING_MATCH };
  }

  resolveStringEvaluation(_: string, defaultValue: string): Promise<ResolutionDetails<string>> {
    return Promise.resolve({ value: defaultValue, reason: StandardResolutionReasons.ERROR, errorCode: ErrorCode.TYPE_MISMATCH });
  }
  resolveNumberEvaluation(_: string, defaultValue: number): Promise<ResolutionDetails<number>> {
    return Promise.resolve({ value: defaultValue, reason: StandardResolutionReasons.ERROR, errorCode: ErrorCode.TYPE_MISMATCH });
  }
  resolveObjectEvaluation<T extends JsonValue>(_: string, defaultValue: T): Promise<ResolutionDetails<T>> {
    return Promise.resolve({ value: defaultValue, reason: StandardResolutionReasons.ERROR, errorCode: ErrorCode.TYPE_MISMATCH });
  }
}
