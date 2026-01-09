# app/api/v1/routes_raster.py

import traceback
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
        error_msg = str(e)
        print(f"\n[ERROR] FileNotFoundError: {error_msg}")
        print(traceback.format_exc())
        raise HTTPException(status_code=404, detail=error_msg)
    except ValueError as e:
        error_msg = str(e)
        print(f"\n[ERROR] ValueError: {error_msg}")
        print(traceback.format_exc())
        raise HTTPException(status_code=400, detail=error_msg)
    except Exception as e:
        error_msg = str(e)
        error_type = type(e).__name__
        print(f"\n[ERROR] {error_type}: {error_msg}")
        print(f"[ERROR] Full traceback:")
        print(traceback.format_exc())
        raise HTTPException(status_code=500, detail=f"{error_type}: {error_msg}")
