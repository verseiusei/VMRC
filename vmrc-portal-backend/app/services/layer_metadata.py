# app/services/layer_metadata.py
"""
Layer metadata service for computing, storing, and retrieving metadata
for raster layers and imported GeoPDF layers.
"""

import json
import numpy as np
from pathlib import Path
from datetime import datetime
from typing import Dict, Any, Optional, Tuple
import rasterio
from rasterio.warp import transform_bounds, array_bounds
from pyproj import Transformer
import shutil

# Storage base directory
STORAGE_BASE = Path("storage")
LAYERS_DIR = STORAGE_BASE / "layers"
LAYERS_DIR.mkdir(parents=True, exist_ok=True)

# TTL for uploads (7 days in seconds)
UPLOAD_TTL_SECONDS = 7 * 24 * 60 * 60


def get_layer_dir(layer_id: str) -> Path:
    """Get the storage directory for a layer."""
    return LAYERS_DIR / layer_id


def ensure_layer_dir(layer_id: str) -> Path:
    """Ensure layer directory exists and return it."""
    layer_dir = get_layer_dir(layer_id)
    layer_dir.mkdir(parents=True, exist_ok=True)
    return layer_dir


def compute_raster_stats(
    raster_path: Path,
    window_size: int = 1024,
    nodata: Optional[float] = None
) -> Dict[str, Any]:
    """
    Compute raster statistics using windowed reading for large files.
    
    Args:
        raster_path: Path to raster file
        window_size: Size of windows for sampling (default 1024x1024)
        nodata: NODATA value to exclude (if None, read from raster)
    
    Returns:
        Dict with min, max, mean, std, nodata, count
    """
    try:
        with rasterio.open(raster_path) as src:
            # Get nodata from raster if not provided
            if nodata is None:
                nodata = src.nodata
            
            # Get raster dimensions
            height, width = src.height, src.width
            
            # For large rasters, sample with windows
            # For small rasters, read entire array
            if height * width > 10_000_000:  # > 10M pixels
                # Windowed reading
                values = []
                for i in range(0, height, window_size):
                    for j in range(0, width, window_size):
                        window = rasterio.windows.Window(
                            j, i,
                            min(window_size, width - j),
                            min(window_size, height - i)
                        )
                        window_data = src.read(1, window=window)
                        
                        # Apply mask if nodata exists
                        if nodata is not None:
                            valid = (window_data != nodata) & np.isfinite(window_data)
                        else:
                            valid = np.isfinite(window_data)
                        
                        if valid.any():
                            values.append(window_data[valid].astype(np.float64))
                
                if not values:
                    return {
                        "min": None,
                        "max": None,
                        "mean": None,
                        "std": None,
                        "nodata": nodata,
                        "count": 0
                    }
                
                # Combine all values
                all_values = np.concatenate(values)
            else:
                # Read entire array for small rasters
                data = src.read(1).astype(np.float64)
                
                # Apply mask
                if nodata is not None:
                    valid = (data != nodata) & np.isfinite(data)
                else:
                    valid = np.isfinite(data)
                
                if not valid.any():
                    return {
                        "min": None,
                        "max": None,
                        "mean": None,
                        "std": None,
                        "nodata": nodata,
                        "count": 0
                    }
                
                all_values = data[valid]
            
            # Compute stats
            if all_values.size == 0:
                return {
                    "min": None,
                    "max": None,
                    "mean": None,
                    "std": None,
                    "nodata": nodata,
                    "count": 0
                }
            
            return {
                "min": float(np.min(all_values)),
                "max": float(np.max(all_values)),
                "mean": float(np.mean(all_values)),
                "std": float(np.std(all_values)),
                "nodata": nodata,
                "count": int(all_values.size)
            }
    
    except Exception as e:
        print(f"[METADATA] Error computing raster stats: {e}")
        return {
            "min": None,
            "max": None,
            "mean": None,
            "std": None,
            "nodata": nodata,
            "count": 0
        }


def compute_raster_bounds_4326(raster_path: Path) -> Optional[Dict[str, float]]:
    """
    Compute raster bounds in EPSG:4326.
    
    Returns:
        Dict with west, south, east, north in EPSG:4326
    """
    try:
        with rasterio.open(raster_path) as src:
            raster_crs = src.crs
            bounds = src.bounds  # (left, bottom, right, top) in raster CRS
            
            # Transform to EPSG:4326
            bounds_4326 = transform_bounds(
                raster_crs,
                "EPSG:4326",
                bounds.left,
                bounds.bottom,
                bounds.right,
                bounds.top,
                densify_pts=21
            )
            
            return {
                "west": float(bounds_4326[0]),
                "south": float(bounds_4326[1]),
                "east": float(bounds_4326[2]),
                "north": float(bounds_4326[3])
            }
    
    except Exception as e:
        print(f"[METADATA] Error computing bounds: {e}")
        return None


