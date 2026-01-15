# app/api/v1/routes_geopdf.py
"""
GeoPDF (Georeferenced PDF) export and upload endpoints for Avenza Maps compatibility.
"""

import subprocess
import shutil
from pathlib import Path
from typing import Optional, Dict, Any
from datetime import datetime
import uuid
import json
import re
import sys
print("PYTHON:", sys.executable)


from fastapi import APIRouter, HTTPException, UploadFile, File, Form
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel

from app.services.raster_service import clip_raster_for_layer, resolve_raster_path
from app.api.v1.routes_raster_export import normalize_for_export, sanitize_filename
import rasterio
from rasterio.mask import mask
from rasterio.warp import transform_geom
from shapely.geometry import shape, mapping
from shapely.validation import make_valid

router = APIRouter(tags=["geopdf"])

# Storage directories
GEOPDF_EXPORT_DIR = Path("static/exports/geopdf")
GEOPDF_UPLOAD_DIR = Path("static/uploads/geopdf")
GEOPDF_DATASETS_INDEX = Path("static/uploads/geopdf/datasets.json")

# Create directories
GEOPDF_EXPORT_DIR.mkdir(parents=True, exist_ok=True)
GEOPDF_UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

# Maximum file size (200MB)
MAX_UPLOAD_SIZE = 200 * 1024 * 1024


def check_gdal_available() -> bool:
    """Check if GDAL is available on the system."""
    try:
        result = subprocess.run(
            ["gdal_translate", "--version"],
            capture_output=True,
            text=True,
            timeout=5
        )
        return result.returncode == 0
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return False
        


# Check GDAL on module load
HAS_GDAL = check_gdal_available()
if not HAS_GDAL:
    print("WARNING: GDAL not found. GeoPDF export will not work.")
    print("WARNING: Install GDAL: https://gdal.org/download.html")
    print("WARNING: On Windows: Use OSGeo4W or conda install -c conda-forge gdal")
    print("WARNING: On Linux: sudo apt-get install gdal-bin")
    print("WARNING: On macOS: brew install gdal")


class GeoPDFExportRequest(BaseModel):
    raster_layer_id: int
    user_clip_geojson: Optional[dict] = None
    title: Optional[str] = None
    dpi: int = 200


