# app/api/endpoints/rasters.py (or similar)
from pydantic import BaseModel
from app.services.raster_service import sample_raster_value

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
