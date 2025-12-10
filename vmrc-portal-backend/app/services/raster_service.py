# app/services/raster_service.py
import uuid
from pathlib import Path

import rasterio
from rasterio.mask import mask
from rasterio.enums import Resampling
from rasterio.transform import xy
from shapely.geometry import shape, mapping
from shapely.ops import unary_union
import numpy as np
import fiona
import imageio

from app.services.raster_index import RASTER_LOOKUP_LIST

# AOI + output dir
AOI_PATH = Path(r"D:\VMRC_Project\Data_Analysis!!\AOI_diss\AOI_diss.shp")
OVERLAY_DIR = Path("static/overlays")
OVERLAY_DIR.mkdir(parents=True, exist_ok=True)


# -----------------------------
# GLOBAL AOI
# -----------------------------
def load_global_aoi_geom():
    with fiona.open(str(AOI_PATH), "r") as src:
        geoms = [shape(feat["geometry"]) for feat in src]
    return unary_union(geoms)


GLOBAL_AOI = load_global_aoi_geom()


def resolve_raster_path(raster_layer_id: int) -> str:
    for r in RASTER_LOOKUP_LIST:
        if r["id"] == raster_layer_id:
            return r["path"]
    raise FileNotFoundError(f"Raster id {raster_layer_id} not found.")


# -----------------------------
# COLOR MAP (like your legend)
# -----------------------------
def classify_to_colormap(values):
    """
    Apply your green→yellow→orange→red color ramp.
    values = 2D numpy array of pixel values
    Returns RGB image (uint8).
    """

    # Define class breaks (%)
    bins = np.array([0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 9999])

    # Corresponding RGB colors
    colors = np.array(
        [
            [0, 100, 0],   # 0–10  dark green
            [0, 128, 0],   # 10–20
            [0, 160, 0],   # 20–30
            [128, 180, 0], # 30–40
            [180, 200, 0], # 40–50 yellow green
            [255, 220, 0], # 50–60 yellow
            [255, 180, 0], # 60–70 orange
            [255, 140, 0], # 70–80 deep orange
            [255, 80, 0],  # 80–90 red-orange
            [200, 0, 0],   # ≥ 90 red
        ]
    )

    idx = np.digitize(values, bins) - 1
    idx = np.clip(idx, 0, len(colors) - 1)

    rgb = colors[idx]
    return rgb.astype(np.uint8)


# -----------------------------------------------
# MAIN CLIPPER — COLORIZED PNG + STATS + PIXELS
# -----------------------------------------------
def clip_raster_for_layer(raster_layer_id: int, user_clip_geojson: dict):
    raster_path = resolve_raster_path(raster_layer_id)

    # Intersect user clip with fixed AOI
    user_geom = shape(user_clip_geojson)
    clip_geom = GLOBAL_AOI.intersection(user_geom)

    if clip_geom.is_empty:
        raise ValueError("AOI ∩ user polygon is empty.")

    with rasterio.open(raster_path) as src:
        # Clip
        clipped, transform = mask(
            src,
            [mapping(clip_geom)],
            crop=True,
            filled=True,
        )

        # If multi-band, average bands; otherwise use band 1
        band = clipped.mean(axis=0) if clipped.ndim == 3 else clipped[0]

        nodata = src.nodata

        # Valid mask (exclude nodata)
        mask_valid = band != nodata
        valid_pixels = band[mask_valid]

        if valid_pixels.size == 0:
            raise ValueError("Clipped area contains only NoData pixels.")

        # -----------------------------
        # Chart data (for histogram/heatmap)
        # -----------------------------
        flat_valid = valid_pixels.astype(float)

        # Sample to avoid sending millions of pixels
        MAX_PIXELS = 50000
        if flat_valid.size > MAX_PIXELS:
            idx = np.random.choice(flat_valid.size, MAX_PIXELS, replace=False)
            flat_valid = flat_valid[idx]

        pixel_list = flat_valid.tolist()

        # -----------------------------
        # Colorize for map overlay
        # -----------------------------
        rgb_img = classify_to_colormap(band)

        # Alpha: valid = 255, nodata = 0
        alpha = (mask_valid * 255).astype("uint8")
        rgba = np.dstack((rgb_img, alpha))

        # Save PNG
        out_png = OVERLAY_DIR / f"{uuid.uuid4().hex}.png"
        imageio.imwrite(out_png, rgba)

        # Bounds (for Leaflet image overlay)
        height, width = band.shape
        west, north = xy(transform, 0, 0, offset="ul")
        east, south = xy(transform, height, width, offset="lr")

    # -------------------------
    # Return response to client
    # -------------------------
        return {
        "overlay_url": f"/static/overlays/{out_png.name}",
        "stats": {
            "min": float(valid_pixels.min()),
            "max": float(valid_pixels.max()),
            "mean": float(valid_pixels.mean()),
            "std": float(valid_pixels.std()),
            "count": int(valid_pixels.size),
        },
        "bounds": {
            "west": west,
            "south": south,
            "east": east,
            "north": north,
        },
        # 👇 for charts
        "pixels": pixel_list,
        "values": pixel_list,   # alias so frontend can use either
    }

