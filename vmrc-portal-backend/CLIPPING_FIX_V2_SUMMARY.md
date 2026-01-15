# Clipping Artifact Fix V2: CRS Reprojection and Bounds Calculation

## Problem

Even after adding `all_touched=True`, the raster overlay still didn't fully fill the AOI boundary. This indicated secondary issues:
1. **CRS mismatch**: Using `shapely.transform()` instead of `rasterio.warp.transform_geom()` for reprojection (less precise for raster operations)
2. **Window rounding**: If pre-windowing was used, it could cause edge pixel loss
3. **Incorrect overlay bounds**: Bounds might not match the actual clipped raster pixels

## Solution

### A) Reproject AOI to Raster CRS Using `rasterio.warp.transform_geom()`

**Why `transform_geom()` instead of `shapely.transform()`:**
- `rasterio.warp.transform_geom()` is specifically designed for raster operations
- More precise coordinate transformation for geospatial data
- Better handling of CRS edge cases
- Ensures geometry coordinates match raster pixel grid exactly

**Implementation:**
```python
from rasterio.warp import transform_geom

aoi_geom_src = mapping(user_geom_4326)  # Convert shapely to GeoJSON dict
aoi_geom_raster_crs = transform_geom(
    "EPSG:4326",
    raster_crs.to_string(),
    aoi_geom_src,
    precision=6  # 6 decimal places for precision
)
shapes = [aoi_geom_raster_crs]  # Use GeoJSON dict directly
```

### B) No Pre-Windowing (Avoid Rounding Issues)

**Why no pre-windowing:**
- `rasterio.mask.mask()` with `crop=True` handles cropping internally
- Pre-windowing with `from_bounds()` can cause rounding that loses edge pixels
- Let `mask()` handle all cropping to ensure pixel-perfect boundaries

**Implementation:**
- Removed any `rasterio.windows.from_bounds()` calls
- Use `mask(..., crop=True)` directly without pre-reading windows
- This ensures all pixels touched by the boundary are included

### C) Compute Overlay Bounds from Clipped Raster Transform

**Why from transform (not AOI bounds):**
- The clipped raster transform is the "truth source" - it represents the actual pixels in the PNG
- AOI bounds might not match exactly due to pixel grid alignment
- Using `array_bounds()` from the transform ensures bounds match what's actually in the image

**Implementation:**
```python
from rasterio.transform import array_bounds
from rasterio.warp import transform_bounds

# Get bounds from clipped raster transform (truth source)
height, width = band.shape
west_raster, south_raster, east_raster, north_raster = array_bounds(
    height, width, out_transform
)

# Transform to EPSG:4326 for Leaflet
west_4326, south_4326, east_4326, north_4326 = transform_bounds(
    raster_crs,
    "EPSG:4326",
    west_raster,
    south_raster,
    east_raster,
    north_raster,
    densify_pts=21  # Better accuracy for bounds transformation
)
```

## Files Changed

### 1. `app/services/raster_service.py`
**Function:** `clip_raster_for_layer()`
- **Lines ~270-315**: Replaced `shapely.transform()` with `rasterio.warp.transform_geom()` for reprojection
- **Lines ~392-399**: Updated `mask()` call to use GeoJSON dict directly from `transform_geom()`
- **Lines ~617-651**: Updated bounds calculation to use `array_bounds()` from clipped raster transform
- **Impact**: PNG overlay rendering, histogram calculation, and bounds all use the same precise geometry

### 2. `app/gis/clip.py`
**Function:** `clip_raster_with_global_aoi_and_user_clip()`
- **Lines ~142-200**: Added reprojection of both global AOI and user clip to raster CRS using `transform_geom()`
- **Lines ~192-199**: Updated `mask()` call to use GeoJSON dict directly
- **Impact**: Ensures intersection geometry is in correct CRS before masking

### 3. `app/api/v1/routes_raster_export.py`
**Function:** `export_raster()` - GeoTIFF export section
- **Lines ~827-867**: Replaced `shapely.transform()` with `rasterio.warp.transform_geom()` for reprojection
- **Lines ~860-867**: Updated `mask()` call to use GeoJSON dict directly
- **Impact**: GeoTIFF exports use same precise geometry as PNG overlay

### 4. `app/api/v1/routes_geopdf.py`
**Function:** `export_geopdf()` - GeoPDF export section
- **Lines ~299-336**: Replaced `shapely.transform()` with `rasterio.warp.transform_geom()` for reprojection
- **Lines ~329-336**: Updated `mask()` call to use GeoJSON dict directly
- **Impact**: GeoPDF exports use same precise geometry as PNG overlay

## Key Changes Summary

1. **Reprojection**: All geometry reprojection now uses `rasterio.warp.transform_geom()` instead of `shapely.transform()`
2. **No Pre-Windowing**: Removed any window reading - let `mask()` handle cropping with `crop=True`
3. **Bounds from Transform**: Overlay bounds computed from clipped raster transform using `array_bounds()`
4. **Consistent Geometry**: All operations (PNG, histogram, export) use the same reprojected geometry

## Verification

- ✅ AOI geometry reprojected to raster CRS using `transform_geom()` (precise)
- ✅ No pre-windowing - `mask()` handles cropping directly
- ✅ Overlay bounds computed from clipped raster transform (truth source)
- ✅ Same geometry used for PNG, histogram, and all exports
- ✅ `all_touched=True` ensures all boundary pixels included
- ✅ Consistent nodata handling across all operations

## Testing Checklist

- [ ] PNG overlay fully fills AOI boundary (no gaps at edges)
- [ ] Overlay bounds match actual PNG pixel extent
- [ ] Histogram matches pixels visible on map
- [ ] GeoTIFF export boundaries match PNG overlay
- [ ] GeoPDF export boundaries match PNG overlay
- [ ] No CRS-related artifacts or misalignment

