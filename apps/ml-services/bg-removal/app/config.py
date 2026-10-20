"""Runtime configuration, read once from the environment."""

from __future__ import annotations

import os
from dataclasses import dataclass

ALLOWED_MODELS: tuple[str, ...] = ("u2netp", "u2net", "birefnet-general-lite", "isnet-general-use")
"""BRIA RMBG-1.4 and RMBG-2.0 are non-commercial and must never be added here."""


@dataclass(frozen=True)
class Settings:
    max_request_bytes: int = 12 * 1024 * 1024
    max_dimension: int = 4096
    max_pixels: int = 24_000_000
    timeout_seconds: float = 25.0
    max_concurrency: int = 2
    default_model: str = "u2netp"
    models_dir: str = "/opt/models"


def load_settings() -> Settings:
    default = os.environ.get("BG_DEFAULT_MODEL", "u2netp")
    if default not in ALLOWED_MODELS:
        raise ValueError(f"BG_DEFAULT_MODEL must be one of {ALLOWED_MODELS}")
    return Settings(
        max_request_bytes=int(os.environ.get("BG_MAX_REQUEST_BYTES", str(12 * 1024 * 1024))),
        max_dimension=int(os.environ.get("BG_MAX_DIMENSION", "4096")),
        max_pixels=int(os.environ.get("BG_MAX_PIXELS", "24000000")),
        timeout_seconds=float(os.environ.get("BG_TIMEOUT_SECONDS", "25")),
        max_concurrency=max(1, int(os.environ.get("BG_MAX_CONCURRENCY", "2"))),
        default_model=default,
        models_dir=os.environ.get("U2NET_HOME", "/opt/models"),
    )
