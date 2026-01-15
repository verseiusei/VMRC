# GeoPDF (Avenza Maps) Support

This document describes the GeoPDF export and upload functionality added to the VMRC Portal.

## Overview

GeoPDF support allows users to:
1. **Export** georeferenced PDFs from raster data that work with Avenza Maps
2. **Upload** existing GeoPDF files for storage and sharing
3. **View** uploaded datasets with preview thumbnails

## Requirements

### Backend

- **GDAL** must be installed and available in the system PATH
  - The backend checks for GDAL on startup and will show warnings if not found
  - GeoPDF export will fail with a clear error message if GDAL is not available

#### Installing GDAL

**Windows:**
- Use OSGeo4W: https://trac.osgeo.org/osgeo4w/
- Or use conda: `conda install -c conda-forge gdal`

**Linux (Ubuntu/Debian):**
```bash
sudo apt-get update
sudo apt-get install gdal-bin
```

**macOS:**
```bash
brew install gdal
```

**Verify Installation:**
```bash
gdal_translate --version
```

### Python Dependencies

All required Python packages should already be in `requirements.txt`. The GeoPDF routes use:
- `rasterio` (for GeoTIFF operations)
- `shapely` (for geometry operations)
- `fastapi` (for API endpoints)
- `subprocess` (built-in, for calling GDAL)

## Architecture

### Backend Endpoints

1. **POST `/api/v1/exports/geopdf`**
   - Exports a georeferenced PDF from a raster layer
   - Input: `raster_layer_id`, `user_clip_geojson` (optional), `title` (optional), `dpi` (default 200)
   - Output: JSON with `download_url` and `preview_url`
   - Process:
     1. Clips raster to AOI (or uses full raster bounds)
     2. Saves clipped raster as temporary GeoTIFF
     3. Uses `gdal_translate -of PDF -co GEOREF=YES` to create GeoPDF
     4. Generates PNG preview using `gdal_translate -of PNG`
     5. Returns download URLs

2. **GET `/api/v1/exports/geopdf/{export_id}/{filename}`**
   - Downloads a generated GeoPDF file

3. **POST `/api/v1/uploads/geopdf`**
   - Uploads a GeoPDF file
   - Input: `file` (multipart/form-data), `name` (optional)
   - Validates: PDF type, max 200MB
   - Stores file and registers in datasets index

4. **GET `/api/v1/datasets`**
   - Lists all datasets (including uploaded GeoPDFs)
   - Returns formatted dataset objects with metadata

5. **GET `/api/v1/datasets/{dataset_id}/download`**
   - Downloads a dataset file

6. **GET `/api/v1/datasets/{dataset_id}/preview`**
   - Gets preview thumbnail for a dataset
   - Uses GDAL to extract first page as PNG if available

### Frontend Components

1. **Export Panel**
   - Added "GeoPDF (Avenza Maps)" checkbox option
   - Tooltip explains what a GeoPDF is
   - Handles GeoPDF export separately (different endpoint)

2. **Upload Section**
   - "Upload GeoPDF (Avenza Maps)" section
   - File picker for PDF files
   - Shows upload progress

3. **Datasets List**
   - Displays all uploaded GeoPDFs
   - Shows preview thumbnails (if available)
   - Download button for each dataset
   - Metadata: name, type, size, creation date

### File Storage

- **Exports**: `static/exports/geopdf/{export_id}/{filename}.pdf`
- **Uploads**: `static/uploads/geopdf/{dataset_id}_{filename}.pdf`
- **Previews**: `static/uploads/geopdf/previews/{dataset_id}_preview.png`
- **Index**: `static/uploads/geopdf/datasets.json` (JSON file storing dataset metadata)

## Testing Instructions

### 1. Start Backend

```bash
cd vmrc-portal-backend
# Activate your virtual environment if using one
python -m uvicorn app.main:app --reload --port 8000
```

**Check for GDAL:**
- Look for startup messages: "WARNING: GDAL not found" or "✓ GDAL available"
- If GDAL is missing, install it before testing

### 2. Start Frontend

```bash
cd vmrc-portal-frontend
npm install  # if needed
npm run dev
```

### 3. Test GeoPDF Export

1. Open the Map Explorer page
2. Select a raster (map type, species, filters)
3. Draw or upload an AOI
4. Click "Generate Map" to clip the raster
5. In the Export section, check "GeoPDF (Avenza Maps)"
6. Optionally set a filename
7. Click "Export"
8. The GeoPDF should download automatically
9. Verify the file opens in a PDF viewer

### 4. Test GeoPDF in Avenza Maps

1. Transfer the downloaded GeoPDF to your mobile device
2. Open Avenza Maps app
3. Import the PDF file
4. Verify:
   - The map displays correctly
   - GPS location dot appears and moves with your location
   - Coordinates are accurate

### 5. Test GeoPDF Upload

1. In the "Upload GeoPDF (Avenza Maps)" section
2. Click "Upload GeoPDF"
3. Select a PDF file (must be a georeferenced PDF)
4. Optionally provide a name
5. Wait for upload confirmation
6. The dataset should appear in the "Datasets" list below

### 6. Test Dataset Management

1. View uploaded datasets in the "Datasets" section
2. Check that preview thumbnails appear (if GDAL is available)
3. Click "Download" to download a dataset
4. Verify the downloaded file is correct

### 7. Verify GeoPDF Georeferencing

**Using GDAL (command line):**
```bash
gdalinfo your_exported_file.pdf
```

Look for:
- Coordinate System information
- Corner coordinates
- GeoTIFF tags

**Using ArcGIS:**
1. Open the GeoPDF in ArcGIS Pro
2. Check that it displays in the correct location
3. Verify coordinate system matches the source raster

## Troubleshooting

### "GDAL is not available" Error

- **Cause**: GDAL is not installed or not in PATH
- **Solution**: Install GDAL (see Requirements section)
- **Verify**: Run `gdal_translate --version` in terminal

### GeoPDF Doesn't Work in Avenza Maps

- **Cause**: PDF may not have proper georeferencing
- **Solution**: 
  - Verify GDAL created the file correctly: `gdalinfo file.pdf`
  - Check that the source raster has valid CRS
  - Ensure the AOI geometry is valid

### Preview Images Not Showing

- **Cause**: GDAL preview generation failed or GDAL not available
- **Solution**: 
  - Check backend logs for preview generation errors
  - Verify GDAL is installed
  - Preview is optional; download should still work

### Upload Fails

- **Cause**: File too large (>200MB) or invalid format
- **Solution**: 
  - Check file size
  - Ensure file is a valid PDF
  - Check backend logs for detailed error

## Code Files Modified

### Backend
- `app/api/v1/routes_geopdf.py` (NEW) - GeoPDF export and upload endpoints
- `app/api/v1/api.py` - Added GeoPDF router

### Frontend
- `src/lib/rasterApi.js` - Added GeoPDF API functions
- `src/routes/MapExplorer.jsx` - Added GeoPDF export/upload UI

## Notes

- GeoPDF files preserve coordinate reference system (CRS) and bounds
- The export process creates a temporary GeoTIFF, then converts to PDF
- Preview images are generated at 800px width (exports) or 400px (uploads)
- Dataset index is stored as JSON (simple file-based storage)
- No database changes required for this feature

