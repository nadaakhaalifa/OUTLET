import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Playwright's loader cannot import the JSON catalog with an import attribute, so read it and substitute simple {name} values.
const ar = JSON.parse(readFileSync(fileURLToPath(new URL("../../../packages/i18n/src/catalogs/ar-EG.json", import.meta.url)), "utf8")) as Record<string, string>;
export const t = (key: string, values: Record<string, string> = {}): string =>
  (ar[key] ?? key).replace(/\{(\w+)\}/g, (_m, name: string) => values[name] ?? "");
