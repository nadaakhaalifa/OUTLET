import type { INestApplication } from "@nestjs/common";
import type { AppConfig } from "./config/env";
import { createRequestContextMiddleware, ID_GENERATOR, type ApiRequest, type ApiResponse, type IdGenerator } from "./platform";

interface ExpressLike {
  disable(name: string): void;
  set(name: string, value: unknown): void;
}

/** Applied identically by main.ts and the tests, so tests exercise the real HTTP configuration. */
export function configureApp(app: INestApplication, config: AppConfig): void {
  app.setGlobalPrefix("v1");
  const express = app.getHttpAdapter().getInstance() as ExpressLike;
  express.disable("x-powered-by");
  express.set("trust proxy", config.trustProxyHops);
  express.set("etag", false);

  const ids = app.get<IdGenerator>(ID_GENERATOR);
  app.use(createRequestContextMiddleware(ids));
  app.use((_req: ApiRequest, res: ApiResponse, next: () => void) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "no-store");
    next();
  });
}
