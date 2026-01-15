# Overlay Persistence Fix

## Problem
After creating a clipped raster overlay, it appears on the map. But when the user starts drawing a new AOI or imports a shapefile, the previous overlay(s) disappear from the map.

## Root Cause
The issue was that `createdRasters` array was being cleared or filtered in several places:
1. When clearing uploaded AOIs (`handleClearUploadedAois`)
2. When removing an AOI (`handleRemoveAoi`)
3. The overlays were tied to AOI state instead of being independent

## Solution

### Changes Made

**1. `MapExplorer.jsx` - `handleUserClipChange()`**
- Added comments clarifying that `createdRasters` should persist independently
- Only clears legacy `overlayUrl`/`overlayBounds` when clip is explicitly cleared (null)
- Does NOT affect `createdRasters` array

**2. `MapExplorer.jsx` - `handleClearUploadedAois()`**
- **REMOVED**: `setCreatedRasters([])` - overlays now persist when clearing AOIs
- Added comment: "DO NOT clear createdRasters here - they should persist until explicitly removed"

**3. `MapExplorer.jsx` - `handleRemoveAoi()`**
- **REMOVED**: `setCreatedRasters((prev) => prev.filter((r) => r.aoiId !== aoiId))`
- Overlays now persist independently of AOI removal
- Added comment: "We do NOT remove createdRasters when AOI is removed"

**4. `BaseMap.jsx` - Overlay Rendering**
- Improved rendering logic with explicit null checks
- Added stable `key={raster.id}` to prevent unnecessary unmounting
- Added comments: "CRITICAL: These overlays persist independently of drawing state or AOI changes"

### Key Principles

1. **Independent State**: `createdRasters` is completely independent of:
   - Drawing state (`userClip`)
   - AOI state (`aois`)
   - Legacy overlay state (`overlayUrl`/`overlayBounds`)

2. **Stable Keys**: Each overlay has a stable `key={raster.id}` to prevent React from unmounting/remounting

3. **No Map Remounting**: `MapContainer` has no `key` prop, so it never remounts

4. **Explicit Removal Only**: Overlays are only removed when:
   - User clicks "Remove" button on a specific raster
   - User clicks "Clear All" button

### Verification

✅ Overlays persist when:
- Drawing a new AOI
- Importing a shapefile
- Clearing uploaded AOIs
- Removing an AOI
- Starting a new draw operation

✅ Overlays are only removed when:
- User explicitly clicks "Remove" on a raster
- User explicitly clicks "Clear All"

### Files Modified

1. `vmrc-portal-frontend/src/routes/MapExplorer.jsx`
   - `handleUserClipChange()` - Added persistence comments
   - `handleClearUploadedAois()` - Removed `setCreatedRasters([])`
   - `handleRemoveAoi()` - Removed filtering of `createdRasters`

2. `vmrc-portal-frontend/src/components/map/BaseMap.jsx`
   - Improved overlay rendering with explicit null checks and comments

