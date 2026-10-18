# Latin tokens in Arabic strings (policy)

Arabic strings are Arabic. Latin text is allowed only where it is the conventional, recognisable form.

## Stays Latin
- Product and brand names: `Z-OUTLET`, `Plus` (the membership name, kept Latin everywhere for consistency), `Apple Pay`, `InstaPay`, `Fawry`, `Meeza`.
- Technical field names and file types a person types or matches against a document: `SKU`, `GTIN`, `IBAN`, `DNS`, `PDF`, `JPG`, `PNG`, `WebP`.
- Endonyms in a language switcher: `English`.
- Worked examples that must be typed literally: `brand.com`, `2026-12-31`.

## Must be translated
- Format hints: never show `YYYY-MM-DD`; write "سنة-شهر-يوم، مثل 2026-12-31".
- Units, status words and generic nouns (delivery, size, return, order, wallet, credit).
- Anything an Arabic UI already has a common word for.

## Rules
- Place a Latin token inside an Arabic sentence on its own words; avoid adjacent punctuation that can flip under bidi. Wrap standalone Latin runs with LRM (U+200E) where the string starts or ends with one.
- Digits follow the user's numeral preference through `localizeDigits`, not hard-coded in strings (except literal examples above).
- Do not add a new Latin token without adding it to the "Stays Latin" list in the same change.
