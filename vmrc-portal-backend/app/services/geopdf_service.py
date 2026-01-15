# app/services/geopdf_service.py
"""
GeoPDF service: Export raster to GeoPDF and import GeoPDF to PNG overlay.
"""

import subprocess
import tempfile
import shutil
from pathlib import Path
from typing import Dict, Optional, Tuple, List
import uuid
import json
from datetime import datetime, timedelta

import rasterio
from rasterio.warp import transform_bounds
from pyproj import Transformer
import numpy as np
from PIL import Image

# Storage directories
GEOPDF_STORAGE_DIR = Path("storage/geopdf")
GEOPDF_STORAGE_DIR.mkdir(parents=True, exist_ok=True)

# Maximum upload size (200MB)
MAX_UPLOAD_SIZE = 200 * 1024 * 1024

# Cleanup: Keep uploads for 7 days
UPLOAD_TTL_DAYS = 7


def check_gdal_available() -> bool:
    """Check if GDAL command-line tools are available on the system."""
    try:
        result = subprocess.run(
            ["gdalwarp", "--version"],
            capture_output=True,
            text=True,
            timeout=5
        )
        return result.returncode == 0
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return False


def check_gdal_python() -> bool:
    """Check if GDAL Python bindings are available."""
    try:
        from osgeo import gdal
        return True
    except ImportError:
        return False


HAS_GDAL_CLI = check_gdal_available()
HAS_GDAL_PYTHON = check_gdal_python()
HAS_GDAL = HAS_GDAL_CLI and HAS_GDAL_PYTHON

if not HAS_GDAL_CLI:
    print("ERROR: GDAL command-line tools are not available. GeoPDF export/import requires GDAL.")
    print("ERROR: Install GDAL: https://gdal.org/download.html")
    print("ERROR: On Windows: Use OSGeo4W or conda install -c conda-forge gdal")
    print("ERROR: On Linux: sudo apt-get install gdal-bin")
    print("ERROR: On macOS: brew install gdal")
elif not HAS_GDAL_PYTHON:
    print("ERROR: GDAL Python bindings are not available.")
    print("ERROR: GDAL CLI is installed, but Python cannot import GDAL.")
    print("ERROR: Install Python bindings:")
    print("ERROR:   - OSGeo4W: Install 'gdal-python' package in OSGeo4W setup")
    print("ERROR:   - Conda: conda install -c conda-forge gdal")
    print("ERROR:   - Pip: pip install gdal (may need to match system GDAL version)")


def export_geopdf(
    raster_path: str,
    aoi_geojson: dict,
    out_pdf_path: Optional[Path] = None,
    title: Optional[str] = None,
    author: Optional[str] = None
) -> Path:
    """
    Export a raster to GeoPDF by clipping to AOI and converting.
    
    Args:
        raster_path: Path to input raster file
        aoi_geojson: GeoJSON geometry for clipping
        out_pdf_path: Optional output PDF path (if None, generates in temp)
        title: Optional PDF title
        author: Optional PDF author
    
    Returns:
        Path to created GeoPDF file
    
    Raises:
        RuntimeError: If GDAL operations fail
    """
    if not HAS_GDAL:
        raise RuntimeError(
            "GDAL is not available. GeoPDF export requires GDAL to be installed. "
            "See installation instructions: https://gdal.org/download.html"
        )
    
    # Generate output path if not provided
    if out_pdf_path is None:
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        out_pdf_path = GEOPDF_STORAGE_DIR / f"export_{timestamp}.pdf"
    
    out_pdf_path = Path(out_pdf_path)
    out_pdf_path.parent.mkdir(parents=True, exist_ok=True)
    
    # Create temp directory for intermediate files
    with tempfile.TemporaryDirectory() as temp_dir:
        temp_path = Path(temp_dir)
        
        # Step 1: Write AOI GeoJSON to temp file
        aoi_geojson_path = temp_path / "aoi.geojson"
        with open(aoi_geojson_path, "w", encoding="utf-8") as f:
            json.dump(aoi_geojson, f)
        
        print(f"[GEOPDF] AOI GeoJSON written to: {aoi_geojson_path}")
        
        # Step 2: Clip raster to AOI using gdalwarp
        clipped_tif_path = temp_path / "clipped.tif"
        print(f"[GEOPDF] Clipping raster to AOI...")
        
        gdalwarp_cmd = [
            "gdalwarp",
            "-cutline", str(aoi_geojson_path),
            "-crop_to_cutline",
            "-dstalpha",  # Add alpha band for transparency
            "-of", "GTiff",
            str(raster_path),
            str(clipped_tif_path)
        ]
        
        result = subprocess.run(
            gdalwarp_cmd,
            capture_output=True,
            text=True,
            timeout=300
        )
        
        if result.returncode != 0:
            error_msg = result.stderr[:500] if result.stderr else str(result)
            raise RuntimeError(f"gdalwarp failed: {error_msg}")
        
        if not clipped_tif_path.exists():
            raise RuntimeError("Clipped GeoTIFF was not created")
        
        print(f"[GEOPDF] Clipped raster saved: {clipped_tif_path}")
        
        # Step 3: Convert clipped GeoTIFF to GeoPDF using gdal_translate
        print(f"[GEOPDF] Converting to GeoPDF...")
        
        gdal_translate_cmd = [
            "gdal_translate",
            "-of", "PDF",
            "-co", "GEOREF=YES",  # Enable georeferencing
            "-co", "DPI=200",
        ]
        
        # Add title/author if provided
        if title:
            gdal_translate_cmd.extend(["-co", f"TITLE={title}"])
        if author:
            gdal_translate_cmd.extend(["-co", f"AUTHOR={author}"])
        
        gdal_translate_cmd.extend([
            str(clipped_tif_path),
            str(out_pdf_path)
        ])
        
        result = subprocess.run(
            gdal_translate_cmd,
            capture_output=True,
            text=True,
            timeout=300
        )
        
        if result.returncode != 0:
            error_msg = result.stderr[:500] if result.stderr else str(result)
            raise RuntimeError(f"gdal_translate failed: {error_msg}")
        
        if not out_pdf_path.exists():
            raise RuntimeError("GeoPDF was not created")
        
        print(f"[GEOPDF] ✓ GeoPDF exported: {out_pdf_path}")
        return out_pdf_path


