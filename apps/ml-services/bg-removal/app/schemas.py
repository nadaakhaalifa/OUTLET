"""Wire schemas (pydantic v2). The Node adapter validates the same shape strictly."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class StatsOut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    width: int
    height: int
    coverage: float = Field(ge=0, le=1)
    border_touch: float = Field(ge=0, le=1)
    components: int = Field(ge=0)
    hole_ratio: float = Field(ge=0, le=1)
    soft_edge_ratio: float = Field(ge=0, le=1)
    subject_bright_ratio: float = Field(ge=0, le=1)
    border_bright_ratio: float = Field(ge=0, le=1)


class CutoutOut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    png_b64: str
    mask_b64: str
    white_jpg_b64: str
    shadow_png_b64: str | None
    stats: StatsOut
    model_id: str
    model_version: str
    latency_ms: int = Field(ge=0)
    # Optional extras (only present on /v1/refine responses).
    background_render_b64: str | None = None
    background_render_mime: str | None = None
    # Computed by code (app/labels.py), never from seller input.
    edit_label: Literal["none", "background_replaced", "composited"] = "background_replaced"
    icc_source: Literal["none", "srgb", "display_p3", "other"] = "none"
    studio_eligible: bool = True


class HealthOut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    status: str
    models_available: list[str]
    default_model: str


class StrokeIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    mode: Literal["erase", "restore"]
    radius: float = Field(gt=0, le=0.25, allow_inf_nan=False)
    points: list[tuple[float, float]] = Field(min_length=1, max_length=2000)


class RefineIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    image_b64: str = Field(min_length=8)
    mask_b64: str | None = None
    strokes: list[StrokeIn] = Field(default_factory=list, max_length=200)
    feather_px: float = Field(default=1.5, ge=0, le=4, allow_inf_nan=False)
    smooth: float = Field(default=0.5, ge=0, le=1, allow_inf_nan=False)
    edge_shift_px: float = Field(default=0.0, ge=-3, le=3, allow_inf_nan=False)
    fill_holes: bool = True
    background: Literal["transparent", "white", "studio"] = "transparent"
