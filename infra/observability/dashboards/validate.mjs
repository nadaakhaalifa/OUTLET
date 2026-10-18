// Validates every dashboard JSON: parses, has uid/title/panels, unique ids, each target has an expr.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = dirname(fileURLToPath(import.meta.url));
let bad = 0;
const uids = new Set();
for (const f of readdirSync(dir).filter((n) => n.endsWith(".json"))) {
  const errs = [];
  try {
    const d = JSON.parse(readFileSync(join(dir, f), "utf8"));
    if (!d.uid || !d.title || !Array.isArray(d.panels) || d.panels.length === 0) errs.push("missing uid/title/panels");
    if (uids.has(d.uid)) errs.push("duplicate uid");
    uids.add(d.uid);
    const ids = new Set();
    for (const p of d.panels ?? []) {
      if (ids.has(p.id)) errs.push(`duplicate panel id ${p.id}`);
      ids.add(p.id);
      if (!p.targets?.length || p.targets.some((t) => !t.expr)) errs.push(`panel ${p.id} has no expr`);
    }
  } catch (e) {
    errs.push(`invalid JSON: ${e.message}`);
  }
  console.log(`${errs.length ? "FAIL" : "ok  "} ${f} ${errs.join("; ")}`);
  bad += errs.length;
}
process.exit(bad ? 1 : 0);
