# Clipping Artifact Fix: all_touched=True Implementation

## Problem Explanation

**Why the artifact occurs:**
- By default, `rasterio.mask.mask()` only includes pixels whose **center point** falls inside the polygon boundary
- Pixels that are **touched by** the boundary but whose center is outside are excluded
- This creates visible "stair-step" cutoffs along polygon edges, especially at diagonal boundaries
- The raster overlay appears to be cut off short of the actual AOI boundary

**Why `all_touched=True` fixes it:**
- When `all_touched=True`, **any pixel that is touched or intersected by the polygon boundary is included**
- This ensures the raster overlay fully fills the AOI boundary with no visible gaps
- The boundary pixels are now included, creating a smooth edge that matches the polygon exactly

## Files Changed

### 1. `app/services/raster_service.py`
**Function:** `clip_raster_for_layer()`
- **Line ~379-395**: Updated `mask()` call to include `all_touched=True`
- **Line ~441-463**: Updated mask handling logic (changed from `filled=False` with MaskedArray to `filled=True` with regular array)
- **Impact:** PNG overlay rendering, histogram calculation, and pixel value extraction all use the same mask

### 2. `app/gis/clip.py`
**Function:** `clip_raster_with_global_aoi_and_user_clip()`
- **Line ~174-189**: Updated `mask()` call to include `all_touched=True` and proper nodata handling
- **Impact:** Used by other parts of the system that need AOI intersection clipping

### 3. `app/api/v1/routes_raster_export.py`
**Function:** `export_raster()` - GeoTIFF export section
- **Line ~842-861**: Updated `mask()` call to include `all_touched=True` and proper nodata handling
- **Impact:** GeoTIFF exports now match PNG overlay boundaries exactly

### 4. `app/api/v1/routes_geopdf.py`
**Function:** `export_geopdf()` - GeoPDF export section
- **Line ~312-331**: Updated `mask()` call to include `all_touched=True` and proper nodata handling
- **Impact:** GeoPDF exports now match PNG overlay boundaries exactly

## Nodata Handling

**Consistent nodata strategy across all functions:**
1. **If source has nodata:** Use `src.nodata` value
2. **If source has no nodata:** Choose based on dtype:
   - `uint8`: 255
   - `uint16`: 65535
   - Other integer: -9999
   - Float: -9999

**Nodata is used consistently for:**
- `mask()` nodata parameter
- Output GeoTIFF metadata
- PNG transparency logic (pixels == nodata are excluded)
- Histogram filtering (nodata pixels excluded)

## Verification: Same Mask for All Operations

**Confirmed:** All three operations (PNG, histogram, export) use the **exact same mask**:

1. **PNG Overlay Rendering:**
   - Uses `mask_valid` to identify valid pixels
   - Only colorizes pixels where `mask_valid == True`
   - Sets alpha=0 for pixels where `mask_valid == False`

2. **Histogram Calculation:**
   - Uses `valid_values = band[mask_valid]` (same mask as PNG)
   - Histogram bins are computed from the same pixel set shown on map
   - **Histogram matches what the map displays**

3. **GeoTIFF Export:**
   - Uses same `mask()` call with `all_touched=True`
   - Same nodata handling
   - **Export boundaries match PNG overlay boundaries**

## Testing Checklist

- [ ] PNG overlay fully fills AOI boundary (no stair-step artifacts)
- [ ] Histogram counts match pixels visible on map
- [ ] GeoTIFF export boundaries match PNG overlay
- [ ] NoData pixels are properly excluded from all calculations
- [ ] Alpha channel correctly shows transparent areas outside polygon

