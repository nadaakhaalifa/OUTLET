# Model, effort and delegation strategy (applies to every project)

## Tiers
| Tier | Model | Effort | Use for |
|---|---|---|---|
| Chief reviewer | Fable | high | Few, high-stakes checkpoints: money/ledger/ACL/data-residency design, security sign-off, milestone reviews |
| Architect | Opus | high | Requirements analysis, architecture, schemas and data flows, complex algorithms, cross-service debugging |
| Builder | Sonnet | medium | Implementing approved plans: features, UI, CRUD endpoints, routine refactors, docs |
| Tester | Sonnet | medium | Writing and running tests from an approved spec |
| Quick fix | Haiku | low | Renames, formatting, boilerplate, trivial isolated fixes |

Default session: `opusplan` (Opus plans, Sonnet executes). Raise effort for architecture and security work; lower it for mechanical edits.

## Delegation
- Delegate to the matching subagent (`chief-reviewer`, `architect`, `builder`, `tester`, `quick-fix`) instead of doing everything in one model.
- Start with the cheapest tier that can do the job correctly. Escalate one tier when: it fails twice on the same issue, the task spans several systems, the right design is unclear, or the change affects security, money, personal data or reliability.
- After a higher tier settles the hard part, hand routine coding and tests back down.
- Use Fable sparingly: a handful of checkpoints per project, not routine work. If Fable declines or is unavailable, use Opus and say so.

## Honesty rules
- Never claim a model switch happened unless the selection or a subagent's model actually changed. Check the current model first (`/model`).
- If automatic switching is not supported here, say so and recommend the closest supported workflow.
- Never skip tests, security checks or validation because a task seems routine.

## New project workflow
1. Analyze the whole brief; list missing requirements, ambiguities, dependencies and risks.
2. Propose architecture, schema, folder structure and milestones; mark each task with its tier.
3. Get approval, then build one milestone at a time: implement, test, review, update docs.
4. Chief-reviewer checkpoint at the end of each milestone that touches money, auth or personal data.
