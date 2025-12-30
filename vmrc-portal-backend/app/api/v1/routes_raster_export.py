# app/api/v1/routes_raster_export.py
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from app.services.raster_service import clip_raster_for_layer
import uuid
from pathlib import Path
import rasterio
from rasterio.mask import mask
from shapely.geometry import shape

router = APIRouter(tags=["export"])

class ExportRequest(BaseModel):
    raster_layer_id: int
    user_clip_geojson: dict
    export_png: bool = False
    export_tif: bool = False
    export_csv: bool = False
    filename: str | None = None   # ❤️ user custom name


@router.post("/export")
def export_raster(req: ExportRequest):
    """Exports clipped raster in PNG, TIFF, and/or CSV."""

    # Perform clip (same as your map overlay process)
    try:
        clip_result = clip_raster_for_layer(
            raster_layer_id=req.raster_layer_id,
            user_clip_geojson=req.user_clip_geojson,
        )
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

    output_files = {}

    # Paths
    out_dir = Path("static/exports")
    out_dir.mkdir(parents=True, exist_ok=True)

    # --------------------------------
    # EXPORT PNG (already generated)
    # --------------------------------
    if req.export_png:
        output_files["png"] = clip_result["overlay_url"]

    # --------------------------------
    # EXPORT TIFF
    # --------------------------------
    if req.export_tif:
        tif_name = f"{uuid.uuid4().hex}.tif"
        tif_path = out_dir / tif_name

        # Recreate the clipped raster using the same logic
        raster_path = clip_result["source_path"]
        geom = shape(req.user_clip_geojson)

        with rasterio.open(raster_path) as src:
            clipped, transform = mask(
                src,
                [geom],
                crop=True,
                filled=True
            )

            meta = src.meta.copy()
            meta.update({
                "height": clipped.shape[1],
                "width": clipped.shape[2],
                "transform": transform
            })

            with rasterio.open(tif_path, "w", **meta) as dst:
                dst.write(clipped)

        output_files["tif"] = f"/static/exports/{tif_name}"

    # --------------------------------
    # EXPORT CSV
    # --------------------------------
    if req.export_csv:
        import numpy as np
        import csv

        csv_name = f"{uuid.uuid4().hex}.csv"
        csv_path = out_dir / csv_name

        values = np.array(clip_result["pixels"])

        with open(csv_path, "w", newline="") as f:
            writer = csv.writer(f)
            writer.writerow(["value"])
            for v in values:
                writer.writerow([v])

        output_files["csv"] = f"/static/exports/{csv_name}"

    return {
        "status": "success",
        "files": output_files
    }
