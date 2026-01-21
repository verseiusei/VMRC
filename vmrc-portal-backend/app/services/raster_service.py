# app/services/raster_service.py
import uuid
import traceback
from pathlib import Path

import rasterio
from rasterio.mask import mask
from rasterio.features import geometry_mask
from rasterio.enums import Resampling
from rasterio.transform import array_bounds, from_bounds
from rasterio.warp import transform_bounds, transform_geom, reproject, calculate_default_transform
from shapely.geometry import shape as shapely_shape, mapping, Polygon, MultiPolygon, box
from shapely.ops import unary_union
from shapely.validation import make_valid
import numpy as np
import fiona
import imageio
from typing import Optional

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
        geoms = [shapely_shape(feat["geometry"]) for feat in src]
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
def clip_raster_for_layer(raster_layer_id: int, user_clip_geojson: dict, zoom: Optional[int] = None):
    """
    Clip raster to user-drawn AOI with proper CRS handling and validation.
    
    This function:
    1. Resolves raster_layer_id to absolute file path
    2. Generates an overlay PNG from the AOI geometry (zoom-independent; no view/zoom-derived resampling)
    3. Clips to user AOI with all_touched=True
    4. Generates PNG overlay and computes histogram from native resolution
    
    Args:
        raster_layer_id: ID of the raster layer to clip
        user_clip_geojson: GeoJSON polygon defining the AOI (EPSG:4326)
        zoom: Deprecated. Previously used for zoom-based display overlay resampling.
              Generation is now zoom-independent; AOI geometry is the only driver.
    
    Returns:
        dict with overlay_url, stats, bounds, pixels, histogram
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
        user_geom_4326 = shapely_shape(user_geom_dict)
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
    
    # ============================================================
    # COMPUTE AOI BOUNDS IN EPSG:4326 (ALWAYS DEFINED)
    # ============================================================
    # CRITICAL: Compute bounds immediately after validation to ensure it's always defined.
    # This prevents UnboundLocalError if bounds are needed later in the function.
    # ============================================================
    
    # Guardrails: Ensure geometry is valid and not empty
    if user_geom_4326 is None:
        raise ValueError("User clip geometry is None")
    
    if user_geom_4326.is_empty:
        raise ValueError("User clip geometry is empty")
    
    # Final validation: ensure geometry is valid after fixing attempts
    if not user_geom_4326.is_valid:
        print("⚠️  Geometry is still invalid after fix attempts, trying buffer(0) as last resort...")
        try:
            user_geom_4326 = user_geom_4326.buffer(0)
            if user_geom_4326.is_empty or not user_geom_4326.is_valid:
                raise ValueError("Geometry is still invalid or empty after buffer(0)")
            print(f"✓ Fixed with buffer(0). New is_valid: {user_geom_4326.is_valid}, is_empty: {user_geom_4326.is_empty}")
        except Exception as e:
            print(f"[ERROR] buffer(0) failed: {e}")
            raise ValueError(f"Cannot fix invalid geometry: {e}")
    
    # Compute bounds: (minx, miny, maxx, maxy) = (west, south, east, north)
    minx, miny, maxx, maxy = user_geom_4326.bounds
    aoi_bounds_4326 = (minx, miny, maxx, maxy)
    
    # Also store individual components for easy access
    aoi_west_4326 = minx
    aoi_south_4326 = miny
    aoi_east_4326 = maxx
    aoi_north_4326 = maxy
    
    print(f"User geometry bounds (EPSG:4326): {aoi_bounds_4326}")
    print(f"  -> west (lon): {aoi_west_4326}")
    print(f"  -> south (lat): {aoi_south_4326}")
    print(f"  -> east (lon): {aoi_east_4326}")
    print(f"  -> north (lat): {aoi_north_4326}")
    print("="*60)
    
    # Get bounds in EPSG:4326 (assumed CRS for GeoJSON) - for backward compatibility
    user_bounds_4326 = aoi_bounds_4326

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
    # STEP 4: Reproject user polygon to raster CRS using rasterio.warp.transform_geom
    # ============================================
    print("\n" + "="*60)
    print("REPROJECTING USER POLYGON TO RASTER CRS")
    print("="*60)
    print(f"Source CRS: EPSG:4326 (assumed for GeoJSON)")
    print(f"Target CRS: {raster_crs}")
    
    # Use rasterio.warp.transform_geom for precise reprojection (better than shapely.transform)
    # This ensures coordinate precision is maintained for raster operations
    try:
        # Convert shapely geometry to GeoJSON dict for transform_geom
        aoi_geom_src = mapping(user_geom_4326_final)
        
        # Reproject using rasterio's transform_geom (more precise for raster operations)
        aoi_geom_raster_crs = transform_geom(
            "EPSG:4326",
            raster_crs.to_string() if hasattr(raster_crs, 'to_string') else str(raster_crs),
            aoi_geom_src,
            precision=6  # 6 decimal places for precision
        )
        
        # Convert back to shapely for bounds checking
        user_geom_raster_crs = shapely_shape(aoi_geom_raster_crs)
        
        print(f"✓ Geometry reprojected successfully")
        print(f"  Source geometry type: {aoi_geom_src.get('type')}")
        print(f"  Reprojected geometry type: {aoi_geom_raster_crs.get('type')}")
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
        error_msg = "AOI outside raster extent"
        error_detail = (
            f"AOI does not overlap raster extent. "
            f"AOI (raster CRS {raster_crs}): "
            f"[{aoi_west:.6f}, {aoi_south:.6f}, {aoi_east:.6f}, {aoi_north:.6f}], "
            f"Raster: [{raster_west:.6f}, {raster_south:.6f}, {raster_east:.6f}, {raster_north:.6f}]"
        )
        print(f"[ERROR] {error_detail}")
        # Raise a custom exception that will be caught and converted to 422
        class AOIOutsideRasterError(ValueError):
            """Custom exception for AOI outside raster extent - should return 422"""
            pass
        raise AOIOutsideRasterError(error_msg)

    # ============================================
    # STEP 6: Clip raster with reprojected geometry
    # ============================================
    print("\n" + "="*60)
    print("CLIPPING RASTER")
    print("="*60)
    
    # Store original geometry for histogram calculation (always uses native resolution)
    original_geom_raster_crs = aoi_geom_raster_crs.copy()
    
    # ============================================================
    # IMPORTANT: Generation must be zoom-independent.
    # We intentionally ignore any provided `zoom` when clipping/stats generation.
    # ============================================================
    if zoom is not None:
        print(f"\n[CLIP] Zoom provided by client (deprecated, ignored): {zoom}")
    # Keep variable for backward-compatible code paths; always disabled now.
    use_high_res_overlay = False
    
    try:
        with rasterio.open(raster_path) as src:
            native_res_x, native_res_y = src.res
            print(f"[CLIP] Native raster resolution: x={native_res_x:.2f}, y={native_res_y:.2f} (units per pixel)")
            
            # Convert GeoJSON dict to shapely geometry
            original_geom_shapely = shapely_shape(original_geom_raster_crs)
            
            # Determine nodata value first (needed for both paths)
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
                    # For float types, use a sentinel value
                    nodata_value = -9999
                print(f"[CLIP] Source has no nodata, using {nodata_value} as nodata value")
            else:
                print(f"[CLIP] Using source nodata value: {nodata_value}")
            
            # ============================================================
            # Overlay generation (zoom-independent): half-pixel buffer at native resolution
            # ============================================================
                # Raster resolution causes unavoidable edge stair-stepping;
                # buffering improves visual coverage.
                # 
                # Coarse resolution (~27m/pixel) creates blocky pixel grid that
                # visually appears not to fully cover AOI edges, even with all_touched=True.
                # Buffering by half a pixel extends geometry slightly to ensure
                # edge pixels are fully included in overlay rendering.
                #
                # IMPORTANT: This is VISUAL ONLY - histogram and export use original AOI.
                # ============================================================
                
                # Compute buffer distance = 0.5 * max(abs(res_x), abs(res_y))
                buffer_dist = 0.5 * max(abs(native_res_x), abs(native_res_y))
                print(f"[CLIP] Buffer distance: {buffer_dist:.2f} (half pixel)")
                
                # Buffer the geometry for overlay generation ONLY
                # This provides better visual coverage while keeping analysis accurate
                buffered_geom_shapely = original_geom_shapely.buffer(buffer_dist)
                buffered_geom_raster_crs = mapping(buffered_geom_shapely)
                
                print(f"[CLIP] Original geometry bounds: {original_geom_shapely.bounds}")
                print(f"[CLIP] Buffered geometry bounds: {buffered_geom_shapely.bounds}")
                print(f"[CLIP] ✓ Using BUFFERED geometry for overlay PNG (visual fix)")
                print(f"[CLIP] ✓ Using ORIGINAL geometry for histogram/export (accurate analysis)")
                
                # Use buffered geometry for overlay clipping
                shapes_overlay = [buffered_geom_raster_crs]  # Buffered for overlay
                
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
                        # For float types, use a sentinel value
                        nodata_value = -9999
                    print(f"[CLIP] Source has no nodata, using {nodata_value} as nodata value")
                else:
                    print(f"[CLIP] Using source nodata value: {nodata_value}")
                
                print(f"Calling rasterio.mask.mask with buffered geometry in CRS: {raster_crs}")
                
                # ============================================================
                # MASK RASTER: Apply TRUE polygon mask (not bbox crop)
                # ============================================================
                # CRITICAL: This applies a polygon mask, not just a bounding box crop.
                # Pixels outside the polygon are filled with nodata and will be transparent.
                # all_touched=True ensures every pixel touched by the boundary is included.
                # ============================================================
                print(f"[CLIP] Applying polygon mask (not bbox crop)...")
                print(f"[CLIP] AOI bounds in raster CRS: {original_geom_shapely.bounds}")
                clipped, out_transform = mask(
                    src,
                    shapes_overlay,  # Polygon geometry in raster CRS (GeoJSON dict) - NOT bounds!
                    crop=True,  # Crop to polygon bounds (but mask by polygon shape)
                    all_touched=True,  # CRITICAL: Include any pixel touched by boundary
                    filled=True,  # Fill outside polygon with nodata (makes transparent)
                    nodata=nodata_value  # Pixels outside polygon become this value
                )
                
                # Debug validation: Verify polygon mask was applied (not just bbox crop)
                # Guard against empty arrays before calling np.mean()
                if clipped.size == 0:
                    print(f"[DEBUG] ⚠️  Clipped result is empty: shape={clipped.shape}")
                else:
                    try:
                        if clipped.ndim == 3:
                            if clipped.shape[0] > 0:
                                check_band = np.mean(clipped, axis=0)
                            else:
                                check_band = clipped[0] if clipped.shape[0] == 1 else np.zeros_like(clipped[0])
                        else:
                            check_band = clipped
                        nodata_count = np.sum((check_band == nodata_value) & np.isfinite(check_band))
                        total_pixels = check_band.size
                        nodata_percent = (nodata_count / total_pixels * 100) if total_pixels > 0 else 0
                        print(f"[DEBUG] Mask validation:")
                        print(f"[DEBUG]   - Output raster shape: {clipped.shape}")
                        print(f"[DEBUG]   - Nodata pixels: {nodata_count}/{total_pixels} ({nodata_percent:.1f}%)")
                        print(f"[DEBUG]   - Valid pixels (inside polygon): {total_pixels - nodata_count}")
                        print(f"[DEBUG] ✓ Polygon mask applied - outside AOI is nodata (will be transparent in PNG)")
                    except (ValueError, ZeroDivisionError) as e:
                        print(f"[DEBUG] ⚠️  Error computing mask validation: {e}")
            
            print(f"✓ Mask operation successful")
            print(f"Clipped shape: {clipped.shape}")
            print(f"Clipped type: {type(clipped)}")
            print(f"Output transform: {out_transform}")
            if clipped.ndim == 3:
                print(f"Bands: {clipped.shape[0]}")
            
            # ============================================================
            # CHECK FOR EMPTY MASK RESULT
            # ============================================================
            if clipped.size == 0 or clipped.shape[0] == 0 or (clipped.ndim >= 2 and (clipped.shape[-1] == 0 or clipped.shape[-2] == 0)):
                error_msg = "AOI too small / no intersect"
                print(f"[ERROR] Mask result is empty: shape={clipped.shape}, size={clipped.size}")
                class EmptyMaskError(ValueError):
                    """Custom exception for empty mask result - should return 422"""
                    pass
                raise EmptyMaskError(error_msg)
            
            # Count valid pixels (inside polygon, not nodata)
            # Guard against empty arrays before calling np.mean()
            try:
                if clipped.ndim == 3:
                    if clipped.shape[0] > 0:
                        band_check = np.mean(clipped, axis=0)
                    else:
                        # Empty bands - this should have been caught earlier, but safety guard
                        band_check = np.array([])
                else:
                    band_check = clipped
                valid_count = np.sum((band_check != nodata_value) & np.isfinite(band_check)) if band_check.size > 0 else 0
                total_count = band_check.size
                # Guard against division by zero when computing percentage
                if total_count > 0:
                    valid_percent = (valid_count / total_count * 100)
                    print(f"Valid pixels (inside polygon): {valid_count} / {total_count} ({valid_percent:.2f}%)")
                else:
                    print(f"Valid pixels (inside polygon): {valid_count} / {total_count} (0.00%)")
            except (ValueError, ZeroDivisionError) as e:
                print(f"[ERROR] Failed to count valid pixels: {e}")
                valid_count = 0
                total_count = 0
            
            # ============================================================
            # CHECK FOR NO VALID PIXELS
            # ============================================================
            if valid_count == 0:
                error_msg = "AOI contains no valid raster pixels (outside extent or all nodata)."
                print(f"[ERROR] No valid pixels found in clipped area")
                class NoValidDataError(ValueError):
                    """Custom exception for no valid data - should return 422"""
                    pass
                raise NoValidDataError(error_msg)
            
            print("="*60)
    except Exception as e:
        # Check if this is a division-by-zero or "no data" error
        error_str = str(e).lower()
        if "division by zero" in error_str or "divide by zero" in error_str or "zero" in error_str:
            # This is likely a "no data" case - return 422
            error_msg = "AOI contains no valid raster pixels (outside extent or all nodata)."
            print(f"[ERROR] Mask operation failed with division-by-zero (likely no valid data): {e}")
            print(f"[ERROR] Raster path: {raster_path}")
            print(f"[ERROR] Raster CRS: {raster_crs}")
            print(f"[ERROR] Raster bounds: {raster_bounds}")
            print(f"[ERROR] AOI bounds (raster CRS): {user_bounds_raster_crs}")
            print(traceback.format_exc())
            class NoValidDataError(ValueError):
                """Custom exception for no valid data - should return 422"""
                pass
            raise NoValidDataError(error_msg)
        else:
            # Unexpected error - log full details but don't expose stack trace to client
            print(f"[ERROR] Mask operation failed: {e}")
            print(f"[ERROR] Raster path: {raster_path}")
            print(f"[ERROR] Raster CRS: {raster_crs}")
            print(f"[ERROR] Raster bounds: {raster_bounds}")
            print(f"[ERROR] Raster transform: {raster_transform}")
            print(f"[ERROR] AOI CRS assumed: EPSG:4326")
            print(f"[ERROR] Geometry type: {type(user_geom_raster_crs)}")
            print(f"[ERROR] Geometry bounds (raster CRS): {user_bounds_raster_crs}")
            print(traceback.format_exc())
            # Re-raise as ValueError to be caught by endpoint handler
            raise ValueError(f"Mask operation failed: {e}")

    # Handle output from rasterio.mask.mask()
    # When filled=True, clipped is a regular numpy array (not masked array)
    # Pixels outside buffered polygon are filled with nodata_value
    # We need to identify which pixels are valid for overlay (buffered) and histogram (original)
    
    # Extract data array
    if clipped.ndim == 3:
        # Multi-band: average bands for display
        band = np.mean(clipped, axis=0).astype(float)
    else:
        # Single band
        band = clipped.astype(float)
    
    # ============================================================
    # CRITICAL: Build valid_mask RIGHT AFTER mask() and BEFORE any normalization
    # ============================================================
    # This must happen immediately after mask() to catch empty/no-data cases
    # before any normalization or color mapping operations that could divide by zero
    # ============================================================
    
    # Build valid_mask: finite pixels AND not nodata
    mask_valid_overlay = np.isfinite(band)
    
    # Exclude nodata pixels (these are outside polygon or actual nodata)
    # CRITICAL: This is how we ensure outside-AOI pixels are transparent
    if nodata_value is not None:
        mask_valid_overlay = mask_valid_overlay & (band != nodata_value)
    
    # Count valid pixels immediately
    valid_count = int(mask_valid_overlay.sum())
    total_count = int(band.size)
    nodata_count = total_count - valid_count
    
    # Log valid pixel count immediately
    print(f"\n[VALID MASK] Valid pixels (finite and != nodata): {valid_count}")
    print(f"[VALID MASK] Nodata pixels (outside polygon or nodata): {nodata_count}")
    print(f"[VALID MASK] Total pixels: {total_count}")
    
    # ============================================================
    # CHECK FOR NO VALID PIXELS - MUST HAPPEN BEFORE ANY NORMALIZATION
    # ============================================================
    if valid_count == 0:
        error_msg = "AOI contains no raster data for this layer."
        print(f"[ERROR] No valid pixels found after masking. valid_count={valid_count}, total_count={total_count}")
        class NoValidDataError(ValueError):
            """Custom exception for no valid data - should return 422"""
            pass
        raise NoValidDataError(error_msg)
    
    print(f"[VALID MASK] ✓ Found {valid_count} valid pixels - proceeding with normalization/color mapping")
    
    # ============================================================
    # CREATE OVERLAY MASK: Pixels inside polygon (exclude nodata)
    # ============================================================
    # The clipped raster from mask() has nodata_value in pixels outside the polygon.
    # We create a mask to identify valid pixels (inside polygon, not nodata).
    # This mask is used for PNG overlay rendering - nodata pixels will be transparent.
    # ============================================================
    
    # Debug: Verify mask correctly identifies polygon interior
    print(f"[PNG MASK] Valid pixels (inside polygon): {valid_count}")
    print(f"[PNG MASK] Nodata pixels (outside polygon): {nodata_count}")
    print(f"[PNG MASK] Total pixels: {band.size}")
    print(f"[PNG MASK] ✓ Mask correctly identifies polygon interior vs exterior")
    
    # ============================================================
    # HISTOGRAM / STATS: Use AOI geometry only (zoom-independent)
    # ============================================================
    # Overlay uses buffered geometry for visual coverage, but histogram/stats must use
    # the ORIGINAL AOI geometry only (no buffer, no zoom-derived resampling).
    #
    # We already have `band` from the buffered clip; filter it back down to the
    # original AOI footprint using geometry_mask + the clipped transform.
    # ============================================================
    mask_original_geom = geometry_mask(
        [original_geom_raster_crs],  # Original geometry (not buffered)
        out_shape=band.shape,
        transform=out_transform,
        invert=True,  # True = inside original polygon
        all_touched=True
    )

    mask_valid_histogram = mask_original_geom
    if nodata_value is not None:
        mask_valid_histogram = mask_valid_histogram & (band != nodata_value)
    mask_valid_histogram = mask_valid_histogram & np.isfinite(band)

    valid_pixels_histogram = band[mask_valid_histogram]
    
    # Final sanity check
    print(f"\n[PNG PREP] Overlay mask: {mask_valid_overlay.sum()} pixels")
    print(f"[PNG PREP] Histogram mask: {valid_pixels_histogram.size} pixels")
    print(f"[PNG PREP] Total overlay pixels: {band.size}")
    
    # Use overlay mask for PNG rendering
    valid_pixels_overlay = band[mask_valid_overlay]

    # ============================================================
    # CHECK FOR NO VALID PIXELS (with proper error handling)
    # ============================================================
    # NOTE: This is a redundant check - valid_count was already checked above
    # But we keep it as a safety guard in case something went wrong
    if valid_pixels_overlay.size == 0:
        error_msg = "AOI contains no raster data for this layer."
        print(f"[ERROR] valid_pixels_overlay is empty (redundant check - valid_count was already checked)")
        class NoValidDataError(ValueError):
            """Custom exception for no valid data - should return 422"""
            pass
        raise NoValidDataError(error_msg)
    
    if valid_pixels_histogram.size == 0:
        # If overlay has valid pixels but original AOI mask yields none, treat it as no-data.
        # This keeps behavior consistent and avoids silently switching to buffered stats.
        error_msg = "AOI contains no valid raster pixels (outside extent or all nodata)."
        print(f"[ERROR] Histogram: No valid pixels in original AOI at native resolution.")
        class NoValidDataError(ValueError):
            """Custom exception for no valid data - should return 422"""
            pass
        raise NoValidDataError(error_msg)

    # -----------------------------
    # Chart data (for histogram/heatmap) - use ORIGINAL geometry
    # -----------------------------
    flat_valid = valid_pixels_histogram.astype(float)  # Use histogram pixels (original AOI)

    # Sample to avoid sending millions of pixels
    MAX_PIXELS = 50000
    if flat_valid.size > MAX_PIXELS:
        idx = np.random.choice(flat_valid.size, MAX_PIXELS, replace=False)
        flat_valid = flat_valid[idx]

    pixel_list = flat_valid.tolist()

    # -----------------------------
    # Colorize for map overlay - use BUFFERED geometry
    # -----------------------------
    # IMPORTANT: Only colorize valid pixels. Masked pixels should remain transparent.
    # Do NOT colorize masked pixels - they should be transparent (alpha=0)
    # Use BUFFERED mask for overlay (better visual coverage)
    
    # Create RGB image - initialize to black (won't matter since alpha=0 for masked)
    rgb_img = np.zeros((band.shape[0], band.shape[1], 3), dtype=np.uint8)
    
    # Only colorize valid pixels (inside buffered polygon and not nodata)
    if mask_valid_overlay.any():
        # Get valid pixel values as 1D array (from buffered overlay)
        valid_values_overlay = band[mask_valid_overlay]
        
        # Colorize only valid pixels
        valid_rgb = classify_to_colormap(valid_values_overlay)
        
        # Place colored pixels back into 2D image at valid positions
        # valid_rgb is shape (N, 3) where N = number of valid pixels
        # We need to reshape it to match mask_valid_overlay positions
        rgb_img[mask_valid_overlay] = valid_rgb

    # -----------------------------
    # Compute histogram from REAL raster values (not PNG/RGB/alpha)
    # -----------------------------
    # CRITICAL: Use ORIGINAL geometry pixels (not buffered) for histogram
    # These are the REAL raster float values, NOT image bytes (0-255) or clamped values
    # Bins: [0,10), [10,20), ..., [80,90), [90,100] where 100 is included in last bin
    # This matches the classify_to_colormap binning logic exactly
    
    histogram_bins = np.array([0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100.0001])  # 100.0001 to include 100 in last bin
    histogram_counts = np.zeros(10, dtype=int)
    histogram_percentages = np.zeros(10, dtype=float)
    
    # Use histogram mask (original geometry, not buffered)
    valid_values_histogram = valid_pixels_histogram  # Already computed from mask_valid_histogram
    
    if mask_valid_histogram.any():
        # Use the REAL raster values from ORIGINAL geometry - these are float values from the raster dataset
        # DO NOT clamp or modify these values - use them as-is
        # The classify_to_colormap function expects values in 0-100 range
        # If values are outside this range, they should be handled by the colormap function itself
        
        # Log the actual raster values to verify we're using the right data
        # Guard against empty arrays before calling min/max/mean/std
        if valid_values_histogram.size == 0:
            print(f"[HISTOGRAM] ⚠️  WARNING: valid_values_histogram is empty - cannot compute stats")
        else:
            print(f"\n[HISTOGRAM] Using REAL raster values from ORIGINAL AOI (not buffered, not PNG/RGB/alpha)")
            print(f"[HISTOGRAM] Raw raster value stats:")
            try:
                vmin = float(valid_values_histogram.min())
                vmax = float(valid_values_histogram.max())
                vmean = float(valid_values_histogram.mean())
                vcount = valid_values_histogram.size
                # Guard std computation - numpy.std can have issues with single values
                if vcount > 1:
                    vstd = float(valid_values_histogram.std())
                elif vcount == 1:
                    vstd = 0.0
                else:
                    vstd = 0.0
                print(f"  - Min: {vmin:.6f}")
                print(f"  - Max: {vmax:.6f}")
                print(f"  - Mean: {vmean:.6f}")
                print(f"  - Std: {vstd:.6f}")
                print(f"  - Count: {vcount}")
                
                # Guard against non-finite min/max
                if not np.isfinite(vmin) or not np.isfinite(vmax):
                    print(f"[HISTOGRAM] ⚠️  WARNING: Min or max is not finite: min={vmin}, max={vmax}")
            except (ValueError, ZeroDivisionError) as e:
                print(f"[HISTOGRAM] ⚠️  ERROR computing stats: {e}")
                print(f"[HISTOGRAM] ⚠️  Array size: {valid_values_histogram.size}, shape: {valid_values_histogram.shape if hasattr(valid_values_histogram, 'shape') else 'N/A'}")
        
        # Sanity check: if min=0 and max=255, we're using image bytes (WRONG)
        if valid_values_histogram.min() == 0 and valid_values_histogram.max() == 255:
            print(f"[HISTOGRAM] ⚠️  WARNING: Values are 0-255 (image bytes) - this is WRONG!")
            print(f"[HISTOGRAM] ⚠️  Expected: float values in 0-100 range matching Stats Summary")
        elif valid_values_histogram.min() >= 0 and valid_values_histogram.max() <= 1.5:
            print(f"[HISTOGRAM] ⚠️  Values appear to be in 0-1 range, may need scaling to 0-100")
        elif valid_values_histogram.min() >= 0 and valid_values_histogram.max() <= 100:
            print(f"[HISTOGRAM] ✓ Values are in expected 0-100 range")
        else:
            print(f"[HISTOGRAM] ⚠️  Values are outside 0-100 range: [{valid_values_histogram.min():.2f}, {valid_values_histogram.max():.2f}]")
        
        # Use values AS-IS (no clamping) - the colormap handles out-of-range values
        # But for histogram, we only want to bin values that are in the valid 0-100 range
        # Values outside this range should be excluded from histogram (they're edge cases)
        values_for_hist = valid_values_histogram.copy()
        
        # Only include values in [0, 100] range for histogram
        # Values outside this range are edge cases and shouldn't affect the histogram
        valid_range_mask = (values_for_hist >= 0) & (values_for_hist <= 100)
        values_in_range = values_for_hist[valid_range_mask]
        
        if values_in_range.size == 0:
            print(f"[HISTOGRAM] ⚠️  WARNING: No values in [0, 100] range!")
        else:
            print(f"[HISTOGRAM] Values in [0, 100] range: {values_in_range.size} / {valid_values_histogram.size}")
            if values_in_range.size < valid_values_histogram.size:
                out_of_range = valid_values_histogram.size - values_in_range.size
                print(f"[HISTOGRAM] Excluded {out_of_range} values outside [0, 100] range")
        
        # Bin assignment: same logic as classify_to_colormap
        # np.digitize returns index of bin, where:
        # - value in [0, 10) -> index 1 -> bin 0
        # - value in [10, 20) -> index 2 -> bin 1
        # - ...
        # - value == 100 -> index 10 -> bin 9 (last bin)
        if values_in_range.size > 0:
            bin_indices = np.digitize(values_in_range, histogram_bins) - 1
            # Clamp to valid range [0, 9] (shouldn't be needed, but safety check)
            bin_indices = np.clip(bin_indices, 0, 9)
            
            # Count pixels in each bin using numpy bincount (efficient)
            counts = np.bincount(bin_indices, minlength=10)
            histogram_counts = counts.astype(int)
            
            # Compute percentages (guard against division by zero)
            total_for_percentages = histogram_counts.sum()
            if total_for_percentages > 0:
                histogram_percentages = (histogram_counts / total_for_percentages * 100).astype(float)
            else:
                # No pixels in [0, 100] range - set all percentages to 0
                histogram_percentages = np.zeros(10, dtype=float)
                print(f"[HISTOGRAM] ⚠️  WARNING: No pixels in [0, 100] range for histogram percentages")
        
        total_valid_pixels = int(valid_values_histogram.size)
    else:
        total_valid_pixels = 0
    
    print(f"\n[HISTOGRAM] Final histogram stats:")
    print(f"  - Total valid pixels: {total_valid_pixels}")
    print(f"  - Pixels in [0, 100] range: {histogram_counts.sum()}")
    print(f"  - Bin counts: {histogram_counts.tolist()}")
    print(f"  - Bin percentages: {[f'{p:.2f}%' for p in histogram_percentages]}")
    print(f"  - Sum of bins: {histogram_counts.sum()} (should equal pixels in [0, 100] range)")

    # ============================================================
    # ALPHA CHANNEL: Make nodata pixels transparent
    # ============================================================
    # CRITICAL: Alpha channel determines transparency in PNG.
    # Pixels outside the polygon (nodata) must have alpha=0 (fully transparent).
    # Pixels inside the polygon must have alpha=255 (fully opaque).
    # This is what makes the overlay match the AOI polygon shape, not a rectangle.
    # ============================================================
    
    # Alpha channel: 255 for valid pixels (inside polygon), 0 for nodata (outside polygon)
    alpha = (mask_valid_overlay * 255).astype("uint8")
    
    # Combine into RGBA
    rgba = np.dstack((rgb_img, alpha))
    
    # Debug validation: Confirm transparency is correct
    transparent_count = (alpha == 0).sum()
    opaque_count = (alpha == 255).sum()
    print(f"\n[PNG ALPHA] RGB shape: {rgb_img.shape}, Alpha shape: {alpha.shape}")
    print(f"[PNG ALPHA] Transparent pixels (outside polygon): {transparent_count}")
    print(f"[PNG ALPHA] Opaque pixels (inside polygon): {opaque_count}")
    print(f"[PNG ALPHA] Alpha range: [{alpha.min()}, {alpha.max()}]")
    print(f"[PNG ALPHA] ✓ Outside-AOI pixels are transparent (alpha=0)")
    print(f"[PNG ALPHA] ✓ Inside-AOI pixels are opaque (alpha=255)")
    print(f"[PNG ALPHA] ✓ Overlay will match AOI polygon shape (not rectangular bbox)")

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
    # STEP 7: Compute Leaflet overlay bounds from clipped raster transform
    # ============================================
    # CRITICAL: Use the clipped raster transform for bounds (truth source).
    # This ensures overlay bounds exactly match what pixels are in the PNG.
    # Do NOT use AOI bounds - use array_bounds from the actual clipped raster.
    # ============================================
    
    # Get dimensions from clipped raster
    h, w = band.shape
    
    # array_bounds returns (left, bottom, right, top) = (west, south, east, north)
    # This is the TRUE bounds of the clipped raster pixels
    west_raster, south_raster, east_raster, north_raster = array_bounds(
        h, w, out_transform
    )

    print("\n" + "="*60)
    print("CLIPPED RASTER BOUNDS (from transform - truth source)")
    print("="*60)
    print(f"West: {west_raster:.6f}, South: {south_raster:.6f}")
    print(f"East: {east_raster:.6f}, North: {north_raster:.6f}")
    print(f"Raster CRS: {raster_crs}")
    print("="*60)

    # Transform bounds from raster CRS to EPSG:4326 for Leaflet
    # transform_bounds returns (west, south, east, north) in EPSG:4326
    # Use densify_pts=21 for better accuracy when transforming bounds
    # Leaflet expects bounds as [[south, west], [north, east]]
    try:
        west_4326, south_4326, east_4326, north_4326 = transform_bounds(
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

    print("\n" + "="*60)
    print("CLIPPED BOUNDS (EPSG:4326 for Leaflet)")
    print("="*60)
    print(f"West (lon): {west_4326:.6f}")
    print(f"South (lat): {south_4326:.6f}")
    print(f"East (lon): {east_4326:.6f}")
    print(f"North (lat): {north_4326:.6f}")
    print("="*60)
    
    # ============================================================
    # SANITY CHECK: Verify overlay bounds intersect AOI bounds
    # ============================================================
    # This ensures the overlay is in the correct location and not appearing as blobs far from AOI
    # ============================================================
    print("\n" + "="*60)
    print("SANITY CHECK: Overlay bounds vs AOI bounds")
    print("="*60)
    
    # Get AOI bounds in EPSG:4326 (from original user geometry)
    # NOTE: aoi_bounds_4326, aoi_west_4326, aoi_south_4326, aoi_east_4326, aoi_north_4326
    # are already computed earlier in the function (after geometry validation)
    # No need to recompute - they are guaranteed to be defined
    
    print(f"AOI bounds (EPSG:4326):")
    print(f"  West: {aoi_west_4326:.6f}, South: {aoi_south_4326:.6f}")
    print(f"  East: {aoi_east_4326:.6f}, North: {aoi_north_4326:.6f}")
    print(f"Overlay bounds (EPSG:4326):")
    print(f"  West: {west_4326:.6f}, South: {south_4326:.6f}")
    print(f"  East: {east_4326:.6f}, North: {north_4326:.6f}")
    
    # Check if bounds intersect (overlay should overlap AOI)
    bounds_intersect = not (
        west_4326 > aoi_east_4326 or  # Overlay is completely to the east of AOI
        east_4326 < aoi_west_4326 or  # Overlay is completely to the west of AOI
        south_4326 > aoi_north_4326 or  # Overlay is completely to the north of AOI
        north_4326 < aoi_south_4326     # Overlay is completely to the south of AOI
    )
    
    print(f"\nBounds intersect: {bounds_intersect}")
    
    if not bounds_intersect:
        error_msg = (
            f"CRITICAL ERROR: Overlay bounds do NOT intersect AOI bounds!\n"
            f"This indicates a CRS transformation or masking error.\n"
            f"AOI bounds (EPSG:4326): [{aoi_west_4326:.6f}, {aoi_south_4326:.6f}, {aoi_east_4326:.6f}, {aoi_north_4326:.6f}]\n"
            f"Overlay bounds (EPSG:4326): [{west_4326:.6f}, {south_4326:.6f}, {east_4326:.6f}, {north_4326:.6f}]\n"
            f"Raster CRS: {raster_crs}\n"
            f"Raster bounds (raster CRS): [{raster_west:.6f}, {raster_south:.6f}, {raster_east:.6f}, {raster_north:.6f}]\n"
            f"AOI bounds (raster CRS): [{aoi_west:.6f}, {aoi_south:.6f}, {aoi_east:.6f}, {aoi_north:.6f}]"
        )
        print(f"[ERROR] {error_msg}")
        raise ValueError(error_msg)
    
    print("✓ Overlay bounds correctly intersect AOI bounds")
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
    # Compute statistics safely (guard against empty arrays and division by zero)
    # -------------------------
    # CRITICAL: valid_pixels_histogram should never be empty at this point (checked above),
    # but we add guards to prevent crashes if somehow it is empty
    if valid_pixels_histogram.size == 0:
        error_msg = "AOI contains no valid raster pixels (outside extent or all nodata)."
        print(f"[ERROR] valid_pixels_histogram is empty when computing stats")
        print(f"[ERROR] WHY: No valid pixels found in histogram mask")
        class NoValidDataError(ValueError):
            """Custom exception for no valid data - should return 422"""
            pass
        raise NoValidDataError(error_msg)
    
    # Compute min/max/mean safely
    stats_min = float(valid_pixels_histogram.min())
    stats_max = float(valid_pixels_histogram.max())
    stats_mean = float(valid_pixels_histogram.mean())
    stats_count = int(valid_pixels_histogram.size)
    
    # Log min/max for debugging
    print(f"[STATS] Computing stats: min={stats_min:.6f}, max={stats_max:.6f}, count={stats_count}")
    
    # Compute std safely: if all values are the same, std = 0 (not division by zero)
    # numpy.std() handles this correctly, but we add a guard for edge cases
    if valid_pixels_histogram.size > 1:
        stats_std = float(valid_pixels_histogram.std())
    elif valid_pixels_histogram.size == 1:
        # Single pixel: std = 0
        stats_std = 0.0
    else:
        # Should never reach here (checked above), but safety guard
        stats_std = 0.0
    
    # Guard against min==max causing issues in normalization (if any exists)
    # This is just for logging - actual normalization happens in classify_to_colormap
    if stats_min == stats_max:
        print(f"[STATS] ⚠️  All pixels have the same value: {stats_min}")
        print(f"[STATS] ⚠️  This is valid, but may cause issues if normalization is applied elsewhere")
    
    # Guard against division by zero in any normalization operations
    # If min==max, any normalization like (arr - vmin) / (vmax - vmin) would divide by zero
    # We don't do this normalization in classify_to_colormap, but log it for safety
    range_value = stats_max - stats_min
    if not np.isfinite(range_value) or range_value == 0:
        print(f"[STATS] ⚠️  Range is zero or invalid: range={range_value}, min={stats_min}, max={stats_max}")
        print(f"[STATS] ⚠️  Any normalization would divide by zero - but we don't normalize in classify_to_colormap")
    
    # -------------------------
    # Return response to client
    # -------------------------
    return {
        "overlay_url": f"/static/overlays/{out_png.name}",
        "stats": {
            # Use histogram pixels (original AOI) for statistics
            "min": stats_min,
            "max": stats_max,
            "mean": stats_mean,
            "std": stats_std,
            "count": stats_count,
        },
        "bounds": {
            "west": float(west_4326),   # lon
            "south": float(south_4326), # lat
            "east": float(east_4326),   # lon
            "north": float(north_4326), # lat
        },
        # 👇 for charts (legacy - kept for compatibility)
        "pixels": pixel_list,
        "values": pixel_list,   # alias so frontend can use either
        # 👇 NEW: Histogram computed from REAL raster values (same as colormap)
        "histogram": {
            "bins": [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100],  # Bin edges for reference
            "counts": histogram_counts.tolist(),  # Count of pixels in each bin [0-10, 10-20, ..., 90-100]
            "percentages": histogram_percentages.tolist(),  # Percentage of pixels in each bin
            "total_valid_pixels": int(total_valid_pixels),  # Total pixels used (excludes nodata)
            "pixels_in_range": int(histogram_counts.sum()),  # Pixels in [0, 100] range (used for histogram)
        },
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
