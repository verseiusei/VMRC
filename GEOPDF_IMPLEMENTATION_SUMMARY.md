# GeoPDF Export/Import Implementation Summary

## Overview

This implementation adds GeoPDF export and import functionality to the VMRC Portal:
- **Export**: Convert raster layers clipped to AOI into georeferenced PDFs for Avenza Maps
- **Import**: Upload GeoPDFs and preview them as PNG overlays on the interactive map

## Files Changed

### Backend Files

#### 1. **NEW: `vmrc-portal-backend/app/services/geopdf_service.py`**
   - Core service module for GeoPDF operations
   - Functions:
     - `export_geopdf()`: Clips raster to AOI and converts to GeoPDF using GDAL
     - `import_geopdf_to_overlay()`: Converts GeoPDF to PNG overlay with bounds
     - `cleanup_old_uploads()`: Removes old uploads (7-day TTL)
   - Uses GDAL subprocess calls (`gdalwarp`, `gdal_translate`)
   - Handles rasterio for PNG conversion and bounds calculation

#### 2. **NEW: `vmrc-portal-backend/app/api/v1/routes_geopdf_import.py`**
   - FastAPI router for GeoPDF endpoints
   - Endpoints:
     - `POST /api/v1/export/geopdf`: Export raster to GeoPDF
     - `POST /api/v1/import/geopdf`: Import GeoPDF and get overlay info
     - `GET /api/v1/layers/<layer_id>/overlay.png`: Serve PNG overlay
   - Validates file types, sizes, and handles errors
   - Returns file downloads and JSON responses

#### 3. **MODIFIED: `vmrc-portal-backend/app/api/v1/api.py`**
   - Added import for `routes_geopdf_import` router
   - Included new router in API router with prefix `""` (no prefix, uses base paths)

### Frontend Files

#### 4. **MODIFIED: `vmrc-portal-frontend/src/lib/rasterApi.js`**
   - Added `exportGeoPDFNew()`: New function for GeoPDF export using `/api/v1/export/geopdf`
   - Added `importGeoPDF()`: New function for GeoPDF import using `/api/v1/import/geopdf`
   - Updated `exportGeoPDF()`: Legacy wrapper that calls `exportGeoPDFNew()`
   - Updated `uploadGeoPDF()`: Legacy wrapper that calls `importGeoPDF()`
   - Handles file downloads and blob responses

#### 5. **MODIFIED: `vmrc-portal-frontend/src/routes/MapExplorer.jsx`**
   - Updated imports to include `exportGeoPDFNew` and `importGeoPDF`
   - Modified `handleUploadGeoPDF()`: Now uses `importGeoPDF()` and immediately displays overlay
   - Updated `handleExport()`: Uses `exportGeoPDFNew()` for GeoPDF exports
   - Updated UI text: Changed "Upload GeoPDF" section to "Import GeoPDF (Preview on Map)"
   - Added overlay URL construction logic for imported GeoPDFs
   - BaseMap component already supports `datasetPreview` prop for overlays

### Documentation

#### 6. **NEW: `vmrc-portal-backend/GEOPDF_SETUP.md`**
   - Complete setup guide
   - GDAL installation instructions for Windows/Linux/macOS
   - API endpoint documentation
   - Testing examples with cURL
   - Troubleshooting guide

## API Endpoints

### Export GeoPDF
```
POST /api/v1/export/geopdf
Content-Type: application/json

{
  "raster_id": 123,
  "aoi_geojson": { ... },
  "title": "optional",
  "author": "optional"
}

Response: PDF file download
```

### Import GeoPDF
```
POST /api/v1/import/geopdf
Content-Type: multipart/form-data

file: <GeoPDF file>

Response: JSON
{
  "layer_id": "upload_abc123",
  "overlay_url": "/api/v1/layers/upload_abc123/overlay.png",
  "bounds": [[south, west], [north, east]],
  "crs": "EPSG:4326"
}
```

### Get Overlay PNG
```
GET /api/v1/layers/<layer_id>/overlay.png

Response: PNG image
```

## Dependencies

### Backend
- `rasterio` - Raster I/O and bounds calculation
- `pyproj` - Coordinate system transformations
- `PIL/Pillow` - PNG image creation
- `numpy` - Array operations
- **GDAL** (system dependency) - GeoPDF operations

### Frontend
- No new dependencies (uses existing React/Leaflet setup)

## Storage Structure

```
storage/geopdf/
├── export_*.pdf              # Exported GeoPDFs
└── layers/
    └── upload_<id>/
        ├── uploaded.pdf      # Original uploaded GeoPDF
        └── upload_<id>_overlay.png  # PNG overlay for map
```

## Key Features

1. **Georeferencing Preserved**: GeoPDFs maintain coordinate information for use in GIS software
2. **Automatic Cleanup**: Old uploads are cleaned up after 7 days
3. **Error Handling**: Clear error messages for GDAL failures, invalid files, etc.
4. **File Size Limits**: 200MB maximum upload size
5. **Immediate Preview**: Imported GeoPDFs are immediately displayed as overlays
6. **No Absolute Paths**: All API responses use relative paths

## Testing

See `GEOPDF_SETUP.md` for detailed testing instructions and cURL examples.

## Notes

- GDAL must be installed and in system PATH
- GeoPDFs are converted to PNG for web display (Leaflet cannot render PDFs)
- Bounds are automatically reprojected to EPSG:4326 for Leaflet compatibility
- The implementation follows existing code patterns and conventions

