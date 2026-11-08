# Agent safety

Source: docs/BUILD-PROMPT.md section 2. Enforced by `.claude/settings.json` and `tooling/hooks/`, not by trust.

## Why (the four incidents)
- Veracode 2025: insecure choices in 45% of security-relevant AI tasks -> Stop hook (typecheck, depcruise, tests) and gitleaks.
- Replit 2025: a dev session deleted a production database -> no remote DB commands, no `DROP`/`TRUNCATE`/unscoped `DELETE` off-localhost, applied migrations are read-only.
- Lovable CVE-2025-48757: missing row-level security -> migrations and workflows cannot be silently changed by the agent.
- ~20% of LLM-recommended packages do not exist (USENIX 2025) -> checks run before the agent may stop.

## What is denied
| Rule | Mechanism |
|---|---|
| Read/Edit/Write `.env*`, `cat/less/head/tail/grep/source` of `.env*` (`.env.example` is allowed in the hook) | `permissions.deny` + `pre-tool-guard.sh` |
| `git push --force`, `-f`, `+refspec` | deny + guard |
| `rm -rf` outside the scratchpad / `/tmp/claude-*` | guard only (a deny rule would also block the scratchpad) |
| `psql`, `pg_*`, `DROP`, `TRUNCATE`, `DELETE` with a non-local host (anything but localhost, 127.0.0.1, ::1); host taken from env vars is refused too, pass `-h localhost` | guard only |
| Edit/Write `infra/migrations/applied/**` | deny. Fix forward with a new migration |
| Edit/Write `.github/workflows/**` | deny |

Hooks: PostToolUse formats the edited file (prettier/eslint if installed, never fails); Stop runs `typecheck`, `depcruise`, `vitest related` when the scripts exist and exits 2 on failure; the pre-commit hook runs gitleaks.

## Enable the pre-commit hook
```
brew install gitleaks
git config core.hooksPath tooling/hooks   # or: ln -sf ../../tooling/hooks/pre-commit .git/hooks/pre-commit
```
Without gitleaks the commit is refused (fail closed). Test the guard: `tooling/hooks/test-hooks.sh`.

## Workflow edits (human route)
The agent cannot edit `.github/workflows/**`. It writes the proposed change to a file outside that path (for example `docs/proposals/ci-<topic>.yml`) and opens a PR labelled `needs-human` describing it. A human copies it into `.github/workflows/`, reviews, and merges. The same route applies to a needed change in applied migrations: add a new migration instead.

## Limits
Deny rules and regex guards are defence in depth, not a sandbox. Shell indirection (`bash -c`, variables, scripts) can evade them. Keep production credentials out of the environment entirely.
