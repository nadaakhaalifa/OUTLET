# apps/web: shopper web shell (E-13)

Next.js 16 App Router, React 19. No catalogue data yet: pages render real empty states and structural skeletons only. Data comes through `src/server/api-client.ts`; the default `UnconfiguredApiClient` returns `null` or empty lists (fail closed).

## Routes (`/[market]-[locale]/...`, e.g. `/eg-ar`)
`/` redirects to `eg-ar` (or `eg-en` for an English `Accept-Language`). `/[segment]` explore, `/deals`, `/stores/[slug]`, `/p/[id]`, `/bag`, `/account`. The segment is validated by `resolveLocale` (`@outlet/i18n`); anything else is a 404 (`global-not-found.tsx`). Each page sets a canonical and hreflang alternates (`ar-EG`, `en-EG`, `x-default`). `/bag` and `/account` are `noindex` and disallowed in robots.txt.

## Security headers
- `src/proxy.ts` (Next 16 name for middleware): strips every inbound `x-middleware-*`, `x-nonce` and `content-security-policy` header, mints a per-request nonce, sets the CSP on the request (so Next nonces its own scripts) and the response. It does not authorize anything; route handlers and loaders must check access themselves, and the edge/CDN must also drop `x-middleware-*`.
- CSP (`src/security/csp.ts`): `default-src 'self'; script-src 'self' 'nonce-…' 'strict-dynamic'; style-src 'self' 'nonce-…'; img-src 'self' data: https:; connect-src 'self'; font-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; upgrade-insecure-requests`. No `unsafe-inline`. `unsafe-eval` only in dev. `require-trusted-types-for 'script'` is added when `CSP_TRUSTED_TYPES=on`.
- Static headers in `next.config.ts` `headers()` (`src/security/headers.ts`): HSTS preload, nosniff, Referrer-Policy strict-origin-when-cross-origin, COOP same-origin, minimal Permissions-Policy. The CSP cannot live in `headers()` because it carries a nonce.
- Consequences: all pages are dynamic (the nonce needs per-request rendering). Inline `style` attributes are blocked by the CSP, so server components size things with CSS classes only; `@outlet/ui-web` components that set inline styles (`Skeleton`, `LocaleProvider`) are not used on SSR paths until they stop doing so.

## Caching and tags
Tag convention (`src/server/cache-tags.ts`): `product:{id}`, `store:{slug}`, `market:{id}`; `revalidateTags()` is the single invalidation entry point for trusted server paths. Tags apply to descriptive catalogue data. Price and stock are read live on every request and must never go through a tagged or cached fetch.

## Config
`SITE_URL` (origin for canonical, sitemap, JSON-LD; defaults to `http://localhost:3000`, must be set in every deployed env), `CSP_TRUSTED_TYPES=on|off`.

## Scripts
`pnpm --filter web build | test | typecheck | e2e` (e2e needs `pnpm exec playwright install chromium` once), Lighthouse budgets in `lighthouserc.json` (LCP <= 2.5 s, script bytes <= 170 KB), run with `pnpm --filter web lighthouse` after adding `@lhci/cli`.