def load_datasets_index() -> list:
    """Load the datasets index JSON file."""
    if not GEOPDF_DATASETS_INDEX.exists():
        return []
    try:
        with open(GEOPDF_DATASETS_INDEX, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception as e:
        print(f"Warning: Failed to load datasets index: {e}")
        return []


def save_datasets_index(datasets: list) -> None:
    """Save the datasets index JSON file."""
    try:
        with open(GEOPDF_DATASETS_INDEX, "w", encoding="utf-8") as f:
            json.dump(datasets, f, indent=2)
    except Exception as e:
        print(f"Warning: Failed to save datasets index: {e}")
    

def extract_geopdf_bounds(pdf_path: Path) -> Optional[Dict[str, float]]:
    """
    Extract geographic bounds from a GeoPDF using GDAL.
    
    Returns:
        Dict with keys: west, south, east, north (in WGS84/EPSG:4326)
        or None if extraction fails
    """
    if not HAS_GDAL:
        return None
    
    try:
        # Use gdalinfo to get bounds
        result = subprocess.run(
            ["gdalinfo", str(pdf_path)],
            capture_output=True,
            text=True,
            timeout=30
        )
        
        if result.returncode != 0:
            print(f"[GEOPDF] gdalinfo failed: {result.stderr}")
            return None
        
        # Parse bounds from gdalinfo output
        # Look for "Upper Left" and "Lower Right" or "Corner Coordinates"
        output = result.stdout
        
        # Try to find corner coordinates
        # Format: Corner Coordinates:
        #         Upper Left  (  -123.4567890,   45.6789012) (-123d27'24.44"W, 45d40'44.04"N)
        #         Lower Right (  -122.3456789,   44.5678901) (-122d20'44.44"W, 44d34'04.04"N)
        
        import re
        
        # Look for coordinate pairs in decimal degrees
        coord_pattern = r'\([\s]*([+-]?\d+\.?\d*)[\s]*,[\s]*([+-]?\d+\.?\d*)\)'
        coords = re.findall(coord_pattern, output)
        
        if len(coords) >= 2:
            # First coordinate is usually Upper Left (west, north)
            # Second coordinate is usually Lower Right (east, south)
            try:
                west = float(coords[0][0])
                north = float(coords[0][1])
                east = float(coords[1][0])
                south = float(coords[1][1])
                
                # Ensure proper min/max
                west, east = min(west, east), max(west, east)
                south, north = min(south, north), max(south, north)
                
                return {
                    "west": west,
                    "south": south,
                    "east": east,
                    "north": north
                }
            except (ValueError, IndexError) as e:
                print(f"[GEOPDF] Failed to parse coordinates: {e}")
                return None
        
        # Alternative: Look for "Upper Left" and "Lower Right" explicitly
        upper_left_match = re.search(r'Upper Left\s*\([^)]*\(([+-]?\d+\.?\d*)[^,]*,\s*([+-]?\d+\.?\d*)', output)
        lower_right_match = re.search(r'Lower Right\s*\([^)]*\(([+-]?\d+\.?\d*)[^,]*,\s*([+-]?\d+\.?\d*)', output)
        
        if upper_left_match and lower_right_match:
            try:
                west = float(upper_left_match.group(1))
                north = float(upper_left_match.group(2))
                east = float(lower_right_match.group(1))
                south = float(lower_right_match.group(2))
                
                west, east = min(west, east), max(west, east)
                south, north = min(south, north), max(south, north)
                
                return {
                    "west": west,
                    "south": south,
                    "east": east,
                    "north": north
                }
            except (ValueError, IndexError) as e:
                print(f"[GEOPDF] Failed to parse explicit coordinates: {e}")
        
        print(f"[GEOPDF] Could not extract bounds from gdalinfo output")
        return None
        
    except Exception as e:
        print(f"[GEOPDF] Error extracting bounds: {e}")
        return None


def generate_geopdf_preview(pdf_path: Path, dataset_id: str) -> Optional[str]:
    """
    Generate a PNG preview image from a GeoPDF.
    
    Returns:
        Preview URL path (relative to static) or None if generation fails
    """
    if not HAS_GDAL:
        return None
    
    try:
        preview_dir = GEOPDF_UPLOAD_DIR / "previews"
        preview_dir.mkdir(parents=True, exist_ok=True)
        preview_path = preview_dir / f"{dataset_id}_preview.png"
        
        # Skip if already exists
        if preview_path.exists():
            return f"/static/uploads/geopdf/previews/{dataset_id}_preview.png"
        
        # Use gdal_translate to extract first page as PNG
        preview_command = [
            "gdal_translate",
            "-of", "PNG",
            "-outsize", "1200", "0",  # Width 1200px, maintain aspect
            str(pdf_path),
            str(preview_path)
        ]
        
        result = subprocess.run(
            preview_command,
            capture_output=True,
            text=True,
            timeout=60,
            check=True
        )
        
        if preview_path.exists():
            print(f"[GEOPDF] Generated preview: {preview_path}")
            return f"/static/uploads/geopdf/previews/{dataset_id}_preview.png"
        else:
            print(f"[GEOPDF] Preview file not created despite success")
            return None
            
    except subprocess.CalledProcessError as e:
        print(f"[GEOPDF] Failed to generate preview: {e.stderr or e.stdout}")
        return None
    except Exception as e:
        print(f"[GEOPDF] Error generating preview: {e}")
        return None


@router.post("/exports/geopdf")
async def export_geopdf(req: GeoPDFExportRequest):
    """
    Export a georeferenced PDF (GeoPDF) for Avenza Maps.
    
    Uses GDAL's gdal_translate to create a true GeoPDF with georeferencing.
    """
    if not HAS_GDAL:
        raise HTTPException(
            status_code=503,
            detail="GDAL is not available. GeoPDF export requires GDAL to be installed. "
                   "Please install GDAL: https://gdal.org/download.html"
        )
    
    try:
        print(f"[GEOPDF] Starting GeoPDF export for raster_layer_id={req.raster_layer_id}")
        
        # Resolve raster path
        try:
            raster_path = resolve_raster_path(req.raster_layer_id)
            raster_name = Path(raster_path).name
        except Exception as e:
            raise HTTPException(status_code=404, detail=f"Raster not found: {str(e)}")
        
        # Use user clip or default to global bounds
        if req.user_clip_geojson:
            try:
                export_feature = normalize_for_export(req.user_clip_geojson)
                geom_dict = export_feature.get("geometry")
                if not geom_dict:
                    raise ValueError("No geometry in GeoJSON")
                user_geom_4326 = shape(geom_dict)
            except Exception as e:
                raise HTTPException(status_code=400, detail=f"Invalid GeoJSON: {str(e)}")
        else:
            # Use full raster bounds if no AOI provided
            with rasterio.open(raster_path) as src:
                bounds = src.bounds
                from shapely.geometry import box
                user_geom_4326 = box(bounds.left, bounds.bottom, bounds.right, bounds.top)
        
        # Ensure geometry is valid
        if not user_geom_4326.is_valid:
            print(f"[GEOPDF] Geometry invalid, attempting to fix...")
            user_geom_4326 = make_valid(user_geom_4326)
        
        # Create export directory
        export_id = uuid.uuid4().hex[:8]
        export_dir = GEOPDF_EXPORT_DIR / export_id
        export_dir.mkdir(parents=True, exist_ok=True)
        
        # Step 1: Clip raster to AOI and save as GeoTIFF
        print(f"[GEOPDF] Clipping raster to AOI...")
        with rasterio.open(raster_path) as src:
            raster_crs = src.crs
            
            # Reproject geometry to raster CRS using rasterio.warp.transform_geom (more precise)
            # Input is EPSG:4326 (GeoJSON), output should be in raster CRS
            print(f"[GEOPDF] Reprojecting geometry from EPSG:4326 to {raster_crs}")
            aoi_geom_src = mapping(user_geom_4326)  # Convert shapely to GeoJSON dict
            aoi_geom_raster_crs = transform_geom(
                "EPSG:4326",
                raster_crs.to_string() if hasattr(raster_crs, 'to_string') else str(raster_crs),
                aoi_geom_src,
                precision=6  # 6 decimal places for precision
            )
            shapes = [aoi_geom_raster_crs]  # Use GeoJSON dict directly
            
            # Determine nodata value: use source nodata if available, otherwise choose based on dtype
            nodata_value = src.nodata
            if nodata_value is None:
                # Choose a safe nodata value based on dtype
                if np.issubdtype(src.dtypes[0], np.integer):
                    # For integer types, use a value outside typical range
                    if src.dtypes[0] == np.uint8:
                        nodata_value = 255
                    elif src.dtypes[0] == np.uint16:
                        nodata_value = 65535
                    else:
                        nodata_value = -9999
                else:
                    # For float types
                    nodata_value = -9999  # Use a sentinel value
                print(f"[GEOPDF] Source has no nodata, using {nodata_value} as nodata value")
            
            # ============================================================
            # MASK RASTER: Use all_touched=True to include any touched pixel
            # ============================================================
            # all_touched=True ensures every pixel that is even slightly touched
            # by the AOI boundary is included. This guarantees no edge pixels are lost.
            #
            # Why this works:
            # - By default, mask() only includes pixels whose center falls inside the polygon
            # - all_touched=True includes ANY pixel touched or intersected by the boundary
            # - Combined with proper CRS reprojection, this ensures complete pixel coverage
            # ============================================================
            clipped, out_transform = mask(
                src,
                shapes,  # GeoJSON geometry dict in raster CRS
                crop=True,  # Crop to geometry bounds (no pre-windowing needed)
                all_touched=True,  # CRITICAL: Include any pixel touched by boundary
                filled=True,  # Fill masked areas with nodata
                nodata=nodata_value  # Use source nodata or safe default
            )
            
            # Save clipped GeoTIFF
            temp_geotiff = export_dir / "clipped.tif"
            meta = src.meta.copy()
            meta.update({
                "height": clipped.shape[1],
                "width": clipped.shape[2],
                "transform": out_transform,
                "driver": "GTiff",
                "compress": "lzw",
            })
            
            # Use the nodata value we set in mask() call
            meta["nodata"] = nodata_value
            
            with rasterio.open(temp_geotiff, "w", **meta) as dst:
                dst.write(clipped)
        
        print(f"[GEOPDF] Clipped GeoTIFF saved to {temp_geotiff}")
        
        # Step 2: Generate GeoPDF using GDAL
        title = req.title or f"VMRC Export {datetime.now().strftime('%Y-%m-%d')}"
        safe_title = sanitize_filename(title)
        pdf_name = f"{safe_title}.pdf"
        pdf_path = export_dir / pdf_name
        
        print(f"[GEOPDF] Generating GeoPDF using gdal_translate...")
        gdal_command = [
            "gdal_translate",
            "-of", "PDF",
            "-co", "GEOREF=YES",  # Enable georeferencing
            "-co", f"DPI={req.dpi}",
            str(temp_geotiff),
            str(pdf_path)
        ]
        
        try:
            result = subprocess.run(
                gdal_command,
                capture_output=True,
                text=True,
                timeout=300,  # 5 minute timeout
                check=True
            )
            print(f"[GEOPDF] gdal_translate output: {result.stdout}")
        except subprocess.CalledProcessError as e:
            error_msg = f"GDAL failed: {e.stderr or e.stdout or str(e)}"
            print(f"[GEOPDF] ERROR: {error_msg}")
            raise HTTPException(status_code=500, detail=error_msg)
        except subprocess.TimeoutExpired:
            raise HTTPException(status_code=500, detail="GeoPDF generation timed out")
        
        if not pdf_path.exists():
            raise HTTPException(status_code=500, detail="GeoPDF file was not created")
        
        print(f"[GEOPDF] ✓ GeoPDF created: {pdf_path}")
        
        # Step 3: Generate PNG preview
        preview_name = f"{safe_title}_preview.png"
        preview_path = export_dir / preview_name
        
        print(f"[GEOPDF] Generating PNG preview...")
        preview_command = [
            "gdal_translate",
            "-of", "PNG",
            "-outsize", "800", "0",  # Width 800px, maintain aspect
            str(temp_geotiff),
            str(preview_path)
        ]
        
        try:
            subprocess.run(
                preview_command,
                capture_output=True,
                text=True,
                timeout=60,
                check=True
            )
            preview_url = f"/static/exports/geopdf/{export_id}/{preview_name}" if preview_path.exists() else None
        except Exception as e:
            print(f"[GEOPDF] Warning: Failed to generate preview: {e}")
            preview_url = None
        
        # Clean up temporary GeoTIFF
        try:
            temp_geotiff.unlink()
        except Exception as e:
            print(f"[GEOPDF] Warning: Failed to delete temp file: {e}")
        
        # Return download URL and preview
        return {
            "status": "success",
            "export_id": export_id,
            "download_url": f"/static/exports/geopdf/{export_id}/{pdf_name}",
            "preview_url": preview_url,
            "filename": pdf_name,
            "title": title,
        }
        
    except HTTPException:
        raise
    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"GeoPDF export failed: {str(e)}")


