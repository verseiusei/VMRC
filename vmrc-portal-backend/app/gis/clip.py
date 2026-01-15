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
from rasterio.warp import transform_geom

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

    # --- 1) Open raster to get CRS ---
    with rasterio.open(raster_path) as src:
        raster_crs = src.crs
        print("\n========== DEBUG CLIP INFO ==========")
        print("Raster path:", raster_path)
        print("Raster bounds:", src.bounds)
        print("Raster CRS:", raster_crs)
        print("NODATA:", src.nodata)
        print("=====================================\n")

    # --- 2) Convert inputs and reproject to raster CRS ---
    global_aoi_feature = get_global_aoi_feature()
    global_geom = _geojson_to_geom(global_aoi_feature)
    user_geom = _geojson_to_geom(user_clip_geojson)
    
    # Reproject geometries to raster CRS using rasterio.warp.transform_geom (more precise)
    # Global AOI: reproject from its source CRS (from shapefile) to raster CRS
    # User clip: reproject from EPSG:4326 (GeoJSON) to raster CRS
    print(f"[CLIP] Reprojecting geometries to raster CRS: {raster_crs}")
    
    # Get global AOI CRS from shapefile
    with fiona.open(AOI_SHP_PATH, "r") as shp:
        global_aoi_crs = shp.crs
        print(f"[CLIP] Global AOI CRS: {global_aoi_crs}")
    
    # Reproject global AOI to raster CRS
    global_geom_dict = mapping(global_geom)
    if global_aoi_crs and str(global_aoi_crs) != str(raster_crs):
        global_geom_raster_crs = transform_geom(
            global_aoi_crs.to_string() if hasattr(global_aoi_crs, 'to_string') else str(global_aoi_crs),
            raster_crs.to_string() if hasattr(raster_crs, 'to_string') else str(raster_crs),
            global_geom_dict,
            precision=6
        )
        global_geom = shape(global_geom_raster_crs)
        print(f"[CLIP] Global AOI reprojected to raster CRS")
    else:
        print(f"[CLIP] Global AOI already in raster CRS")
    
    # Reproject user clip to raster CRS (assumed EPSG:4326 input)
    user_geom_dict = mapping(user_geom)
    user_geom_raster_crs = transform_geom(
        "EPSG:4326",
        raster_crs.to_string() if hasattr(raster_crs, 'to_string') else str(raster_crs),
        user_geom_dict,
        precision=6
    )
    user_geom = shape(user_geom_raster_crs)
    print(f"[CLIP] User clip reprojected to raster CRS")

    # --- 3) Intersection in raster CRS ---
    intersection = global_geom.intersection(user_geom)

    if intersection.is_empty:
        raise ValueError("No overlap between AOI and user clip polygon.")

    # Bounds in raster CRS
    west, south, east, north = intersection.bounds
    bounds_dict = {
        "south": float(south),
        "west": float(west),
        "north": float(north),
        "east": float(east),
    }

    # Convert intersection to GeoJSON dict for mask()
    geom_mapping = mapping(intersection)

    # --- 4) Clip raster ---
    with rasterio.open(raster_path) as src:
        print(f"[CLIP] AOI ∩ User bounds (raster CRS): {intersection.bounds}")

        # Determine nodata value: use source nodata if available, otherwise choose based on dtype
        nodata_value = src.nodata
        if nodata_value is None:
            # Choose a safe nodata value based on dtype
            if np.issubdtype(src.dtypes[0], np.integer):
                # For integer types, use a value outside typical range
                if src.dtypes[0] == np.uint8:
                    nodata_value = 255
                elif src.dtypes[0] == np.uint16:
                    nodata_value = 65535
                else:
                    nodata_value = -9999
            else:
                # For float types
                nodata_value = -9999  # Use a sentinel value
            print(f"[CLIP] Source has no nodata, using {nodata_value} as nodata value")
        
        # ============================================================
        # MASK RASTER: Use all_touched=True to include any touched pixel
        # ============================================================
        # all_touched=True ensures every pixel that is even slightly touched
        # by the AOI boundary is included. This guarantees no edge pixels are lost.
        #
        # Why this works:
        # - By default, mask() only includes pixels whose center falls inside the polygon
        # - all_touched=True includes ANY pixel touched or intersected by the boundary
        # - Combined with proper CRS reprojection, this ensures complete pixel coverage
        # ============================================================
        shapes = [geom_mapping]  # GeoJSON dict in raster CRS
        out_image, out_transform = mask(
            src,
            shapes,
            crop=True,  # Crop to geometry bounds (no pre-windowing needed)
            all_touched=True,  # CRITICAL: Include any pixel touched by boundary
            filled=True,  # Fill masked areas with nodata
            nodata=nodata_value  # Use source nodata or safe default
        )

        out_meta = src.meta.copy()
        out_meta.update({
            "height": out_image.shape[1],
            "width": out_image.shape[2],
            "transform": out_transform,
        })

        # Use the nodata value we set in mask() call
        out_meta["nodata"] = nodata_value

    # --- 4) Stats ---
    band = out_image[0].astype(float)
    valid = np.isfinite(band)

    # Exclude nodata pixels (these are outside polygon or actual nodata)
    if nodata_value is not None:
        valid &= band != nodata_value

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
