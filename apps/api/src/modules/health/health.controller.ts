import { Controller, Get, HttpCode, Inject } from "@nestjs/common";
import { z } from "zod";
import { Contract, NoRateLimit, Public } from "../../platform/decorators.js";
import { ProblemError } from "../../platform/problem.js";
import { ReadinessProbe } from "./readiness.js";

const Check = z.enum(["ok", "failed", "skipped"]);
const Live = z.strictObject({ status: z.literal("ok") });
const Ready = z.strictObject({ status: z.literal("ready"), checks: z.strictObject({ lifecycle: Check, db: Check, migrations: Check, role: Check }) });

export const READINESS = Symbol("READINESS");

/** Kubernetes probes. Global (no market), public, exempt from rate limits (they come from the kubelet, not users). */
@Controller("v1/health")
export class HealthController {
  constructor(@Inject(READINESS) private readonly readiness: ReadinessProbe) {}

  @Get("live")
  @HttpCode(200)
  @Public()
  @NoRateLimit("kubelet liveness probe")
  @Contract({ operationId: "getLiveness", summary: "Liveness probe", tags: ["Health"], response: Live, cacheControl: "no-store", maxQueries: 0 })
  live(): z.infer<typeof Live> {
    return { status: "ok" };
  }

  @Get("ready")
  @HttpCode(200)
  @Public()
  @NoRateLimit("kubelet readiness probe")
  @Contract({ operationId: "getReadiness", summary: "Readiness probe: DB, migrations, runtime role, draining", tags: ["Health"], response: Ready, cacheControl: "no-store", maxQueries: 1 })
  async ready(): Promise<z.infer<typeof Ready>> {
    const r = await this.readiness.check();
    // Which check failed is operational, not personal; no messages or versions are returned.
    if (!r.ready) throw new ProblemError(503, "not-ready", "The service is not ready", { detail: Object.entries(r.checks).filter(([, v]) => v === "failed").map(([k]) => k).join(","), retryAfterS: 5, headers: { "Retry-After": "5" } });
    return { status: "ready", checks: r.checks };
  }
}
