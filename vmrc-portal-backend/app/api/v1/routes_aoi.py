# app/api/v1/routes_aoi.py

from pathlib import Path
import json

from fastapi import APIRouter, HTTPException, status, UploadFile, File

import fiona
from shapely.geometry import shape, mapping
from shapely.ops import unary_union

router = APIRouter()

# AOI shapefile path
AOI_SHP_PATH = Path(r"D:\VMRC_Project\Data_Analysis!!\AOI_diss\AOI_diss.shp")

# Simple in-memory cache so we don't keep re-reading the shapefile
_global_aoi_geojson = None


def load_global_aoi_geojson() -> dict:
    """
    Load and cache the AOI shapefile as a dissolved GeoJSON FeatureCollection.
    """
    global _global_aoi_geojson
    if _global_aoi_geojson is not None:
        return _global_aoi_geojson

    if not AOI_SHP_PATH.exists():
        raise FileNotFoundError(f"AOI shapefile not found at: {AOI_SHP_PATH}")

    geometries = []

    with fiona.open(AOI_SHP_PATH, "r") as src:
        for feat in src:
            geom = shape(feat["geometry"])
            geometries.append(geom)

    if not geometries:
        raise ValueError("AOI shapefile is empty – no geometries found.")

    if len(geometries) == 1:
        union_geom = geometries[0]
    else:
        union_geom = unary_union(geometries)

    if union_geom.is_empty:
        raise ValueError("AOI geometry is empty after union().")

    feature = {
        "type": "Feature",
        "properties": {},
        "geometry": mapping(union_geom),
    }

    _global_aoi_geojson = {
        "type": "FeatureCollection",
        "features": [feature],
    }
    return _global_aoi_geojson


# ---------- ENDPOINTS ----------

@router.get("/", summary="Get global AOI as GeoJSON")
def get_global_aoi():
    """
    Return the global VMRC AOI as GeoJSON FeatureCollection
    for the frontend map.
    """
    try:
        return load_global_aoi_geojson()
    except FileNotFoundError as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(exc),
        )
    except Exception as exc:
        print("Error loading AOI shapefile:", exc)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to load global AOI.",
        )


@router.post("/upload", summary="Upload custom AOI GeoJSON")
async def upload_aoi(file: UploadFile = File(...)):
    """
    Upload a custom AOI as GeoJSON/JSON.

    Returns: {"geojson": <the-geojson>}
    """
    if not file.filename.lower().endswith((".geojson", ".json")):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Please upload a GeoJSON (.geojson/.json) file.",
        )

    data_bytes = await file.read()
    try:
        geojson = json.loads(data_bytes.decode("utf-8"))
    except json.JSONDecodeError:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid GeoJSON file.",
        )

    # Just echo it back – frontend handles drawing it
    return {"geojson": geojson}
