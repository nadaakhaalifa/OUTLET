import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { configureApp } from "./app.setup";
import { ConfigError, loadConfig } from "./config/env";
import { HttpTelemetryInterceptor, startTelemetry } from "./platform/telemetry";

async function bootstrap(): Promise<void> {
  // Must start before Nest so instrumentation sees the first request. No-op without OTEL_EXPORTER_OTLP_ENDPOINT.
  const telemetry = startTelemetry(process.env);
  const config = loadConfig(process.env);
  const app = await NestFactory.create(AppModule.register(config), { bufferLogs: false, rawBody: true });
  configureApp(app, config);
  app.useGlobalInterceptors(new HttpTelemetryInterceptor());
  app.enableShutdownHooks();
  await app.listen(config.port);
  process.once("beforeExit", () => void telemetry.shutdown());
}

bootstrap().catch((err: unknown) => {
  if (err instanceof ConfigError) {
    process.stderr.write(`${err.message}\n`);
  } else {
    process.stderr.write(`${err instanceof Error ? `${err.name}: ${err.message}` : "startup failed"}\n`);
  }
  process.exit(1);
});
