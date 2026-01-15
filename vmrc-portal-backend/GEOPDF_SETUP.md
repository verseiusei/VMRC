# GeoPDF Export/Import Setup Guide

This guide explains how to set up and use the GeoPDF export and import features in the VMRC Portal.

## Features

1. **Export GeoPDF**: Export a raster clipped to an AOI as a georeferenced PDF for use in Avenza Maps, ArcGIS, or QGIS.
2. **Import GeoPDF**: Upload a GeoPDF and preview it as a PNG overlay on the interactive map.

## Prerequisites

### Required Dependencies

1. **GDAL** (Geospatial Data Abstraction Library)
   - Required for GeoPDF export/import operations
   - Must be installed and available in system PATH

2. **Python Packages**
   ```bash
   pip install rasterio pyproj pillow numpy
   ```

### GDAL Installation

#### Windows
- **Option 1 (Recommended)**: Install via OSGeo4W
  1. Download from: https://trac.osgeo.org/osgeo4w/
  2. Run installer and select "Express Desktop Install"
  3. Select GDAL package
  4. Add `C:\OSGeo4W64\bin` to your system PATH

- **Option 2**: Install via Conda
  ```bash
  conda install -c conda-forge gdal
  ```

#### Linux (Ubuntu/Debian)
```bash
sudo apt-get update
sudo apt-get install gdal-bin libgdal-dev
pip install gdal  # Python bindings
```

#### macOS
```bash
brew install gdal
```

### Verify GDAL Installation

After installation, verify GDAL is available:

```bash
gdalwarp --version
gdal_translate --version
gdalinfo --version
```

You should see version information. If you get "command not found", ensure GDAL is in your PATH.

## Backend Setup

### Storage Directories

The backend automatically creates these directories:
- `storage/geopdf/` - Main storage directory
- `storage/geopdf/layers/` - Imported GeoPDF layers and overlays

### API Endpoints

#### 1. Export GeoPDF
**POST** `/api/v1/export/geopdf`

Request body (JSON):
```json
{
  "raster_id": 123,
  "aoi_geojson": {
    "type": "Feature",
    "geometry": {
      "type": "Polygon",
      "coordinates": [[...]]
    }
  },
  "title": "Optional title",
  "author": "Optional author"
}
```

Response:
- Returns PDF file download (Content-Type: application/pdf)
- Filename: `vmrc_<raster_id>_<timestamp>.pdf`

#### 2. Import GeoPDF
**POST** `/api/v1/upload/geopdf`

Request (multipart/form-data):
- `file`: GeoPDF file (max 200MB)

Response (JSON):
```json
{
  "layer_id": "upload_abc123",
  "overlay_url": "/api/v1/layers/upload_abc123/overlay.png",
  "bounds": [[south, west], [north, east]],
  "crs": "EPSG:4326"
}
```

#### 3. Get Overlay PNG
**GET** `/api/v1/layers/<layer_id>/overlay.png`

Returns the PNG overlay image for an imported GeoPDF layer.

## Frontend Usage

### Export GeoPDF

1. Draw or upload an AOI on the map
2. Select a raster layer
3. In the Export panel, check "GeoPDF (Avenza Maps)" or click "Export GeoPDF" button
4. The PDF will download automatically

### Import GeoPDF

1. In the sidebar, find "Import GeoPDF (Preview on Map)" section
2. Click "Upload GeoPDF" button
3. Select a GeoPDF file (max 200MB)
4. The GeoPDF will be converted to a PNG overlay and displayed on the map
5. The overlay can be removed by clicking "Remove" in the datasets list

## Testing

### Test Export with cURL

```bash
curl -X POST http://localhost:8000/api/v1/export/geopdf \
  -H "Content-Type: application/json" \
  -d '{
    "raster_id": 1,
    "aoi_geojson": {
      "type": "Feature",
      "geometry": {
        "type": "Polygon",
        "coordinates": [[[-120, 45], [-119, 45], [-119, 46], [-120, 46], [-120, 45]]]
      }
    },
    "title": "Test Export"
  }' \
  --output test_export.pdf
```

### Test Import with cURL

```bash
curl -X POST http://localhost:8000/api/v1/upload/geopdf \
  -F "file=@/path/to/your/geopdf.pdf" \
  -H "Accept: application/json"
```

## How It Works

### Export Process

1. **Clip Raster**: Uses `gdalwarp` to clip the input raster to the AOI GeoJSON boundary
   ```bash
   gdalwarp -cutline aoi.geojson -crop_to_cutline -dstalpha input.tif clipped.tif
   ```

2. **Convert to GeoPDF**: Uses `gdal_translate` to convert the clipped GeoTIFF to a georeferenced PDF
   ```bash
   gdal_translate -of PDF -co GEOREF=YES -co DPI=200 clipped.tif output.pdf
   ```

3. **Return File**: The PDF is returned as a file download with proper georeferencing metadata

### Import Process

1. **Extract Raster**: Uses `gdal_translate` to extract the first raster layer from the GeoPDF
   ```bash
   gdal_translate -of GTiff input.pdf extracted.tif
   ```

2. **Convert to PNG**: Reads the GeoTIFF with rasterio, normalizes to 8-bit RGBA, and saves as PNG with transparency

3. **Compute Bounds**: Uses rasterio to get bounds in the source CRS, then reprojects to EPSG:4326 (WGS84) for Leaflet

4. **Return Overlay Info**: Returns the PNG URL and bounds for display on the map

## Cleanup

The backend automatically cleans up old uploads:
- Uploads older than 7 days are deleted on server startup
- Export PDFs older than 7 days are also cleaned up

## Troubleshooting

### "GDAL is not available" Error

- Verify GDAL is installed: `gdalwarp --version`
- Check that GDAL is in your system PATH
- Restart the backend server after installing GDAL

### "gdalwarp failed" Error

- Check that the AOI GeoJSON is valid
- Ensure the raster file exists and is readable
- Check backend logs for detailed error messages

### "GeoPDF import failed" Error

- Verify the PDF is a valid GeoPDF (has georeferencing information)
- Check file size (max 200MB)
- Ensure the PDF contains raster data (not just vector graphics)

### Overlay Not Displaying

- Check browser console for errors
- Verify the overlay URL is accessible: `GET /api/v1/layers/<layer_id>/overlay.png`
- Ensure bounds are in EPSG:4326 format: `[[south, west], [north, east]]`

## File Structure

```
vmrc-portal-backend/
├── app/
│   ├── api/
│   │   └── v1/
│   │       └── routes_geopdf_import.py  # New API endpoints
│   └── services/
│       └── geopdf_service.py  # GeoPDF export/import logic
└── storage/
    └── geopdf/
        ├── export_*.pdf  # Exported GeoPDFs
        └── layers/
            └── upload_*/
                ├── uploaded.pdf
                └── upload_*_overlay.png
```

## Notes

- GeoPDFs exported from this system are compatible with Avenza Maps, ArcGIS, and QGIS
- Imported GeoPDFs are converted to PNG overlays for web display (Leaflet cannot render PDFs directly)
- The system preserves georeferencing information throughout the export/import process
- All file paths in API responses are relative (no absolute filesystem paths exposed)

