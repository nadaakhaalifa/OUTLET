// `pnpm prepare`: point git at tooling/git-hooks. No-op outside a git checkout (e.g. CI tarballs).
import { execFileSync } from "node:child_process";
try {
  execFileSync("git", ["config", "core.hooksPath", "tooling/git-hooks"], { stdio: "ignore" });
} catch {
  // not a git checkout
}
