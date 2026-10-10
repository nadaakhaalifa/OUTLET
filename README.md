# Outlet NK (spec name: HAUL)

Egypt-first, multi-vendor outlet marketplace: local and global brands sell clearance stock at real, machine-verified discounts.

- **Platforms:** iOS (Expo / React Native) first, then Android; Seller Center and Admin Console on the web.
- **Source of truth:** "HAUL master prompt v3" (kept in the Outlet NK Claude Project). Where it says HAUL, read Outlet NK.
- **Current phase:** Phase 0, Foundations.

## Repository layout (target, per spec §T1)

```
apps/       mobile, seller-web, admin-web, api, workers, crawler, ml-services
packages/   domain, validation, api-client, ui-tokens, i18n, analytics, config, policy
infra/      terraform, observability
docs/       adr, specs, data-model, security, privacy, compliance, runbooks
```

## Next steps

1. Open questions that block irreversible decisions (data residency, wallet licensing, PSP split payments, age policy, Apple billing).
2. ADRs 0001–0005 in `docs/adr/`.
3. Verify register in `docs/compliance/verify-register.md`.
