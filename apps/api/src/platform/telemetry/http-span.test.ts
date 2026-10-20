import { Controller, Get, Param, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { SpanKind } from "@opentelemetry/api";
import { node, tracing } from "@opentelemetry/sdk-node";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createRequestContextMiddleware } from "../request-context";
import { HttpTelemetryInterceptor } from "./http.interceptor";
import { ATTRIBUTE_ALLOW_LIST } from "./attributes";

@Controller("v1/things")
class ThingsController {
  @Get(":id")
  get(@Param("id") id: string): { id: string } {
    return { id };
  }
}

describe("HTTP span via in-process harness", () => {
  const exporter = new tracing.InMemorySpanExporter();
  const provider = new node.NodeTracerProvider({ spanProcessors: [new tracing.SimpleSpanProcessor(exporter)] });
  let app: INestApplication;
  beforeAll(async () => {
    provider.register();
    const mod = await Test.createTestingModule({ controllers: [ThingsController] }).compile();
    app = mod.createNestApplication();
    let n = 0;
    app.use(
      createRequestContextMiddleware({
        uuidV7: () => `00000000-0000-7000-8000-${String(++n).padStart(12, "0")}`,
        hex: (b: number) => "a".repeat(b * 2).slice(0, b * 2),
      } as never),
    );
    app.useGlobalInterceptors(new HttpTelemetryInterceptor());
    await app.init();
  });
  afterAll(async () => {
    await app.close();
    await provider.shutdown();
  });
  beforeEach(() => exporter.reset());

  it("creates a server span with the route template and continues the incoming trace", async () => {
    const traceId = "0af7651916cd43dd8448eb211c80319c";
    await request(app.getHttpServer())
      .get("/v1/things/secret-id-123")
      .set("traceparent", `00-${traceId}-b7ad6b7169203331-01`)
      .expect(200);
    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    const s = spans[0];
    expect(s?.kind).toBe(SpanKind.SERVER);
    expect(s?.name).toBe("GET /v1/things/:id");
    expect(s?.spanContext().traceId).toBe(traceId);
    expect(s?.parentSpanContext?.spanId).toBe("b7ad6b7169203331");
    expect(s?.attributes["http.response.status_code"]).toBe(200);
    expect(JSON.stringify(s?.attributes)).not.toContain("secret-id-123");
    for (const k of Object.keys(s?.attributes ?? {})) expect(ATTRIBUTE_ALLOW_LIST.has(k)).toBe(true);
  });

  it("records 404 handler-less routes without spans and does not break", async () => {
    await request(app.getHttpServer()).get("/nope").expect(404);
    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });
});
