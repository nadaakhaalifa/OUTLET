import { markConfigured } from "./unconfigured";
import type { AppConfig } from "../config/env";
import { createAwsAdapters, type AwsAdapters } from "./adapters/aws";

export * from "./adapters/aws";

const cache = new WeakMap<AppConfig, AwsAdapters>();

/** One AWS adapter set per AppConfig, shared by ports.ts and compose.ts. Absent config yields all-null (Unconfigured). */
export function awsAdaptersFor(config: AppConfig): AwsAdapters {
  let a = cache.get(config);
  if (a === undefined) {
    a = createAwsAdapters(config.aws ?? { region: undefined, probeTimeoutMs: 2000, s3: null, kms: null, secrets: null });
    cache.set(config, a);
    for (const [name, probe] of a.probes) markConfigured(name, probe);
  }
  return a;
}
