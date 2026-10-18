# Third-party notices

## Bundled fonts

All bundled fonts are licensed under the SIL Open Font License, Version 1.1 (https://openfontlicense.org). The font files ship in `apps/mobile/assets/fonts` and are mirrored in `apps/admin-web/public/fonts`, `apps/seller-web/public/fonts` and `apps/shopper-web/public/fonts`. The full licence texts sit next to the fonts as `LICENSE-*-OFL.txt` (Amiri, Inter, Playfair Display).

| Font | Used for | Copyright |
|---|---|---|
| Playfair Display (400, 500, 600, 400 italic) | Latin display type | Copyright 2017 The Playfair Display Project Authors (https://github.com/clauseggers/Playfair-Display), with Reserved Font Name "Playfair Display" |
| Inter (400, 500, 600) | Latin UI text | Copyright 2020 The Inter Project Authors (https://github.com/rsms/inter) |
| Amiri (400, 700) | Arabic display type | Copyright 2010-2022 The Amiri Project Authors (https://github.com/aliftype/amiri) |
| IBM Plex Sans Arabic (300, 400, 500) | Arabic UI text | Copyright IBM Corp. (the font files embed "Copyright 2019 IBM Corp. All rights reserved."); SIL OFL 1.1 as published at https://github.com/IBM/plex |

Gap: no `LICENSE` file for IBM Plex Sans Arabic is stored in the repository yet. Add the OFL text from the IBM Plex repository next to the font files before a public release.

Playfair Display and Inter were sourced from the `@expo-google-fonts/playfair-display` and `@expo-google-fonts/inter` 0.4.2 npm tarballs. The OFL permits bundling and embedding; the fonts are not sold on their own and keep their names.

## npm dependencies

Licences of npm dependencies are declared in each package's `package.json` and in `node_modules/<package>/LICENSE`. A machine-readable inventory is produced per build as a CycloneDX SBOM by `.github/workflows/sbom.yml`. A consolidated third-party licence report for distribution has not been generated yet; produce it from the SBOM before shipping the mobile app or the web apps.