@router.get("/exports/geopdf/{export_id}/{filename}")
async def download_geopdf(export_id: str, filename: str):
    """Download a generated GeoPDF file."""
    file_path = GEOPDF_EXPORT_DIR / export_id / filename
    
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="GeoPDF file not found")
    
    if not file_path.suffix.lower() == ".pdf":
        raise HTTPException(status_code=400, detail="Invalid file type")
    
    return FileResponse(
        path=str(file_path),
        media_type="application/pdf",
        filename=filename,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'}
    )


@router.post("/uploads/geopdf")
async def upload_geopdf(
    file: UploadFile = File(...),
    name: Optional[str] = Form(None)
):
    """
    Upload a georeferenced PDF file.
    
    Validates the file is a PDF and stores it for later use.
    """
    # Validate file type
    if not file.content_type or "pdf" not in file.content_type.lower():
        raise HTTPException(status_code=400, detail="File must be a PDF")
    
    # Read file to check size
    file_content = await file.read()
    file_size = len(file_content)
    
    if file_size > MAX_UPLOAD_SIZE:
        raise HTTPException(
            status_code=400,
            detail=f"File size ({file_size / 1024 / 1024:.1f}MB) exceeds maximum ({MAX_UPLOAD_SIZE / 1024 / 1024}MB)"
        )
    
    if file_size == 0:
        raise HTTPException(status_code=400, detail="File is empty")
    
    # Sanitize filename
    original_filename = file.filename or "uploaded.pdf"
    safe_filename = sanitize_filename(original_filename)
    if not safe_filename.endswith(".pdf"):
        safe_filename += ".pdf"
    
    # Generate unique filename if needed
    dataset_id = uuid.uuid4().hex[:8]
    final_filename = f"{dataset_id}_{safe_filename}"
    file_path = GEOPDF_UPLOAD_DIR / final_filename
    
    # Save file
    try:
        with open(file_path, "wb") as f:
            f.write(file_content)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to save file: {str(e)}")
    
    # Generate preview PNG and extract bounds
    preview_url = None
    preview_bounds = None
    
    if HAS_GDAL:
        print(f"[GEOPDF] Generating preview and extracting bounds for {dataset_id}...")
        
        # Generate preview PNG
        preview_url = generate_geopdf_preview(file_path, dataset_id)
        
        # Extract bounds
        preview_bounds = extract_geopdf_bounds(file_path)
        
        if preview_bounds:
            print(f"[GEOPDF] Extracted bounds: {preview_bounds}")
        else:
            print(f"[GEOPDF] Warning: Could not extract bounds from GeoPDF")
    else:
        print(f"[GEOPDF] GDAL not available, skipping preview and bounds extraction")
    
    # Register in datasets index
    dataset_name = name or safe_filename.replace(".pdf", "")
    dataset = {
        "id": dataset_id,
        "name": dataset_name,
        "type": "geopdf",
        "filename": final_filename,
        "file_path": str(file_path.relative_to(Path("static"))),
        "size_bytes": file_size,
        "created_at": datetime.now().isoformat(),
        "original_filename": original_filename,
        "preview_url": preview_url,
        "preview_bounds": preview_bounds,
    }
    
    datasets = load_datasets_index()
    datasets.append(dataset)
    save_datasets_index(datasets)
    
    print(f"[GEOPDF] Uploaded GeoPDF: {dataset_id} - {dataset_name}")
    
    return {
        "status": "success",
        "dataset": dataset,
    }


