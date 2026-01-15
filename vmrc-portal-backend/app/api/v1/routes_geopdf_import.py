# app/api/v1/routes_geopdf_import.py
"""
GeoPDF import/export endpoints for raster export and GeoPDF preview import.
"""

import subprocess
import shutil
import os
from pathlib import Path
from typing import Optional, Dict, Any
from datetime import datetime
import uuid
import json

from fastapi import APIRouter, HTTPException, UploadFile, File
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel

from app.services.raster_service import resolve_raster_path
from app.services.geopdf_service import (
    export_geopdf,
    import_geopdf_to_overlay,
    cleanup_old_uploads,
    HAS_GDAL,
    HAS_GDAL_CLI,
    HAS_GDAL_PYTHON,
    MAX_UPLOAD_SIZE,
    GEOPDF_STORAGE_DIR
)
from app.api.v1.routes_raster_export import normalize_for_export

router = APIRouter(tags=["geopdf"])

# Run cleanup on module load
cleanup_old_uploads()


@router.get("/geopdf/status")
async def get_geopdf_status():
    """
    Diagnostic endpoint to check GDAL availability from the server's perspective.
    """
    import subprocess
    import sys
    
    diagnostics = {
        "gdal_cli_available": False,
        "gdal_python_available": False,
        "gdal_fully_available": False,
        "python_path": sys.executable,
        "python_version": sys.version,
        "gdal_cli_version": None,
        "gdal_python_version": None,
        "gdal_cli_error": None,
        "gdal_python_error": None,
        "path_env": os.environ.get("PATH", "")[:200] + "..." if len(os.environ.get("PATH", "")) > 200 else os.environ.get("PATH", ""),
    }
    
    # Check GDAL CLI
    try:
        result = subprocess.run(
            ["gdalwarp", "--version"],
            capture_output=True,
            text=True,
            timeout=5
        )
        if result.returncode == 0:
            diagnostics["gdal_cli_available"] = True
            diagnostics["gdal_cli_version"] = result.stdout.strip()
        else:
            diagnostics["gdal_cli_error"] = result.stderr or "Command failed"
    except FileNotFoundError:
        diagnostics["gdal_cli_error"] = "gdalwarp command not found in PATH"
    except Exception as e:
        diagnostics["gdal_cli_error"] = str(e)
    
    # Check GDAL Python
    try:
        from osgeo import gdal
        diagnostics["gdal_python_available"] = True
        diagnostics["gdal_python_version"] = gdal.__version__
    except ImportError as e:
        diagnostics["gdal_python_error"] = str(e)
    except Exception as e:
        diagnostics["gdal_python_error"] = str(e)
    
    diagnostics["gdal_fully_available"] = (
        diagnostics["gdal_cli_available"] and 
        diagnostics["gdal_python_available"]
    )
    
    return diagnostics


class GeoPDFExportRequest(BaseModel):
    raster_id: int
    aoi_geojson: dict
    title: Optional[str] = None
    author: Optional[str] = None


@router.post("/export/geopdf")
async def export_geopdf_endpoint(req: GeoPDFExportRequest):
    """
    Export a raster to GeoPDF by clipping to AOI.
    
    Request JSON:
    {
      "raster_id": 123,
      "aoi_geojson": { ... },
      "title": "optional",
      "author": "optional"
    }
    
    Returns:
        File download: application/pdf
        Filename: vmrc_<raster_id>_<timestamp>.pdf
    """
    if not HAS_GDAL:
        if not HAS_GDAL_CLI:
            raise HTTPException(
                status_code=500,
                detail="GDAL command-line tools are not available. GeoPDF export requires GDAL to be installed. "
                       "See installation instructions: https://gdal.org/download.html"
            )
        else:
            raise HTTPException(
                status_code=500,
                detail="GDAL Python bindings are not available. Install with: "
                       "OSGeo4W: Install 'gdal-python' package, or "
                       "Conda: conda install -c conda-forge gdal, or "
                       "Pip: pip install gdal (must match system GDAL version)"
            )
    
    try:
        # Resolve raster path
        raster_path = resolve_raster_path(req.raster_id)
        raster_name = Path(raster_path).name
        
        print(f"[GEOPDF] Export request for raster_id={req.raster_id}, raster={raster_name}")
        
        # Normalize AOI GeoJSON
        try:
            export_feature = normalize_for_export(req.aoi_geojson)
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"Invalid AOI GeoJSON: {str(e)}")
        
        # Generate output filename
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        pdf_filename = f"vmrc_{req.raster_id}_{timestamp}.pdf"
        pdf_path = GEOPDF_STORAGE_DIR / pdf_filename
        
        # Export to GeoPDF
        exported_path = export_geopdf(
            raster_path=raster_path,
            aoi_geojson=export_feature,
            out_pdf_path=pdf_path,
            title=req.title or f"VMRC Export {raster_name}",
            author=req.author or "VMRC Portal"
        )
        
        print(f"[GEOPDF] ✓ Export complete: {exported_path}")
        
        # Return file download
        return FileResponse(
            path=str(exported_path),
            media_type="application/pdf",
            filename=pdf_filename,
            headers={"Content-Disposition": f'attachment; filename="{pdf_filename}"'}
        )
        
    except HTTPException:
        raise
    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"GeoPDF export failed: {str(e)}")


