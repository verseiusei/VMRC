# All-Touched Implementation: Guaranteeing Complete Pixel Coverage

## Why `all_touched=True` Guarantees "Any Touched Pixel is Included"

### Default Behavior (all_touched=False)
- `rasterio.mask.mask()` by default only includes pixels whose **center point** falls inside the polygon
- Pixels that are **touched or intersected** by the boundary but whose center is outside are **excluded**
- This creates visible "stair-step" cutoffs along polygon edges, especially at diagonal boundaries

### With `all_touched=True`
- **ANY pixel that is touched or intersected by the polygon boundary is included**
- This ensures complete pixel coverage - no edge pixels are lost
- Combined with proper CRS reprojection and transform-based bounds, this guarantees pixel-perfect boundaries

### Implementation Pattern

All mask operations follow this exact pattern:

```python
from rasterio.warp import transform_geom
from rasterio.mask import mask

# 1. Reproject AOI to raster CRS (CRITICAL - prevents CRS mismatch edge loss)
aoi_raster = transform_geom(
    "EPSG:4326",
    src.crs.to_string(),
    aoi_geojson,
    precision=6
)
shapes = [aoi_raster]

# 2. Mask with all_touched=True (guarantees any touched pixel is included)
out_img, out_transform = mask(
    src,
    shapes,
    crop=True,        # Crop to geometry bounds
    all_touched=True, # CRITICAL: Include any pixel touched by boundary
    filled=True,      # Fill masked areas with nodata
    nodata=src.nodata # Use source nodata or safe default
)

# 3. Compute bounds from transform (truth source - prevents wrong bounds)
from rasterio.transform import array_bounds
from rasterio.warp import transform_bounds

h, w = out_img.shape[1], out_img.shape[2]
west, south, east, north = array_bounds(h, w, out_transform)

west, south, east, north = transform_bounds(
    src.crs, "EPSG:4326",
    west, south, east, north,
    densify_pts=21
)
```

## Files Updated

### 1. `app/services/raster_service.py`
**Function:** `clip_raster_for_layer()`
- **Lines ~428-442**: Mask with `all_touched=True` and detailed comments
- **Lines ~496-520**: Histogram uses same clipped raster, filtered to original AOI
- **Lines ~701-710**: Bounds computed from clipped raster transform

### 2. `app/gis/clip.py`
**Function:** `clip_raster_with_global_aoi_and_user_clip()`
- **Lines ~232-242**: Mask with `all_touched=True` and detailed comments
- Reprojects both global AOI and user clip to raster CRS before masking

### 3. `app/api/v1/routes_raster_export.py`
**Function:** `export_raster()` - GeoTIFF export
- **Lines ~858-867**: Mask with `all_touched=True` and detailed comments
- Reprojects AOI to raster CRS using `transform_geom()`

### 4. `app/api/v1/routes_geopdf.py`
**Function:** `export_geopdf()` - GeoPDF export
- **Lines ~327-336**: Mask with `all_touched=True` and detailed comments
- Reprojects AOI to raster CRS using `transform_geom()`

## Key Guarantees

### ✅ No Edge Pixel Loss
- **CRS Reprojection**: AOI reprojected to raster CRS before masking (prevents CRS mismatch)
- **all_touched=True**: Any pixel touched by boundary is included
- **No Pre-Windowing**: No `from_bounds()` or window reads that could cut edges
- **Transform-Based Bounds**: Bounds computed from actual clipped raster (not AOI bounds)

### ✅ Histogram from Same Masked Pixels
- Histogram uses the same `clipped` raster array as overlay
- Filtered to original AOI (not buffered) for statistical accuracy
- NoData pixels excluded from histogram calculation
- Same transform, same pixels, just different mask applied

### ✅ Consistent Implementation
- All mask operations use the same pattern
- All use `all_touched=True`
- All reproject AOI to raster CRS first
- All compute bounds from transform

## Verification Checklist

- [x] All mask calls use `all_touched=True`
- [x] All mask calls use `crop=True`
- [x] All mask calls use `filled=True`
- [x] All mask calls use proper nodata handling
- [x] All reproject AOI to raster CRS before masking
- [x] No pre-windowing (no `from_bounds()` or window reads)
- [x] Bounds computed from clipped raster transform
- [x] Histogram uses same clipped raster (filtered to original AOI, excluding nodata)

## Why This Works

1. **CRS Reprojection**: Ensures geometry coordinates match raster pixel grid exactly
2. **all_touched=True**: Includes any pixel touched by boundary (not just center-inside)
3. **No Pre-Windowing**: Let `mask(crop=True)` handle all cropping to avoid rounding
4. **Transform-Based Bounds**: Bounds match actual pixel extent in PNG

This combination guarantees that **every pixel touched by the AOI boundary is included** in the clipped raster, with no edge pixel loss due to CRS mismatch, window rounding, or incorrect bounds.

