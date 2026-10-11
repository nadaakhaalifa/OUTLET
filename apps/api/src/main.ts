import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { configureApp } from "./app.setup";
import { ConfigError, loadConfig } from "./config/env";

async function bootstrap(): Promise<void> {
  const config = loadConfig(process.env);
  const app = await NestFactory.create(AppModule.register(config), { bufferLogs: false, rawBody: true });
  configureApp(app, config);
  app.enableShutdownHooks();
  await app.listen(config.port);
}

bootstrap().catch((err: unknown) => {
  if (err instanceof ConfigError) {
    process.stderr.write(`${err.message}\n`);
  } else {
    process.stderr.write(`${err instanceof Error ? `${err.name}: ${err.message}` : "startup failed"}\n`);
  }
  process.exit(1);
});
