# ADR-0044: Bottom tabs become Home, Discover, Saved, Bag, Profile

- Status: **Accepted (owner decision)**
- Date: 2026-10-15
- Deciders: Owner (design board), Product
- Spec refs: `docs/haul-master-prompt-v3.md` Part C "Tabs: Home, Explore, Stylist, Bag, Me" and §11, §8

## Context and problem statement
The owner's design board (shown twice) fixes the bottom bar as Home, Discover, Saved, Bag, Profile, with Saved replacing the Stylist tab. The master prompt names a different fixed tab set.

## Decision
1. Tabs are Home, Discover (old Explore), Saved (wishlists), Bag, Profile (old Me). This supersedes the master prompt tab line; the owner decision overrides the spec text.
2. The stylist stays a full feature and keeps its route `/stylist` (moved to `app/stylist.tsx`, outside the tab group). Entry points: a "Style me" row at the top of Discover, a "Style me" row in Profile, plus existing in-flow entries (PDP complete the look, bag).
3. File routes `explore` and `me` keep their names so deep links `/explore`, `/me`, `/stylist`, `/wishlists` continue to work. Only ids, labels and test ids change (`tab-discover`, `tab-saved`, `tab-profile`).
4. Saved renders the existing wishlists screen; `/wishlists` remains a pushed route to the same screen.

## Options compared
- Rename route files to discover/profile and add redirects vs keep the file names: renaming needs redirects and risks breaking links from other screens; keeping them has zero link risk and a small naming mismatch, documented here.

## Consequences
Good: matches the board, no feature removed, no broken links. Bad: stylist discoverability drops from one tap to two; track `stylist_outfit_generated` volume after release. Maestro flows now use the new test ids. Arabic labels (اكتشف, المحفوظات, حسابي) need native review; the bag label stays "Cart" per the earlier owner decision.
