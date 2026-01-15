# app/api/v1/routes_raster.py

import traceback
import json
from pathlib import Path
from typing import Optional
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from app.services.raster_service import clip_raster_for_layer, resolve_raster_path, OVERLAY_DIR

router = APIRouter(tags=["rasters"])

# Path to raster registry (relative to backend root)
# This assumes the script is run from the backend root directory
RASTER_REGISTRY_PATH = Path("app/data/raster_registry.json")


def load_raster_registry():
    """Load raster registry JSON file."""
    if not RASTER_REGISTRY_PATH.exists():
        return {}
    
    try:
        with open(RASTER_REGISTRY_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data
    except Exception as e:
        print(f"[RASTER] Error loading registry: {e}")
        return {}


@router.get("/rasters/{raster_id}/metadata")
async def get_raster_metadata(raster_id: int):
    """
    Get metadata for a catalog raster.
    
    GET /api/v1/rasters/{raster_id}/metadata
    
    Returns:
        JSON metadata object
    """
    registry = load_raster_registry()
    rasters = registry.get("rasters", [])
    
    # Find raster in registry
    raster_meta = next((r for r in rasters if r.get("raster_id") == raster_id), None)
    
    if not raster_meta:
        # Return default metadata if not in registry
        try:
            raster_path = resolve_raster_path(raster_id)
            raster_name = Path(raster_path).name
            
            return {
                "raster_id": raster_id,
                "title": raster_name,
                "summary": f"Raster layer {raster_id}: {raster_name}",
                "tags": ["raster"],
                "credits": "",
                "units": "",
                "crs": "EPSG:4326",
                "source_type": "raster"
            }
        except Exception as e:
            raise HTTPException(
                status_code=404,
                detail=f"Raster {raster_id} not found: {str(e)}"
            )
    
    # Add source_type if missing
    if "source_type" not in raster_meta:
        raster_meta["source_type"] = "raster"
    
    return raster_meta


class ClipRequest(BaseModel):
    raster_layer_id: int
    user_clip_geojson: dict
    zoom: Optional[int] = None  # Leaflet zoom level for display overlay resampling


@router.get("/value", summary="Get raster value at a specific lat/lon")
async def get_raster_value(layer_id: int, lat: float, lon: float):
    """
    Get raster value at a specific latitude/longitude coordinate.
    
    Query parameters:
    - layer_id: Raster layer ID
    - lat: Latitude (EPSG:4326)
    - lon: Longitude (EPSG:4326)
    
    Returns:
    - lat: Latitude (same as input)
    - lon: Longitude (same as input)
    - value: Raster pixel value (float) or None if nodata
    - nodata: Boolean indicating if pixel is nodata or outside bounds
    """
    try:
        from app.services.raster_service import sample_raster_value
        
        result = sample_raster_value(
            raster_layer_id=layer_id,
            lon=lon,
            lat=lat
        )
        
        return {
            "lat": lat,
            "lon": lon,
            "value": result.get("value"),
            "nodata": result.get("is_nodata", True),
        }
    except FileNotFoundError as e:
        error_msg = str(e)
        print(f"\n[ERROR] FileNotFoundError: {error_msg}")
        print(traceback.format_exc())
        raise HTTPException(status_code=404, detail=error_msg)
    except Exception as e:
        error_msg = str(e)
        print(f"\n[ERROR] Error getting raster value: {error_msg}")
        print(traceback.format_exc())
        raise HTTPException(status_code=500, detail=f"Failed to get raster value: {error_msg}")


@router.post("/clip")
async def clip_raster(req: ClipRequest):
    try:
        return clip_raster_for_layer(
            raster_layer_id=req.raster_layer_id,
            user_clip_geojson=req.user_clip_geojson,
            zoom=req.zoom  # Pass zoom for display overlay resampling
        )
    except FileNotFoundError as e:
        error_msg = str(e)
        print(f"\n[ERROR] FileNotFoundError: {error_msg}")
        print(traceback.format_exc())
        raise HTTPException(status_code=404, detail=error_msg)
    except ValueError as e:
        error_msg = str(e)
        error_detail = error_msg
        
        # Check for specific error types that should return 422 (Unprocessable Entity)
        # These are validation errors that the user can fix by choosing a different AOI
        if ("AOI contains no raster data" in error_msg or 
            "AOI contains no raster data for this layer" in error_msg or
            "AOI contains no valid raster pixels" in error_msg or
            "outside extent or all nodata" in error_msg):
            error_detail = "AOI contains no valid raster pixels (outside extent or all nodata)."
            print(f"\n[ERROR] No valid data: {error_detail}")
            print(f"[ERROR] Original error: {error_msg}")
            print(traceback.format_exc())
            raise HTTPException(status_code=422, detail=error_detail)
        elif "AOI outside raster extent" in error_msg or "AOI too small" in error_msg or "no intersect" in error_msg:
            error_detail = "AOI outside raster extent"
            print(f"\n[ERROR] AOI outside extent: {error_detail}")
            print(traceback.format_exc())
            raise HTTPException(status_code=422, detail=error_detail)
        elif "division by zero" in error_msg.lower() or "divide by zero" in error_msg.lower():
            # Division by zero should be caught earlier, but if it reaches here, return 422
            error_detail = "AOI contains no valid raster pixels (outside extent or all nodata)."
            print(f"\n[ERROR] Division by zero detected: {error_msg}")
            print(traceback.format_exc())
            raise HTTPException(status_code=422, detail=error_detail)
        else:
            # Other ValueError cases return 400 (Bad Request)
            print(f"\n[ERROR] ValueError: {error_msg}")
            print(traceback.format_exc())
            raise HTTPException(status_code=400, detail=error_msg)
    except Exception as e:
        # Unexpected errors return 500 (Internal Server Error)
        error_msg = str(e)
        print(f"\n[ERROR] Unexpected error in clip_raster: {error_msg}")
        print(traceback.format_exc())
        # Don't expose internal error details to client
        raise HTTPException(status_code=500, detail="Internal server error during raster clipping")
    except Exception as e:
        error_msg = str(e)
        error_type = type(e).__name__
        print(f"\n[ERROR] {error_type}: {error_msg}")
        print(f"[ERROR] Full traceback:")
        print(traceback.format_exc())
        raise HTTPException(status_code=500, detail=f"{error_type}: {error_msg}")


@router.delete("/overlays/{overlay_filename}")
async def delete_overlay(overlay_filename: str):
    """
    Delete an overlay PNG file by filename.
    
    DELETE /api/v1/rasters/overlays/{overlay_filename}
    
    This endpoint allows the frontend to clean up overlay files when rasters are removed.
    """
    try:
        # Security: Only allow deleting files in the overlay directory
        # Prevent path traversal attacks by ensuring filename doesn't contain path separators
        if "/" in overlay_filename or "\\" in overlay_filename:
            raise HTTPException(
                status_code=400,
                detail="Invalid filename: path separators not allowed"
            )
        
        overlay_path = OVERLAY_DIR / overlay_filename
        
        if not overlay_path.exists():
            raise HTTPException(
                status_code=404,
                detail=f"Overlay file not found: {overlay_filename}"
            )
        
        # Verify the file is actually in the overlay directory (prevent path traversal)
        if not overlay_path.resolve().is_relative_to(OVERLAY_DIR.resolve()):
            raise HTTPException(
                status_code=400,
                detail="Invalid path: file must be in overlay directory"
            )
        
        # Delete the file
        overlay_path.unlink()
        
        return {
            "success": True,
            "message": f"Overlay {overlay_filename} deleted successfully"
        }
    except HTTPException:
        raise
    except Exception as e:
        error_msg = str(e)
        print(f"\n[ERROR] Failed to delete overlay {overlay_filename}: {error_msg}")
        print(traceback.format_exc())
        raise HTTPException(status_code=500, detail=f"Failed to delete overlay: {error_msg}")
