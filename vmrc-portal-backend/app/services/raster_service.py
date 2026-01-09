# app/services/raster_service.py
import uuid
import traceback
from pathlib import Path

import rasterio
from rasterio.mask import mask
from rasterio.enums import Resampling
from rasterio.transform import array_bounds
from rasterio.warp import transform_bounds
from shapely.geometry import shape, mapping, Polygon, MultiPolygon, box
from shapely.ops import unary_union, transform
from shapely.validation import make_valid
import numpy as np
import fiona
import imageio
from pyproj import Transformer

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
    """
    Resolve raster layer ID to absolute file path.
    Validates that the file exists before returning.
    """
    print(f"\n[DEBUG] Resolving raster path for layer_id={raster_layer_id}")
    
    # Find raster in lookup list
    raster_item = None
    for r in RASTER_LOOKUP_LIST:
        if r["id"] == raster_layer_id:
            raster_item = r
            break
    
    if not raster_item:
        print(f"[ERROR] Raster id {raster_layer_id} not found in RASTER_LOOKUP_LIST")
        print(f"[ERROR] Total rasters in index: {len(RASTER_LOOKUP_LIST)}")
        raise FileNotFoundError(f"Raster id {raster_layer_id} not found.")
    
    raster_path = raster_item["path"]
    dataset_type = raster_item.get("dataset_type", "unknown")
    raster_name = raster_item.get("name", "unknown")
    
    print(f"[DEBUG] Found raster in index:")
    print(f"  - Name: {raster_name}")
    print(f"  - Path: {raster_path}")
    print(f"  - Dataset type: {dataset_type}")
    
    # Validate file exists
    raster_path_obj = Path(raster_path)
    if not raster_path_obj.exists():
        print(f"[ERROR] Raster file does not exist: {raster_path}")
        raise FileNotFoundError(f"Raster file not found: {raster_path}")
    
    print(f"[DEBUG] ✓ Raster file exists and is accessible")
    print(f"[DEBUG] File size: {raster_path_obj.stat().st_size / (1024*1024):.2f} MB")
    
    return raster_path


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
    """
    Clip raster to user-drawn AOI with proper CRS handling and validation.
    
    This function:
    1. Resolves raster_layer_id to absolute file path
    2. Validates file exists
    3. Clips raster to user polygon (NOT global AOI)
    4. Returns overlay_url, bounds, stats, and pixel values
    """
    print("\n" + "="*60)
    print("CLIP RASTER REQUEST")
    print("="*60)
    print(f"Raster layer ID: {raster_layer_id}")
    print(f"User clip GeoJSON type: {type(user_clip_geojson)}")
    
    try:
        raster_path = resolve_raster_path(raster_layer_id)
    except Exception as e:
        print(f"[ERROR] Failed to resolve raster path for layer_id={raster_layer_id}: {e}")
        print(traceback.format_exc())
        raise

    # ============================================
    # STEP 1: Load and log raster info
    # ============================================
    try:
        with rasterio.open(raster_path) as src:
            raster_crs = src.crs
            raster_bounds = src.bounds  # (left, bottom, right, top) in raster CRS
            raster_transform = src.transform
            raster_width = src.width
            raster_height = src.height
            raster_res = (abs(raster_transform[0]), abs(raster_transform[4]))
            raster_nodata = src.nodata

            print("\n" + "="*60)
            print("RASTER INFO")
            print("="*60)
            print(f"Raster path: {raster_path}")
            print(f"Raster CRS: {raster_crs}")
            print(f"Raster bounds (in raster CRS): {raster_bounds}")
            print(f"  -> left (west): {raster_bounds.left}")
            print(f"  -> bottom (south): {raster_bounds.bottom}")
            print(f"  -> right (east): {raster_bounds.right}")
            print(f"  -> top (north): {raster_bounds.top}")
            print(f"Raster transform: {raster_transform}")
            print(f"Raster resolution: {raster_res} (x, y)")
            print(f"Raster width: {raster_width}, height: {raster_height}")
            print(f"Raster NODATA: {raster_nodata}")
            print("="*60)
    except Exception as e:
        print(f"[ERROR] Failed to open raster: {e}")
        print(traceback.format_exc())
        raise ValueError(f"Failed to open raster at {raster_path}: {e}")

    # ============================================
    # STEP 2: Parse and validate user GeoJSON
    # ============================================
    print("\n" + "="*60)
    print("PARSING USER GEOJSON")
    print("="*60)
    print(f"User clip GeoJSON type: {type(user_clip_geojson)}")
    print(f"User clip GeoJSON keys: {user_clip_geojson.keys() if isinstance(user_clip_geojson, dict) else 'N/A'}")
    
    # Handle Feature, FeatureCollection, or Geometry
    if not isinstance(user_clip_geojson, dict):
        raise ValueError(f"user_clip_geojson must be a dict, got {type(user_clip_geojson)}")
    
    # Extract geometry from Feature or FeatureCollection
    if user_clip_geojson.get("type") == "Feature":
        user_geom_dict = user_clip_geojson.get("geometry")
        if user_geom_dict is None:
            raise ValueError("GeoJSON Feature missing 'geometry' property")
    elif user_clip_geojson.get("type") == "FeatureCollection":
        features = user_clip_geojson.get("features", [])
        if not features:
            raise ValueError("GeoJSON FeatureCollection is empty")
        # Use first feature's geometry
        user_geom_dict = features[0].get("geometry")
        if user_geom_dict is None:
            raise ValueError("First feature in FeatureCollection missing 'geometry'")
    else:
        # Assume it's a Geometry object
        user_geom_dict = user_clip_geojson

    print(f"Extracted geometry type: {user_geom_dict.get('type') if isinstance(user_geom_dict, dict) else 'N/A'}")
    
    # Convert to shapely geometry
    try:
        user_geom_4326 = shape(user_geom_dict)
    except Exception as e:
        print(f"[ERROR] Failed to create shapely geometry from GeoJSON: {e}")
        print(traceback.format_exc())
        raise ValueError(f"Invalid GeoJSON geometry: {e}")

    # Validate and fix geometry
    print(f"Geometry type: {type(user_geom_4326)}")
    print(f"Geometry is_valid: {user_geom_4326.is_valid}")
    print(f"Geometry is_empty: {user_geom_4326.is_empty}")
    
    if user_geom_4326.is_empty:
        raise ValueError("User clip geometry is empty")
    
    # Fix invalid geometries
    if not user_geom_4326.is_valid:
        print("⚠️  Geometry is invalid, attempting to fix...")
        try:
            user_geom_4326 = make_valid(user_geom_4326)
            print(f"✓ Fixed geometry. New is_valid: {user_geom_4326.is_valid}")
        except Exception as e:
            print(f"⚠️  make_valid failed, trying buffer(0): {e}")
            try:
                user_geom_4326 = user_geom_4326.buffer(0)
                print(f"✓ Fixed with buffer(0). New is_valid: {user_geom_4326.is_valid}")
            except Exception as e2:
                print(f"[ERROR] Both make_valid and buffer(0) failed: {e2}")
                raise ValueError(f"Cannot fix invalid geometry: {e2}")
    
    # Ensure it's a Polygon or MultiPolygon
    if not isinstance(user_geom_4326, (Polygon, MultiPolygon)):
        raise ValueError(f"Geometry must be Polygon or MultiPolygon, got {type(user_geom_4326)}")
    
    # Get bounds in EPSG:4326 (assumed CRS for GeoJSON)
    user_bounds_4326 = user_geom_4326.bounds  # (minx, miny, maxx, maxy) = (west, south, east, north)
    print(f"User geometry bounds (EPSG:4326): {user_bounds_4326}")
    print(f"  -> west (lon): {user_bounds_4326[0]}")
    print(f"  -> south (lat): {user_bounds_4326[1]}")
    print(f"  -> east (lon): {user_bounds_4326[2]}")
    print(f"  -> north (lat): {user_bounds_4326[3]}")
    print("="*60)

    # ============================================
    # STEP 3: Use ONLY user polygon (NOT global AOI intersection)
    # ============================================
    print("\n" + "="*60)
    print("USER POLYGON (NO GLOBAL AOI INTERSECTION)")
    print("="*60)
    print("⚠️  IMPORTANT: Using ONLY user polygon - NO intersection with global AOI")
    print("⚠️  This ensures the clip matches exactly what the user drew")
    
    # Use the user geometry directly - NO intersection with global AOI
    user_geom_4326_final = user_geom_4326
    user_bounds_4326_final = user_geom_4326_final.bounds
    
    print(f"\nUser polygon bounds (EPSG:4326): {user_bounds_4326_final}")
    print(f"  -> west (lon): {user_bounds_4326_final[0]}")
    print(f"  -> south (lat): {user_bounds_4326_final[1]}")
    print(f"  -> east (lon): {user_bounds_4326_final[2]}")
    print(f"  -> north (lat): {user_bounds_4326_final[3]}")
    print("="*60)

    # ============================================
    # STEP 4: Reproject user polygon to raster CRS
    # ============================================
    print("\n" + "="*60)
    print("REPROJECTING USER POLYGON TO RASTER CRS")
    print("="*60)
    print(f"Source CRS: EPSG:4326 (assumed for GeoJSON)")
    print(f"Target CRS: {raster_crs}")
    
    # Create transformer: EPSG:4326 -> raster CRS
    # Use always_xy=True to ensure (lon, lat) order for EPSG:4326
    try:
        transformer_to_raster = Transformer.from_crs(
            "EPSG:4326",
            raster_crs,
            always_xy=True
        )
    except Exception as e:
        print(f"[ERROR] Failed to create transformer: {e}")
        print(traceback.format_exc())
        raise ValueError(f"Failed to create CRS transformer: {e}")

    # Reproject the user polygon geometry
    def reproject_geom(geom):
        """Reproject shapely geometry from EPSG:4326 to raster CRS"""
        return transform(transformer_to_raster.transform, geom)

    try:
        user_geom_raster_crs = reproject_geom(user_geom_4326_final)
    except Exception as e:
        print(f"[ERROR] Reprojection failed: {e}")
        print(traceback.format_exc())
        raise ValueError(f"Failed to reproject geometry: {e}")

    user_bounds_raster_crs = user_geom_raster_crs.bounds

    print("\n" + "="*60)
    print("USER POLYGON (reprojected to raster CRS)")
    print("="*60)
    print(f"Raster CRS: {raster_crs}")
    print(f"User polygon bounds (in raster CRS): {user_bounds_raster_crs}")
    print(f"  -> minx (west): {user_bounds_raster_crs[0]}")
    print(f"  -> miny (south): {user_bounds_raster_crs[1]}")
    print(f"  -> maxx (east): {user_bounds_raster_crs[2]}")
    print(f"  -> maxy (north): {user_bounds_raster_crs[3]}")
    print("="*60)

    # ============================================
    # STEP 5: Check if user polygon overlaps raster bounds
    # ============================================
    aoi_west = user_bounds_raster_crs[0]
    aoi_south = user_bounds_raster_crs[1]
    aoi_east = user_bounds_raster_crs[2]
    aoi_north = user_bounds_raster_crs[3]

    raster_west = raster_bounds.left
    raster_south = raster_bounds.bottom
    raster_east = raster_bounds.right
    raster_north = raster_bounds.top

    # Check for overlap using shapely intersection
    raster_bbox = box(raster_west, raster_south, raster_east, raster_north)
    overlaps = user_geom_raster_crs.intersects(raster_bbox)

    print("\n" + "="*60)
    print("OVERLAP CHECK")
    print("="*60)
    print(f"AOI bounds (raster CRS): west={aoi_west:.6f}, south={aoi_south:.6f}, east={aoi_east:.6f}, north={aoi_north:.6f}")
    print(f"Raster bounds (raster CRS): west={raster_west:.6f}, south={raster_south:.6f}, east={raster_east:.6f}, north={raster_north:.6f}")
    print(f"Overlaps (shapely.intersects): {overlaps}")
    print("="*60)

    if not overlaps:
        error_msg = (
            f"AOI does not overlap raster extent. "
            f"AOI (raster CRS {raster_crs}): "
            f"[{aoi_west:.6f}, {aoi_south:.6f}, {aoi_east:.6f}, {aoi_north:.6f}], "
            f"Raster: [{raster_west:.6f}, {raster_south:.6f}, {raster_east:.6f}, {raster_north:.6f}]"
        )
        print(f"[ERROR] {error_msg}")
        raise ValueError(error_msg)

    # ============================================
    # STEP 6: Clip raster with reprojected geometry
    # ============================================
    print("\n" + "="*60)
    print("CLIPPING RASTER")
    print("="*60)
    
    try:
        with rasterio.open(raster_path) as src:
            # Get nodata value from source
            src_nodata = src.nodata
            if src_nodata is None:
                print(f"⚠️  Raster has no nodata value set. Areas outside geometry will be NaN.")
            
            # Clip using user polygon geometry (in raster CRS)
            # CRITICAL: Use ONLY user polygon - NO intersection with global AOI
            geom_dict = mapping(user_geom_raster_crs)
            print(f"Calling rasterio.mask.mask with geometry in CRS: {raster_crs}")
            print(f"Geometry type: {type(user_geom_raster_crs)}")
            print(f"Geometry GeoJSON type: {geom_dict.get('type')}")
            print(f"Geometry has coordinates: {'coordinates' in geom_dict}")
            if 'coordinates' in geom_dict:
                coords = geom_dict['coordinates']
                if isinstance(coords, list) and len(coords) > 0:
                    print(f"Geometry has {len(coords[0]) if isinstance(coords[0], list) else 'N/A'} coordinate points")
            print(f"Source nodata: {src_nodata}")
            
            clipped, out_transform = mask(
                src,
                [geom_dict],  # Polygon geometry, NOT bounds
                crop=True,
                filled=False,  # CRITICAL: Don't fill with nodata - masked pixels stay masked
            )
            
            print(f"✓ Mask operation successful")
            print(f"Clipped shape: {clipped.shape}")
            print(f"Clipped type: {type(clipped)}")
            print(f"Is masked array: {isinstance(clipped, np.ma.MaskedArray)}")
            
            # Sanity log: verify mask is applied
            if isinstance(clipped, np.ma.MaskedArray):
                masked_count = np.sum(clipped.mask)
                total_count = clipped.size
                print(f"Masked pixels: {masked_count}")
                print(f"Total pixels: {total_count}")
                print(f"Masked percentage: {(masked_count / total_count * 100):.2f}%")
                if masked_count == 0:
                    print("⚠️  WARNING: No masked pixels! Polygon mask may not be applied.")
                else:
                    print(f"✓ Mask is applied: {masked_count} pixels are masked (outside polygon)")
            else:
                print("⚠️  ERROR: clipped is NOT a MaskedArray! Mask was lost.")
                print(f"Total pixels: {clipped.size}")
            
            print(f"Output transform: {out_transform}")
            if clipped.ndim == 3:
                print(f"Bands: {clipped.shape[0]}")
            print("="*60)
    except Exception as e:
        print(f"[ERROR] Mask operation failed: {e}")
        print(f"[ERROR] Raster path: {raster_path}")
        print(f"[ERROR] Raster CRS: {raster_crs}")
        print(f"[ERROR] Raster bounds: {raster_bounds}")
        print(f"[ERROR] Raster transform: {raster_transform}")
        print(f"[ERROR] AOI CRS assumed: EPSG:4326")
        print(f"[ERROR] Geometry type: {type(user_geom_raster_crs)}")
        print(f"[ERROR] Geometry bounds (raster CRS): {user_bounds_raster_crs}")
        print(traceback.format_exc())
        raise ValueError(f"Mask operation failed: {e}")

    # Handle masked array from rasterio.mask.mask()
    # When filled=False, clipped is a masked array where areas outside polygon are masked
    # The mask is True for pixels OUTSIDE the polygon (should be transparent)
    # CRITICAL: Preserve the mask throughout processing - do NOT lose it
    
    if not isinstance(clipped, np.ma.MaskedArray):
        raise ValueError("ERROR: clipped is NOT a MaskedArray! This should not happen with filled=False. The polygon mask was not applied.")
    
    # Extract mask and data while preserving the mask
    # geometry_mask is True for pixels OUTSIDE the polygon (should be transparent)
    if clipped.ndim == 3:
        # For multi-band, combine masks (pixel is masked if ANY band is masked)
        # This ensures if any band is outside polygon, the pixel is masked
        geometry_mask = clipped.mask.any(axis=0)
        # Get data array - use masked array operations to preserve mask
        # Average bands while preserving mask
        band_ma = np.ma.mean(clipped, axis=0)
        band = band_ma.data
        # Ensure mask is preserved
        if hasattr(band_ma, 'mask'):
            geometry_mask = band_ma.mask | geometry_mask
    else:
        # Single band - preserve mask directly
        geometry_mask = clipped.mask.copy()
        band = clipped.data.copy()
    
    # Valid mask: pixels that are NOT masked by geometry AND are valid data
    # geometry_mask is True for pixels outside polygon (should be transparent)
    # mask_valid is True for pixels inside polygon AND valid data
    mask_valid = ~geometry_mask  # Invert: True = valid (inside polygon)
    
    # Also exclude nodata values (in case some nodata pixels are inside polygon)
    if src_nodata is not None:
        mask_valid = mask_valid & (band != src_nodata)
    
    # Exclude NaN/Inf
    mask_valid = mask_valid & np.isfinite(band)
    
    # Final sanity check
    print(f"\n[PNG PREP] Geometry mask (outside polygon): {geometry_mask.sum()} pixels")
    print(f"[PNG PREP] Valid mask (inside polygon): {mask_valid.sum()} pixels")
    print(f"[PNG PREP] Total pixels: {band.size}")
    
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
    # IMPORTANT: Only colorize valid pixels. Masked pixels should remain transparent.
    # Do NOT colorize masked pixels - they should be transparent (alpha=0)
    
    # Create RGB image - initialize to black (won't matter since alpha=0 for masked)
    rgb_img = np.zeros((band.shape[0], band.shape[1], 3), dtype=np.uint8)
    
    # Only colorize valid pixels (inside polygon and not nodata)
    if mask_valid.any():
        # Get valid pixel values as 1D array
        valid_values = band[mask_valid]
        
        # Colorize only valid pixels
        valid_rgb = classify_to_colormap(valid_values)
        
        # Place colored pixels back into 2D image at valid positions
        # valid_rgb is shape (N, 3) where N = number of valid pixels
        # We need to reshape it to match mask_valid positions
        rgb_img[mask_valid] = valid_rgb

    # Alpha channel: 255 for valid pixels, 0 for masked/invalid pixels
    # This ensures masked pixels (outside polygon) are fully transparent
    alpha = (mask_valid * 255).astype("uint8")
    
    # Combine into RGBA
    rgba = np.dstack((rgb_img, alpha))
    
    print(f"\n[PNG] RGB shape: {rgb_img.shape}, Alpha shape: {alpha.shape}")
    print(f"[PNG] Valid pixels: {mask_valid.sum()}, Masked pixels: {(~mask_valid).sum()}")
    print(f"[PNG] Alpha range: [{alpha.min()}, {alpha.max()}]")

    # Save PNG with crisp pixel rendering (nearest neighbor, no interpolation)
    # imageio.imwrite preserves exact pixel values - no interpolation applied
    # CRITICAL: Do NOT resize or apply any interpolation - preserve native pixel size
    # 
    # NOTE: For future zoom-based rendering, we could:
    # - Accept a scale_factor parameter (e.g., 1.0 = native, 2.0 = 2x resolution)
    # - Use rasterio.warp.reproject with scale_factor to generate higher-res PNGs
    # - Cache multiple resolutions and serve based on map zoom level
    # - This would prevent pixel stretching when zooming in
    # BUT: If resizing is needed, MUST use nearest-neighbor only (no bilinear/bicubic)
    out_png = OVERLAY_DIR / f"{uuid.uuid4().hex}.png"
    # imageio.imwrite with numpy array preserves exact values - no resizing/interpolation
    imageio.imwrite(out_png, rgba)
    
    print(f"[PNG] Saved: {out_png.name}")
    print(f"[PNG] Dimensions: {rgba.shape[1]}x{rgba.shape[0]} (width x height)")
    print(f"[PNG] Pixel rendering: nearest neighbor (crisp, no smoothing) - matches ArcGIS Pro")
    print(f"[PNG] Note: Native pixel size preserved (~600-800m). Frontend handles interpolation mode.")

    # ============================================
    # STEP 7: Compute bounds in raster CRS, then transform to EPSG:4326
    # ============================================
    height, width = band.shape
    
    # Use array_bounds() to get accurate bounds from transform and shape
    # This returns (left, bottom, right, top) in the CRS of the transform
    west_raster, south_raster, east_raster, north_raster = array_bounds(
        height, width, out_transform
    )

    print("\n" + "="*60)
    print("CLIPPED BOUNDS (raster CRS)")
    print("="*60)
    print(f"West: {west_raster:.6f}, South: {south_raster:.6f}")
    print(f"East: {east_raster:.6f}, North: {north_raster:.6f}")
    print("="*60)

    # Transform bounds from raster CRS to EPSG:4326
    # transform_bounds returns (minx, miny, maxx, maxy) = (west, south, east, north)
    # Use densify_pts for better accuracy when transforming bounds
    try:
        bounds_4326 = transform_bounds(
            raster_crs,
            "EPSG:4326",
            west_raster,
            south_raster,
            east_raster,
            north_raster,
            densify_pts=21  # Densify bounds for more accurate transformation
        )
    except Exception as e:
        print(f"[ERROR] Failed to transform bounds: {e}")
        print(traceback.format_exc())
        raise ValueError(f"Failed to transform bounds to EPSG:4326: {e}")

    west_4326, south_4326, east_4326, north_4326 = bounds_4326

    print("\n" + "="*60)
    print("CLIPPED BOUNDS (EPSG:4326 for Leaflet)")
    print("="*60)
    print(f"West (lon): {west_4326:.6f}")
    print(f"South (lat): {south_4326:.6f}")
    print(f"East (lon): {east_4326:.6f}")
    print(f"North (lat): {north_4326:.6f}")
    print("="*60)
    
    # Final bounds validation log
    print("\n" + "="*60)
    print("FINAL BOUNDS SENT TO FRONTEND (EPSG:4326)")
    print("="*60)
    print(f"{{west: {west_4326:.6f}, south: {south_4326:.6f}, east: {east_4326:.6f}, north: {north_4326:.6f}}}")
    print(f"Expected Oregon range: west≈-125..-116, lat≈42..49")
    print(f"✓ West (lon) in range: {-125 <= west_4326 <= -116}")
    print(f"✓ East (lon) in range: {-125 <= east_4326 <= -116}")
    print(f"✓ South (lat) in range: {42 <= south_4326 <= 49}")
    print(f"✓ North (lat) in range: {42 <= north_4326 <= 49}")
    print("="*60 + "\n")

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
            "west": float(west_4326),   # lon
            "south": float(south_4326), # lat
            "east": float(east_4326),   # lon
            "north": float(north_4326), # lat
        },
        # 👇 for charts
        "pixels": pixel_list,
        "values": pixel_list,   # alias so frontend can use either
    }

# -----------------------------------------
# SAMPLE SINGLE VALUE AT LON / LAT
# -----------------------------------------
def sample_raster_value(raster_layer_id: int, lon: float, lat: float):
    """
    Get raster value at a given lon/lat.

    NOTE: Assumes raster CRS is geographic (e.g. EPSG:4269).
    If you later use projected rasters, you'll want to reproject
    the (lon, lat) into the raster's CRS before sampling.
    """
    raster_path = resolve_raster_path(raster_layer_id)

    with rasterio.open(raster_path) as src:
        # Use rasterio's sampling at a single point
        # (x = lon, y = lat)
        sample = list(src.sample([(lon, lat)]))[0]

        # If multi-band, just take the first band (or mean if you prefer)
        value = float(sample[0])

        nodata = src.nodata
        if nodata is not None and value == nodata:
            return {
                "value": None,
                "is_nodata": True,
                "crs": src.crs.to_string() if src.crs else None,
            }

        return {
            "value": value,
            "is_nodata": False,
            "crs": src.crs.to_string() if src.crs else None,
        }
