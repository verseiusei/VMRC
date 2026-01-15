# Visual Buffer Implementation: Half-Pixel Buffer for Overlay

## Problem

The AOI overlay still appears not fully filled along diagonal edges due to **coarse raster resolution (~27m per pixel)**. Even with `all_touched=True`, the blocky pixel grid creates a visual impression that the overlay doesn't fully cover the AOI boundary.

## Solution

**Half-pixel buffer for overlay generation only** - This is a **visual fix only**. Histogram and export remain accurate to the original AOI.

### Why This Works

- **Raster resolution**: ~27m/pixel means each pixel is quite large
- **Visual gap**: Even with `all_touched=True`, pixel grid alignment can create visual gaps
- **Half-pixel buffer**: Extends geometry by `0.5 * max(abs(res_x), abs(res_y))`
- **Visual only**: Statistics and exports use original AOI (no buffer) for accuracy

## Implementation Details

### 1. Reproject AOI to Raster CRS

```python
from rasterio.warp import transform_geom

aoi_raster = transform_geom(
    "EPSG:4326",
    src.crs.to_string(),
    aoi_geojson,
    precision=6
)
```

### 2. Buffer AOI by Half Pixel (Overlay ONLY)

```python
from shapely.geometry import shape, mapping

geom = shape(aoi_raster)
half_pixel = 0.5 * max(abs(src.res[0]), abs(src.res[1]))
geom_buffered = geom.buffer(half_pixel)
```

### 3. Mask Raster Using Buffered AOI

```python
from rasterio.mask import mask

overlay_img, overlay_transform = mask(
    src,
    [mapping(geom_buffered)],
    crop=True,
    all_touched=True,
    filled=True,
    nodata=src.nodata
)
```

### 4. Histogram + Export Use Original AOI

- **MUST use original (unbuffered) AOI**
- **MUST use all_touched=True**
- **MUST exclude nodata**

Implementation:
- Clip raster with buffered geometry (for overlay)
- Filter clipped data to original geometry using `geometry_mask()` (for histogram/export)
- This ensures histogram and export statistics are accurate to actual AOI

### 5. Leaflet Overlay Bounds

```python
from rasterio.transform import array_bounds
from rasterio.warp import transform_bounds

h, w = overlay_img.shape[1:]
west, south, east, north = array_bounds(h, w, overlay_transform)

west, south, east, north = transform_bounds(
    src.crs, "EPSG:4326",
    west, south, east, north,
    densify_pts=21
)
```

Bounds sent to Leaflet as: `{west, south, east, north}` (frontend converts to `[[south, west], [north, east]]`)

## Files Changed

### `app/services/raster_service.py`
**Function:** `clip_raster_for_layer()`

**Key Sections:**
- **Lines ~367-381**: Buffer calculation and geometry buffering (with detailed comments)
- **Lines ~414-424**: Mask raster with buffered geometry for overlay
- **Lines ~478-492**: Create histogram mask from original geometry (unbuffered)
- **Lines ~500-512**: Separate pixel arrays for overlay (buffered) and histogram (original)
- **Lines ~514-525**: Chart data uses original AOI pixels
- **Lines ~527-548**: Overlay rendering uses buffered AOI pixels
- **Lines ~550-630**: Histogram computation uses original AOI pixels
- **Lines ~673-710**: Bounds computed from clipped raster transform

## Verification Checklist

✅ **Overlay uses buffered AOI**
- Clipped with buffered geometry
- All pixels in buffered area rendered
- Visual coverage extends slightly beyond AOI boundary

✅ **Histogram uses original AOI**
- Filtered from buffered clip using `geometry_mask()`
- Uses original (unbuffered) geometry
- Statistics match actual AOI (not buffered)

✅ **Export uses original AOI**
- Export functions use original geometry (separate clipping)
- GeoTIFF exports are accurate to actual AOI

✅ **Bounds from transform**
- Computed using `array_bounds(h, w, out_transform)`
- Represents actual clipped raster extent
- Transformed to EPSG:4326 for Leaflet

## Comments in Code

The implementation includes detailed comments explaining:
- Why buffering is needed (coarse resolution causes visual gaps)
- That this is visual only (histogram/export remain accurate)
- How the separation works (buffered for overlay, original for analysis)

## Testing

- [ ] PNG overlay fully covers AOI boundary (no visual gaps)
- [ ] Histogram counts match original AOI (not buffered)
- [ ] Statistics (min/max/mean/std/count) match original AOI
- [ ] Overlay bounds match PNG pixel extent
- [ ] No data leakage from buffered area into statistics

