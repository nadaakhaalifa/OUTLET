# Privacy engineering artifacts (spec B1, T6)

> Status: DRAFT, not reviewed by counsel or the DPO. Nothing here is legal advice. Items marked **VERIFY BEFORE LAUNCH** are open.

| File | What it is | How it is produced |
|---|---|---|
| `data_inventory.yaml` | Source of truth: every field with PII class, purpose, lawful basis, retention, processor, residency, encryption | Hand-maintained |
| `ropa.md` | Record of processing activities | Generated |
| `processors-register.md` | Processors with DPA status, role, location, TIA need | Generated from the inventory `processors` map |
| `retention-schedule.md` | Retention rules, purge jobs and metrics | Generated from the inventory `retention` map |
| `dpia-stylist.md`, `dpia-fit.md`, `dpia-budget.md`, `dpia-fraud.md` | DPIA skeletons for the four models | Hand-maintained, risks and sign-off blank |
| `tia-template.md` | Transfer impact assessment template | Hand-maintained |

## Commands

```
node tooling/privacy/check-inventory.mjs        # validate, fail on untagged fields and untagged migration columns
node tooling/privacy/generate-ropa.mjs          # regenerate ropa.md, processors-register.md, retention-schedule.md
node tooling/privacy/generate-ropa.mjs --check  # CI: fail if generated files are stale
node --test 'tooling/privacy/test/*.test.mjs'   # unit tests
```

## Adding a column

1. Add the migration.
2. Add the field to the owning table in `data_inventory.yaml` with `pii_class` and `encryption` (never defaulted). Other tags come from the table `defaults` unless overridden.
3. Run the checker and the generator, commit both the YAML and the regenerated markdown.

The checker reads `packages/db/migrations/*.sql` and fails on any `CREATE TABLE` or `ADD COLUMN` that has no inventory entry.
