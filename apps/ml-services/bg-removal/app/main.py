"""FastAPI app: /healthz and POST /v1/cutout. Image bytes are never logged."""

from __future__ import annotations

import asyncio
import base64
import io
import json
import logging
import time
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Literal

import numpy as np
from fastapi import FastAPI, HTTPException, Query, Request
from PIL import Image, UnidentifiedImageError
from pydantic import ValidationError

from .config import ALLOWED_MODELS, Settings, load_settings
from .models import Matter, RembgMatter, UnknownModelError
from .processing import Stroke, apply_strokes, derive, render_background
from .schemas import CutoutOut, HealthOut, RefineIn, StatsOut

log = logging.getLogger("bg-removal")
_SUPPORTED = {"JPEG", "PNG", "WEBP"}
_QUALITY_ORDER = {
    "high": ("birefnet-general-lite", "u2net", "u2netp"),
    "fast": ("u2netp", "u2net", "birefnet-general-lite"),
}


def _log(event: str, **fields: object) -> None:
    log.info(json.dumps({"event": event, **fields}, separators=(",", ":")))


async def _read_capped(request: Request, limit: int) -> bytes:
    declared = request.headers.get("content-length")
    if declared is not None and declared.isdigit() and int(declared) > limit:
        raise HTTPException(status_code=413, detail="request_too_large")
    chunks: list[bytes] = []
    total = 0
    async for chunk in request.stream():
        total += len(chunk)
        if total > limit:
            raise HTTPException(status_code=413, detail="request_too_large")
        chunks.append(chunk)
    if total == 0:
        raise HTTPException(status_code=422, detail="empty_body")
    return b"".join(chunks)


def _decode(data: bytes, max_dimension: int) -> Image.Image:
    try:
        probe = Image.open(io.BytesIO(data))
        if probe.format not in _SUPPORTED:
            raise HTTPException(status_code=422, detail="unsupported_type")
        if probe.width > max_dimension or probe.height > max_dimension:
            raise HTTPException(status_code=422, detail="too_large_dimensions")
        probe.verify()
        img = Image.open(io.BytesIO(data))
        img.load()
    except HTTPException:
        raise
    except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError) as e:
        raise HTTPException(status_code=422, detail="malformed_image") from e
    return img.convert("RGB")


