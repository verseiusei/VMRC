# Layer Metadata Implementation

## Overview

This implementation adds app-level metadata for raster layers and imported GeoPDF layers. Metadata is stored in JSON files on the backend and displayed in a "Layer Info" panel on the frontend.

## Files Changed

### Backend

1. **`app/services/layer_metadata.py`** (NEW)
   - Service for computing, storing, and retrieving layer metadata
   - Functions: `compute_raster_stats()`, `compute_raster_bounds_4326()`, `compute_pixel_size()`, `create_raster_metadata()`, `save_metadata()`, `load_metadata()`, `cleanup_old_uploads()`

2. **`app/api/v1/routes_layers.py`** (NEW)
   - Endpoint: `GET /api/v1/layers/{layer_id}/metadata`
   - Returns metadata for uploaded GeoPDFs and processed layers

3. **`app/api/v1/routes_raster.py`** (MODIFIED)
   - Added endpoint: `GET /api/v1/rasters/{raster_id}/metadata`
   - Returns metadata for catalog rasters from registry

4. **`app/api/v1/routes_geopdf_import.py`** (MODIFIED)
   - Updated to save metadata when importing GeoPDFs

5. **`app/api/v1/api.py`** (MODIFIED)
   - Added routes_layers router

6. **`app/data/raster_registry.json`** (NEW)
   - JSON registry file for catalog raster metadata

### Frontend

1. **`src/components/ui/LayerInfoPanel.jsx`** (NEW)
   - Component to display layer metadata
   - Shows title, summary, tags, CRS, bounds, pixel size, stats, etc.

2. **`src/lib/rasterApi.js`** (MODIFIED)
   - Added `fetchLayerMetadata(layerId)` function
   - Added `fetchRasterMetadata(rasterId)` function

3. **`src/routes/MapExplorer.jsx`** (MODIFIED)
   - Added state for layer metadata
   - Added useEffect to load metadata when active layer changes
   - Added LayerInfoPanel to right sidebar

## How to Add/Edit Metadata in raster_registry.json

The registry file is located at: `vmrc-portal-backend/app/data/raster_registry.json`

### Format

```json
{
  "rasters": [
    {
      "raster_id": 1,
      "title": "Layer Title",
      "summary": "Description of the layer",
      "tags": ["tag1", "tag2"],
      "credits": "Attribution/credits",
      "units": "percent",
      "crs": "EPSG:4326"
    }
  ]
}
```

### Adding a New Raster

1. Open `app/data/raster_registry.json`
2. Add a new object to the `rasters` array with:
   - `raster_id`: The database ID of the raster layer
   - `title`: Display title
   - `summary`: Description
   - `tags`: Array of tag strings
   - `credits`: Attribution (optional)
   - `units`: Data units (e.g., "percent", "meters")
   - `crs`: Coordinate reference system (default: "EPSG:4326")

### Example

```json
{
  "raster_id": 50,
  "title": "Douglas-fir Mortality - June, Wet, Medium Stress, 75% Cover",
  "summary": "Monthly mortality risk map for Douglas-fir under wet conditions in June with medium stress levels and 75% canopy cover.",
  "tags": ["mortality", "douglas-fir", "june", "wet", "medium-stress", "75-cover"],
  "credits": "VMRC Research Team",
  "units": "percent",
  "crs": "EPSG:4326"
}
```

## API Endpoints

### GET /api/v1/layers/{layer_id}/metadata

Returns metadata for uploaded GeoPDFs or processed layers.

**Example:**
```bash
curl http://localhost:8000/api/v1/layers/upload_8f31a2b4c5d6/metadata
```

**Response:**
```json
{
  "layer_id": "upload_8f31a2b4c5d6",
  "title": "Uploaded GeoPDF",
  "summary": "User-uploaded GeoPDF preview: example.pdf",
  "tags": ["geopdf", "upload"],
  "credits": "",
  "units": "",
  "crs": "EPSG:4326",
  "bounds": [[45.123, -123.456], [45.789, -122.123]],
  "pixel_size": null,
  "stats": {
    "min": null,
    "max": null,
    "mean": null,
    "std": null,
    "nodata": null,
    "count": null
  },
  "created_at": "2026-01-09T10:15:00Z",
  "source_type": "geopdf_upload"
}
```

### GET /api/v1/rasters/{raster_id}/metadata

Returns metadata for catalog rasters.

**Example:**
```bash
curl http://localhost:8000/api/v1/rasters/1/metadata
```

**Response:**
```json
{
  "raster_id": 1,
  "title": "Douglas-fir Mortality - April, Dry, Low Stress, 50% Cover",
  "summary": "Monthly mortality risk map for Douglas-fir under dry conditions in April with low stress levels and 50% canopy cover.",
  "tags": ["mortality", "douglas-fir", "april", "dry", "low-stress", "50-cover"],
  "credits": "VMRC Research Team",
  "units": "percent",
  "crs": "EPSG:4326",
  "source_type": "raster"
}
```

## Storage Structure

Metadata is stored in:
```
storage/layers/<layer_id>/
  ├── metadata.json
  ├── overlay.png (if exists)
  └── export.pdf (if exists)
```

## Cleanup

Old upload layers (older than 7 days) are automatically cleaned up on server startup via `cleanup_old_uploads()`.

## Notes

- Metadata is computed from raster files when available
- For GeoPDF uploads, stats may be null (PNG overlays don't have numeric data)
- Bounds are always in EPSG:4326 (WGS84)
- Pixel size is computed in meters
- No absolute file paths are included in JSON responses

