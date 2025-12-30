from fastapi import APIRouter
from pydantic import BaseModel
from app.services.raster_service import sample_raster_value

router = APIRouter(tags=["rasters"])

class SampleRequest(BaseModel):
    rasterLayerId: int
    lon: float
    lat: float

@router.post("/sample")
def sample_value(req: SampleRequest):
    res = sample_raster_value(
        raster_layer_id=req.rasterLayerId,
        lon=req.lon,
        lat=req.lat
    )
    return {
        "value": res["value"],
        "is_nodata": res["is_nodata"],
        "lon": req.lon,
        "lat": req.lat,
        "crs": res["crs"]
    }