def create_app(settings: Settings | None = None, matter: Matter | None = None) -> FastAPI:
    cfg = settings or load_settings()
    engine: Matter = matter or RembgMatter(cfg.models_dir)
    gate = asyncio.Semaphore(cfg.max_concurrency)
    Image.MAX_IMAGE_PIXELS = cfg.max_dimension * cfg.max_dimension

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        logging.basicConfig(level=logging.INFO, format="%(message)s")
        yield

    app = FastAPI(
        title="outlet-bg-removal",
        version="0.1.0",
        lifespan=lifespan,
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )

    def resolve_model(model: str | None, quality: str | None) -> str:
        if model is not None:
            if model not in ALLOWED_MODELS:
                raise HTTPException(status_code=422, detail="unknown_model")
            return model
        if quality is None:
            return cfg.default_model
        have = engine.available()
        for cand in _QUALITY_ORDER[quality]:
            if cand in have:
                return cand
        return cfg.default_model

    @app.get("/healthz", response_model=HealthOut)
    def healthz() -> HealthOut:
        return HealthOut(status="ok", models_available=engine.available(), default_model=cfg.default_model)

    @app.post("/v1/cutout", response_model=CutoutOut, response_model_exclude_unset=True)
    async def cutout(
        request: Request,
        model: str | None = Query(default=None),
        quality: Literal["fast", "high"] | None = Query(default=None),
        smooth: float = Query(default=0.5, ge=0, le=1),
        edge_shift_px: float = Query(default=0.0, ge=-3, le=3),
        fill_holes: bool = Query(default=True),
        feather_px: float = Query(default=1.5, ge=0, le=4),
        padding_ratio: float = Query(default=0.06, ge=0, le=0.3),
        white_max_side: int = Query(default=1600, ge=256, le=4096),
        shadow: bool = Query(default=True),
    ) -> CutoutOut:
        rid = uuid.uuid4().hex[:12]
        t0 = time.perf_counter()
        model = resolve_model(model, quality)
        data = await _read_capped(request, cfg.max_request_bytes)
        image = _decode(data, cfg.max_dimension)
        if gate.locked():
            raise HTTPException(status_code=429, detail="busy")

        def work() -> CutoutOut:
            alpha = engine.matte(model, image)
            rgb = np.asarray(image, dtype=np.uint8)
            d = derive(
                rgb,
                alpha,
                feather_px=feather_px,
                padding_ratio=padding_ratio,
                white_max_side=white_max_side,
                shadow=shadow,
                smooth=smooth,
                edge_shift_px=edge_shift_px,
                fill_holes=fill_holes,
            )
            s = d.stats
            return CutoutOut(
                png_b64=base64.b64encode(d.png).decode("ascii"),
                mask_b64=base64.b64encode(d.mask).decode("ascii"),
                white_jpg_b64=base64.b64encode(d.white_jpg).decode("ascii"),
                shadow_png_b64=None
                if d.shadow_png is None
                else base64.b64encode(d.shadow_png).decode("ascii"),
                stats=StatsOut(**s.__dict__),
                model_id=model,
                model_version=engine.version(model),
                latency_ms=int((time.perf_counter() - t0) * 1000),
            )

        async with gate:
            try:
                out = await asyncio.wait_for(asyncio.to_thread(work), timeout=cfg.timeout_seconds)
            except TimeoutError as e:
                _log("cutout", id=rid, model=model, status=504, bytes_in=len(data))
                raise HTTPException(status_code=504, detail="timeout") from e
            except UnknownModelError as e:
                raise HTTPException(status_code=422, detail="unknown_model") from e
            except FileNotFoundError as e:
                _log("cutout", id=rid, model=model, status=503, bytes_in=len(data))
                raise HTTPException(status_code=503, detail="model_not_installed") from e
        _log(
            "cutout",
            id=rid,
            model=model,
            status=200,
            bytes_in=len(data),
            width=image.width,
            height=image.height,
            latency_ms=out.latency_ms,
        )
        return out

    def _b64(raw: str, limit: int) -> bytes:
        try:
            data = base64.b64decode(raw, validate=True)
        except (ValueError, TypeError) as e:
            raise HTTPException(status_code=422, detail="invalid_base64") from e
        if not data or len(data) > limit:
            raise HTTPException(status_code=422, detail="invalid_payload_size")
        return data

    @app.post("/v1/refine", response_model=CutoutOut, response_model_exclude_unset=True)
    async def refine(
        request: Request,
        model: str | None = Query(default=None),
        quality: Literal["fast", "high"] | None = Query(default=None),
        padding_ratio: float = Query(default=0.06, ge=0, le=0.3),
        white_max_side: int = Query(default=1600, ge=256, le=4096),
        shadow: bool = Query(default=True),
    ) -> CutoutOut:
        rid = uuid.uuid4().hex[:12]
        t0 = time.perf_counter()
        model_id = resolve_model(model, quality)
        # JSON carries two base64 payloads (image + mask) plus strokes.
        body_cap = (cfg.max_request_bytes * 4 // 3 + 4) * 2 + 2 * 1024 * 1024
        raw = await _read_capped(request, body_cap)
        try:
            req = RefineIn.model_validate_json(raw)
        except ValidationError as e:
            # Never echo the input (it may contain image data): only the failing field locations.
            locs = ",".join(".".join(str(x) for x in err["loc"][:3]) for err in e.errors()[:5])
            raise HTTPException(status_code=422, detail=f"invalid_request:{locs}") from e
        img_bytes = _b64(req.image_b64, cfg.max_request_bytes)
        image = _decode(img_bytes, cfg.max_dimension)
        w, h = image.size
        mask_arr: np.ndarray[tuple[int, ...], np.dtype[np.float32]] | None = None
        if req.mask_b64 is not None:
            mbytes = _b64(req.mask_b64, cfg.max_request_bytes)
            try:
                m = Image.open(io.BytesIO(mbytes))
                if m.format != "PNG" or m.mode != "L":
                    raise HTTPException(status_code=422, detail="mask_must_be_8bit_grayscale_png")
                if m.size != (w, h):
                    raise HTTPException(status_code=422, detail="mask_size_mismatch")
                m.load()
            except HTTPException:
                raise
            except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError) as e:
                raise HTTPException(status_code=422, detail="malformed_mask") from e
            mask_arr = np.asarray(m, dtype=np.float32) / 255.0
        short = float(min(w, h))
        strokes = [
            Stroke(
                mode=st.mode,
                radius_px=st.radius * short,
                points=tuple(
                    (min(1.0, max(0.0, px)) * (w - 1), min(1.0, max(0.0, py)) * (h - 1))
                    for px, py in st.points
                ),
            )
            for st in req.strokes
        ]
        if gate.locked():
            raise HTTPException(status_code=429, detail="busy")

        def work() -> CutoutOut:
            alpha = mask_arr if mask_arr is not None else engine.matte(model_id, image)
            rgb = np.asarray(image, dtype=np.uint8)
            edited, touched = apply_strokes(alpha, strokes)
            d = derive(
                rgb,
                edited,
                feather_px=req.feather_px,
                padding_ratio=padding_ratio,
                white_max_side=white_max_side,
                shadow=shadow,
                smooth=req.smooth,
                edge_shift_px=req.edge_shift_px,
                fill_holes=req.fill_holes,
                protect=touched if strokes else None,
                stats_alpha=edited,
            )
            render, mime = render_background(d.rgba, req.background, white_max_side)
            s = d.stats
            return CutoutOut(
                png_b64=base64.b64encode(d.png).decode("ascii"),
                mask_b64=base64.b64encode(d.mask).decode("ascii"),
                white_jpg_b64=base64.b64encode(d.white_jpg).decode("ascii"),
                shadow_png_b64=None
                if d.shadow_png is None
                else base64.b64encode(d.shadow_png).decode("ascii"),
                stats=StatsOut(**s.__dict__),
                model_id=model_id if mask_arr is None else "provided-mask",
                model_version=engine.version(model_id) if mask_arr is None else "provided-mask",
                latency_ms=int((time.perf_counter() - t0) * 1000),
                background_render_b64=base64.b64encode(render).decode("ascii"),
                background_render_mime=mime,
            )

        async with gate:
            try:
                out = await asyncio.wait_for(asyncio.to_thread(work), timeout=cfg.timeout_seconds)
            except TimeoutError as e:
                _log("refine", id=rid, status=504, bytes_in=len(raw))
                raise HTTPException(status_code=504, detail="timeout") from e
            except UnknownModelError as e:
                raise HTTPException(status_code=422, detail="unknown_model") from e
            except FileNotFoundError as e:
                _log("refine", id=rid, status=503, bytes_in=len(raw))
                raise HTTPException(status_code=503, detail="model_not_installed") from e
        _log(
            "refine",
            id=rid,
            status=200,
            bytes_in=len(raw),
            width=w,
            height=h,
            strokes=len(strokes),
            latency_ms=out.latency_ms,
        )
        return out

    return app


def factory() -> FastAPI:
    """uvicorn --factory app.main:factory"""
    return create_app()
