# AOI Upload Implementation

## Overview
Frontend-only implementation for uploading and displaying AOI files (Shapefile, GeoJSON, KML) on the Leaflet map. Uploaded AOIs are displayed as non-editable layers, separate from user-drawn clip AOIs.

## Files Created/Modified

### New Files
- `src/lib/aoiParser.js` - File parsing utilities (Shapefile, GeoJSON, KML)

### Modified Files
- `src/routes/MapExplorer.jsx` - Updated upload handler with frontend parsing
- `src/components/map/BaseMap.jsx` - Added `UploadedAOILayer` component for non-editable layers

## Features

### Supported Formats
1. **Shapefile (.zip)** - Parsed using `shpjs`
   - Handles multiple layers (returns array of FeatureCollections)
   - Automatically extracts .shp, .shx, .dbf from ZIP

2. **GeoJSON (.geojson, .json)**
   - Normalizes to FeatureCollection format
   - Handles Feature, FeatureCollection, or raw Geometry

3. **KML (.kml)** - Basic support
   - Parses Placemark elements
   - Extracts coordinates and creates GeoJSON features
   - **Note**: Full KML support (styles, extended data) requires additional libraries

### Key Behaviors

1. **Non-Editable Layers**
   - Uploaded AOIs are marked with `_pmIgnore = true`
   - Geoman editing is disabled on upload
   - Protected from removal mode (erase tool)

2. **Auto-Zoom**
   - Map automatically zooms to bounds of uploaded AOIs
   - Combines bounds from multiple layers if present

3. **Multiple Layers**
   - Shapefiles with multiple layers are all displayed
   - Each layer gets a unique ID for tracking

4. **Layer Management**
   - UI shows list of uploaded AOIs
   - Individual remove button for each AOI
   - "Clear All" button to remove all uploaded AOIs

## CRS Handling

### Current Implementation (Frontend-Only)
- **Assumption**: All uploaded files are in EPSG:4326 (WGS84)
- `shpjs` handles shapefile projection automatically if .prj file is present
- **Limitation**: If shapefile uses non-WGS84 CRS without .prj, coordinates may be incorrect

### Production Recommendation (Backend)
For production use with various CRS:

```python
# Backend endpoint: /api/v1/aoi/upload
from geopandas import read_file
import json

def upload_aoi(file):
    # Read file (GeoPandas handles CRS automatically)
    gdf = read_file(file)
    
    # Reproject to WGS84 if needed
    if gdf.crs and gdf.crs != "EPSG:4326":
        gdf = gdf.to_crs("EPSG:4326")
    
    # Convert to GeoJSON
    geojson = json.loads(gdf.to_json())
    
    return {"geojson": geojson}
```

**Benefits of Backend Approach**:
- Proper CRS detection from .prj files
- Accurate reprojection using PROJ
- Handles complex projections (UTM, State Plane, etc.)
- Validates geometry before sending to frontend

## Usage

### Uploading Files
1. Click "Choose file" button
2. Select .zip, .geojson, .json, or .kml file
3. File is parsed on frontend
4. AOI(s) appear on map immediately
5. Map auto-zooms to show uploaded AOIs

### Managing Uploaded AOIs
- View list of uploaded files in the upload section
- Click × to remove individual AOI
- Click "Clear All" to remove all uploaded AOIs

## Technical Details

### GeoJSON Normalization
The `normalizeGeoJSON()` function ensures all inputs become FeatureCollections:
- Single Feature → Wrapped in FeatureCollection
- Raw Geometry → Wrapped in Feature with empty properties
- FeatureCollection → Returned as-is

### Bounds Calculation
`getGeoJSONBounds()` extracts bounds from any GeoJSON geometry type:
- Point, LineString, Polygon
- MultiPoint, MultiLineString, MultiPolygon
- Handles nested coordinate arrays correctly

### Geoman Protection
Multiple layers of protection:
1. `_pmIgnore` flag on layer
2. `layer.pm.disable()` called on mount
3. Event listeners prevent Geoman from attaching
4. `enable()` method overridden to prevent re-enabling

## Error Handling
- Invalid file types show clear error messages
- Empty files or files with no features are rejected
- Parse errors are caught and displayed to user
- File input is reset after upload to allow re-uploading same file

## Dependencies
- `shpjs@^6.2.0` - Already installed for shapefile parsing
- No additional dependencies required

## Future Enhancements
1. **Backend CRS handling** - Move to backend for production
2. **KML full support** - Use `@placemark/tokml` or `toGeoJSON` library
3. **Drag-and-drop** - Add drag-and-drop file upload
4. **Progress indicator** - Show upload progress for large files
5. **Layer styling** - Allow users to customize uploaded AOI colors

