// Regenerates docs/analytics/events.md from the catalog by running the registry test in update mode.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const cwd = fileURLToPath(new URL("..", import.meta.url));
const r = spawnSync("npx", ["vitest", "run", "src/events-doc.test.ts"], {
  cwd,
  stdio: "inherit",
  env: { ...process.env, UPDATE_EVENTS_DOC: "1" },
});
process.exit(r.status ?? 1);
