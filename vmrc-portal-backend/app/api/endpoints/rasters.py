# app/api/endpoints/rasters.py

from fastapi import APIRouter
from pydantic import BaseModel

from app.services.raster_service import (
    clip_raster_for_layer,
    sample_raster_value,
)

router = APIRouter()


# -----------------------------
# SAMPLE SINGLE POINT VALUE
# -----------------------------
class SampleRequest(BaseModel):
    rasterLayerId: int
    lon: float   # longitude
    lat: float   # latitude


@router.post("/sample")
def sample_value(req: SampleRequest):
    result = sample_raster_value(
        raster_layer_id=req.rasterLayerId,
        lon=req.lon,
        lat=req.lat,
    )

    return {
        "value": result["value"],
        "is_nodata": result["is_nodata"],
        "lon": req.lon,
        "lat": req.lat,
        "crs": result["crs"],
    }