def compute_pixel_size(raster_path: Path) -> Optional[Tuple[float, float]]:
    """
    Compute pixel size in meters.
    
    Returns:
        Tuple of (x_resolution, y_resolution) in meters, or None
    """
    try:
        with rasterio.open(raster_path) as src:
            transform = src.transform
            crs = src.crs
            
            # Get pixel size in CRS units
            x_res = abs(transform[0])
            y_res = abs(transform[4])
            
            # If CRS is geographic (lat/lon), convert to meters
            if crs and crs.is_geographic:
                # Approximate conversion at center of raster
                center_lat = (src.bounds.top + src.bounds.bottom) / 2
                # 1 degree lat ≈ 111,320 m
                # 1 degree lon ≈ 111,320 * cos(lat) m
                lat_m = 111320.0
                lon_m = 111320.0 * np.cos(np.radians(center_lat))
                x_res_m = x_res * lon_m
                y_res_m = y_res * lat_m
                return (float(x_res_m), float(y_res_m))
            else:
                # Assume already in meters (or CRS units)
                return (float(x_res), float(y_res))
    
    except Exception as e:
        print(f"[METADATA] Error computing pixel size: {e}")
        return None


def create_raster_metadata(
    raster_path: Path,
    layer_id: str,
    title: str,
    summary: str = "",
    tags: list = None,
    credits: str = "",
    units: str = "",
    source_type: str = "raster"
) -> Dict[str, Any]:
    """
    Create metadata for a raster layer.
    
    Args:
        raster_path: Path to raster file
        layer_id: Unique layer identifier
        title: Layer title
        summary: Layer description
        tags: List of tags
        credits: Attribution/credits
        units: Data units (e.g., "percent", "meters")
        source_type: "raster" or "geopdf_upload"
    
    Returns:
        Metadata dict
    """
    # Compute stats
    stats = compute_raster_stats(raster_path)
    
    # Compute bounds
    bounds_dict = compute_raster_bounds_4326(raster_path)
    bounds_array = None
    if bounds_dict:
        bounds_array = [
            [bounds_dict["south"], bounds_dict["west"]],
            [bounds_dict["north"], bounds_dict["east"]]
        ]
    
    # Compute pixel size
    pixel_size = compute_pixel_size(raster_path)
    
    # Get CRS
    try:
        with rasterio.open(raster_path) as src:
            crs_str = str(src.crs) if src.crs else "EPSG:4326"
    except:
        crs_str = "EPSG:4326"
    
    metadata = {
        "layer_id": layer_id,
        "title": title,
        "summary": summary,
        "tags": tags or [],
        "credits": credits,
        "units": units,
        "crs": crs_str,
        "bounds": bounds_array,
        "pixel_size": list(pixel_size) if pixel_size else None,
        "stats": stats,
        "created_at": datetime.utcnow().isoformat() + "Z",
        "source_type": source_type
    }
    
    return metadata


def save_metadata(layer_id: str, metadata: Dict[str, Any]) -> bool:
    """Save metadata to layer directory."""
    try:
        layer_dir = ensure_layer_dir(layer_id)
        metadata_path = layer_dir / "metadata.json"
        
        with open(metadata_path, "w", encoding="utf-8") as f:
            json.dump(metadata, f, indent=2, ensure_ascii=False)
        
        print(f"[METADATA] Saved metadata for layer {layer_id}")
        return True
    
    except Exception as e:
        print(f"[METADATA] Error saving metadata: {e}")
        return False


def load_metadata(layer_id: str) -> Optional[Dict[str, Any]]:
    """Load metadata from layer directory."""
    try:
        layer_dir = get_layer_dir(layer_id)
        metadata_path = layer_dir / "metadata.json"
        
        if not metadata_path.exists():
            return None
        
        with open(metadata_path, "r", encoding="utf-8") as f:
            metadata = json.load(f)
        
        return metadata
    
    except Exception as e:
        print(f"[METADATA] Error loading metadata: {e}")
        return None


def cleanup_old_uploads():
    """Delete layer directories older than TTL."""
    if not LAYERS_DIR.exists():
        return
    
    now = datetime.utcnow().timestamp()
    deleted_count = 0
    
    for layer_dir in LAYERS_DIR.iterdir():
        if not layer_dir.is_dir():
            continue
        
        # Only clean up upload layers
        if not layer_dir.name.startswith("upload_"):
            continue
        
        metadata_path = layer_dir / "metadata.json"
        if not metadata_path.exists():
            # Check directory modification time
            dir_mtime = layer_dir.stat().st_mtime
            age_seconds = now - dir_mtime
            if age_seconds > UPLOAD_TTL_SECONDS:
                try:
                    shutil.rmtree(layer_dir)
                    deleted_count += 1
                    print(f"[METADATA] Cleaned up old layer: {layer_dir.name}")
                except Exception as e:
                    print(f"[METADATA] Error cleaning up {layer_dir.name}: {e}")
            continue
        
        try:
            with open(metadata_path, "r") as f:
                metadata = json.load(f)
            
            created_at_str = metadata.get("created_at", "")
            if created_at_str:
                created_at = datetime.fromisoformat(created_at_str.replace("Z", "+00:00"))
                age_seconds = now - created_at.timestamp()
                
                if age_seconds > UPLOAD_TTL_SECONDS:
                    shutil.rmtree(layer_dir)
                    deleted_count += 1
                    print(f"[METADATA] Cleaned up old layer: {layer_dir.name}")
        
        except Exception as e:
            print(f"[METADATA] Error checking {layer_dir.name}: {e}")
    
    if deleted_count > 0:
        print(f"[METADATA] Cleaned up {deleted_count} old layer directories")