@router.get("/datasets")
async def list_datasets():
    """List all datasets (including uploaded GeoPDFs)."""
    datasets = load_datasets_index()
    
    # Format datasets for frontend (no full paths)
    formatted_datasets = []
    for ds in datasets:
        formatted = {
            "id": ds.get("id"),
            "name": ds.get("name"),
            "type": ds.get("type", "geopdf"),
            "type_label": "GeoPDF (Avenza Maps)" if ds.get("type") == "geopdf" else ds.get("type", "Unknown"),
            "size_bytes": ds.get("size_bytes"),
            "created_at": ds.get("created_at"),
            "download_url": f"/api/v1/datasets/{ds.get('id')}/download",
            "preview_url": ds.get("preview_url"),  # Direct preview URL if available
            "preview_bounds": ds.get("preview_bounds"),  # Geographic bounds for overlay
        }
        formatted_datasets.append(formatted)
    
    return {
        "status": "success",
        "datasets": formatted_datasets,
        "count": len(formatted_datasets),
    }


@router.get("/datasets/{dataset_id}/download")
async def download_dataset(dataset_id: str):
    """Download a dataset file."""
    datasets = load_datasets_index()
    dataset = next((ds for ds in datasets if ds.get("id") == dataset_id), None)
    
    if not dataset:
        raise HTTPException(status_code=404, detail="Dataset not found")
    
    file_path = Path("static") / dataset.get("file_path", "")
    
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="Dataset file not found")
    
    filename = dataset.get("original_filename") or dataset.get("filename", "download.pdf")
    
    return FileResponse(
        path=str(file_path),
        media_type="application/pdf",
        filename=filename,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'}
    )


