# ============================================================
# File: app/gis/clip.py
# VMRC Portal – Clipping Utilities (FINAL CLEAN VERSION)
# ============================================================

from functools import lru_cache
from pathlib import Path
from typing import Dict, Tuple

import fiona
import numpy as np
import rasterio
from rasterio.mask import mask

from shapely.geometry import shape, mapping
from shapely.ops import unary_union
from shapely.geometry.base import BaseGeometry


# ============================================================
# AOI SHAPEFILE PATH
# ============================================================

AOI_SHP_PATH = Path(r"D:\VMRC_Project\Data_Analysis!!\AOI_diss\AOI_diss.shp")


# ============================================================
# Load Full AOI as GeoJSON (optional for API GET /aoi)
# ============================================================

def get_global_aoi_geojson() -> dict:
    """
    Return AOI as a FeatureCollection (for frontend display).
    """
    if not AOI_SHP_PATH.exists():
        raise FileNotFoundError(f"AOI shapefile not found at: {AOI_SHP_PATH}")

    features = []
    with fiona.open(AOI_SHP_PATH, "r") as src:
        for feat in src:
            features.append({
                "type": "Feature",
                "properties": feat.get("properties") or {},
                "geometry": feat["geometry"]
            })

    if not features:
        raise RuntimeError("AOI shapefile contains no features.")

    return {"type": "FeatureCollection", "features": features}


# ============================================================
# Load & dissolve AOI (cached for speed)
# ============================================================

@lru_cache
def _load_global_aoi_feature() -> dict:
    """
    Load AOI shapefile and dissolve all parts into ONE geometry.
    """
    if not AOI_SHP_PATH.exists():
        raise FileNotFoundError(f"AOI shapefile not found: {AOI_SHP_PATH}")

    geoms = []
    props = {}

    with fiona.open(AOI_SHP_PATH, "r") as src:
        for feat in src:
            g = shape(feat["geometry"])
            geoms.append(g)

            if not props:
                props = feat.get("properties") or {}

    if not geoms:
        raise RuntimeError("AOI shapefile has no valid geometries.")

    # Dissolve union
    if len(geoms) == 1:
        union_geom = geoms[0]
    else:
        union_geom = unary_union(geoms)

    if union_geom.is_empty:
        raise RuntimeError("AOI became empty after union().")

    return {
        "type": "Feature",
        "properties": props,
        "geometry": mapping(union_geom),
    }


def get_global_aoi_feature() -> dict:
    """
    Public accessor — always returns the cached dissolved AOI.
    """
    return _load_global_aoi_feature()


# ============================================================
# Convert GeoJSON → Shapely Geometry
# ============================================================

def _geojson_to_geom(obj: dict) -> BaseGeometry:
    """
    Accepts Feature or Geometry.
    """
    if not isinstance(obj, dict):
        raise ValueError("GeoJSON object must be a dictionary.")

    if obj.get("type") == "Feature":
        geom = obj.get("geometry")
        if geom is None:
            raise ValueError("GeoJSON Feature missing geometry.")
    else:
        geom = obj

    return shape(geom)


# ============================================================
# CORE FUNCTION: Clip raster to AOI ∩ user polygon
# ============================================================

def clip_raster_with_global_aoi_and_user_clip(
    raster_path: str,
    user_clip_geojson: dict,
):
    """
    Main clipping function — used by raster_service.py.
    Clips raster to:
        intersection = (global AOI) ∩ (user polygon)
    Returns:
        out_image : np.ndarray (bands, rows, cols)
        stats     : dict
        out_meta  : updated raster metadata
        bounds    : geographic bounds of clipped region
    """

    # --- 1) Convert inputs ---
    global_geom = _geojson_to_geom(get_global_aoi_feature())
    user_geom = _geojson_to_geom(user_clip_geojson)

    # --- 2) Intersection ---
    intersection = global_geom.intersection(user_geom)

    if intersection.is_empty:
        raise ValueError("No overlap between AOI and user clip polygon.")

    # Bounds (raster is EPSG:4269)
    west, south, east, north = intersection.bounds
    bounds_dict = {
        "south": float(south),
        "west": float(west),
        "north": float(north),
        "east": float(east),
    }

    geom_mapping = mapping(intersection)

    # --- 3) Clip raster ---
    with rasterio.open(raster_path) as src:

        print("\n========== DEBUG CLIP INFO ==========")
        print("Raster path:", raster_path)
        print("Raster bounds:", src.bounds)
        print("Raster CRS:", src.crs)
        print("NODATA:", src.nodata)
        print("AOI ∩ User bounds:", intersection.bounds)
        print("=====================================\n")

        out_image, out_transform = mask(
            src,
            [geom_mapping],
            crop=True
        )

        out_meta = src.meta.copy()
        out_meta.update({
            "height": out_image.shape[1],
            "width": out_image.shape[2],
            "transform": out_transform,
        })

        nodata = src.nodata if src.nodata is not None else out_meta.get("nodata")
        out_meta["nodata"] = nodata

    # --- 4) Stats ---
    band = out_image[0].astype(float)
    valid = np.isfinite(band)

    if nodata is not None:
        valid &= band != nodata

    values = band[valid]

    if values.size == 0:
        raise ValueError("Clipped raster contains no valid pixels.")

    stats = {
        "min": float(values.min()),
        "max": float(values.max()),
        "mean": float(values.mean()),
        "std": float(values.std()),
    }

    return out_image, stats, out_meta, bounds_dict
