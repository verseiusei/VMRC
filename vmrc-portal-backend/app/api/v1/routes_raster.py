# app/api/v1/routes_raster.py

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from app.services.raster_service import clip_raster_for_layer

router = APIRouter(tags=["rasters"])

class ClipRequest(BaseModel):
    raster_layer_id: int
    user_clip_geojson: dict


@router.post("/clip")
async def clip_raster(req: ClipRequest):
    try:
        return clip_raster_for_layer(
            raster_layer_id=req.raster_layer_id,
            user_clip_geojson=req.user_clip_geojson
        )
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
