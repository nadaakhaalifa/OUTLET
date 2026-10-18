import { serializeJsonLd } from "../view-models/product";

/**
 * Structured data block. `application/ld+json` is a data block, not executable script, so it is not subject to
 * `script-src` and needs no nonce. The payload is built only from API data (see view-models/product.ts).
 */
export function JsonLd({ data }: { data: Record<string, unknown> }) {
  return <script type="application/ld+json">{serializeJsonLd(data)}</script>;
}
