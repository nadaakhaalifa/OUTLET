"""Edit label derived by code from the applied operations, never typed by the seller (spec section 7)."""

from __future__ import annotations

from typing import Literal

EditLabel = Literal["none", "background_replaced", "composited"]
# "ai_generated" is reserved in the spec; no producer exists, so it is deliberately not constructible here.


def derive_edit_label(
    *, background_replaced: bool, template: bool = False, shadow: bool = False, brand_background: bool = False
) -> EditLabel:
    """composited: template, shadow or brand background. background_replaced: plain background only."""
    if template or shadow or brand_background:
        return "composited"
    if background_replaced:
        return "background_replaced"
    return "none"
