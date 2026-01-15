# Zoom-Based Display Overlay Resampling

## Overview

Implements a high-resolution display overlay pipeline that generates smoother, non-blocky overlays when zoomed in, while keeping analysis/export/histogram at native raster resolution.

## How It Works

### Zoom Threshold
- **Threshold**: Zoom level 12+
- **When zoom >= 12**: Generate high-res display overlay (resampled to 7m/pixel)
- **When zoom < 12 or None**: Use fallback half-pixel buffer (native resolution)

### High-Resolution Overlay (Zoom >= 12)

1. **Resample raster** to finer resolution (7m/pixel) using `rasterio.warp.reproject`
   - Uses bilinear resampling for smooth display (can be changed to nearest for categorical)
   - Resamples only the AOI extent + margin (efficient)

2. **Clip resampled raster** with AOI using `all_touched=True`
   - No buffer needed - high resolution already provides smooth edges

3. **Generate PNG overlay** from resampled data
   - Smooth, non-blocky appearance when zoomed in
   - Bounds computed from resampled transform

### Fallback (Zoom < 12 or None)

1. **Buffer AOI** by half pixel (native resolution)
   - Provides better visual coverage for coarse resolution
   - Same as previous implementation

2. **Clip native raster** with buffered AOI
   - Uses `all_touched=True` for complete pixel coverage

### Histogram (Always Native Resolution)

**CRITICAL**: Histogram always uses native raster values, not resampled display overlay.

- **If high-res overlay**: Clips native raster separately for histogram
- **If fallback**: Filters buffered clip to original AOI using `geometry_mask()`
- Ensures histogram matches actual raster data, not interpolated display values

## Implementation Details

### Backend Changes

**`app/services/raster_service.py`** - `clip_raster_for_layer()`
- Added `zoom` parameter (optional)
- Resampling logic when `zoom >= 12`
- Separate native clipping for histogram when using high-res overlay
- Fallback to half-pixel buffer when `zoom < 12` or `None`

**`app/api/v1/routes_raster.py`** - `/clip` endpoint
- Added `zoom` field to `ClipRequest` model
- Passes zoom to `clip_raster_for_layer()`

### Frontend Changes

**`vmrc-portal-frontend/src/lib/rasterApi.js`** - `clipRaster()`
- Added `zoom` parameter (optional)
- Sends zoom level to backend API

**Frontend Usage**:
```javascript
// Get current map zoom level
const zoom = map.getZoom();

// Call clip with zoom
const result = await clipRaster({
  rasterLayerId: layerId,
  userClipGeoJSON: aoi,
  zoom: zoom  // Send zoom for high-res overlay
});
```

## Configuration

- **ZOOM_THRESHOLD**: 12 (resample when zoom >= this level)
- **TARGET_RESOLUTION**: 7.0 meters (target pixel size for high-res overlay)
- **Resampling method**: Bilinear (smooth for continuous data)
  - Can be changed to `Resampling.nearest` for categorical data

## Benefits

1. **Smooth Display**: High-res overlay eliminates blocky appearance when zoomed in
2. **Accurate Analysis**: Histogram/export always use native resolution
3. **Efficient**: Only resamples when needed (zoom >= 12)
4. **Backward Compatible**: Falls back to buffer method when zoom not provided

## Testing Checklist

- [ ] High-res overlay generated when zoom >= 12
- [ ] Fallback buffer used when zoom < 12 or None
- [ ] Histogram uses native resolution (not resampled)
- [ ] Overlay bounds match resampled transform
- [ ] No performance issues with resampling
- [ ] Frontend sends zoom level correctly