def import_geopdf_to_overlay(
    uploaded_pdf_path: Path,
    out_dir: Path,
    layer_id: str
) -> Dict[str, any]:
    """
    Import a GeoPDF and convert to PNG overlay with bounds.
    
    Args:
        uploaded_pdf_path: Path to uploaded GeoPDF file
        out_dir: Directory to store output files
        layer_id: Unique identifier for this layer
    
    Returns:
        Dict with keys:
            - overlay_url: URL path to PNG overlay
            - bounds: [[south, west], [north, east]] in EPSG:4326
            - crs: "EPSG:4326"
    
    Raises:
        RuntimeError: If conversion fails
    """
    if not HAS_GDAL:
        raise RuntimeError(
            "GDAL is not available. GeoPDF import requires GDAL to be installed. "
            "See installation instructions: https://gdal.org/download.html"
        )
    
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    
    # Create temp directory for intermediate files
    with tempfile.TemporaryDirectory() as temp_dir:
        temp_path = Path(temp_dir)
        
        # Step 1: Convert GeoPDF to GeoTIFF (extract first raster layer)
        extracted_tif_path = temp_path / "extracted.tif"
        print(f"[GEOPDF] Converting GeoPDF to GeoTIFF...")
        
        gdal_translate_cmd = [
            "gdal_translate",
            "-of", "GTiff",
            str(uploaded_pdf_path),
            str(extracted_tif_path)
        ]
        
        result = subprocess.run(
            gdal_translate_cmd,
            capture_output=True,
            text=True,
            timeout=300
        )
        
        if result.returncode != 0:
            error_msg = result.stderr[:500] if result.stderr else str(result)
            raise RuntimeError(f"gdal_translate failed: {error_msg}")
        
        if not extracted_tif_path.exists():
            raise RuntimeError("Extracted GeoTIFF was not created")
        
        print(f"[GEOPDF] Extracted GeoTIFF: {extracted_tif_path}")
        
        # Step 2: Read GeoTIFF with rasterio and convert to PNG
        print(f"[GEOPDF] Converting to PNG overlay...")
        
        with rasterio.open(extracted_tif_path) as src:
            # Get bounds in source CRS
            bounds_src = src.bounds
            src_crs = src.crs
            
            # Read raster data
            data = src.read()
            
            # Handle single band or RGB
            if len(data.shape) == 3:
                # Multi-band: use first 3 bands as RGB, or first band if grayscale
                if data.shape[0] >= 3:
                    # RGB
                    band_r = data[0]
                    band_g = data[1]
                    band_b = data[2]
                    # Handle alpha if present
                    if data.shape[0] >= 4:
                        alpha = data[3]
                    else:
                        alpha = np.ones_like(band_r, dtype=np.uint8) * 255
                else:
                    # Grayscale
                    band_r = data[0]
                    band_g = data[0]
                    band_b = data[0]
                    alpha = np.ones_like(band_r, dtype=np.uint8) * 255
            else:
                # Single band
                band_r = data
                band_g = data
                band_b = data
                alpha = np.ones_like(data, dtype=np.uint8) * 255
            
            # Handle nodata
            nodata = src.nodata
            if nodata is not None:
                nodata_mask = (band_r == nodata) | ~np.isfinite(band_r)
                alpha[nodata_mask] = 0
            
            # Normalize to 0-255
            def normalize_band(band):
                band = band.astype(np.float32)
                valid = np.isfinite(band) & (band != nodata if nodata is not None else True)
                if valid.any():
                    min_val = np.nanmin(band[valid])
                    max_val = np.nanmax(band[valid])
                    if max_val > min_val:
                        band = (band - min_val) / (max_val - min_val) * 255
                    else:
                        band[valid] = 128  # Gray for constant values
                band = np.clip(band, 0, 255).astype(np.uint8)
                return band
            
            band_r = normalize_band(band_r)
            band_g = normalize_band(band_g)
            band_b = normalize_band(band_b)
            
            # Stack into RGBA
            rgba = np.stack([band_r, band_g, band_b, alpha], axis=0)
            rgba = np.transpose(rgba, (1, 2, 0))  # (height, width, 4)
            
            # Save PNG
            overlay_png_path = out_dir / f"{layer_id}_overlay.png"
            img = Image.fromarray(rgba, mode="RGBA")
            img.save(overlay_png_path, "PNG")
            
            print(f"[GEOPDF] PNG overlay saved: {overlay_png_path}")
            
            # Step 3: Compute bounds in EPSG:4326
            print(f"[GEOPDF] Computing bounds in EPSG:4326...")
            
            if src_crs and src_crs.to_string() != "EPSG:4326":
                # Reproject bounds to WGS84
                bounds_4326 = transform_bounds(
                    src_crs,
                    "EPSG:4326",
                    bounds_src.left,
                    bounds_src.bottom,
                    bounds_src.right,
                    bounds_src.top
                )
            else:
                bounds_4326 = (
                    bounds_src.left,
                    bounds_src.bottom,
                    bounds_src.right,
                    bounds_src.top
                )
            
            # Convert to Leaflet format: [[south, west], [north, east]]
            west, south, east, north = bounds_4326
            bounds_leaflet = [[south, west], [north, east]]
            
            print(f"[GEOPDF] Bounds (EPSG:4326): west={west}, south={south}, east={east}, north={north}")
            
            return {
                "overlay_url": f"/api/layers/{layer_id}/overlay.png",
                "bounds": bounds_leaflet,
                "crs": "EPSG:4326"
            }


