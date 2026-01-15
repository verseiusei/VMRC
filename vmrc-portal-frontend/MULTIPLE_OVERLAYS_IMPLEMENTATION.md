# Multiple Raster Overlays Implementation

## Overview

Implemented support for displaying multiple raster overlays simultaneously. Users can create multiple clipped rasters, and all of them persist and display on the map at once.

## Changes Made

### Frontend State Management

**Replaced single overlay state with array:**
- **Before**: `overlayUrl`, `overlayBounds`, `histogram` (single values)
- **After**: `createdRasters[]` array + `activeRasterId` (multiple rasters)

**Each raster entry contains:**
```javascript
{
  id: "raster-{timestamp}-{random}",  // Unique ID
  name: "WH Dry 04 50% · AOI Name · Dec 15 2:30 PM",  // Display name
  createdAt: "2024-12-15T14:30:00.000Z",  // Timestamp
  overlayUrl: "/static/overlays/{uuid}.png",  // PNG endpoint
  overlayBounds: { west, south, east, north },  // Leaflet bounds
  stats: { min, max, mean, std, count },  // Statistics
  pixelValues: [...],  // Pixel values array
  histogram: { counts, percentages, ... },  // Histogram data
  activeRasterId: 123,  // Backend raster layer ID
  ramp: { colors, labels },  // Color ramp for legend
  aoiId: "aoi-123",  // Associated AOI ID
  meta: { mapType, species, ... }  // Metadata
}
```

### Map Rendering

**BaseMap.jsx** now renders all rasters from `createdRasters` array:
```jsx
{createdRasters.map((raster) => (
  raster.overlayUrl && raster.overlayBounds && (
    <RasterOverlay
      key={raster.id}
      overlayUrl={raster.overlayUrl}
      bounds={raster.overlayBounds}
    />
  )
))}
```

All overlays are displayed simultaneously (stacked layers).

### Histogram Panel

**Histogram shows data for active raster:**
- If `activeRasterId` is set and raster exists: shows histogram
- If no active raster: shows helpful message
- No "No layer metadata available" placeholder

**Active raster selection:**
- Most recently created raster is active by default
- Clicking a raster in the list sets it as active
- Histogram updates to show active raster's data

### Created Rasters List Panel

**Scrollable panel below histogram:**
- Shows all created rasters with name, preview, legend bar
- "Show" button sets raster as active (for histogram)
- "Remove" button removes raster from list and map
- Active raster is highlighted

### Handlers

**`handleShowRaster(rasterId)`:**
- Sets raster as active (updates histogram)
- Does NOT clear other overlays (all remain visible)

**`handleRemoveRaster(rasterId)`:**
- Removes raster from `createdRasters` array
- If removed was active, switches to next available raster
- If no rasters left, clears histogram panel

**On new raster creation:**
- Adds to `createdRasters` array (most recent first)
- Sets as active raster automatically
- Updates histogram panel with new raster's data

## Files Updated

### 1. `vmrc-portal-frontend/src/routes/MapExplorer.jsx`

**Key Changes:**
- **Lines ~755-806**: Updated `handleGenerate` to add new raster to array and set as active
- **Lines ~1055-1099**: Updated `handleShowRaster` to only set active (not clear others)
- **Lines ~1101-1145**: Updated `handleRemoveRaster` to handle active raster switching
- **Lines ~1818-1845**: Updated histogram tab to show active raster or helpful message
- **Lines ~1820-1834**: Pass `createdRasters` to BaseMap

### 2. `vmrc-portal-frontend/src/components/map/BaseMap.jsx`

**Key Changes:**
- **Lines ~579**: Added `createdRasters` prop
- **Lines ~655-664**: Render all rasters from `createdRasters` array simultaneously
- **Lines ~666-675**: Legacy overlay only shows if no created rasters

### 3. `vmrc-portal-frontend/src/components/raster/CreatedRastersList.jsx`

**Already implemented** - no changes needed. Component handles:
- Displaying raster list with previews
- Active raster highlighting
- Show/Remove buttons

## Backend

**No cleanup of old overlays:**
- Backend creates PNG files with UUID names: `{uuid.uuid4().hex}.png`
- Files persist in `static/overlays/` directory
- No automatic deletion - files remain until explicitly removed
- This allows multiple overlays to persist

## User Experience

1. **Create first raster**: Appears on map, histogram shows its data
2. **Create second raster**: Both appear on map (stacked), second is active
3. **Click first raster in list**: First becomes active (histogram updates), both still visible
4. **Remove second raster**: First remains visible and active
5. **Remove all rasters**: Map clears, histogram shows message

## Testing Checklist

- [ ] Multiple rasters can be created and all display simultaneously
- [ ] Histogram shows data for active raster
- [ ] Clicking raster in list updates histogram (doesn't remove others)
- [ ] Removing raster removes it from map and list
- [ ] Removing active raster switches to next available
- [ ] Created Rasters panel shows all rasters with previews
- [ ] No "No layer metadata available" placeholder in histogram
- [ ] Backend doesn't delete old overlay files