@router.get("/datasets/{dataset_id}/preview")
async def get_dataset_preview(dataset_id: str):
    """Get preview thumbnail for a dataset."""
    datasets = load_datasets_index()
    dataset = next((ds for ds in datasets if ds.get("id") == dataset_id), None)
    
    if not dataset:
        raise HTTPException(status_code=404, detail="Dataset not found")
    
    if dataset.get("type") != "geopdf":
        # Return generic icon for non-GeoPDF datasets
        return JSONResponse({"preview_url": None, "message": "Preview not available for this dataset type"})
    
    # Try to generate preview from PDF using GDAL if available
    if HAS_GDAL:
        file_path = Path("static") / dataset.get("file_path", "")
        if file_path.exists():
            preview_dir = GEOPDF_UPLOAD_DIR / "previews"
            preview_dir.mkdir(parents=True, exist_ok=True)
            preview_path = preview_dir / f"{dataset_id}_preview.png"
            
            if not preview_path.exists():
                try:
                    # Use gdal_translate to extract first page as PNG
                    preview_command = [
                        "gdal_translate",
                        "-of", "PNG",
                        "-outsize", "400", "0",  # Width 400px
                        str(file_path),
                        str(preview_path)
                    ]
                    subprocess.run(
                        preview_command,
                        capture_output=True,
                        text=True,
                        timeout=30,
                        check=True
                    )
                except Exception as e:
                    print(f"[GEOPDF] Warning: Failed to generate preview: {e}")
                    return JSONResponse({"preview_url": None, "message": "Preview generation failed"})
            
            if preview_path.exists():
                return JSONResponse({
                    "preview_url": f"/static/uploads/geopdf/previews/{dataset_id}_preview.png"
                })
    
    return JSONResponse({"preview_url": None, "message": "Preview not available"})


