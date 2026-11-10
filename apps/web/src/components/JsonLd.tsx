/** JSON-LD data block. `<` is escaped so a value can never close the script element. */
export function JsonLd({ data, nonce }: { data: Readonly<Record<string, unknown>>; nonce: string | undefined }) {
  const json = JSON.stringify(data).replace(/</g, "\\u003c");
  return <script type="application/ld+json" nonce={nonce} dangerouslySetInnerHTML={{ __html: json }} />;
}
