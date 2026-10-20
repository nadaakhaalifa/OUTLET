# ADR-0054: iPad support (supportsTablet), width-based classes, 1.725x zoom, bespoke entrance page

- Status: **Proposed.** The owner decided the 1.725x zoom, the no-fade text curve (cap 2 x the zoom in force) and an entrance-only bespoke layout. `supportsTablet` is **not** decided and stays off: it changes App Store obligations and is likely irreversible (VERIFY).
- Date: 2026-10-16
- Deciders: Owner (zoom, cap, scope; iPad support pending), Architect (design)
- Spec refs: `docs/specs/ipad-adaptation.md` (6A entrance, 6B later proposals); master prompt sections 25, B7, T2
- Related: ADR-0044, ADR-0053; `docs/specs/guest-browsing.md`

## Context
The owner asked for "bigger fonts and everything" on iPad. The zoom then went through several values on 2026-10-16:
- 1.25x
- 1.75x ("way more zoomed in")
- 1.25x ("too zoomed in")
- 1.5x
- **1.725x** ("15% more" on top of 1.5)

At 1.75x the role chooser was a phone column with wide margins, and its bottom was clipped with no scroll affordance. The owner wants it "designed for the iPad screen, and another design for the iPhone screen", starting with the entrance page only.

## Decision
1. **`IPAD_ZOOM = 1.725` is the only zoom constant and the maximum zoom.** The zoom in force is `z(w) = 1` below 600 pt and `min(IPAD_ZOOM, 1 + (w - 600) / 375)` from 600 pt (rounded to 0.01). It is continuous at 600, monotonic, and never lays a window out narrower than an iPhone (effective >= 375). Compact windows are unchanged.
   - Spacing, radii and art scale by `z`.
   - Controls and glyphs use a derived `CONTROL_ZOOM(z) = 1 + (z - 1) * 0.62` (about 1.45 at full zoom), and touch targets stay at 44 pt or more.
   - **Text: no Dynamic Type fade.** Text is `z` times the phone size, and Dynamic Type applies its usual 2x on top, so the rendered scale is `z * min(fs, 2)`: at most 2z (3.45x the phone size at full zoom) and never smaller than the phone size. This **supersedes the earlier 2.45x cap** (WCAG 1.4.4, resize text up to 200%: a fade gave iPad users a weaker response to their text-size setting than iPhone users get; without it the setting grows text 2x on both). Accessibility flag: the cost is large text at the biggest sizes, handled by scrolling and growing controls.
2. **Effective width = window / z(w).**
   - Classes: `regular` below 760 effective, `expanded` at 760 or more (window 1311 at full zoom: 13-inch landscape only).
   - Max widths in effective points: form 440, reading 560, grid none.
   - Form sheet from 460 effective (420 eff wide); with the ramp this covers every window >= 600 pt.
   - Two-pane (later 6B screens) only at 13-inch landscape (798 eff).
3. **Bespoke layout, entrance page only (`/role`).**
   - `phone` below 600 pt.
   - `band` from 600 pt up to 640 effective: a hero band, then the choices.
   - `split` at 640 effective or more: brand panel at the start (42% or 50%), choices pane at the end, toggle at the top-end of the choices pane.
   - Mirrors in RTL.
   - Only the choices pane scrolls.
   - Other screens get only the generic zoom, max widths and grid columns. Their bespoke layouts are proposals, not approved.
4. **No-clip rule.** Every screen scrolls or fits at windows from 600 to 1376 pt and at the largest Dynamic Type. Scroll indicators show on iPad. Enforced by Maestro flow 15.
5. **Token-level zoom**, not a root transform.
6. **iPad support stays off.** `IOS_SUPPORTS_TABLET` defaults to false and no EAS profile sets it.

## Options compared
| Option | Complexity | Accuracy | Cost | Scalability |
|---|---|---|---|---|
| iPhone compatibility mode | None | Poor | Zero | n/a |
| Max-width only | Very low | Poor: the rejected phone column | Low | Poor |
| Zoom only | Medium | Poor: the owner rejected it at 1.75x | Medium | Poor |
| `isTablet` branches everywhere | High | Uneven; breaks in Split View | High | Poor |
| **Zoom 1.725 + width classes + bespoke layouts as approved (entrance first) (chosen)** | Medium | Designed for iPad; any window; Dynamic Type-aware | T0 + T5 | Good |

## Consequences
- If iPad support is approved later:
  - 13-inch iPad screenshots in AR and EN are required.
  - App Review may test on iPad.
  - Dropping iPad support later is likely refused (VERIFY).
  - The Mac listing defaults to opt-out.
- **Work packages.** T0 is built at 1.725x and verifies the derived tables, the zoom ramp properties and the no-fade text curve. T5 is reduced to the entrance page. Lint rules `DS-RN-WINDOW` and `DS-RN-RAW-SIZE` are baselined once; only `role-choice/*` is burned down now.
- **Blocks.** The owner's `supportsTablet` decision, and VERIFY items on iPadOS 26 windows, the device-family removal rule and the Expo `~ipad` orientation key.
