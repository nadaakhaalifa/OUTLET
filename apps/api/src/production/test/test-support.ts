import "reflect-metadata";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { createTestDatabaseUpTo } from "@outlet/db";
import type { Kysely } from "kysely";
import { AppModule } from "../../app.module";
import { configureApp } from "../../app.setup";
import { loadConfig, type AppConfig } from "../../config/env";
import { createPgliteDatabase, type PgliteInstance } from "../../platform/db";

export const PROD_ENV = {
  NODE_ENV: "production",
  DEV_FIXTURES: "false",
  DATABASE_URL: "postgres://app@db.invalid/outlet",
  SIZE_DEMAND_PSEUDONYM_KEY: "d".repeat(32),
  OTP_PEPPER: "p".repeat(32),
  IP_HASH_KEY: "k".repeat(32),
  AGE_BLOCK_KEY: "a".repeat(32),
} as const;

export interface ProductionTestApp {
  readonly app: INestApplication;
  readonly db: Kysely<Record<string, never>>;
  readonly config: AppConfig;
}

/** Latest migration number; the production composition needs every table. */
const LAST_MIGRATION = 9999;

export async function newTestDb(): Promise<Kysely<Record<string, never>>> {
  const raw = await createTestDatabaseUpTo(LAST_MIGRATION);
  return createPgliteDatabase<Record<string, never>>(raw as unknown as PgliteInstance);
}

/** The real production module graph over PGlite, with the real HTTP configuration. */
export async function bootProduction(): Promise<ProductionTestApp> {
  const db = await newTestDb();
  const config = loadConfig({ ...PROD_ENV });
  const mod = await Test.createTestingModule({ imports: [AppModule.register(config, {}, { production: { db } })] }).compile();
  const app = mod.createNestApplication();
  configureApp(app, config);
  await app.init();
  return { app, db, config };
}
