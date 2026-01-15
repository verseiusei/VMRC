# Buffering Fix: Half-Pixel Buffer for Overlay Generation

## Problem

Even with `all_touched=True`, the raster overlay still appears not to fully cover AOI edges. This is due to **coarse raster resolution (~27m/pixel)**. The blocky pixel grid creates a visual impression that the overlay doesn't fully fill the AOI boundary, even though all touched pixels are included.

## Solution

**Buffer the AOI geometry by half a pixel** in raster CRS for overlay generation only. This provides better visual coverage while keeping statistics and exports accurate to the original AOI.

### Why Half-Pixel Buffer?

- **Raster resolution**: ~27m/pixel means each pixel is quite large
- **Visual gap**: Even with `all_touched=True`, the pixel grid alignment can create visual gaps
- **Half-pixel buffer**: Extends the geometry by 0.5 * max(res_x, res_y), ensuring edge pixels are fully included
- **Overlay only**: Statistics and exports use original AOI (no buffer) for accuracy

## Implementation

### Buffer Calculation
```python
# Compute buffer distance = 0.5 * max(abs(src.res[0]), abs(src.res[1]))
res_x, res_y = src.res
buffer_dist = 0.5 * max(abs(res_x), abs(res_y))
```

### Geometry Buffering
```python
# Convert GeoJSON to shapely for buffering
original_geom_shapely = shape(original_geom_raster_crs)

# Buffer by half pixel
buffered_geom_shapely = original_geom_shapely.buffer(buffer_dist)
buffered_geom_raster_crs = mapping(buffered_geom_shapely)
```

### Separate Masks

1. **Overlay Mask (Buffered)**: Used for PNG rendering
   - Clips raster with buffered geometry
   - Provides full visual coverage
   - All pixels in buffered area are rendered

2. **Histogram Mask (Original)**: Used for statistics and histogram
   - Masks clipped data with original geometry using `geometry_mask()`
   - Ensures histogram matches actual AOI (not buffered)
   - Statistics are accurate to original AOI

## Files Changed

### `app/services/raster_service.py`
**Function:** `clip_raster_for_layer()`

**Key Changes:**
- **Lines ~357-401**: Buffer geometry by half pixel before clipping
- **Lines ~466-495**: Create separate masks for overlay (buffered) and histogram (original)
- **Lines ~477-490**: Use `geometry_mask()` to create histogram mask from original geometry
- **Lines ~500-520**: Histogram uses original geometry pixels
- **Lines ~530-550**: Overlay uses buffered geometry pixels
- **Lines ~680-690**: Statistics use original geometry pixels

**Impact:**
- ✅ PNG overlay uses buffered geometry (full visual coverage)
- ✅ Histogram uses original geometry (accurate statistics)
- ✅ Statistics use original geometry (accurate counts)
- ✅ Bounds computed from clipped raster transform (truth source)

## Verification

### Overlay (Buffered)
- Clipped with buffered geometry
- All pixels in buffered area rendered
- Visual coverage extends slightly beyond AOI boundary
- Better visual match with coarse resolution

### Histogram (Original)
- Computed from pixels inside original AOI only
- Uses `geometry_mask()` to filter buffered clip to original geometry
- Statistics match actual AOI (not buffered)
- Accurate pixel counts and distributions

### Bounds
- Computed from `array_bounds(height, width, out_transform)`
- Represents actual clipped raster extent
- Transformed to EPSG:4326 for Leaflet
- Matches PNG pixel extent exactly

## Testing Checklist

- [ ] PNG overlay fully covers AOI boundary (no visual gaps)
- [ ] Histogram counts match original AOI (not buffered)
- [ ] Statistics (min/max/mean/std/count) match original AOI
- [ ] Overlay bounds match PNG pixel extent
- [ ] No data leakage from buffered area into statistics