@router.delete("/geopdf/{dataset_id}")
async def delete_geopdf(dataset_id: str):
    """Delete a GeoPDF dataset and its associated files."""
    datasets = load_datasets_index()
    dataset = next((ds for ds in datasets if ds.get("id") == dataset_id), None)
    
    if not dataset:
        raise HTTPException(status_code=404, detail="Dataset not found")
    
    if dataset.get("type") != "geopdf":
        raise HTTPException(status_code=400, detail="Only GeoPDF datasets can be deleted via this endpoint")
    
    # Delete PDF file
    file_path = Path("static") / dataset.get("file_path", "")
    if file_path.exists():
        try:
            file_path.unlink()
            print(f"[GEOPDF] Deleted PDF file: {file_path}")
        except Exception as e:
            print(f"[GEOPDF] Warning: Failed to delete PDF file: {e}")
    
    # Delete preview PNG
    preview_url = dataset.get("preview_url")
    if preview_url:
        preview_path = Path("static") / preview_url.lstrip("/static/")
        if preview_path.exists():
            try:
                preview_path.unlink()
                print(f"[GEOPDF] Deleted preview file: {preview_path}")
            except Exception as e:
                print(f"[GEOPDF] Warning: Failed to delete preview file: {e}")
    
    # Remove from datasets index
    updated_datasets = [ds for ds in datasets if ds.get("id") != dataset_id]
    save_datasets_index(updated_datasets)
    
    print(f"[GEOPDF] Deleted dataset: {dataset_id} - {dataset.get('name')}")
    
    return {
        "status": "success",
        "message": f"Dataset {dataset_id} deleted successfully"
    }

