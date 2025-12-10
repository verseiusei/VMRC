# File: app/schemas/raster.py

from __future__ import annotations

from datetime import datetime

from typing import Dict, List
from pydantic import BaseModel


# -----------------------------
# DB-layer serializers
# -----------------------------

class RasterLayerBase(BaseModel):
    name: str
    description: str | None = None
    storage_path: str


class RasterLayerRead(RasterLayerBase):
    id: int
    created_at: datetime

    class Config:
        # Pydantic v2 equivalent of orm_mode=True
        from_attributes = True


class RasterLayerListResponse(BaseModel):
    items: List[RasterLayerRead]
    total: int


# -----------------------------
# Clip request / response
# -----------------------------

class RasterClipRequest(BaseModel):
    raster_layer_id: int
    user_clip_geojson: dict


class RasterClipResponse(BaseModel):
    overlay_url: str
    stats: Dict[str, float]
    bounds: Dict[str, float]
    pixel_values: List[float] = []