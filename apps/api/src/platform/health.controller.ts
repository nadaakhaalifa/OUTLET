import { Controller, Get, Header, Inject, Injectable, Optional, Res } from "@nestjs/common";
import { Public, SkipRateLimit } from "./decorators";
import type { ApiResponse } from "./http-types";
import type { ReadinessCheck } from "./ports";

@Injectable()
export class ReadinessRegistry {
  private readonly checks: ReadinessCheck[] = [];
  register(check: ReadinessCheck): void {
    this.checks.push(check);
  }
  all(): readonly ReadinessCheck[] {
    return this.checks;
  }
}

/** Optional production report (provider and dependency status). Names and counters only, no PII. */
export const READINESS_REPORT = Symbol("READINESS_REPORT");
export interface ReadinessReport {
  describe(): Promise<Record<string, unknown>>;
}

/** Liveness and readiness. No dependencies are touched by liveness; no data is returned by either. */
@Controller()
export class HealthController {
  constructor(
    private readonly registry: ReadinessRegistry,
    @Optional() @Inject(READINESS_REPORT) private readonly report?: ReadinessReport,
  ) {}

  @Get("health")
  @Public()
  @SkipRateLimit()
  @Header("Cache-Control", "no-store")
  live(): { status: "ok" } {
    return { status: "ok" };
  }

  @Get("ready")
  @Public()
  @SkipRateLimit()
  @Header("Cache-Control", "no-store")
  async ready(@Res({ passthrough: true }) res: ApiResponse): Promise<{ status: "ready" | "not_ready"; checks: Record<string, "ok" | "fail"> } & Record<string, unknown>> {
    const checks: Record<string, "ok" | "fail"> = {};
    await Promise.all(
      this.registry.all().map(async (c) => {
        try {
          checks[c.name] = (await c.check()) ? "ok" : "fail";
        } catch {
          checks[c.name] = "fail";
        }
      }),
    );
    const ok = Object.values(checks).every((v) => v === "ok");
    if (!ok) res.status(503);
    let extra: Record<string, unknown> = {};
    if (this.report !== undefined) {
      try {
        extra = await this.report.describe();
      } catch {
        extra = { report: "unavailable" };
      }
    }
    return { status: ok ? "ready" : "not_ready", checks, ...extra };
  }
}