def cleanup_old_uploads() -> int:
    """
    Clean up old GeoPDF uploads older than TTL_DAYS.
    
    Returns:
        Number of files deleted
    """
    if not GEOPDF_STORAGE_DIR.exists():
        return 0
    
    cutoff_time = datetime.now() - timedelta(days=UPLOAD_TTL_DAYS)
    deleted_count = 0
    
    # Clean up layer directories
    layers_dir = GEOPDF_STORAGE_DIR / "layers"
    if layers_dir.exists():
        for layer_dir in layers_dir.iterdir():
            if layer_dir.is_dir():
                # Check modification time
                mtime = datetime.fromtimestamp(layer_dir.stat().st_mtime)
                if mtime < cutoff_time:
                    try:
                        shutil.rmtree(layer_dir)
                        deleted_count += 1
                        print(f"[GEOPDF] Cleaned up old layer: {layer_dir.name}")
                    except Exception as e:
                        print(f"[GEOPDF] Warning: Failed to delete {layer_dir}: {e}")
    
    # Clean up old export PDFs
    for pdf_file in GEOPDF_STORAGE_DIR.glob("export_*.pdf"):
        mtime = datetime.fromtimestamp(pdf_file.stat().st_mtime)
        if mtime < cutoff_time:
            try:
                pdf_file.unlink()
                deleted_count += 1
                print(f"[GEOPDF] Cleaned up old export: {pdf_file.name}")
            except Exception as e:
                print(f"[GEOPDF] Warning: Failed to delete {pdf_file}: {e}")
    
    if deleted_count > 0:
        print(f"[GEOPDF] Cleanup complete: {deleted_count} files/directories deleted")
    
    return deleted_count