@router.post("/upload/geopdf")
async def import_geopdf_endpoint(file: UploadFile = File(...)):
    """
    Import a GeoPDF and convert to PNG overlay for map preview.
    
    Form data:
    - file: GeoPDF file (multipart/form-data)
    
    Response JSON:
    {
      "layer_id": "upload_<uuid>",
      "overlay_url": "/api/layers/<layer_id>/overlay.png",
      "bounds": [[southLat, westLng], [northLat, eastLng]],
      "crs": "EPSG:4326"
    }
    """
    if not HAS_GDAL:
        if not HAS_GDAL_CLI:
            raise HTTPException(
                status_code=503,
                detail="GDAL command-line tools are not available. GeoPDF import requires GDAL to be installed. "
                       "See installation instructions: https://gdal.org/download.html"
            )
        else:
            raise HTTPException(
                status_code=503,
                detail="GDAL Python bindings are not available. Install with: "
                       "OSGeo4W: Install 'gdal-python' package, or "
                       "Conda: conda install -c conda-forge gdal, or "
                       "Pip: pip install gdal (must match system GDAL version)"
            )
    
    # Validate file type
    if not file.content_type or "pdf" not in file.content_type.lower():
        if not file.filename or not file.filename.lower().endswith(".pdf"):
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
    
    # Generate unique layer ID
    layer_id = f"upload_{uuid.uuid4().hex[:12]}"
    layer_dir = GEOPDF_STORAGE_DIR / "layers" / layer_id
    layer_dir.mkdir(parents=True, exist_ok=True)
    
    # Save uploaded PDF
    uploaded_pdf_path = layer_dir / "uploaded.pdf"
    try:
        with open(uploaded_pdf_path, "wb") as f:
            f.write(file_content)
        print(f"[GEOPDF] Uploaded GeoPDF saved: {uploaded_pdf_path}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to save uploaded file: {str(e)}")
    
    # Convert to overlay
    try:
        result = import_geopdf_to_overlay(
            uploaded_pdf_path=uploaded_pdf_path,
            out_dir=layer_dir,
            layer_id=layer_id
        )
        
        # Save metadata for the imported layer
        from app.services.layer_metadata import save_metadata
        from datetime import datetime
        
        # Create metadata manually for GeoPDF (PNG doesn't have geographic stats)
        metadata = {
            "layer_id": layer_id,
            "title": file.filename or "Uploaded GeoPDF",
            "summary": f"User-uploaded GeoPDF preview: {file.filename or 'Unknown'}",
            "tags": ["geopdf", "upload"],
            "credits": "",
            "units": "",
            "crs": result.get("crs", "EPSG:4326"),
            "bounds": result.get("bounds"),  # [[south, west], [north, east]]
            "pixel_size": None,  # PNG overlays don't have meaningful pixel size
            "stats": {
                "min": None,
                "max": None,
                "mean": None,
                "std": None,
                "nodata": None,
                "count": None
            },
            "created_at": datetime.utcnow().isoformat() + "Z",
            "source_type": "geopdf_upload"
        }
        save_metadata(layer_id, metadata)
        
        print(f"[GEOPDF] ✓ Import complete: layer_id={layer_id}")
        return JSONResponse({
            "layer_id": layer_id,
            "overlay_url": result["overlay_url"],
            "bounds": result["bounds"],
            "crs": result["crs"]
        })
        
    except Exception as e:
        import traceback
        traceback.print_exc()
        # Clean up on failure
        try:
            shutil.rmtree(layer_dir)
        except:
            pass
        raise HTTPException(status_code=500, detail=f"GeoPDF import failed: {str(e)}")


@router.get("/layers/{layer_id}/overlay.png")
async def get_layer_overlay(layer_id: str):
    """
    Serve the PNG overlay for an imported GeoPDF layer.
    
    GET /api/layers/<layer_id>/overlay.png
    """
    # Validate layer_id format (prevent directory traversal)
    if not layer_id.startswith("upload_") or len(layer_id) < 20:
        raise HTTPException(status_code=400, detail="Invalid layer_id format")
    
    overlay_path = GEOPDF_STORAGE_DIR / "layers" / layer_id / f"{layer_id}_overlay.png"
    
    if not overlay_path.exists():
        raise HTTPException(status_code=404, detail="Overlay not found")
    
    return FileResponse(
        path=str(overlay_path),
        media_type="image/png",
        headers={"Cache-Control": "public, max-age=3600"}
    )

