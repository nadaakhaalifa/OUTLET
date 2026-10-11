# Policy as code (stubs)

`terraform.rego` holds a first set of Conftest guardrails (T7). Status: written, not yet executed
here, because neither `conftest` nor `opa` is installed on the authoring machine. CI runs them
in the `iac` job of `.github/workflows/ci.yml`.

Run locally:

```sh
conftest test infra/terraform --policy infra/terraform/policy --parser hcl2
```

Checkov (also in CI) covers the broader built-in rule set; these rules encode project-specific
rules: no hard-coded region (ADR-0002), no secret values in state, OIDC only, PITR on.
