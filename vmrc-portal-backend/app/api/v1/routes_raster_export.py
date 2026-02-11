# app/api/v1/routes_raster_export.py
from fastapi import APIRouter, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel
from app.services.raster_service import clip_raster_for_layer, resolve_raster_path
from app.services.layer_metadata import compute_pixel_size
from pathlib import Path
import rasterio
from rasterio.mask import mask
from rasterio.warp import transform_geom
from rasterio.windows import from_bounds, Window
from rasterio.features import geometry_mask
from shapely.geometry import shape, mapping, Polygon, MultiPolygon
from shapely.validation import make_valid
from shapely.ops import unary_union
import numpy as np
import csv
import json
import uuid
import re
from datetime import datetime
from typing import List, Optional, Dict, Any
import base64
from io import BytesIO
import xml.etree.ElementTree as ET
import os
import zipfile
import shutil

# Try to import requests for image fetching
try:
    import requests
    HAS_REQUESTS = True
except ImportError:
    HAS_REQUESTS = False
    print("WARNING: requests not installed. Preview image embedding in PDF may not work.")

# PDF generation imports
try:
    from reportlab.lib.pagesizes import letter, A4, landscape
    from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
    from reportlab.lib.units import inch
    from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, Image, PageBreak, KeepTogether, KeepInFrame
    from reportlab.lib import colors
    from reportlab.pdfgen import canvas
    # Note: ImageReader is only for canvas.drawImage(), not for Platypus Image flowable
    # For Platypus Image, use BytesIO directly
    HAS_REPORTLAB = True
except ImportError:
    HAS_REPORTLAB = False
    print("WARNING: reportlab not installed. PDF export will not work. Install with: pip install reportlab")

router = APIRouter(tags=["export"])

class ExportRequest(BaseModel):
    raster_layer_id: int
    user_clip_geojson: dict
    formats: List[str] = []  # ["png", "tif", "csv", "geojson", "json", "pdf"]
    filename: Optional[str] = None
    context: Optional[Dict[str, Any]] = None  # UI selections for PDF report
    overlay_url: Optional[str] = None  # Optional: use existing PNG overlay instead of re-clipping
    aoi_name: Optional[str] = None  # Optional: AOI name for PDF title (e.g., "Uploaded AOI" or filename)
    overlay_urls: Optional[List[Dict[str, Any]]] = None  # Optional: array of {overlay_url, aoi_name, user_clip_geojson} for multi-AOI PDF


class PDFExportRequest(BaseModel):
    """Request model for dedicated PDF export endpoint."""
    raster_layer_id: int
    user_clip_geojson: dict
    filename: Optional[str] = None  # Auto-generated if not provided
    context: Optional[Dict[str, Any]] = None  # UI selections: mapType, species, condition, month, coverPercent, etc.
    aoi_name: Optional[str] = None  # Optional: AOI name for report header
    overlay_url: Optional[str] = None  # Optional: use existing PNG overlay (must include stats in context)
    stats: Optional[Dict[str, Any]] = None  # Optional: pre-computed stats (if overlay_url is provided)


def sanitize_filename(name: str) -> str:
    """Remove dangerous characters from filename."""
    if not name:
        return ""
    # Replace spaces and slashes with underscores, remove other dangerous chars
    name = re.sub(r'[^\w\-_\.]', '_', name)
    # Remove consecutive underscores
    name = re.sub(r'_+', '_', name)
    return name.strip('_')


def generate_default_filename() -> str:
    """Generate a safe default filename with timestamp."""
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    return f"vmrc_export_{timestamp}"


def expand_map_type(map_type: str) -> str:
    """Expand map type abbreviations to full names."""
    if not map_type:
        return ""
    map_type_lower = str(map_type).lower()
    if map_type_lower == "hsl":
        return "High Stress Level"
    elif map_type_lower == "mortality":
        return "Mortality (Monthly)"
    return str(map_type).title()


def expand_condition(condition: str) -> str:
    """Expand condition abbreviations to full names."""
    if not condition:
        return ""
    cond_upper = str(condition).upper()
    if cond_upper == "D" or cond_upper == "DRY":
        return "Dry"
    elif cond_upper == "W" or cond_upper == "WET":
        return "Wet"
    elif cond_upper == "N" or cond_upper == "NORMAL":
        return "Normal"
    return str(condition).title()


def get_stress_display_name(stress_code: str) -> str:
    """Convert stress code to display name (no 'Stress' in option text, no acronyms)."""
    stress_map = {
        "l": "Low",
        "ml": "Medium-low",
        "m": "Medium",
        "mh": "Medium-high",
        "h": "High",
        "vh": "Very High"
    }
    return stress_map.get((stress_code or "").lower(), str(stress_code) if stress_code else "")


def format_report_selections(context: Optional[Dict[str, Any]]) -> List[tuple]:
    """
    Build Raster/Selection Summary rows for PDF: list of (label, value) in required order.
    Uses UI filter titles; values are display names (no D/W/N, no acronyms).
    Western hemlock: drought resistance shows only "Medium (only option for Western hemlock)".
    """
    if not context:
        return []
    rows = []
    species_raw = context.get("species", "")
    species_display = "Douglas-fir" if species_raw == "Douglas-fir" else "Western hemlock" if species_raw == "Western Hemlock" else (species_raw or "—")
    is_wh = (species_raw or "").lower() in ("western hemlock", "wh")

    # 1) Species
    rows.append(("Species", species_display))

    # 2) Seedling Drought Resistance Category (WH: only Medium; DF: full name, optionally with PLC when available)
    hsl_class = context.get("hslClass") or context.get("stressLevel") or ""
    if is_wh:
        drought_display = "Medium (only option for Western hemlock)"
    else:
        drought_display = get_stress_display_name(hsl_class) if hsl_class else "—"
        plc_mpa = context.get("plcMpa") or context.get("plc_mpa")
        if drought_display and plc_mpa is not None:
            drought_display = f"{drought_display} (PLC 2.5 = {plc_mpa} MPa)"
    rows.append(("Seedling Drought Resistance Category", drought_display))

    # 3) Time of the Year
    map_type = (context.get("mapType") or context.get("product") or "").lower()
    if map_type == "hsl":
        time_display = "High Stress Level"
    else:
        month = context.get("month", "")
        time_display = get_month_name(month) if month else "—"
    rows.append(("Time of the Year", time_display))

    # 4) Climate Scenario (Normal, Dry, Wet — no D/W/N)
    cond = context.get("condition") or context.get("hslCondition") or ""
    climate_display = expand_condition(cond) if cond else "—"
    rows.append(("Climate Scenario", climate_display))

    # 5) Maximum Vegetation Cover (%)
    cover = context.get("coverPercent")
    rows.append(("Maximum Vegetation Cover (%)", str(cover) if cover is not None and cover != "" else "—"))

    return rows


def get_month_name(month_code: str) -> str:
    """Convert month code (04-09) to month name."""
    month_map = {
        "04": "April",
        "05": "May",
        "06": "June",
        "07": "July",
        "08": "August",
        "09": "September"
    }
    return month_map.get(month_code, f"Month {month_code}")


def get_raster_base_filename(raster_layer_id: int) -> str:
    """
    Get the base filename from the actual raster file (matches Raster Overview).
    
    Extracts the filename from the raster path and strips the extension.
    Example: "HSL2.5_DF_50_D_l.tif" -> "HSL2.5_DF_50_D_l"
    
    Args:
        raster_layer_id: ID of the raster layer
    
    Returns:
        Sanitized base filename (without extension)
    """
    try:
        raster_path = resolve_raster_path(raster_layer_id)
        raster_filename = Path(raster_path).name
        # Strip extension (e.g., "HSL2.5_DF_50_D_l.tif" -> "HSL2.5_DF_50_D_l")
        base_name = Path(raster_filename).stem
        print(f"[EXPORT FILENAME] Raster path: {raster_path}")
        print(f"[EXPORT FILENAME] Raster filename: {raster_filename}")
        print(f"[EXPORT FILENAME] Base name (no extension): {base_name}")
        # Sanitize for Windows (remove spaces, slashes, colons) but preserve structure
        sanitized = sanitize_filename(base_name)
        return sanitized
    except Exception as e:
        print(f"[EXPORT FILENAME] Warning: Could not get raster filename: {e}")
        return generate_default_filename()


def build_export_filename(context: Optional[Dict[str, Any]], extension: str = "") -> str:
    """
    Build export filename from context filters with specific rules:
    
    Pattern: ${mapTypeCode}_${speciesCode}_${conditionCode}_Cover${cover}${classPart}${monthPart}
    
    Rules:
    - If mapType === "HSL" -> DO NOT include month
    - If species === "WH" -> DO NOT include class
    
    Args:
        context: Dictionary with mapType, species, condition, month, coverPercent, hslClass
        extension: File extension (e.g., ".pdf", ".png", ".tif") - will be added if not empty
    
    Returns:
        Sanitized filename string
    """
    if not context:
        return generate_default_filename() + extension
    
    # Extract and normalize values (support both legacy mapType and new product + month)
    map_type = str(context.get("mapType", "")).upper()
    if not map_type and context.get("product"):
        map_type = str(context.get("product", "")).upper()
    species = context.get("species", "")
    condition = context.get("condition", "")
    hsl_condition = context.get("hslCondition", "")
    month = context.get("month")  # None or omitted for HSL; "04"-"09" for MORTALITY
    cover_percent = context.get("coverPercent")
    hsl_class = context.get("hslClass")
    
    # Debug: Log all input values
    print(f"[EXPORT FILENAME] Input filters:")
    print(f"  mapType: {map_type}")
    print(f"  species: {species}")
    print(f"  condition: {condition}")
    print(f"  hslCondition: {hsl_condition}")
    print(f"  month: {month}")
    print(f"  coverPercent: {cover_percent}")
    print(f"  hslClass: {hsl_class}")
    
    filename_parts = []
    
    # 1. Map type code
    if map_type == "HSL" or map_type == "HIGH STRESS LEVEL":
        map_type_code = "HSL"
    elif map_type == "MORTALITY":
        map_type_code = "MORTALITY"
    elif map_type:
        map_type_code = map_type
    else:
        map_type_code = None
    
    if map_type_code:
        filename_parts.append(map_type_code)
    
    # 2. Species code
    species_code = None
    if species:
        if species == "Douglas-fir":
            species_code = "DF"
        elif species == "Western Hemlock":
            species_code = "WH"
        else:
            # Use first 2-3 letters of species name
            species_code = species.replace(" ", "").replace("-", "")[:3].upper()
    
    if species_code:
        filename_parts.append(species_code)
    
    # 3. Condition code (use full names: DRY/WET/NORMAL for consistency)
    condition_code = None
    if map_type == "HSL" and hsl_condition:
        # Map HSL condition codes to full names
        cond_map = {"D": "DRY", "W": "WET", "N": "NORMAL", "DRY": "DRY", "WET": "WET", "NORMAL": "NORMAL"}
        condition_code = cond_map.get(str(hsl_condition).upper(), "DRY")  # Default to DRY if unknown
    elif condition:
        # Mortality uses full condition names
        condition_upper = str(condition).upper()
        if condition_upper in ["DRY", "D"]:
            condition_code = "DRY"
        elif condition_upper in ["WET", "W"]:
            condition_code = "WET"
        elif condition_upper in ["NORMAL", "N"]:
            condition_code = "NORMAL"
        else:
            condition_code = condition_upper[:4]
    
    if condition_code:
        filename_parts.append(condition_code)
    
    # 4. Cover percent
    if cover_percent:
        filename_parts.append(f"Cover{cover_percent}")
    
    # 5. Class part (ONLY if species !== "WH" and class is present)
    class_part = ""
    if species_code != "WH" and hsl_class:
        # Map class codes to standard format
        class_map = {
            "l": "ClassI", "L": "ClassI",
            "ml": "ClassII", "ML": "ClassII",
            "m": "ClassIII", "M": "ClassIII",
            "mh": "ClassIV", "MH": "ClassIV",
            "h": "ClassV", "H": "ClassV",
            "vh": "ClassVI", "VH": "ClassVI"
        }
        class_code = class_map.get(str(hsl_class), f"Class{hsl_class}")
        class_part = f"_{class_code}"
    
    # 6. Month part (ONLY if mapType !== "HSL" and month is present)
    month_part = ""
    if map_type != "HSL" and month:
        month_str = str(month)
        # Format as M04, M05, etc. (zero-padded 2 digits)
        if month_str.isdigit():
            month_code = f"M{month_str.zfill(2)}"
        else:
            month_code = f"M{month_str}"
        month_part = f"_{month_code}"
    
    # Build base filename
    base_name = "_".join(filename_parts) + class_part + month_part
    
    if not base_name or base_name == class_part + month_part:
        base_name = generate_default_filename()
    
    # Debug: Log computed parts
    print(f"[EXPORT FILENAME] Computed parts:")
    print(f"  mapTypeCode: {map_type_code}")
    print(f"  speciesCode: {species_code}")
    print(f"  conditionCode: {condition_code}")
    print(f"  cover: Cover{cover_percent if cover_percent else 'N/A'}")
    print(f"  classPart: {class_part if class_part else '(omitted - species is WH)' if species_code == 'WH' else '(omitted - no class)'}")
    print(f"  monthPart: {month_part if month_part else '(omitted - mapType is HSL)' if map_type == 'HSL' else '(omitted - no month)'}")
    print(f"[EXPORT FILENAME] Final base name: {base_name}")
    
    # Sanitize and add extension
    sanitized = sanitize_filename(base_name)
    if extension and not sanitized.endswith(extension):
        sanitized += extension
    
    return sanitized


def build_human_readable_raster_label(context: Optional[Dict[str, Any]]) -> str:
    """
    Build human-readable raster label from context.
    Format: High Stress Level – {Species} – {Condition} – Month {MM} – Cover {XX}% – Class {I/II/etc}
    """
    if not context:
        return "Raster"
    
    parts = []
    
    # Map Type (support both mapType and product)
    map_type = context.get("mapType", "") or (context.get("product") or "").lower()
    if map_type == "hsl":
        parts.append("High Stress Level")
    elif map_type == "mortality":
        parts.append("Mortality")
    
    # Species
    species = context.get("species", "")
    if species:
        parts.append(species)
    
    # Condition
    condition = context.get("condition", "")
    hsl_condition = context.get("hslCondition", "")
    if map_type == "hsl" and hsl_condition:
        cond_map = {"D": "Dry", "W": "Wet", "N": "Normal"}
        parts.append(cond_map.get(hsl_condition, hsl_condition))
    elif condition:
        parts.append(condition)
    
    # Month (for Mortality)
    if map_type == "mortality":
        month = context.get("month", "")
        if month:
            parts.append(get_month_name(month))
    
    # Stress Level / Class
    df_stress = context.get("dfStress", "")
    hsl_class = context.get("hslClass", "")
    if map_type == "mortality" and df_stress:
        # Extract stress code from dfStress (e.g., "Low Stress" -> "l")
        stress_code = ""
        if "Low Stress" in df_stress:
            stress_code = "l"
        elif "Medium-Low Stress" in df_stress:
            stress_code = "ml"
        elif "Medium Stress" in df_stress:
            stress_code = "m"
        elif "Medium-High Stress" in df_stress:
            stress_code = "mh"
        elif "High Stress" in df_stress:
            stress_code = "h"
        elif "Very High Stress" in df_stress:
            stress_code = "vh"
        if stress_code:
            parts.append(get_stress_display_name(stress_code))
    elif map_type == "hsl" and hsl_class:
        parts.append(get_stress_display_name(hsl_class))
    
    # Cover Percent
    cover_percent = context.get("coverPercent", "")
    if cover_percent:
        parts.append(f"Cover {cover_percent}%")
    
    # Class (for HSL)
    if map_type == "hsl" and hsl_class:
        # Map class codes to Roman numerals or class names
        class_map = {
            "l": "Class I",
            "ml": "Class II",
            "m": "Class III",
            "mh": "Class IV",
            "h": "Class V",
            "vh": "Class VI"
        }
        class_label = class_map.get(hsl_class.lower(), f"Class {hsl_class}")
        # Only add if not already added as stress level
        if not any("Class" in p for p in parts):
            parts.append(class_label)
    
    return " – ".join(parts) if parts else "Raster"


def get_histogram_bin_ranges() -> List[str]:
    """Get histogram bin range labels with en dash (prevents Excel auto-formatting)."""
    return ["10", "20", "30", "40", "50",
            "60", "70", "80", "90", "100"]


def compute_expanded_stats(stats: Dict[str, Any], histogram: Optional[Dict[str, Any]] = None, valid_pixels: Optional[np.ndarray] = None) -> Dict[str, Any]:
    """
    Compute expanded statistics matching the UI cards:
    - Area by Threshold (High >=70, Moderate-High >=50, Low <=30)
    - Most Common Value Range (Dominant Range + Coverage %)
    
    Args:
        stats: Basic stats dict with min, max, mean, std, count
        histogram: Optional histogram dict with bins, counts, percentages
        valid_pixels: Optional numpy array of valid pixel values (if histogram not available)
    
    Returns:
        Expanded stats dict with threshold areas and dominant range
    """
    expanded = {}
    
    # Get pixel counts for thresholds
    if histogram and "counts" in histogram:
        # Use histogram counts (10 bins: 0-10, 10-20, ..., 90-100)
        bin_counts = np.array(histogram["counts"])
        total_pixels = histogram.get("total_valid_pixels", bin_counts.sum())
        
        # Threshold calculations based on bin ranges
        # High >= 70: bins 7, 8, 9 (70-80, 80-90, 90-100)
        high_count = bin_counts[7:].sum() if len(bin_counts) >= 10 else 0
        high_percent = (high_count / total_pixels * 100) if total_pixels > 0 else 0
        
        # Moderate-High >= 50: bins 5, 6, 7, 8, 9 (50-60, 60-70, 70-80, 80-90, 90-100)
        moderate_high_count = bin_counts[5:].sum() if len(bin_counts) >= 10 else 0
        moderate_high_percent = (moderate_high_count / total_pixels * 100) if total_pixels > 0 else 0
        
        # Low <= 30: bins 0, 1, 2, 3 (0-10, 10-20, 20-30, 30-40)
        low_count = bin_counts[:4].sum() if len(bin_counts) >= 4 else 0
        low_percent = (low_count / total_pixels * 100) if total_pixels > 0 else 0
        
        # Most Common Value Range (dominant bin)
        dominant_bin_idx = int(np.argmax(bin_counts))
        bin_ranges = get_histogram_bin_ranges()
        dominant_range = bin_ranges[dominant_bin_idx] if dominant_bin_idx < len(bin_ranges) else "Unknown"
        dominant_count = int(bin_counts[dominant_bin_idx])
        dominant_percent = (dominant_count / total_pixels * 100) if total_pixels > 0 else 0
        
        expanded["area_by_threshold"] = {
            "high": {"count": int(high_count), "percent": float(high_percent)},
            "moderate_high": {"count": int(moderate_high_count), "percent": float(moderate_high_percent)},
            "low": {"count": int(low_count), "percent": float(low_percent)},
        }
        expanded["most_common_range"] = {
            "range": dominant_range,
            "count": int(dominant_count),
            "percent": float(dominant_percent),
        }
        # Area by Mortality Class (5 bins: 0-20, 20-40, 40-60, 60-80, 80-100) for one-page PDF
        # Bins 0-1 -> 0-20, 2-3 -> 20-40, 4-5 -> 40-60, 6-7 -> 60-80, 8-9 -> 80-100
        total_px = float(total_pixels)
        expanded["area_by_mortality_class"] = []
        for start, end, (i0, i1) in [(0, 20, (0, 2)), (20, 40, (2, 4)), (40, 60, (4, 6)), (60, 80, (6, 8)), (80, 100, (8, 10))]:
            c = int(bin_counts[i0:i1].sum()) if len(bin_counts) >= i1 else 0
            pct = (c / total_px * 100) if total_px > 0 else 0.0
            expanded["area_by_mortality_class"].append({"range": f"{start}-{end}", "count": c, "percent": pct})
    elif valid_pixels is not None and len(valid_pixels) > 0:
        # Compute from pixel values directly
        total_pixels = len(valid_pixels)
        
        high_count = np.sum(valid_pixels >= 70)
        moderate_high_count = np.sum(valid_pixels >= 50)
        low_count = np.sum(valid_pixels <= 30)
        
        high_percent = (high_count / total_pixels * 100) if total_pixels > 0 else 0
        moderate_high_percent = (moderate_high_count / total_pixels * 100) if total_pixels > 0 else 0
        low_percent = (low_count / total_pixels * 100) if total_pixels > 0 else 0
        
        # Most common range: find which bin has most pixels
        bin_counts = np.zeros(10, dtype=int)
        for v in valid_pixels:
            clamped = max(0, min(100, v))
            idx = 9 if clamped == 100 else max(0, min(9, int(np.floor(clamped / 10))))
            bin_counts[idx] += 1
        
        dominant_bin_idx = int(np.argmax(bin_counts))
        bin_ranges = get_histogram_bin_ranges()
        dominant_range = bin_ranges[dominant_bin_idx] if dominant_bin_idx < len(bin_ranges) else "Unknown"
        dominant_count = int(bin_counts[dominant_bin_idx])
        dominant_percent = (dominant_count / total_pixels * 100) if total_pixels > 0 else 0
        
        expanded["area_by_threshold"] = {
            "high": {"count": int(high_count), "percent": float(high_percent)},
            "moderate_high": {"count": int(moderate_high_count), "percent": float(moderate_high_percent)},
            "low": {"count": int(low_count), "percent": float(low_percent)},
        }
        expanded["most_common_range"] = {
            "range": dominant_range,
            "count": int(dominant_count),
            "percent": float(dominant_percent),
        }
        # Area by Mortality Class (5 bins) from bin_counts
        total_px = float(total_pixels)
        expanded["area_by_mortality_class"] = []
        for start, end, (i0, i1) in [(0, 20, (0, 2)), (20, 40, (2, 4)), (40, 60, (4, 6)), (60, 80, (6, 8)), (80, 100, (8, 10))]:
            c = int(bin_counts[i0:i1].sum())
            pct = (c / total_px * 100) if total_px > 0 else 0.0
            expanded["area_by_mortality_class"].append({"range": f"{start}-{end}", "count": c, "percent": pct})
    else:
        # Fallback: set defaults
        expanded["area_by_threshold"] = {
            "high": {"count": 0, "percent": 0.0},
            "moderate_high": {"count": 0, "percent": 0.0},
            "low": {"count": 0, "percent": 0.0},
        }
        expanded["most_common_range"] = {
            "range": "Unknown",
            "count": 0,
            "percent": 0.0,
        }
        expanded["area_by_mortality_class"] = [
            {"range": "0-20", "count": 0, "percent": 0.0},
            {"range": "20-40", "count": 0, "percent": 0.0},
            {"range": "40-60", "count": 0, "percent": 0.0},
            {"range": "60-80", "count": 0, "percent": 0.0},
            {"range": "80-100", "count": 0, "percent": 0.0},
        ]
    
    return expanded


def render_clipped_preview_png(raster_layer_id: int, user_clip_geojson: dict) -> bytes:
    """
    Generate PNG preview of clipped raster (same as map overlay).
    
    This function reuses clip_raster_for_layer() to generate the same PNG
    that's used in the UI, ensuring colors and classification match exactly.
    
    Args:
        raster_layer_id: ID of the raster layer to clip
        user_clip_geojson: GeoJSON polygon defining the AOI (EPSG:4326)
    
    Returns:
        PNG image bytes (RGBA with transparency)
    
    Raises:
        ValueError: If PNG generation fails
    """
    from app.services.raster_service import clip_raster_for_layer
    
    print(f"[PNG PREVIEW] Generating clipped raster preview for layer {raster_layer_id}...")
    
    try:
        # Use clip_raster_for_layer to get the same PNG as the UI
        clip_result = clip_raster_for_layer(
            raster_layer_id=raster_layer_id,
            user_clip_geojson=user_clip_geojson,
            zoom=None  # Use native resolution for PDF
        )
        
        # Extract PNG overlay URL
        overlay_url = clip_result.get("overlay_url", "")
        if not overlay_url:
            raise ValueError("clip_raster_for_layer did not return overlay_url")
        
        # Load PNG bytes from file
        overlay_filename = Path(overlay_url).name
        overlay_path = Path("static/overlays") / overlay_filename
        
        if not overlay_path.exists():
            raise ValueError(f"PNG overlay file not found: {overlay_path}")
        
        with open(overlay_path, "rb") as f:
            png_bytes = f.read()
        
        print(f"[PNG PREVIEW] ✓ Generated PNG preview ({len(png_bytes)} bytes)")
        return png_bytes
        
    except Exception as e:
        error_msg = f"Failed to generate PNG preview: {str(e)}"
        print(f"[PNG PREVIEW] ERROR: {error_msg}")
        import traceback
        traceback.print_exc()
        raise ValueError(error_msg)


# Product name for metadata: VMRC = Vegetation Management Research Cooperative, SMS = Seedling Mortality Simulator
VMRC_PRODUCT_NAME = "VMRC (Vegetation Management Research Cooperative) Seedling Mortality Simulator (SMS)"
VMRC_CREDITS = "Vegetation Management Research Cooperative (VMRC) - Seedling Mortality Simulator (SMS)"


def build_arcgis_metadata(context: Optional[Dict[str, Any]], raster_name: str) -> Dict[str, str]:
    """
    Build ArcGIS-readable metadata tags from context and raster information.
    Uses VMRC = Vegetation Management Research Cooperative, Seedling Mortality Simulator (SMS).
    
    Args:
        context: Filter selections from the UI
        raster_name: Name of the raster file
        
    Returns:
        Dictionary of GDAL metadata tags for ArcGIS
    """
    context = context or {}
    
    # Title: concise dataset title
    map_type = expand_map_type(context.get("mapType", ""))
    species = context.get("species", "Unknown Species")
    title_parts = []
    if map_type:
        title_parts.append(map_type)
    title_parts.append(species)
    if context.get("month"):
        title_parts.append(f"Month {context.get('month')}")
    title = " - ".join(title_parts) if title_parts else raster_name
    
    # Summary (idAbs): short abstract, one or two sentences
    summary_parts = []
    if map_type:
        summary_parts.append(f"This dataset represents {map_type.lower()} data for {species}.")
    condition = expand_condition(context.get("condition", ""))
    if condition:
        summary_parts.append(f"Climate condition: {condition}.")
    if context.get("coverPercent"):
        summary_parts.append(f"Cover percentage: {context.get('coverPercent')}%.")
    summary = " ".join(summary_parts) if summary_parts else f"{VMRC_PRODUCT_NAME} output: {raster_name}"
    
    # Description (idPurp): product name then structured parameters
    desc_lines = [
        "Product: " + VMRC_PRODUCT_NAME,
        "",
        "Dataset parameters:",
    ]
    for label, value in format_report_selections(context):
        if value and value != "—":
            desc_lines.append(f"  {label} {value}")
    description = "\n".join(desc_lines)
    
    # Keywords: include full product acronym and SMS for discoverability
    tags_list = ["VMRC", "Vegetation Management Research Cooperative", "Seedling Mortality Simulator", "SMS"]
    if map_type:
        if "Mortality" in map_type:
            tags_list.append("Mortality")
        if "High Stress Level" in map_type or "HSL" in map_type:
            tags_list.append("HSL")
    if species:
        species_tag = species.replace(" ", "_").replace("-", "_")
        tags_list.append(species_tag)
    if condition:
        tags_list.append(condition)
    if context.get("coverPercent"):
        tags_list.append(f"Cover_{context.get('coverPercent')}%")
    tags = ", ".join(tags_list)
    
    return {
        "TITLE": title,
        "SUMMARY": summary,
        "DESCRIPTION": description,
        "TAGS": tags,
        "CREDITS": VMRC_CREDITS,
        "USE_LIMITATIONS": "For research and visualization purposes only.",
    }


def write_arcgis_metadata(tif_path: Path, metadata: Dict[str, str]) -> None:
    """
    Write ArcGIS-readable metadata tags to a GeoTIFF file.
    
    ArcGIS reads metadata from multiple sources. We write:
    1. Standard TIFF tags (TIFFTAG_DOCUMENTNAME, TIFFTAG_IMAGEDESCRIPTION)
    2. GDAL domain tags (for compatibility with other tools)
    
    Note: ArcGIS may require clicking "Copy data source's metadata to this layer"
    button in the Metadata tab to populate the fields, or may need metadata
    synchronization.
    
    Args:
        tif_path: Path to the GeoTIFF file
        metadata: Dictionary of metadata tags to write
    """
    try:
        print(f"[EXPORT] Writing ArcGIS metadata to {tif_path}...")
        # Open in "r+" mode to update existing file
        with rasterio.open(str(tif_path), "r+") as dst:
            all_tags = {}
            
            # 1. Write standard TIFF tags that ArcGIS recognizes
            # These are the primary tags ArcGIS reads
            if "TITLE" in metadata:
                title = str(metadata["TITLE"])
                if len(title) > 200:
                    title = title[:200] + "..."
                all_tags["TIFFTAG_DOCUMENTNAME"] = title
                print(f"[EXPORT] Writing TITLE as TIFFTAG_DOCUMENTNAME: {title[:50]}...")
            
            if "DESCRIPTION" in metadata:
                desc = str(metadata["DESCRIPTION"])
                if len(desc) > 65000:
                    desc = desc[:65000] + "..."
                all_tags["TIFFTAG_IMAGEDESCRIPTION"] = desc
                print(f"[EXPORT] Writing DESCRIPTION as TIFFTAG_IMAGEDESCRIPTION: {len(desc)} chars")
            
            # 2. Write all metadata to GDAL domain (for other tools and as fallback)
            for key, value in metadata.items():
                value_str = str(value)
                if len(value_str) > 65000:
                    value_str = value_str[:65000] + "..."
                all_tags[key] = value_str
            
            # Update all tags
            dst.update_tags(**all_tags)
            
            print(f"[EXPORT] Written metadata tags: {list(metadata.keys())}")
            print(f"[EXPORT] Total tags written: {len(all_tags)}")
            print(f"[EXPORT] Note: In ArcGIS, you may need to click 'Copy data source's metadata to this layer'")
            print(f"[EXPORT]      button in the Metadata tab to populate the fields.")
            
        print(f"[EXPORT] ✓ ArcGIS metadata written successfully")
    except Exception as e:
        print(f"[EXPORT] Warning: Failed to write ArcGIS metadata: {e}")
        import traceback
        traceback.print_exc()
        # Don't fail the export if metadata writing fails


def write_arcgis_tif_xml(tif_path: Path, metadata: Dict[str, str]) -> Optional[str]:
    """
    Write ArcGIS-readable XML metadata sidecar file (<name>.tif.xml).
    
    ArcGIS automatically reads sidecar XML files with the exact name pattern:
    - 55.tif -> 55.tif.xml (NOT 55.tif.aux.xml)
    
    This function creates an XML file following ArcGIS ESRI metadata profile structure.
    
    Args:
        tif_path: Path to the GeoTIFF file (e.g., "raster.tif")
        metadata: Dictionary with keys: TITLE, SUMMARY, DESCRIPTION, TAGS, CREDITS, USE_LIMITATIONS
    
    Returns:
        Path to the created XML file as string, or None if creation failed
    """
    try:
        # Log input path
        print(f"[EXPORT] ===== ArcGIS XML Metadata Creation =====")
        print(f"[EXPORT] Input tif_path: {tif_path}")
        print(f"[EXPORT] tif_path type: {type(tif_path)}")
        print(f"[EXPORT] tif_path absolute: {tif_path.resolve()}")
        
        # Ensure we create <name>.tif.xml (not <name>.tif.aux.xml)
        # If tif_path is "path/to/55.tif", xml_path should be "path/to/55.tif.xml"
        # Use string concatenation to ensure correct naming
        tif_path_str = str(tif_path)
        xml_path_str = tif_path_str + ".xml"
        xml_path = Path(xml_path_str)
        
        print(f"[EXPORT] Computed xml_path: {xml_path}")
        print(f"[EXPORT] xml_path absolute: {xml_path.resolve()}")
        print(f"[EXPORT] xml_path parent: {xml_path.parent}")
        print(f"[EXPORT] xml_path name: {xml_path.name}")
        
        # Verify we're not creating double extensions
        if xml_path.name.endswith(".xml.xml"):
            raise ValueError(f"Double extension detected: {xml_path.name}")
        
        # Verify we're creating .tif.xml (not just .xml)
        if not xml_path.name.endswith(".tif.xml"):
            print(f"[EXPORT] WARNING: XML filename does not end with .tif.xml: {xml_path.name}")
        
        print(f"[EXPORT] Writing ArcGIS XML metadata to {xml_path}...")
        
        # Create root element with ArcGIS ESRI metadata namespace
        # ArcGIS reads this specific structure for metadata import
        root = ET.Element("metadata")
        root.set("xmlns", "http://www.esri.com/metadata/")
        root.set("xmlns:esri", "http://www.esri.com/metadata/")
        root.set("xmlns:gml", "http://www.opengis.net/gml")
        root.set("xmlns:xlink", "http://www.w3.org/1999/xlink")
        root.set("xmlns:xsi", "http://www.w3.org/2001/XMLSchema-instance")
        root.set("xsi:schemaLocation", "http://www.esri.com/metadata/ http://www.esri.com/metadata/esriprof80.xsd")
        
        # DataIdInfo section (main metadata container for ArcGIS)
        data_id_info = ET.SubElement(root, "dataIdInfo")
        
        # Title (resTitle)
        if metadata.get("TITLE"):
            id_citation = ET.SubElement(data_id_info, "idCitation")
            res_title = ET.SubElement(id_citation, "resTitle")
            res_title.text = str(metadata["TITLE"]).strip()
        
        # Summary/Abstract (idAbs)
        if metadata.get("SUMMARY"):
            id_abs = ET.SubElement(data_id_info, "idAbs")
            id_abs.text = str(metadata["SUMMARY"]).strip()
        
        # Description/Purpose (idPurp)
        if metadata.get("DESCRIPTION"):
            id_purp = ET.SubElement(data_id_info, "idPurp")
            id_purp.text = str(metadata["DESCRIPTION"]).strip()
        
        # Tags/Keywords (searchKeys)
        if metadata.get("TAGS"):
            search_keys = ET.SubElement(data_id_info, "searchKeys")
            keyword = ET.SubElement(search_keys, "keyword")
            keyword.text = str(metadata["TAGS"]).strip()
        
        # Credits (idCredit)
        if metadata.get("CREDITS"):
            id_credit = ET.SubElement(data_id_info, "idCredit")
            id_credit.text = str(metadata["CREDITS"]).strip()
        
        # Use Limitations (resConst/useLimit)
        if metadata.get("USE_LIMITATIONS"):
            res_const = ET.SubElement(data_id_info, "resConst")
            consts = ET.SubElement(res_const, "Consts")
            use_limit = ET.SubElement(consts, "useLimit")
            use_limit.text = str(metadata["USE_LIMITATIONS"]).strip()
        
        # Create XML tree and write to file
        tree = ET.ElementTree(root)
        
        # Format with indentation for readability (Python 3.9+)
        try:
            ET.indent(tree, space="  ")
        except AttributeError:
            # ET.indent not available in Python < 3.9, skip indentation
            pass
        
        # Write to file with UTF-8 encoding and proper XML declaration
        print(f"[EXPORT] Writing XML file to disk...")
        tree.write(
            xml_path,
            encoding="utf-8",
            xml_declaration=True,
            method="xml"
        )
        
        # Verify file was created
        xml_path_abs = xml_path.resolve()
        file_exists = os.path.exists(xml_path_abs)
        file_size = os.path.getsize(xml_path_abs) if file_exists else 0
        
        print(f"[EXPORT] ===== Verification =====")
        print(f"[EXPORT] XML file path (absolute): {xml_path_abs}")
        print(f"[EXPORT] os.path.exists(xml_path): {file_exists}")
        print(f"[EXPORT] File size: {file_size} bytes")
        print(f"[EXPORT] File naming: {tif_path.name} -> {xml_path.name}")
        
        if not file_exists:
            raise FileNotFoundError(f"XML file was not created: {xml_path_abs}")
        
        if file_size == 0:
            raise ValueError(f"XML file is empty: {xml_path_abs}")
        
        print(f"[EXPORT] ✓ ArcGIS XML metadata written successfully: {xml_path}")
        print(f"[EXPORT] =================================")
        
        return str(xml_path)
        
    except Exception as e:
        print(f"[EXPORT] ERROR: Failed to write ArcGIS XML metadata: {e}")
        import traceback
        traceback.print_exc()
        print(f"[EXPORT] =================================")
        # Don't fail the export if XML metadata writing fails
        return None


def create_tif_zip(tif_path: Path, zip_path: Path) -> bool:
    """
    Create a ZIP file containing the GeoTIFF and its associated metadata files.
    
    Includes:
    - The .tif file
    - The .tif.xml metadata file (if exists)
    - Any .aux.xml files (if exists)
    
    Args:
        tif_path: Path to the GeoTIFF file
        zip_path: Path where the ZIP file should be created
        
    Returns:
        True if zip was created successfully, False otherwise
    """
    try:
        print(f"[EXPORT] Creating ZIP archive: {zip_path}")
        
        with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as zipf:
            # Add the main .tif file
            if tif_path.exists():
                zipf.write(tif_path, tif_path.name)
                print(f"[EXPORT] Added to ZIP: {tif_path.name}")
            else:
                print(f"[EXPORT] WARNING: TIF file not found: {tif_path}")
                return False
            
            # Add .tif.xml metadata file (ArcGIS sidecar)
            xml_path = Path(str(tif_path) + ".xml")
            if xml_path.exists():
                zipf.write(xml_path, xml_path.name)
                print(f"[EXPORT] Added to ZIP: {xml_path.name}")
            else:
                print(f"[EXPORT] Note: XML metadata file not found: {xml_path}")
            
            # Add .aux.xml file if it exists (GDAL auxiliary file)
            aux_xml_path = Path(str(tif_path) + ".aux.xml")
            if aux_xml_path.exists():
                zipf.write(aux_xml_path, aux_xml_path.name)
                print(f"[EXPORT] Added to ZIP: {aux_xml_path.name}")
        
        # Verify zip was created
        if zip_path.exists() and zip_path.stat().st_size > 0:
            zip_size = zip_path.stat().st_size
            print(f"[EXPORT] ✓ ZIP archive created successfully: {zip_path.name} ({zip_size:,} bytes)")
            return True
        else:
            print(f"[EXPORT] ERROR: ZIP file was not created or is empty")
            return False
            
    except Exception as e:
        print(f"[EXPORT] ERROR: Failed to create ZIP archive: {e}")
        import traceback
        traceback.print_exc()
        return False


def fetch_image_as_base64(image_url: str, base_url: str = "http://127.0.0.1:8000") -> Optional[str]:
    """
    Fetch an image from URL and convert to base64 data URL.
    
    Args:
        image_url: Relative or absolute URL to the image
        base_url: Base URL to prepend if image_url is relative
        
    Returns:
        Base64 data URL string (e.g., "data:image/png;base64,...") or None if failed
    """
    if not HAS_REQUESTS:
        print(f"[EXPORT] Warning: requests library not available, cannot fetch image from URL")
        return None
    
    try:
        # Handle relative URLs
        if image_url.startswith("/"):
            full_url = f"{base_url}{image_url}"
        elif not image_url.startswith("http"):
            full_url = f"{base_url}/{image_url}"
        else:
            full_url = image_url
        
        print(f"[EXPORT] Fetching image from: {full_url}")
        
        # Fetch the image
        response = requests.get(full_url, timeout=10)
        response.raise_for_status()
        
        # Determine content type
        content_type = response.headers.get("Content-Type", "image/png")
        if not content_type.startswith("image/"):
            content_type = "image/png"
        
        # Convert to base64
        image_data = base64.b64encode(response.content).decode("utf-8")
        data_url = f"data:{content_type};base64,{image_data}"
        
        print(f"[EXPORT] Successfully converted image to base64 (size: {len(image_data)} chars)")
        return data_url
    except Exception as e:
        print(f"[EXPORT] Warning: Failed to fetch image as base64: {e}")
        return None


# Max length for any text turned into a PDF Paragraph to prevent LayoutError from huge content
PDF_MAX_TEXT_LEN = 500
ACRES_PER_SQ_M = 1.0 / 4046.8564224


def safe_text_for_pdf(value: Any, max_len: int = PDF_MAX_TEXT_LEN) -> str:
    """
    Sanitize a value for use in a PDF Paragraph/Table cell. Never pass through
    full GeoJSON, request JSON, or report_json to avoid infinite-height cells.
    Logs length to help prevent regressions.
    """
    if value is None:
        return "—"
    if isinstance(value, (dict, list)):
        # Summarize only (e.g. "3 vertices", "2 features") — never render raw JSON
        if isinstance(value, list):
            summary = f"({len(value)} items)"
        else:
            keys = list(value.keys())[:5]
            summary = f"({len(value)} keys: {', '.join(str(k) for k in keys)}…)"
        text = summary
    else:
        text = str(value).strip()
    if len(text) > max_len:
        text = text[:max_len] + "…"
    # Debug: log length so we catch future regressions (do not log full content)
    print(f"[PDF] Paragraph text length: {len(text)} chars (max {max_len})")
    return text or "—"


def _bounds_to_center(bounds: Any) -> tuple:
    """Return (center_lon, center_lat) from bounds. Bounds may be dict {west,south,east,north} or list [[south,west],[north,east]]."""
    if not bounds:
        return (None, None)
    if isinstance(bounds, dict):
        return (
            (bounds.get("west", 0) + bounds.get("east", 0)) / 2,
            (bounds.get("south", 0) + bounds.get("north", 0)) / 2,
        )
    if isinstance(bounds, (list, tuple)) and len(bounds) >= 2:
        try:
            sw, ne = bounds[0], bounds[1]
            west = sw[1] if isinstance(sw, (list, tuple)) and len(sw) >= 2 else 0
            south = sw[0] if isinstance(sw, (list, tuple)) else 0
            east = ne[1] if isinstance(ne, (list, tuple)) and len(ne) >= 2 else 0
            north = ne[0] if isinstance(ne, (list, tuple)) else 0
            return ((west + east) / 2, (south + north) / 2)
        except (IndexError, TypeError):
            return (None, None)
    return (None, None)


def build_pdf_report_landscape(
    title: str,
    png_bytes: bytes,
    stats: Dict[str, Any],
    legend_bins: List[Dict[str, Any]],
    aoi_name: Optional[str] = None,
    raster_name: Optional[str] = None,
    raster_crs: Optional[Any] = None,
    context: Optional[Dict[str, Any]] = None,
    center_lon: Optional[float] = None,
    center_lat: Optional[float] = None,
) -> bytes:
    """
    Build a 2-page PDF report in landscape orientation. Never embeds full GeoJSON/JSON
    to avoid LayoutError from infinite-height cells; all text is sanitized and capped.
    """
    if not HAS_REPORTLAB:
        raise ValueError("reportlab not installed")
    
    pdf_buffer = BytesIO()
    landscape_size = landscape(letter)
    
    def on_first_page_landscape(canvas, doc):
        draw_pdf_header(canvas, doc, landscape_size)
    
    def on_later_pages_landscape(canvas, doc):
        draw_pdf_header(canvas, doc, landscape_size)
    
    HEADER_H = 50
    header_margin = (HEADER_H + 10) / 72.0 * inch
    doc = SimpleDocTemplate(
        pdf_buffer,
        pagesize=landscape_size,
        topMargin=header_margin,
        bottomMargin=0.35 * inch,
        leftMargin=0.4 * inch,
        rightMargin=0.4 * inch,
        onFirstPage=on_first_page_landscape,
        onLaterPages=on_later_pages_landscape,
    )
    story = []
    styles = getSampleStyleSheet()
    
    # ----- HEADER on top (Oregon logo left, title center, VMRC logo right) — in story so it always shows
    story.append(_make_header_table_flowable())
    story.append(Spacer(1, 0.12 * inch))
    
    # ----- PAGE 1: Content centered and spaced (not congested)
    export_date_style = ParagraphStyle(
        name="ExportDate", fontName="Helvetica", fontSize=9,
        textColor=colors.HexColor("#374151"), spaceAfter=4, alignment=1,
    )
    export_date_text = safe_text_for_pdf(datetime.now().strftime("%Y-%m-%d %H:%M"))
    story.append(Paragraph(f"Export Date: {export_date_text}", export_date_style))
    story.append(Spacer(1, 0.12 * inch))
    
    # Parameter summary — centered block; label column wide enough so "Seedling Drought Resistance Category" + value don't overlap
    selection_rows = format_report_selections(context)
    info_label_style = ParagraphStyle(name="InfoLabel", fontName="Helvetica-Bold", fontSize=9, textColor=colors.HexColor("#111827"), leftIndent=0, rightIndent=0)
    info_value_style = ParagraphStyle(name="InfoValue", fontName="Helvetica", fontSize=9, textColor=colors.HexColor("#111827"), leftIndent=0)
    info_data = [
        [Paragraph(safe_text_for_pdf(label + ":"), info_label_style), Paragraph(safe_text_for_pdf(value), info_value_style)]
        for label, value in selection_rows
    ]
    if not info_data:
        info_data = [[Paragraph("—", info_label_style), Paragraph("—", info_value_style)]]
    col_label = 3.4 * inch   # wide enough for "Seedling Drought Resistance Category:"
    col_value = 3.8 * inch   # plenty of room for value (e.g. "low", "Douglas-fir")
    info_table = Table(info_data, colWidths=[col_label, col_value])
    info_table.setStyle(TableStyle([
        ("ALIGN", (0, 0), (-1, -1), "LEFT"),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("FONTSIZE", (0, 0), (-1, -1), 9),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("LEFTPADDING", (0, 0), (0, -1), 0),
        ("RIGHTPADDING", (0, 0), (0, -1), 14),
        ("LEFTPADDING", (1, 0), (1, -1), 4),
        ("RIGHTPADDING", (1, 0), (1, -1), 0),
        ("BACKGROUND", (0, 0), (-1, -1), colors.white),
        ("TEXTCOLOR", (0, 0), (-1, -1), colors.HexColor("#111827")),
    ]))
    info_wrapper = Table([[KeepInFrame(col_label + col_value, 2.5 * inch, content=[info_table], mode="shrink")]], colWidths=[col_label + col_value])
    info_wrapper.hAlign = "CENTER"
    story.append(info_wrapper)
    story.append(Spacer(1, 0.14 * inch))
    
    # Raster preview — centered heading and image
    raster_heading_style = ParagraphStyle(name="RasterH", parent=styles["Heading3"], alignment=1, spaceAfter=6)
    story.append(Paragraph("<b>Raster Preview</b>", raster_heading_style))
    story.append(Spacer(1, 0.06 * inch))
    try:
        from PIL import Image as PILImage
        pil_img = PILImage.open(BytesIO(png_bytes))
        img_width_px, img_height_px = pil_img.size
        aspect_ratio = img_height_px / img_width_px if img_width_px > 0 else 1.0
    except Exception:
        img_width_px, img_height_px = 800, 800
        aspect_ratio = 1.0
    max_img_width = 5.5 * inch
    max_img_height = 1.65 * inch
    img_width = max_img_width
    img_height = img_width * aspect_ratio
    if img_height > max_img_height:
        img_height = max_img_height
        img_width = img_height / aspect_ratio
    try:
        map_flowable = Image(BytesIO(png_bytes), width=img_width, height=img_height)
        map_wrapper = Table([[map_flowable]], colWidths=[img_width])
        map_wrapper.setStyle(TableStyle([
            ("ALIGN", (0, 0), (-1, -1), "CENTER"),
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#d1d5db")),
            ("BACKGROUND", (0, 0), (-1, -1), colors.white),
        ]))
        map_wrapper.hAlign = "CENTER"
        story.append(map_wrapper)
        if center_lon is not None and center_lat is not None:
            coords_style = ParagraphStyle(
                name="Coords", fontName="Helvetica", fontSize=8,
                textColor=colors.HexColor("#6b7280"), spaceAfter=0, alignment=1,
            )
            story.append(Paragraph(
                safe_text_for_pdf(f"Longitude: {center_lon:.4f}, Latitude: {center_lat:.4f}"),
                coords_style,
            ))
    except Exception:
        story.append(Paragraph("Map image unavailable", styles["Normal"]))
    
    # Single page break — content is designed to fit; no page 3
    story.append(PageBreak())
    
    # ----- HEADER on page 2 (same as page 1)
    story.append(_make_header_table_flowable())
    story.append(Spacer(1, 0.16 * inch))
    
    # ----- PAGE 2: Horizontal legend on top (rows and columns exchanged), then stats and area below
    legend_colors = [
        colors.HexColor("#006400"), colors.HexColor("#228B22"),
        colors.HexColor("#9ACD32"), colors.HexColor("#FFD700"),
        colors.HexColor("#FFA500"), colors.HexColor("#FF8C00"),
        colors.HexColor("#FF6B00"), colors.HexColor("#FF4500"),
        colors.HexColor("#DC143C"), colors.HexColor("#B22222"),
    ]
    legend_ranges = ["0–10", "10–20", "20–30", "30–40", "40–50",
                    "50–60", "60–70", "70–80", "80–90", "90–100"]
    # Horizontal layout: row 0 = color swatches, row 1 = range labels (so nothing is hidden)
    legend_data = [[""] * 10, legend_ranges]
    col_w = 0.88 * inch  # wide enough so "90–100" and color box are not hidden
    legend_col_widths = [col_w] * 10
    legend_table = Table(legend_data, colWidths=legend_col_widths)
    legend_style = TableStyle([
        ("ALIGN", (0, 0), (-1, -1), "CENTER"),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("FONTNAME", (0, 1), (-1, 1), "Helvetica-Bold"),
        ("FONTSIZE", (0, 0), (-1, 0), 9),
        ("FONTSIZE", (0, 1), (-1, 1), 10),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("LEFTPADDING", (0, 0), (-1, -1), 4),
        ("RIGHTPADDING", (0, 0), (-1, -1), 4),
        ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#e5e7eb")),
        ("TEXTCOLOR", (0, 1), (-1, 1), colors.HexColor("#111827")),
    ])
    for i in range(10):
        legend_style.add("BACKGROUND", (i, 0), (i, 0), legend_colors[i])
    legend_table.setStyle(legend_style)
    
    # Acres from pixel count * pixel area (m²); if CRS is meters, acres = m² / 4046.8564224
    pixel_area_m2 = stats.get("pixel_area_m2") or 0.0
    total_count = stats.get("count", 0)
    acres_total = (total_count * pixel_area_m2 * ACRES_PER_SQ_M) if pixel_area_m2 > 0 else 0.0
    
    # Statistics Summary: header "Seedling Mortality (%)", then Min, Max, Mean, Median, Std Dev, Acres (1 decimal)
    median_val = stats.get("median")
    stats_data = [
        ["Seedling Mortality (%)", ""],
        ["Min", f"{stats.get('min', 0):.1f}"],
        ["Max", f"{stats.get('max', 0):.1f}"],
        ["Mean", f"{stats.get('mean', 0):.1f}"],
        ["Median", f"{median_val:.1f}" if median_val is not None else "N/A"],
        ["Std Dev", f"{stats.get('std', 0):.1f}"],
        ["Acres", f"{acres_total:.1f}"],
    ]
    stats_table = Table(stats_data, colWidths=[2.0 * inch, 1.2 * inch])
    stats_table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#2f3a4a")),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTSIZE", (0, 0), (-1, -1), 8),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 2),
        ("TOPPADDING", (0, 0), (-1, -1), 2),
        ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#e5e7eb")),
        ("BACKGROUND", (0, 1), (-1, -1), colors.white),
        ("TEXTCOLOR", (0, 1), (-1, -1), colors.HexColor("#111827")),
    ]))
    
    # Area by Mortality Class (%): fixed classes 0–20, 20–40, 40–60, 60–80, 80–100; columns Seedling Mortality (%), Acres, Area (%)
    fixed_classes = ["0–20", "20–40", "40–60", "60–80", "80–100"]
    area_class_rows = [["Seedling Mortality (%)", "Acres", "Area (%)"]]
    area_by_class = stats.get("area_by_mortality_class") or []
    for i, range_label in enumerate(fixed_classes):
        if i < len(area_by_class):
            row = area_by_class[i]
            c = row.get("count", 0)
            pct = row.get("percent", 0)
            acres_row = (c * pixel_area_m2 * ACRES_PER_SQ_M) if pixel_area_m2 > 0 else 0.0
            area_class_rows.append([range_label, f"{acres_row:.1f}", f"{pct:.1f}"])
        else:
            area_class_rows.append([range_label, "—", "—"])
    area_table = Table(area_class_rows, colWidths=[1.35 * inch, 1.0 * inch, 1.0 * inch])
    area_table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#2f3a4a")),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTSIZE", (0, 0), (-1, -1), 8),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 2),
        ("TOPPADDING", (0, 0), (-1, -1), 2),
        ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#e5e7eb")),
        ("BACKGROUND", (0, 1), (-1, -1), colors.white),
        ("TEXTCOLOR", (0, 1), (-1, -1), colors.HexColor("#111827")),
    ]))
    
    # Page 2: vertical stack — horizontal legend on top, then Statistics Summary, then Area by Mortality Class below
    legend_heading = Paragraph(
        "<b>Legend — Seedling Mortality (%)</b>",
        ParagraphStyle(name="L", fontName="Helvetica-Bold", fontSize=10, spaceAfter=10, alignment=1),
    )
    story.append(legend_heading)
    legend_table.hAlign = "CENTER"
    story.append(legend_table)
    story.append(Spacer(1, 0.3 * inch))
    story.append(Paragraph(
        "<b>Statistics Summary</b>",
        ParagraphStyle(name="S", fontName="Helvetica-Bold", fontSize=10, spaceAfter=10, alignment=1),
    ))
    stats_table.hAlign = "CENTER"
    story.append(stats_table)
    story.append(Spacer(1, 0.28 * inch))
    story.append(Paragraph(
        "<b>Area by Mortality Class (%)</b>",
        ParagraphStyle(name="A", fontName="Helvetica-Bold", fontSize=10, spaceAfter=10, alignment=1),
    ))
    area_table.hAlign = "CENTER"
    story.append(area_table)
    
    doc.build(story)
    pdf_bytes = pdf_buffer.getvalue()
    pdf_buffer.close()
    print(f"[PDF] ✓ Generated landscape PDF report ({len(pdf_bytes)} bytes)")
    return pdf_bytes


def _make_header_table_flowable():
    """
    Build header as a Platypus Table flowable: Oregon logo LEFT, title CENTER, VMRC logo RIGHT.
    Logos are sized to fit the column while preserving aspect ratio so they don't look squashed.
    """
    base_dir = Path(__file__).parent.parent.parent.parent
    # Full-width leader (left to right): landscape frame ~10.2"; use full width so header spans edge to edge
    frame_width = 10.2 * inch
    col_left = 2.0 * inch
    col_center = frame_width - 4.0 * inch  # 6.2"
    col_right = 2.0 * inch
    # Max logo size: fit within column while preserving aspect ratio (no squashing)
    max_logo_height_pt = 52  # ~0.72 inch — large enough to read clearly
    max_logo_width_pt = 1.35 * 72  # 1.35 inch in points (fits in 1.6" column with padding)

    osu_logo_paths = [
        base_dir.parent / "vmrc-portal-frontend" / "public" / "oregon.jpg",
        base_dir / "static" / "logos" / "osu_logo.png",
        base_dir / "static" / "logos" / "OSU_logo.png",
        base_dir / "static" / "logos" / "osu.png",
        base_dir / "static" / "osu_logo.png",
    ]
    vmrc_logo_paths = [
        base_dir.parent / "vmrc-portal-frontend" / "public" / "vmrc.png",
        base_dir / "static" / "logos" / "vmrc_logo.png",
        base_dir / "static" / "logos" / "VMRC_logo.png",
        base_dir / "static" / "logos" / "vmrc.png",
        base_dir / "static" / "vmrc.png",
        Path("static/logos/vmrc_logo.png"),
        Path("static/logos/vmrc.png"),
        Path("static/vmrc.png"),
    ]
    osu_path = next((p for p in osu_logo_paths if p.exists()), None)
    vmrc_path = next((p for p in vmrc_logo_paths if p.exists()), None)

    styles = getSampleStyleSheet()
    title_style = ParagraphStyle(
        name="HeaderTitle",
        parent=styles["Normal"],
        fontName="Helvetica-Bold",
        fontSize=14,
        textColor=colors.HexColor("#111827"),
        alignment=1,
        spaceBefore=0,
        spaceAfter=0,
    )
    title_para = Paragraph("VMRC Seedling Mortality Simulator", title_style)

    def _logo_img(path, max_w_pt, max_h_pt):
        if not path or not path.exists():
            return Paragraph("", styles["Normal"])
        try:
            from PIL import Image as PILImage
            with open(path, "rb") as f:
                pil = PILImage.open(f)
                iw, ih = pil.size
            if iw <= 0 or ih <= 0:
                return Image(str(path), width=max_w_pt, height=max_h_pt)
            # Scale to fit within max box, preserving aspect ratio (no squashing)
            scale = min(max_w_pt / iw, max_h_pt / ih)
            w, h = iw * scale, ih * scale
            return Image(str(path), width=w, height=h)
        except Exception:
            return Paragraph("", styles["Normal"])

    left_cell = _logo_img(osu_path, max_logo_width_pt, max_logo_height_pt)
    right_cell = _logo_img(vmrc_path, max_logo_width_pt, max_logo_height_pt)
    header_table = Table(
        [[left_cell, title_para, right_cell]],
        colWidths=[col_left, col_center, col_right],
    )
    header_table.setStyle(
        TableStyle([
            ("ALIGN", (0, 0), (0, 0), "LEFT"),
            ("ALIGN", (1, 0), (1, 0), "CENTER"),
            ("ALIGN", (2, 0), (2, 0), "RIGHT"),
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#f3f4f6")),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 10),
            ("TOPPADDING", (0, 0), (-1, -1), 10),
            ("LEFTPADDING", (0, 0), (-1, -1), 12),
            ("RIGHTPADDING", (0, 0), (-1, -1), 12),
            ("LINEBELOW", (0, 0), (-1, -1), 1.5, colors.HexColor("#d1d5db")),
        ])
    )
    header_table.hAlign = "CENTER"
    return header_table


def draw_pdf_header(canvas, doc, pagesize):
    """
    Header at top of every page: Oregon logo LEFT, "VMRC Seedling Mortality Simulator" CENTER, VMRC logo RIGHT.
    Drawn on the canvas only; body content starts below the reserved top margin.
    """
    print("[PDF] 🔵 CALLING draw_pdf_header - START")
    canvas.saveState()
    
    page_width, page_height = pagesize
    HEADER_H = 50  # Header height in points (tight to top of page)
    
    # ReportLab: (0,0) is bottom-left; top of page = page_height. Draw header band at very top.
    canvas.setFillColorRGB(0.96, 0.96, 0.96)  # Light gray
    canvas.rect(0, page_height - HEADER_H, page_width, HEADER_H, fill=1, stroke=0)
    print(f"[PDF] ✓ Drew header background rectangle: x=0, y={page_height - HEADER_H}, w={page_width}, h={HEADER_H}")
    
    # Logos first so title can be drawn on top (no overlap)
    logo_height = 28
    logo_margin = 0.4 * inch
    base_dir = Path(__file__).parent.parent.parent.parent

    # Oregon (OSU) logo on the LEFT
    osu_logo_paths = [
        base_dir.parent / "vmrc-portal-frontend" / "public" / "oregon.jpg",  # Primary: /public/oregon.jpg
        base_dir / "static" / "logos" / "osu_logo.png",
        base_dir / "static" / "logos" / "OSU_logo.png",
        base_dir / "static" / "logos" / "osu.png",
        base_dir / "static" / "osu_logo.png",
    ]
    osu_logo_path = None
    for path in osu_logo_paths:
        if path.exists():
            osu_logo_path = path
            break
    
    if osu_logo_path:
        try:
            from reportlab.lib.utils import ImageReader
            osu_img = ImageReader(str(osu_logo_path))
            # Get image dimensions
            img_width, img_height_orig = osu_img.getSize()
            # Calculate width maintaining aspect ratio
            logo_width = logo_height * (img_width / img_height_orig) if img_height_orig > 0 else logo_height
            logo_y = page_height - logo_height - 6  # 6pt from top (header at top of page)
            canvas.drawImage(osu_img, logo_margin, logo_y, width=logo_width, height=logo_height, preserveAspectRatio=True)
            print(f"[PDF] ✓ Loaded OSU logo from: {osu_logo_path}")
        except Exception as e:
            print(f"[PDF] Warning: Could not load OSU logo: {e}")
    else:
        print(f"[PDF] Info: OSU logo not found (checked {len(osu_logo_paths)} paths)")
    
    # VMRC logo on RIGHT (vmrc.png in /public folder)
    vmrc_logo_paths = [
        base_dir.parent / "vmrc-portal-frontend" / "public" / "vmrc.png",  # Primary: /public/vmrc.png
        base_dir / "static" / "logos" / "vmrc_logo.png",
        base_dir / "static" / "logos" / "VMRC_logo.png",
        base_dir / "static" / "logos" / "vmrc.png",
        base_dir / "static" / "vmrc.png",
        Path("static/logos/vmrc_logo.png"),
        Path("static/logos/vmrc.png"),
        Path("static/vmrc.png"),
    ]
    vmrc_logo_path = None
    for path in vmrc_logo_paths:
        if path.exists():
            vmrc_logo_path = path
            break
    
    if vmrc_logo_path:
        try:
            from reportlab.lib.utils import ImageReader
            vmrc_img = ImageReader(str(vmrc_logo_path))
            # Get image dimensions
            img_width, img_height_orig = vmrc_img.getSize()
            # Calculate width maintaining aspect ratio
            logo_width = logo_height * (img_width / img_height_orig) if img_height_orig > 0 else logo_height
            logo_y = page_height - logo_height - 6  # 6pt from top (header at top of page)
            logo_x = page_width - logo_width - logo_margin
            canvas.drawImage(vmrc_img, logo_x, logo_y, width=logo_width, height=logo_height, preserveAspectRatio=True)
            print(f"[PDF] ✓ Loaded VMRC logo from: {vmrc_logo_path}")
        except Exception as e:
            print(f"[PDF] Warning: Could not load VMRC logo: {e}")
    else:
        print(f"[PDF] Info: VMRC logo not found (checked {len(vmrc_logo_paths)} paths)")
    
    # Title "VMRC Seedling Mortality Simulator" in the CENTER (drawn last so it is never covered by logos)
    canvas.setFont("Helvetica-Bold", 14)
    canvas.setFillColorRGB(0.07, 0.07, 0.07)
    title_text = "VMRC Seedling Mortality Simulator"
    title_width = canvas.stringWidth(title_text, "Helvetica-Bold", 14)
    title_x = (page_width - title_width) / 2
    title_y = page_height - 14
    canvas.drawString(title_x, title_y, title_text)
    
    # Divider line at bottom of header
    divider_y = page_height - HEADER_H
    canvas.setStrokeColorRGB(0.82, 0.82, 0.82)  # RGB(180,180,180) = light gray
    canvas.setLineWidth(1)
    canvas.line(0, divider_y, page_width, divider_y)
    print(f"[PDF] ✓ Drew divider line at y={divider_y} (from x=0 to x={page_width})")
    
    canvas.restoreState()
    print("[PDF] 🔵 draw_pdf_header - COMPLETE")


def build_pdf_report(
    title: str,
    png_bytes: Optional[bytes],
    stats: Dict[str, Any],
    legend_bins: List[Dict[str, Any]],
    aoi_name: Optional[str] = None,
    raster_name: Optional[str] = None,
    context: Optional[Dict[str, Any]] = None
) -> bytes:
    """
    Build a PDF report with raster image preview, legend, and statistics.
    
    The image is embedded from PNG bytes to ensure pixelated rendering (no smoothing).
    Uses BytesIO directly with reportlab.platypus.Image (not ImageReader, which is for canvas.drawImage).
    
    Layout: Landscape orientation with header, map preview, legend, and expanded statistics.
    Uses KeepTogether to prevent pagination issues.
    
    Args:
        title: Report title (dataset name + params)
        png_bytes: PNG image bytes (colorized raster overlay) - may be None if unavailable
        stats: Statistics dict with min, max, mean, median, std, count, and expanded stats
        legend_bins: List of legend bin dicts with {range, color, label}
        aoi_name: Optional AOI name
        raster_name: Optional raster file name
        context: Optional context dict with filter selections
    
    Returns:
        PDF bytes ready for download
    """
    if not HAS_REPORTLAB:
        raise ValueError("reportlab not installed")
    
    # Create in-memory PDF buffer
    pdf_buffer = BytesIO()
    
    # Create PDF document in landscape orientation (better for maps)
    landscape_size = landscape(letter)  # 11" x 8.5"
    
    # Header callbacks - apply header on every page
    def on_first_page(canvas, doc):
        """Add header on first page."""
        print("[PDF] 🔵 on_first_page callback triggered")
        draw_pdf_header(canvas, doc, landscape_size)
        print("[PDF] 🔵 on_first_page callback complete")
    
    def on_later_pages(canvas, doc):
        """Add header on subsequent pages."""
        print("[PDF] 🔵 on_later_pages callback triggered")
        draw_pdf_header(canvas, doc, landscape_size)
        print("[PDF] 🔵 on_later_pages callback complete")
    
    # Calculate top margin: HEADER_H (60pt) + 20pt padding = 80pt
    # This ensures body content starts BELOW the header and cannot cover it
    HEADER_H = 60  # Header height in points
    header_margin = (HEADER_H + 20) / 72.0 * inch  # Convert points to inches (72pt = 1 inch)
    print(f"[PDF] Header margin: {header_margin} inches ({HEADER_H + 20} points)")
    
    doc = SimpleDocTemplate(
        pdf_buffer,
        pagesize=landscape_size,
        topMargin=header_margin,  # CRITICAL: Content starts BELOW header (HEADER_H + 20pt)
        bottomMargin=0.5*inch,
        leftMargin=0.5*inch,
        rightMargin=0.5*inch,
        onFirstPage=on_first_page,
        onLaterPages=on_later_pages,
    )
    story = []
    styles = getSampleStyleSheet()
    
    # ============================================================
    # PDF HEADER: Title + Logos (as first element in story)
    # This ensures header appears on every page as part of content flow
    # ============================================================
    header_section = []
    
    # Create header table with logos and title
    # Get logo paths
    base_dir = Path(__file__).parent.parent.parent.parent
    osu_logo_path = None
    vmrc_logo_path = None
    
    # Find OSU logo (oregon.jpg in /public folder)
    osu_logo_paths = [
        base_dir.parent / "vmrc-portal-frontend" / "public" / "oregon.jpg",  # Primary: /public/oregon.jpg
        base_dir / "static" / "logos" / "osu_logo.png",
        base_dir / "static" / "logos" / "OSU_logo.png",
        base_dir / "static" / "logos" / "osu.png",
        base_dir / "static" / "osu_logo.png",
    ]
    for path in osu_logo_paths:
        if path.exists():
            osu_logo_path = path
            break
    
    # Find VMRC logo (vmrc.png in /public folder)
    vmrc_logo_paths = [
        base_dir.parent / "vmrc-portal-frontend" / "public" / "vmrc.png",  # Primary: /public/vmrc.png
        base_dir / "static" / "logos" / "vmrc_logo.png",
        base_dir / "static" / "logos" / "VMRC_logo.png",
        base_dir / "static" / "logos" / "vmrc.png",
        base_dir / "static" / "vmrc.png",
        Path("static/logos/vmrc_logo.png"),
        Path("static/logos/vmrc.png"),
        Path("static/vmrc.png"),
    ]
    for path in vmrc_logo_paths:
        if path.exists():
            vmrc_logo_path = path
            break
    
    # Build header row: [OSU Logo, Title, VMRC Logo]
    header_cells = []
    
    # Left: OSU logo (or empty space)
    if osu_logo_path:
        try:
            from PIL import Image as PILImage
            osu_img_pil = PILImage.open(osu_logo_path)
            osu_img_width, osu_img_height = osu_img_pil.size
            logo_height_pt = 40  # 40px height (strict requirement)
            logo_width_pt = logo_height_pt * (osu_img_width / osu_img_height) if osu_img_height > 0 else logo_height_pt
            osu_img = Image(str(osu_logo_path), width=logo_width_pt, height=logo_height_pt)
            header_cells.append(osu_img)
            print(f"[PDF] ✓ Adding OSU logo to header from: {osu_logo_path}")
        except Exception as e:
            print(f"[PDF] Warning: Could not load OSU logo for header: {e}")
            header_cells.append(Paragraph("", styles['Normal']))  # Empty cell
    else:
        header_cells.append(Paragraph("", styles['Normal']))  # Empty cell if logo not found
    
    # Center: Title VMRC Seedling Mortality Simulator
    title_style = ParagraphStyle(
        'HeaderTitle',
        parent=styles['Heading1'],
        fontSize=16,
        textColor=colors.HexColor('#111827'),
        alignment=1,  # Center
        spaceAfter=0,
        spaceBefore=0,
        fontName='Helvetica-Bold',  # Font weight 700 (bold)
    )
    header_cells.append(Paragraph("VMRC Seedling Mortality Simulator", title_style))
    
    # Right: VMRC logo (or empty space)
    if vmrc_logo_path:
        try:
            from PIL import Image as PILImage
            vmrc_img_pil = PILImage.open(vmrc_logo_path)
            vmrc_img_width, vmrc_img_height = vmrc_img_pil.size
            logo_height_pt = 40  # 40px height (strict requirement)
            logo_width_pt = logo_height_pt * (vmrc_img_width / vmrc_img_height) if vmrc_img_height > 0 else logo_height_pt
            vmrc_img = Image(str(vmrc_logo_path), width=logo_width_pt, height=logo_height_pt)
            header_cells.append(vmrc_img)
            print(f"[PDF] ✓ Adding VMRC logo to header from: {vmrc_logo_path}")
        except Exception as e:
            print(f"[PDF] Warning: Could not load VMRC logo for header: {e}")
            header_cells.append(Paragraph("", styles['Normal']))  # Empty cell
    else:
        header_cells.append(Paragraph("", styles['Normal']))  # Empty cell if logo not found
    
    # Create header table with 3 columns: [OSU Logo | Title | VMRC Logo]
    # Equivalent to: display: flex; align-items: center; justify-content: space-between;
    header_table = Table([header_cells], colWidths=[2*inch, 6*inch, 2*inch])
    header_table.setStyle(TableStyle([
        ('ALIGN', (0, 0), (0, 0), 'LEFT'),   # OSU logo left
        ('ALIGN', (1, 0), (1, 0), 'CENTER'), # Title center (flex: 1 equivalent)
        ('ALIGN', (2, 0), (2, 0), 'RIGHT'),  # VMRC logo right
        ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),  # align-items: center
        ('BOTTOMPADDING', (0, 0), (-1, -1), 12),  # 12px padding (equivalent)
        ('TOPPADDING', (0, 0), (-1, -1), 12),     # 12px padding (equivalent)
        ('LEFTPADDING', (0, 0), (-1, -1), 24),    # 24px left/right padding (equivalent)
        ('RIGHTPADDING', (0, 0), (-1, -1), 24),
        ('BACKGROUND', (0, 0), (-1, -1), colors.white),  # White background (or light gray if preferred)
        ('LINEBELOW', (0, 0), (-1, -1), 2, colors.HexColor('#dddddd')),  # 2px border-bottom (#ddd)
    ]))
    
    header_section.append(header_table)
    
    # Add header section to story FIRST (ensures it appears at top of page 1)
    # Header callbacks (on_first_page, on_later_pages) will add header to all pages
    story.append(KeepTogether(header_section))
    story.append(Spacer(1, 0.25*inch))  # 20px margin-bottom equivalent
    
    # ============================================================
    # METADATA: Export Date + Raster / Selection Summary (label + value, required order)
    # ============================================================
    info_data = [["Export Date:", datetime.now().strftime('%Y-%m-%d %H:%M:%S')]]
    selection_rows = format_report_selections(context)
    for label, value in selection_rows:
        info_data.append([label + ":", value])

    if info_data:
        info_table = Table(info_data, colWidths=[2.2*inch, 6.8*inch])
        info_table.setStyle(TableStyle([
            ('ALIGN', (0, 0), (-1, -1), 'LEFT'),
            ('FONTNAME', (0, 0), (0, -1), 'Helvetica-Bold'),
            ('FONTSIZE', (0, 0), (-1, -1), 10),
            ('BOTTOMPADDING', (0, 0), (-1, -1), 4),
            ('TOPPADDING', (0, 0), (-1, -1), 4),
        ]))
        story.append(info_table)
    story.append(Spacer(1, 0.2*inch))
    
    # ============================================================
    # RASTER IMAGE PREVIEW
    # ============================================================
    story.append(Paragraph("<b>Raster Preview</b>", styles['Heading2']))
    story.append(Spacer(1, 0.1*inch))
    
    # Load PNG from bytes (for Platypus Image, use BytesIO directly, not ImageReader)
    if png_bytes:
        try:
            # Get image dimensions using PIL to calculate aspect ratio
            try:
                from PIL import Image as PILImage
                pil_img = PILImage.open(BytesIO(png_bytes))
                img_width_px, img_height_px = pil_img.size
                aspect_ratio = img_height_px / img_width_px if img_width_px > 0 else 1.0
            except ImportError:
                # Fallback: assume square if PIL not available
                print("[PDF] Warning: PIL not available, using default aspect ratio")
                img_width_px, img_height_px = 800, 800
                aspect_ratio = 1.0
            
            # Fit to landscape page width (9.5 inches max, with margins)
            max_width = 9.5 * inch
            img_width = max_width
            img_height = img_width * aspect_ratio
            
            # Limit height to prevent page overflow
            max_height = 5.0 * inch
            if img_height > max_height:
                img_height = max_height
                img_width = img_height / aspect_ratio
            
            # Create Image flowable from BytesIO directly (not ImageReader)
            # ImageReader is only for canvas.drawImage(), not for Platypus Image
            img = Image(BytesIO(png_bytes), width=img_width, height=img_height)
            
            # Wrap in table for centering and border
            img_table = Table([[img]], colWidths=[max_width])
            img_table.setStyle(TableStyle([
                ('ALIGN', (0, 0), (-1, -1), 'CENTER'),
                ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
                ('GRID', (0, 0), (-1, -1), 1, colors.HexColor('#d1d5db')),  # Light gray border
                ('BACKGROUND', (0, 0), (-1, -1), colors.white),
            ]))
            
            story.append(img_table)
            print(f"[PDF] ✓ Embedded raster preview image ({img_width_px}x{img_height_px} px, {img_width:.2f}x{img_height:.2f} inches)")
        except Exception as img_err:
            print(f"[PDF] ERROR: Failed to embed image: {img_err}")
            import traceback
            traceback.print_exc()
            story.append(Paragraph(f"Preview image unavailable: {str(img_err)}", styles['Normal']))
    else:
        story.append(Paragraph("Preview image unavailable (PNG generation failed)", styles['Normal']))
    
    story.append(Spacer(1, 0.2*inch))
    
    # ============================================================
    # LEGEND: Color bins (0–10, 10–20, ..., 90–100)
    # ============================================================
    story.append(Paragraph("<b>Legend</b>", styles['Heading2']))
    story.append(Spacer(1, 0.1*inch))
    
    # Legend colors matching the colormap (same as UI)
    legend_colors = [
        colors.HexColor('#006400'),  # 0–10  dark green
        colors.HexColor('#228B22'),  # 10–20
        colors.HexColor('#9ACD32'),  # 20–30
        colors.HexColor('#FFD700'),  # 30–40
        colors.HexColor('#FFA500'),  # 40–50
        colors.HexColor('#FF8C00'),  # 50–60
        colors.HexColor('#FF6B00'),  # 60–70
        colors.HexColor('#FF4500'),  # 70–80
        colors.HexColor('#DC143C'),  # 80–90
        colors.HexColor('#B22222'),  # 90–100
    ]
    
    legend_ranges = ["0–10", "10–20", "20–30", "30–40", "40–50", "50–60", "60–70", "70–80", "80–90", "90–100"]
    
    # Build legend table: [Color Box, Seedling Mortality (%)]
    legend_data = [["Color", "Seedling Mortality (%)"]]
    for range_label in legend_ranges:
        legend_data.append(["", range_label])
    
    legend_table = Table(legend_data, colWidths=[1*inch, 1.5*inch])
    legend_style = TableStyle([
        ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor('#2f3a4a')),  # Header background: #2f3a4a
        ('TEXTCOLOR', (0, 0), (-1, 0), colors.white),  # Header text: white, bold
        ('ALIGN', (0, 0), (-1, -1), 'CENTER'),
        ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),  # Font weight 700 (bold)
        ('FONTSIZE', (0, 0), (-1, 0), 11),  # Header font size
        ('FONTSIZE', (0, 1), (-1, -1), 9),  # Data rows keep original size
        ('BOTTOMPADDING', (0, 0), (-1, 0), 8),  # Header padding: 8px vertical
        ('TOPPADDING', (0, 0), (-1, 0), 8),
        ('LEFTPADDING', (0, 0), (-1, 0), 10),  # Header padding: 10px horizontal
        ('RIGHTPADDING', (0, 0), (-1, 0), 10),
        ('BOTTOMPADDING', (0, 1), (-1, -1), 4),  # Data row padding
        ('TOPPADDING', (0, 1), (-1, -1), 4),
        ('GRID', (0, 0), (-1, -1), 0.5, colors.HexColor('#e5e7eb')),
    ])
    # Color each row's first cell with the legend color
    for i in range(10):
        legend_style.add('BACKGROUND', (0, i+1), (0, i+1), legend_colors[i])
    legend_table.setStyle(legend_style)
    
    story.append(legend_table)
    story.append(Spacer(1, 0.3*inch))
    
    # ============================================================
    # STATISTICS SUMMARY TABLE (Keep together to prevent pagination issues)
    # ============================================================
    stats_section = []
    stats_section.append(Paragraph("<b>Statistics Summary</b>", styles['Heading2']))
    stats_section.append(Spacer(1, 0.1*inch))
    
    # Calculate median if not provided
    median = stats.get("median")
    if median is None and stats.get("count", 0) > 0:
        median = None
    
    stats_data = [
        ["Metric", "Value"],
        ["Count", str(stats.get("count", 0))],
        ["Min", f"{stats.get('min', 0):.2f}"],
        ["Max", f"{stats.get('max', 0):.2f}"],
        ["Mean", f"{stats.get('mean', 0):.2f}"],
        ["Median", f"{median:.2f}" if median is not None else "N/A"],
        ["Std Dev", f"{stats.get('std', 0):.2f}"],
    ]
    
    stats_table = Table(stats_data, colWidths=[2*inch, 3*inch])
    stats_table.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor('#2f3a4a')),  # Header background: #2f3a4a
        ('TEXTCOLOR', (0, 0), (-1, 0), colors.white),  # Header text: white, bold
        ('BACKGROUND', (0, 1), (0, -1), colors.HexColor('#f9fafb')),  # Label column background
        ('TEXTCOLOR', (0, 1), (-1, -1), colors.HexColor('#111827')),  # Data rows only (not header)
        ('ALIGN', (0, 0), (-1, -1), 'LEFT'),
        ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),  # Header font weight 700 (bold)
        ('FONTSIZE', (0, 0), (-1, 0), 12),  # Header font size
        ('FONTSIZE', (0, 1), (-1, -1), 10),  # Data rows keep original size
        ('BOTTOMPADDING', (0, 0), (-1, 0), 8),  # Header padding: 8px vertical
        ('TOPPADDING', (0, 0), (-1, 0), 8),
        ('LEFTPADDING', (0, 0), (-1, 0), 10),  # Header padding: 10px horizontal
        ('RIGHTPADDING', (0, 0), (-1, 0), 10),
        ('BOTTOMPADDING', (0, 1), (-1, -1), 6),  # Data row padding
        ('TOPPADDING', (0, 1), (-1, -1), 6),
        ('GRID', (0, 0), (-1, -1), 0.5, colors.HexColor('#e5e7eb')),
        ('ROWBACKGROUNDS', (0, 1), (-1, -1), [colors.white, colors.HexColor('#f9fafb')]),
    ]))
    stats_section.append(stats_table)
    
    # Use KeepTogether to prevent splitting the stats table across pages
    story.append(KeepTogether(stats_section))
    story.append(Spacer(1, 0.3*inch))
    
    # ============================================================
    # EXPANDED STATISTICS: Area by Threshold
    # ============================================================
    if "area_by_threshold" in stats:
        threshold_section = []
        threshold_section.append(Paragraph("<b>Area by Threshold</b>", styles['Heading2']))
        threshold_section.append(Spacer(1, 0.1*inch))
        
        threshold_data = [
            ["Threshold", "Count", "Percentage"],
            ["High (≥70%)", 
             str(stats["area_by_threshold"]["high"]["count"]),
             f"{stats['area_by_threshold']['high']['percent']:.2f}%"],
            ["Moderate-High (≥50%)",
             str(stats["area_by_threshold"]["moderate_high"]["count"]),
             f"{stats['area_by_threshold']['moderate_high']['percent']:.2f}%"],
            ["Low (≤30%)",
             str(stats["area_by_threshold"]["low"]["count"]),
             f"{stats['area_by_threshold']['low']['percent']:.2f}%"],
        ]
        
        threshold_table = Table(threshold_data, colWidths=[2.5*inch, 1.5*inch, 1.5*inch])
        threshold_table.setStyle(TableStyle([
            ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor('#2f3a4a')),  # Header background: #2f3a4a
            ('TEXTCOLOR', (0, 0), (-1, 0), colors.white),  # Header text: white, bold
            ('BACKGROUND', (0, 1), (0, -1), colors.HexColor('#f9fafb')),
            ('TEXTCOLOR', (0, 1), (-1, -1), colors.HexColor('#111827')),  # Data rows only (not header)
            ('ALIGN', (0, 0), (-1, -1), 'LEFT'),
            ('ALIGN', (1, 0), (-1, -1), 'RIGHT'),  # Numbers right-aligned
            ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),  # Header font weight 700 (bold)
            ('FONTSIZE', (0, 0), (-1, 0), 12),  # Header font size
            ('FONTSIZE', (0, 1), (-1, -1), 10),  # Data rows keep original size
            ('BOTTOMPADDING', (0, 0), (-1, 0), 8),  # Header padding: 8px vertical
            ('TOPPADDING', (0, 0), (-1, 0), 8),
            ('LEFTPADDING', (0, 0), (-1, 0), 10),  # Header padding: 10px horizontal
            ('RIGHTPADDING', (0, 0), (-1, 0), 10),
            ('BOTTOMPADDING', (0, 1), (-1, -1), 6),  # Data row padding
            ('TOPPADDING', (0, 1), (-1, -1), 6),
            ('GRID', (0, 0), (-1, -1), 0.5, colors.HexColor('#e5e7eb')),
            ('ROWBACKGROUNDS', (0, 1), (-1, -1), [colors.white, colors.HexColor('#f9fafb')]),
        ]))
        threshold_section.append(threshold_table)
        
        story.append(KeepTogether(threshold_section))
        story.append(Spacer(1, 0.3*inch))
    
    # Most Common Value Range section REMOVED for one-page report (per requirements).
    
    # Build PDF
    print("[PDF] 🔵 About to call doc.build(story) - header callbacks will execute during build")
    doc.build(story)
    print("[PDF] 🔵 doc.build(story) complete")
    
    # Get PDF bytes
    pdf_bytes = pdf_buffer.getvalue()
    pdf_buffer.close()
    
    print(f"[PDF] ✓ Generated PDF report ({len(pdf_bytes)} bytes)")
    return pdf_bytes


def normalize_for_export(geojson: dict) -> dict:
    """
    Normalize GeoJSON to a single Feature (Polygon/MultiPolygon preferred).
    
    Handles:
    - FeatureCollection: filters to Polygon/MultiPolygon, unions if multiple
    - Feature: returns as-is
    - Geometry: wraps in Feature
    
    Returns:
        dict: Single GeoJSON Feature with Polygon or MultiPolygon geometry
        
    Raises:
        ValueError: If no valid polygon features exist
    """
    if not geojson:
        raise ValueError("GeoJSON is empty or None")
    
    geojson_type = geojson.get("type", "").lower()
    
    # Case 1: FeatureCollection
    if geojson_type == "featurecollection":
        features = geojson.get("features", [])
        if not features:
            raise ValueError("FeatureCollection is empty")
        
        # Filter to Polygon/MultiPolygon features only
        polygon_features = []
        for feat in features:
            if feat.get("type", "").lower() != "feature":
                continue
            geom = feat.get("geometry")
            if not geom:
                continue
            geom_type = geom.get("type", "").lower()
            if geom_type in ["polygon", "multipolygon"]:
                polygon_features.append(feat)
        
        if not polygon_features:
            raise ValueError("No Polygon or MultiPolygon features found in FeatureCollection")
        
        # If single feature, return it
        if len(polygon_features) == 1:
            return polygon_features[0]
        
        # Multiple features: union them into one
        print(f"[normalize_for_export] Found {len(polygon_features)} polygon features, unioning...")
        try:
            # Convert to shapely geometries
            shapely_geoms = []
            for feat in polygon_features:
                geom_dict = feat.get("geometry")
                if geom_dict:
                    geom = shape(geom_dict)
                    if geom.is_valid:
                        shapely_geoms.append(geom)
                    else:
                        print(f"[normalize_for_export] Invalid geometry, attempting to fix...")
                        shapely_geoms.append(make_valid(geom))
            
            if not shapely_geoms:
                raise ValueError("No valid polygon geometries found after validation")
            
            # Union all geometries
            if len(shapely_geoms) == 1:
                unioned_geom = shapely_geoms[0]
            else:
                unioned_geom = unary_union(shapely_geoms)
            
            # Ensure valid
            if not unioned_geom.is_valid:
                print(f"[normalize_for_export] Unioned geometry invalid, attempting to fix...")
                unioned_geom = make_valid(unioned_geom)
            
            # Convert back to GeoJSON Feature
            return {
                "type": "Feature",
                "properties": polygon_features[0].get("properties", {}),
                "geometry": mapping(unioned_geom)
            }
        except Exception as e:
            raise ValueError(f"Failed to union polygon features: {str(e)}")
    
    # Case 2: Feature
    elif geojson_type == "feature":
        geom = geojson.get("geometry")
        if not geom:
            raise ValueError("Feature has no geometry")
        geom_type = geom.get("type", "").lower()
        if geom_type not in ["polygon", "multipolygon"]:
            raise ValueError(f"Feature geometry type '{geom_type}' is not Polygon or MultiPolygon")
        return geojson
    
    # Case 3: Geometry object
    elif geojson_type in ["polygon", "multipolygon", "point", "linestring", "multipoint", "multilinestring"]:
        geom_type = geojson_type
        if geom_type not in ["polygon", "multipolygon"]:
            raise ValueError(f"Geometry type '{geom_type}' is not Polygon or MultiPolygon")
        return {
            "type": "Feature",
            "properties": {},
            "geometry": geojson
        }
    
    # Unknown type
    else:
        raise ValueError(f"Unknown or unsupported GeoJSON type: {geojson.get('type', 'unknown')}")


def build_report_metadata(
    raster_name: str,
    raster_path: Optional[str],
    context: Optional[Dict[str, Any]],
    stats: Dict[str, Any],
    bounds: Dict[str, float],
    pixel_values: List[float],
    export_id: str,
) -> Dict[str, Any]:
    """Build comprehensive report metadata for embedding in exports."""
    
    # Calculate histogram bins
    valid_pixels = np.array([v for v in pixel_values if np.isfinite(v)]) if pixel_values else np.array([])
    bin_counts = np.zeros(10, dtype=int)
    if len(valid_pixels) > 0:
        for v in valid_pixels:
            clamped = max(0, min(100, v))
            idx = 9 if clamped == 100 else max(0, min(9, int(np.floor(clamped / 10))))
            bin_counts[idx] += 1
    
    total_count = bin_counts.sum() or 1
    histogram = {
        "bins": [
            {
                "range": range_label,
                "count": int(count),
                "percentage": float((count / total_count) * 100) if total_count > 0 else 0.0
            }
            for range_label, count in zip(
                get_histogram_bin_ranges(),
                bin_counts
            )
        ]
    }
    
    # Calculate percentiles
    percentiles = {}
    if len(valid_pixels) > 0:
        sorted_pixels = np.sort(valid_pixels)
        for p in [10, 25, 50, 75, 90]:
            idx = max(0, min(len(sorted_pixels) - 1, int((p / 100) * (len(sorted_pixels) - 1))))
            percentiles[f"p{p}"] = float(sorted_pixels[idx])
    
    # Calculate median
    median = float(np.median(valid_pixels)) if len(valid_pixels) > 0 else None
    
    report = {
        "export_date": datetime.now().isoformat(),
        "export_id": export_id,
        "software": "VMRC Portal",
        "raster": {
            "name": raster_name,
            "path": str(raster_path) if raster_path else None,
        },
        "context": context or {},
        "aoi": {
            "bounds": bounds,
        },
        "statistics": {
            **stats,
            "median": median,
            "percentiles": percentiles,
        },
        "histogram": histogram,
    }
    
    return report


def export_multi_aoi_pdf(req: ExportRequest):
    """
    Generate a PDF with one page per AOI when multiple overlay URLs are provided.
    """
    if not HAS_REPORTLAB:
        raise HTTPException(status_code=400, detail="reportlab not installed. Install with: pip install reportlab")
    
    if not req.overlay_urls or len(req.overlay_urls) == 0:
        raise HTTPException(status_code=400, detail="overlay_urls must be provided for multi-AOI export")
    
    # Prepare output directory
    export_id = uuid.uuid4().hex[:8]
    # Build base filename from context filters (with HSL/WH rules)
    if req.filename:
        base_filename = sanitize_filename(req.filename)
    else:
        # Use filter-based filename (without extension - will be added per format)
        base_filename = build_export_filename(req.context, "")
        if not base_filename:
            base_filename = generate_default_filename()
    out_dir = Path("static/exports") / export_id
    out_dir.mkdir(parents=True, exist_ok=True)
    
    pdf_name = f"{base_filename}.pdf"
    pdf_path = out_dir / pdf_name
    
    # Create PDF with header callbacks
    letter_size = letter  # 8.5" x 11"
    
    # Header callbacks - apply header on every page
    def on_first_page_multi(canvas, doc):
        """Add header on first page."""
        print("[PDF MULTI-AOI] 🔵 on_first_page callback triggered")
        draw_pdf_header(canvas, doc, letter_size)
        print("[PDF MULTI-AOI] 🔵 on_first_page callback complete")
    
    def on_later_pages_multi(canvas, doc):
        """Add header on subsequent pages."""
        print("[PDF MULTI-AOI] 🔵 on_later_pages callback triggered")
        draw_pdf_header(canvas, doc, letter_size)
        print("[PDF MULTI-AOI] 🔵 on_later_pages callback complete")
    
    # Calculate top margin: HEADER_H (60pt) + 20pt padding = 80pt
    HEADER_H = 60  # Header height in points
    header_margin = (HEADER_H + 20) / 72.0 * inch  # Convert points to inches (72pt = 1 inch)
    print(f"[PDF MULTI-AOI] Header margin: {header_margin} inches ({HEADER_H + 20} points)")
    
    doc = SimpleDocTemplate(
        str(pdf_path),
        pagesize=letter_size,
        topMargin=header_margin,  # CRITICAL: Content starts BELOW header (HEADER_H + 20pt)
        bottomMargin=0.5*inch,
        leftMargin=0.5*inch,
        rightMargin=0.5*inch,
        onFirstPage=on_first_page_multi,
        onLaterPages=on_later_pages_multi,
    )
    story = []
    styles = getSampleStyleSheet()
    
    # Get raster name
    try:
        raster_path = resolve_raster_path(req.raster_layer_id)
        raster_name = Path(raster_path).name
    except Exception as e:
        print(f"Warning: Could not resolve raster path: {e}")
        raster_name = "unknown.tif"
    
    # Build dataset title from context (same display values as Raster/Selection Summary)
    dataset_title = "VMRC Seedling Mortality Simulator"
    if req.context:
        parts = [v for (_, v) in format_report_selections(req.context) if v and v != "—"]
        if parts:
            dataset_title = " · ".join(parts)
    
    # Generate one page per AOI
    for idx, aoi_data in enumerate(req.overlay_urls):
        overlay_url = aoi_data.get("overlay_url", "")
        aoi_name = aoi_data.get("aoi_name", f"AOI {idx + 1}")
        aoi_stats = aoi_data.get("stats", {})
        aoi_bounds = aoi_data.get("bounds", {})
        aoi_geojson = aoi_data.get("user_clip_geojson", req.user_clip_geojson)
        
        # Page break (except for first page)
        if idx > 0:
            story.append(PageBreak())
        
        # Title
        title_style = ParagraphStyle(
            'CustomTitle',
            parent=styles['Heading1'],
            fontSize=24,
            textColor=colors.HexColor('#111827'),
            spaceAfter=30,
        )
        story.append(Paragraph(dataset_title, title_style))
        story.append(Spacer(1, 0.2*inch))
        
        # REMOVED: AOI line - do not show AOI in PDF
        # story.append(Paragraph(f"<b>AOI:</b> {aoi_name}", styles['Normal']))
        # story.append(Spacer(1, 0.1*inch))
        
        # Date/Time
        story.append(Paragraph(f"<b>Export Date:</b> {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}", styles['Normal']))
        story.append(Spacer(1, 0.3*inch))
        
        # Raster Info
        story.append(Paragraph("<b>Raster Information</b>", styles['Heading2']))
        raster_table_data = [["Raster Name:", raster_name]]
        raster_table = Table(raster_table_data, colWidths=[2*inch, 4.5*inch])
        raster_table.setStyle(TableStyle([
            ('BACKGROUND', (0, 0), (0, -1), colors.HexColor('#f9fafb')),
            ('TEXTCOLOR', (0, 0), (-1, -1), colors.HexColor('#111827')),
            ('ALIGN', (0, 0), (-1, -1), 'LEFT'),
            ('FONTNAME', (0, 0), (0, -1), 'Helvetica-Bold'),
            ('FONTSIZE', (0, 0), (-1, -1), 10),
            ('BOTTOMPADDING', (0, 0), (-1, -1), 6),
            ('TOPPADDING', (0, 0), (-1, -1), 6),
            ('GRID', (0, 0), (-1, -1), 0.5, colors.HexColor('#e5e7eb')),
        ]))
        story.append(raster_table)
        story.append(Spacer(1, 0.3*inch))
        
        # Statistics (if available)
        if aoi_stats:
            story.append(Paragraph("<b>Statistics</b>", styles['Heading2']))
            stats_data = [
                ["Count:", str(aoi_stats.get("count", "N/A"))],
                ["Min:", f"{aoi_stats.get('min', 0):.2f}"],
                ["Max:", f"{aoi_stats.get('max', 0):.2f}"],
                ["Mean:", f"{aoi_stats.get('mean', 0):.2f}"],
                ["Std Dev:", f"{aoi_stats.get('std', 0):.2f}"],
            ]
            stats_table = Table(stats_data, colWidths=[2*inch, 4.5*inch])
            stats_table.setStyle(TableStyle([
                ('BACKGROUND', (0, 0), (0, -1), colors.HexColor('#f9fafb')),
                ('TEXTCOLOR', (0, 0), (-1, -1), colors.HexColor('#111827')),
                ('ALIGN', (0, 0), (-1, -1), 'LEFT'),
                ('FONTNAME', (0, 0), (0, -1), 'Helvetica-Bold'),
                ('FONTSIZE', (0, 0), (-1, -1), 10),
                ('BOTTOMPADDING', (0, 0), (-1, -1), 6),
                ('TOPPADDING', (0, 0), (-1, -1), 6),
                ('GRID', (0, 0), (-1, -1), 0.5, colors.HexColor('#e5e7eb')),
            ]))
            story.append(stats_table)
            story.append(Spacer(1, 0.3*inch))
        
        # Preview Image
        story.append(Paragraph("<b>Preview Image</b>", styles['Heading2']))
        story.append(Spacer(1, 0.2*inch))
        
        try:
            if overlay_url:
                overlay_filename = Path(overlay_url).name
                overlay_path = Path("static/overlays") / overlay_filename
                
                if overlay_path.exists():
                    print(f"[EXPORT] Using local overlay file: {overlay_path}")
                    try:
                        img = Image(str(overlay_path), width=6.5*inch, height=6.5*inch, kind='proportional')
                        img_table = Table([[img]], colWidths=[6.5*inch])
                        img_table.setStyle(TableStyle([
                            ('GRID', (0, 0), (-1, -1), 1, colors.HexColor('#d1d5db')),
                            ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
                        ]))
                        story.append(img_table)
                        print(f"[EXPORT] ✓ Preview image embedded for AOI: {aoi_name}")
                    except Exception as local_err:
                        print(f"[EXPORT] Warning: Failed to load local image: {local_err}")
                        story.append(Paragraph("Preview unavailable", styles['Normal']))
                else:
                    data_url = fetch_image_as_base64(overlay_url)
                    if data_url:
                        img = Image(data_url, width=6.5*inch, height=6.5*inch, kind='proportional')
                        img_table = Table([[img]], colWidths=[6.5*inch])
                        img_table.setStyle(TableStyle([
                            ('GRID', (0, 0), (-1, -1), 1, colors.HexColor('#d1d5db')),
                            ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
                        ]))
                        story.append(img_table)
                        print(f"[EXPORT] ✓ Preview image embedded from URL for AOI: {aoi_name}")
                    else:
                        story.append(Paragraph("Preview unavailable", styles['Normal']))
            else:
                story.append(Paragraph("Preview unavailable", styles['Normal']))
        except Exception as img_err:
            print(f"[EXPORT] Warning: Could not embed preview image for AOI {aoi_name}: {img_err}")
            story.append(Paragraph("Preview unavailable", styles['Normal']))
    
    # Build PDF
    print(f"[EXPORT] Building multi-AOI PDF document...")
    doc.build(story)
    print(f"[EXPORT] ✓ Multi-AOI PDF exported successfully: {pdf_path}")
    
    return {
        "status": "success",
        "files": {
            "pdf": f"/static/exports/{export_id}/{pdf_name}"
        }
    }


@router.post("/export")
def export_raster(req: ExportRequest):
    """Exports clipped raster in multiple formats: PNG, TIF, CSV, GeoJSON, JSON, PDF."""
    
    if not req.formats:
        raise HTTPException(status_code=400, detail="At least one format must be selected")

    # ============================================================
    # HANDLE MULTI-AOI EXPORT (if overlay_urls provided)
    # ============================================================
    if req.overlay_urls and len(req.overlay_urls) > 0:
        # Multi-AOI export: generate one PDF with one page per AOI
        if "pdf" in req.formats:
            return export_multi_aoi_pdf(req)
        else:
            # For non-PDF formats, export each AOI separately
            # This is a simplified approach - could be enhanced
            raise HTTPException(status_code=400, detail="Multi-AOI export currently only supports PDF format")

    # ============================================================
    # SINGLE AOI EXPORT (existing logic)
    # ============================================================
    # Use provided overlay_url if available (skip clipping), otherwise clip fresh
    clip_result = None
    if req.overlay_url:
        # Use existing PNG overlay - get stats from context if available
        print(f"[EXPORT] Using provided overlay_url: {req.overlay_url}")
        # Get stats, histogram, and bounds from context if provided (frontend should pass stats from createdRasters)
        stats_from_context = {}
        histogram_from_context = None
        bounds_from_context = {}
        pixel_values_from_context = []
        if req.context:
            if "stats" in req.context:
                stats_from_context = req.context["stats"]
            if "histogram" in req.context:
                histogram_from_context = req.context["histogram"]
            if "bounds" in req.context:
                bounds_from_context = req.context["bounds"]
            if "pixelValues" in req.context:
                pixel_values_from_context = req.context["pixelValues"]
        
        clip_result = {
            "overlay_url": req.overlay_url,
            "stats": stats_from_context,
            "histogram": histogram_from_context,
            "bounds": bounds_from_context,
            "pixels": pixel_values_from_context,
        }
        print(f"[EXPORT] Using stats from context: {stats_from_context}")
        print(f"[EXPORT] Using histogram from context: {histogram_from_context is not None}")
    else:
        # Perform clip (same as map overlay process)
        try:
            clip_result = clip_raster_for_layer(
                raster_layer_id=req.raster_layer_id,
                user_clip_geojson=req.user_clip_geojson,
            )
        except Exception as e:
            import traceback
            traceback.print_exc()
            raise HTTPException(status_code=400, detail=f"Clip failed: {str(e)}")

    # Prepare output directory
    export_id = uuid.uuid4().hex[:8]
    # Build base filename from context filters (with HSL/WH rules)
    if req.filename:
        base_filename = sanitize_filename(req.filename)
    else:
        # Use filter-based filename (without extension - will be added per format)
        base_filename = build_export_filename(req.context, "")
        if not base_filename:
            base_filename = generate_default_filename()

    # Save exports to static/exports for serving via StaticFiles
    out_dir = Path("static/exports") / export_id
    out_dir.mkdir(parents=True, exist_ok=True)
    
    output_files = {}
    errors = {}

    # Get raster path for metadata (resolve separately since clip_result doesn't include it)
    try:
        raster_path = resolve_raster_path(req.raster_layer_id)
        raster_name = Path(raster_path).name
    except Exception as e:
        print(f"Warning: Could not resolve raster path: {e}")
        raster_path = None
        raster_name = "unknown.tif"
    
    # Get stats and pixel values from clip result
    stats = clip_result.get("stats", {})
    pixel_values = clip_result.get("pixels", []) or clip_result.get("values", [])
    bounds = clip_result.get("bounds", {})
    
    # Convert pixel values to numpy array for processing
    # clip_result.pixels should already be valid pixels (nodata filtered)
    pixel_array = np.array(pixel_values) if pixel_values else np.array([])
    valid_pixels = pixel_array[np.isfinite(pixel_array)] if len(pixel_array) > 0 else np.array([])
    
    # Build report metadata for embedding
    report_metadata = build_report_metadata(
        raster_name=raster_name,
        raster_path=raster_path,
        context=req.context,
        stats=stats,
        bounds=bounds,
        pixel_values=pixel_values,
        export_id=export_id,
    )

    # --------------------------------
    # EXPORT PNG (with metadata embedding)
    # --------------------------------
    if "png" in req.formats:
        try:
            # Use the overlay URL from clip result
            overlay_url = clip_result.get("overlay_url")
            if overlay_url:
                # Copy PNG and embed metadata
                overlay_filename = Path(overlay_url).name
                source_png_path = Path("static/overlays") / overlay_filename
                
                if source_png_path.exists():
                    # Create export PNG with metadata
                    png_name = f"{base_filename}.png"
                    png_path = out_dir / png_name
                    
                    # Use Pillow to read, add metadata, and save
                    from PIL import Image, PngImagePlugin
                    
                    img = Image.open(source_png_path)
                    
                    # Create PNG metadata chunks
                    pnginfo = PngImagePlugin.PngInfo()
                    
                    # Add report as JSON in text chunk
                    report_json = json.dumps(report_metadata, indent=2)
                    pnginfo.add_text("VMRC_Report", report_json)
                    
                    # Add individual fields as text chunks for easy reading
                    context = req.context or {}
                    pnginfo.add_text("VMRC_RasterName", raster_name)
                    pnginfo.add_text("VMRC_RasterPath", str(raster_path) if raster_path else "")
                    pnginfo.add_text("VMRC_MapType", str(context.get("mapType", "")))
                    pnginfo.add_text("VMRC_Species", str(context.get("species", "")))
                    pnginfo.add_text("VMRC_ExportID", export_id)
                    pnginfo.add_text("VMRC_CreatedAt", datetime.now().isoformat())
                    
                    # Save with metadata
                    img.save(png_path, "PNG", pnginfo=pnginfo)
                    
                    output_files["png"] = f"/static/exports/{export_id}/{png_name}"
                else:
                    # Fallback: use original overlay URL
                    output_files["png"] = overlay_url
            else:
                errors["png"] = "PNG overlay not available"
        except Exception as e:
            import traceback
            traceback.print_exc()
            errors["png"] = str(e)

    # --------------------------------
    # EXPORT GeoTIFF
    # --------------------------------
    if "tif" in req.formats:
        try:
            print(f"[EXPORT] Generating GeoTIFF export...")
            if not raster_path:
                errors["tif"] = "Raster path not available"
                print(f"[EXPORT] GeoTIFF error: Raster path not available")
            else:
                tif_name = f"{base_filename}.tif"
                tif_path = out_dir / tif_name
                print(f"[EXPORT] GeoTIFF output path: {tif_path}")

                # Normalize GeoJSON to single Feature before parsing geometry
                try:
                    export_feature = normalize_for_export(req.user_clip_geojson)
                    geom_dict = export_feature.get("geometry")
                    if not geom_dict:
                        raise ValueError("Normalized feature has no geometry")
                    user_geom_4326 = shape(geom_dict)
                except Exception as norm_err:
                    print(f"[EXPORT] GeoTIFF: Failed to normalize GeoJSON: {norm_err}")
                    raise ValueError(f"Cannot parse geometry from GeoJSON: {norm_err}")
                
                # Ensure geometry is valid
                if not user_geom_4326.is_valid:
                    print(f"[EXPORT] Geometry invalid, attempting to fix...")
                    user_geom_4326 = make_valid(user_geom_4326)
                
                print(f"[EXPORT] Opening raster: {raster_path}")
                with rasterio.open(raster_path) as src:
                    # Log source raster properties
                    print(f"[EXPORT] ========== SOURCE RASTER PROPERTIES ==========")
                    print(f"[EXPORT] Source CRS: {src.crs}")
                    print(f"[EXPORT] Source transform: {src.transform}")
                    print(f"[EXPORT] Source width: {src.width}, height: {src.height}")
                    print(f"[EXPORT] Source dtype: {src.dtypes[0]}")
                    print(f"[EXPORT] Source nodata: {src.nodata}")
                    print(f"[EXPORT] Source bounds: {src.bounds}")
                    print(f"[EXPORT] ==============================================")
                    
                    raster_crs = src.crs
                    
                    # Reproject geometry to raster CRS
                    print(f"[EXPORT] Reprojecting geometry from EPSG:4326 to {raster_crs}")
                    aoi_geom_src = mapping(user_geom_4326)  # Convert shapely to GeoJSON dict
                    aoi_geom_raster_crs = transform_geom(
                        "EPSG:4326",
                        raster_crs.to_string() if hasattr(raster_crs, 'to_string') else str(raster_crs),
                        aoi_geom_src,
                        precision=6
                    )
                    
                    # Convert back to shapely for bounds calculation
                    aoi_geom_shapely = shape(aoi_geom_raster_crs)
                    
                    # Get bounds of reprojected geometry
                    aoi_bounds = aoi_geom_shapely.bounds  # (minx, miny, maxx, maxy)
                    print(f"[EXPORT] AOI bounds in raster CRS: {aoi_bounds}")
                    
                    # ============================================================
                    # COMPUTE PIXEL-ALIGNED WINDOW
                    # ============================================================
                    # This ensures the output aligns with the source grid
                    # No resampling, no warping - just a true clip of source pixels
                    print(f"[EXPORT] Computing pixel-aligned window...")
                    win = from_bounds(
                        aoi_bounds[0],  # minx (west)
                        aoi_bounds[1],  # miny (south)
                        aoi_bounds[2],  # maxx (east)
                        aoi_bounds[3],  # maxy (north)
                        src.transform
                    )
                    
                    # Round window to pixel boundaries (align to source grid)
                    win = win.round_offsets().round_lengths()
                    print(f"[EXPORT] Pixel-aligned window: {win}")
                    print(f"[EXPORT] Window row_off: {win.row_off}, col_off: {win.col_off}")
                    print(f"[EXPORT] Window height: {win.height}, width: {win.width}")
                    
                    # Ensure window is within source bounds
                    # Clamp window offsets and sizes to source dimensions
                    row_off = max(0, int(win.row_off))
                    col_off = max(0, int(win.col_off))
                    row_end = min(src.height, row_off + int(win.height))
                    col_end = min(src.width, col_off + int(win.width))
                    
                    # Recreate window with clamped bounds
                    win = Window(col_off=col_off, row_off=row_off, width=col_end - col_off, height=row_end - row_off)
                    print(f"[EXPORT] Clamped window: row_off={row_off}, col_off={col_off}, height={win.height}, width={win.width}")
                    
                    # Read raw band data from window (no resampling, no warping)
                    print(f"[EXPORT] Reading raw data from window...")
                    windowed_data = src.read(window=win)
                    print(f"[EXPORT] Windowed data shape: {windowed_data.shape}")
                    
                    # Get transform for the window (aligned to source grid)
                    out_transform = src.window_transform(win)
                    print(f"[EXPORT] Output transform: {out_transform}")
                    
                    # Determine nodata value: use source nodata if available
                    nodata_value = src.nodata
                    if nodata_value is None:
                        # Choose a safe nodata value based on dtype
                        if np.issubdtype(src.dtypes[0], np.integer):
                            if src.dtypes[0] == np.uint8:
                                nodata_value = 255
                            elif src.dtypes[0] == np.uint16:
                                nodata_value = 65535
                            else:
                                nodata_value = -9999
                        else:
                            nodata_value = -9999
                        print(f"[EXPORT] Source has no nodata, using {nodata_value} as nodata value")
                    
                    # Create mask for the windowed data
                    # geometry_mask with invert=False returns True for pixels OUTSIDE the geometry
                    # We want to mask (set to nodata) pixels outside the geometry
                    print(f"[EXPORT] Creating geometry mask for windowed data...")
                    mask_array = geometry_mask(
                        [aoi_geom_raster_crs],
                        out_shape=(win.height, win.width),
                        transform=out_transform,
                        invert=False,  # False = True for pixels OUTSIDE geometry (should be masked)
                        all_touched=True  # Include any pixel touched by boundary
                    )
                    
                    # Apply mask: set pixels outside geometry to nodata
                    # mask_array is True for pixels OUTSIDE the geometry
                    for band_idx in range(windowed_data.shape[0]):
                        windowed_data[band_idx][mask_array] = nodata_value
                    
                    print(f"[EXPORT] Mask applied. Final data shape: {windowed_data.shape}")
                    
                    # ============================================================
                    # BUILD OUTPUT METADATA (preserve source properties)
                    # ============================================================
                    meta = src.profile.copy()  # Start with source profile
                    meta.update({
                        "height": win.height,
                        "width": win.width,
                        "transform": out_transform,
                        "driver": "GTiff",
                        "compress": "lzw",
                        "nodata": nodata_value,
                    })
                    
                    # Log output properties for comparison
                    print(f"[EXPORT] ========== OUTPUT RASTER PROPERTIES ==========")
                    print(f"[EXPORT] Output CRS: {meta['crs']}")
                    print(f"[EXPORT] Output transform: {meta['transform']}")
                    print(f"[EXPORT] Output width: {meta['width']}, height: {meta['height']}")
                    print(f"[EXPORT] Output dtype: {meta['dtype']}")
                    print(f"[EXPORT] Output nodata: {meta['nodata']}")
                    print(f"[EXPORT] ==============================================")
                    
                    # Build tags for metadata embedding
                    tags = {}
                    
                    # ImageDescription: compact JSON report
                    report_json_compact = json.dumps(report_metadata, separators=(',', ':'))
                    # Truncate if too long (TIFF tag has size limit)
                    if len(report_json_compact) > 65000:
                        report_json_compact = report_json_compact[:65000] + "..."
                    tags["TIFFTAG_IMAGEDESCRIPTION"] = report_json_compact
                    
                    # Custom VMRC tags
                    context = req.context or {}
                    tags["vmrc:raster_name"] = raster_name
                    tags["vmrc:raster_path"] = str(raster_path) if raster_path else ""
                    tags["vmrc:map_type"] = str(context.get("mapType", ""))
                    tags["vmrc:species"] = str(context.get("species", ""))
                    tags["vmrc:cover_percent"] = str(context.get("coverPercent", ""))
                    tags["vmrc:condition"] = str(context.get("condition", ""))
                    tags["vmrc:month"] = str(context.get("month", ""))
                    tags["vmrc:stress_level"] = str(context.get("stressLevel", ""))
                    tags["vmrc:export_id"] = export_id
                    tags["vmrc:created_at"] = datetime.now().isoformat()
                    tags["vmrc:software"] = "VMRC Portal"
                    
                    print(f"[EXPORT] Writing GeoTIFF to {tif_path}...")
                    with rasterio.open(tif_path, "w", **meta) as dst:
                        dst.write(windowed_data)
                        # Write tags
                        dst.update_tags(**tags)
                    
                    # Write ArcGIS-readable metadata after file is created
                    context = req.context or {}
                    arcgis_metadata = build_arcgis_metadata(context, raster_name)
                    
                    # Write embedded TIFF tags
                    write_arcgis_metadata(tif_path, arcgis_metadata)
                    
                    # Write sidecar XML file for ArcGIS (<name>.tif.xml)
                    xml_path_result = write_arcgis_tif_xml(tif_path, arcgis_metadata)
                    
                    print(f"[EXPORT] ✓ GeoTIFF exported successfully: {tif_path}")
                    
                    # Create ZIP file containing .tif and .tif.xml (and any .aux.xml)
                    zip_name = f"{base_filename}.zip"
                    zip_path = out_dir / zip_name
                    
                    if create_tif_zip(tif_path, zip_path):
                        # Return ZIP file instead of individual .tif file
                        output_files["tif"] = f"/static/exports/{export_id}/{zip_name}"
                        print(f"[EXPORT] ✓ ZIP archive created: {zip_name}")
                    else:
                        # Fallback: return individual .tif file if ZIP creation failed
                        output_files["tif"] = f"/static/exports/{export_id}/{tif_name}"
                        print(f"[EXPORT] WARNING: ZIP creation failed, returning individual .tif file")
                    
                    # Include XML metadata path in response for debugging (even though it's in the ZIP)
                    if xml_path_result:
                        # Convert to relative path for API response
                        try:
                            xml_path_obj = Path(xml_path_result)
                            # Get just the filename (e.g., "55.tif.xml")
                            xml_filename = xml_path_obj.name
                            output_files["tif_xml"] = f"/static/exports/{export_id}/{xml_filename}"
                            print(f"[EXPORT] XML metadata path in response: {output_files['tif_xml']}")
                        except Exception as rel_err:
                            print(f"[EXPORT] Warning: Could not compute relative XML path: {rel_err}")
                            # Fallback: use the full path as-is
                            output_files["tif_xml"] = xml_path_result
                    else:
                        print(f"[EXPORT] WARNING: XML metadata file was not created")
        except Exception as e:
            import traceback
            error_msg = f"GeoTIFF export failed: {str(e)}"
            print(f"[EXPORT] ERROR: {error_msg}")
            traceback.print_exc()
            errors["tif"] = error_msg

    # --------------------------------
    # EXPORT CSV (Histogram bins + stats)
    # --------------------------------
    if "csv" in req.formats:
        try:
            csv_name = f"{base_filename}.csv"
            csv_path = out_dir / csv_name
            
            with open(csv_path, "w", newline="", encoding="utf-8") as f:
                writer = csv.writer(f)
                
                # Write report metadata as comment header
                writer.writerow(["# VMRC Seedling Mortality Simulator Export"])
                writer.writerow([f"# Export Date: {report_metadata['export_date']}"])
                writer.writerow([f"# Export ID: {export_id}"])
                writer.writerow([f"# Software: {report_metadata['software']}"])
                writer.writerow([f"# Raster: {raster_name}"])
                if raster_path:
                    writer.writerow([f"# Raster Path: {raster_path}"])
                
                context = req.context or {}
                if context:
                    writer.writerow(["# Raster / Selection Summary:"])
                    for label, value in format_report_selections(context):
                        writer.writerow([f"#   {label}: {value}"])
                writer.writerow([])
                
                # Write stats summary
                writer.writerow(["Statistics Summary"])
                writer.writerow(["Metric", "Value"])
                writer.writerow(["Count", stats.get("count", len(valid_pixels))])
                writer.writerow(["Min", f"{stats.get('min', 0):.2f}"])
                writer.writerow(["Max", f"{stats.get('max', 0):.2f}"])
                writer.writerow(["Mean", f"{stats.get('mean', 0):.2f}"])
                writer.writerow(["Std Dev", f"{stats.get('std', 0):.2f}"])
                
                # Calculate median if not in stats
                if len(valid_pixels) > 0:
                    median = float(np.median(valid_pixels))
                    writer.writerow(["Median", f"{median:.2f}"])
                else:
                    writer.writerow(["Median", "N/A"])
                writer.writerow([])
                
                # Write histogram bins
                writer.writerow(["Histogram Bins"])
                writer.writerow(["Range", "Count", "Percentage"])
                
                bin_counts = np.zeros(10, dtype=int)
                if len(valid_pixels) > 0:
                    for v in valid_pixels:
                        clamped = max(0, min(100, v))
                        idx = 9 if clamped == 100 else max(0, min(9, int(np.floor(clamped / 10))))
                        bin_counts[idx] += 1
                
                total_count = bin_counts.sum() or 1
                bin_ranges = get_histogram_bin_ranges()
                
                for i, (range_label, count) in enumerate(zip(bin_ranges, bin_counts)):
                    percentage = (count / total_count) * 100 if total_count > 0 else 0
                    writer.writerow([range_label, count, f"{percentage:.2f}%"])
            
            output_files["csv"] = f"/static/exports/{export_id}/{csv_name}"
        except Exception as e:
            import traceback
            traceback.print_exc()
            errors["csv"] = str(e)

    # --------------------------------
    # EXPORT GeoJSON (AOI geometry)
    # --------------------------------
    if "geojson" in req.formats:
        try:
            geojson_name = f"{base_filename}_aoi.geojson"
            geojson_path = out_dir / geojson_name
            
            # Normalize GeoJSON to single Feature for GeoJSON export
            try:
                export_feature = normalize_for_export(req.user_clip_geojson)
                geometry = export_feature.get("geometry")
                if not geometry:
                    raise ValueError("Normalized feature has no geometry")
            except Exception as norm_err:
                print(f"[EXPORT] GeoJSON: Failed to normalize GeoJSON: {norm_err}")
                # Fallback: try to extract geometry directly
                if req.user_clip_geojson.get("type") == "Feature":
                    geometry = req.user_clip_geojson.get("geometry", req.user_clip_geojson)
                elif "geometry" in req.user_clip_geojson:
                    geometry = req.user_clip_geojson["geometry"]
                else:
                    geometry = req.user_clip_geojson
            
            # Include full report metadata in properties
            feature_collection = {
                "type": "FeatureCollection",
                "features": [
                    {
                        "type": "Feature",
                        "geometry": geometry,
                        "properties": {
                            "name": "User AOI",
                            "export_date": datetime.now().isoformat(),
                            "vmrc_report": report_metadata,  # Full report embedded
                        }
                    }
                ]
            }
            
            with open(geojson_path, "w", encoding="utf-8") as f:
                json.dump(feature_collection, f, indent=2)
            
            output_files["geojson"] = f"/static/exports/{export_id}/{geojson_name}"
        except Exception as e:
            import traceback
            traceback.print_exc()
            errors["geojson"] = str(e)

    # --------------------------------
    # EXPORT JSON (metadata)
    # --------------------------------
    if "json" in req.formats:
        try:
            json_name = f"{base_filename}_metadata.json"
            json_path = out_dir / json_name
            
            # JSON export IS the report metadata (already built)
            metadata = report_metadata.copy()
            metadata["raster"]["layer_id"] = req.raster_layer_id
            # Parse geometry type from normalized feature
            try:
                export_feature = normalize_for_export(req.user_clip_geojson)
                geom_type = export_feature.get("geometry", {}).get("type", "Unknown")
            except Exception:
                # Fallback: try to get type from original
                if "geometry" in req.user_clip_geojson:
                    geom_type = req.user_clip_geojson["geometry"].get("type", "Unknown")
                else:
                    geom_type = req.user_clip_geojson.get("type", "Unknown")
            metadata["aoi"]["geometry_type"] = geom_type
            
            with open(json_path, "w", encoding="utf-8") as f:
                json.dump(metadata, f, indent=2)
            
            output_files["json"] = f"/static/exports/{export_id}/{json_name}"
        except Exception as e:
            import traceback
            traceback.print_exc()
            errors["json"] = str(e)

    # --------------------------------
    # EXPORT PDF (Report)
    # --------------------------------
    if "pdf" in req.formats:
        if not HAS_REPORTLAB:
            error_msg = "reportlab not installed. Install with: pip install reportlab"
            print(f"[EXPORT] PDF error: {error_msg}")
            errors["pdf"] = error_msg
        else:
            try:
                print(f"[EXPORT] Generating PDF report with raster preview...")
                pdf_name = f"{base_filename}.pdf"
                pdf_path = out_dir / pdf_name
                
                # ============================================================
                # LOAD PNG OVERLAY BYTES (same colorized PNG as map overlay)
                # ============================================================
                png_bytes = None
                overlay_url = req.overlay_url or clip_result.get("overlay_url", "")
                
                if overlay_url:
                    overlay_filename = Path(overlay_url).name
                    overlay_path = Path("static/overlays") / overlay_filename
                    
                    if overlay_path.exists():
                        # Load PNG bytes from local file
                        print(f"[EXPORT] Loading PNG overlay from: {overlay_path}")
                        try:
                            with open(overlay_path, "rb") as f:
                                png_bytes = f.read()
                            print(f"[EXPORT] ✓ Loaded PNG overlay ({len(png_bytes)} bytes)")
                        except Exception as load_err:
                            print(f"[EXPORT] Warning: Failed to load PNG file: {load_err}")
                            png_bytes = None
                    else:
                        # Try fetching from URL
                        print(f"[EXPORT] Local file not found, fetching from URL: {overlay_url}")
                        if HAS_REQUESTS:
                            try:
                                base_url = "http://127.0.0.1:8000"
                                if overlay_url.startswith("/"):
                                    full_url = f"{base_url}{overlay_url}"
                                else:
                                    full_url = f"{base_url}/{overlay_url}"
                                
                                response = requests.get(full_url, timeout=10)
                                response.raise_for_status()
                                png_bytes = response.content
                                print(f"[EXPORT] ✓ Fetched PNG overlay from URL ({len(png_bytes)} bytes)")
                            except Exception as fetch_err:
                                print(f"[EXPORT] Warning: Failed to fetch PNG from URL: {fetch_err}")
                                png_bytes = None
                
                # If PNG still not available, generate it now
                if not png_bytes:
                    print(f"[EXPORT] PNG overlay not found, generating new preview...")
                    try:
                        png_bytes = render_clipped_preview_png(
                            raster_layer_id=req.raster_layer_id,
                            user_clip_geojson=req.user_clip_geojson
                        )
                        print(f"[EXPORT] ✓ Generated PNG preview ({len(png_bytes)} bytes)")
                    except Exception as gen_err:
                        error_msg = f"Failed to generate PNG preview: {str(gen_err)}"
                        print(f"[EXPORT] ERROR: {error_msg}")
                        import traceback
                        traceback.print_exc()
                        # Continue without image - will show "Preview image unavailable" in PDF
                
                # ============================================================
                # BUILD PDF REPORT WITH RASTER PREVIEW
                # ============================================================
                # Build title from context (same display values as Raster/Selection Summary)
                title_text = "VMRC Seedling Mortality Simulator"
                if req.context:
                    parts = [v for (_, v) in format_report_selections(req.context) if v and v != "—"]
                    if parts:
                        title_text = " · ".join(parts)
                
                # Calculate median if not in stats
                median = None
                if len(valid_pixels) > 0:
                    median = float(np.median(valid_pixels))
                elif stats.get("median") is not None:
                    median = stats.get("median")
                
                # Prepare stats dict for PDF helper
                pdf_stats = {
                    "min": stats.get("min", 0),
                    "max": stats.get("max", 0),
                    "mean": stats.get("mean", 0),
                    "median": median,
                    "std": stats.get("std", 0),
                    "count": stats.get("count", len(valid_pixels) if len(valid_pixels) > 0 else 0),
                }
                
                # Get histogram from clip_result for expanded stats
                histogram = clip_result.get("histogram")
                
                # Compute expanded statistics (Area by Threshold, Most Common Range)
                expanded_stats = compute_expanded_stats(
                    stats=pdf_stats,
                    histogram=histogram,
                    valid_pixels=valid_pixels if len(valid_pixels) > 0 else None
                )
                
                # Merge expanded stats into pdf_stats
                pdf_stats.update(expanded_stats)
                
                # Pixel area (m²) for Acres: count * pixel_area_m2 / 4046.8564224 (always set so PDF never misses key)
                pixel_area_m2 = 0.0
                if raster_path and Path(raster_path).exists():
                    try:
                        res = compute_pixel_size(Path(raster_path))
                        if res and len(res) >= 2:
                            pixel_area_m2 = float(res[0]) * float(res[1])
                    except Exception:
                        pass
                pdf_stats["pixel_area_m2"] = pixel_area_m2
                
                # Center lon/lat for caption (bounds from context may be list [[south,west],[north,east]])
                bounds = clip_result.get("bounds") or {}
                center_lon, center_lat = _bounds_to_center(bounds)
                
                # Legend bins (matching colormap)
                legend_bins = [
                    {"range": "0–10", "color": "#006400", "label": "0–10"},
                    {"range": "10–20", "color": "#228B22", "label": "10–20"},
                    {"range": "20–30", "color": "#9ACD32", "label": "20–30"},
                    {"range": "30–40", "color": "#FFD700", "label": "30–40"},
                    {"range": "40–50", "color": "#FFA500", "label": "40–50"},
                    {"range": "50–60", "color": "#FF8C00", "label": "50–60"},
                    {"range": "60–70", "color": "#FF6B00", "label": "60–70"},
                    {"range": "70–80", "color": "#FF4500", "label": "70–80"},
                    {"range": "80–90", "color": "#DC143C", "label": "80–90"},
                    {"range": "90–100", "color": "#B22222", "label": "90–100"},
                ]
                
                # Generate 2-page PDF (same layout as direct PDF download)
                raster_crs = None
                if raster_path and Path(raster_path).exists():
                    try:
                        with rasterio.open(raster_path) as src:
                            raster_crs = src.crs
                    except Exception:
                        pass
                pdf_bytes = build_pdf_report_landscape(
                    title=title_text,
                    png_bytes=png_bytes if png_bytes else b"",  # Must be bytes; empty if unavailable
                    stats=pdf_stats,
                    legend_bins=legend_bins,
                    aoi_name=req.aoi_name,
                    raster_name=raster_name,
                    raster_crs=raster_crs,
                    context=req.context,
                    center_lon=center_lon,
                    center_lat=center_lat,
                )
                    
                # Write PDF bytes to file
                with open(pdf_path, "wb") as f:
                    f.write(pdf_bytes)
                
                if png_bytes:
                    print(f"[EXPORT] ✓ PDF exported successfully with raster preview: {pdf_path}")
                else:
                    print(f"[EXPORT] ✓ PDF exported successfully (text-only, image unavailable): {pdf_path}")
                
                output_files["pdf"] = f"/static/exports/{export_id}/{pdf_name}"
                
            except Exception as e:
                import traceback
                error_msg = f"PDF export failed: {str(e)}"
                print(f"[EXPORT] ERROR: {error_msg}")
                traceback.print_exc()
                errors["pdf"] = error_msg

    # Create sidecar report files (JSON and PDF) for all exports
    # These provide metadata even if embedding fails
    try:
        # Sidecar JSON report
        sidecar_json_name = f"{base_filename}_report.json"
        sidecar_json_path = out_dir / sidecar_json_name
        with open(sidecar_json_path, "w", encoding="utf-8") as f:
            json.dump(report_metadata, f, indent=2)
        output_files["report_json"] = f"/static/exports/{export_id}/{sidecar_json_name}"
        
        # Sidecar PDF report (if reportlab available and PDF not already exported)
        if HAS_REPORTLAB and "pdf" not in req.formats:
            try:
                sidecar_pdf_name = f"{base_filename}_report.pdf"
                sidecar_pdf_path = out_dir / sidecar_pdf_name
                
                # Generate PDF report (reuse same logic as main PDF export)
                # This is a simplified version - full version already exists above
                # For sidecar, we'll create a basic report
                doc = SimpleDocTemplate(str(sidecar_pdf_path), pagesize=letter, topMargin=0.5*inch)
                story = []
                styles = getSampleStyleSheet()
                
                story.append(Paragraph("VMRC Seedling Mortality Simulator", styles['Heading1']))
                story.append(Spacer(1, 0.2*inch))
                story.append(Paragraph(f"<b>Export Date:</b> {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}", styles['Normal']))
                story.append(Spacer(1, 0.3*inch))
                
                # Add basic info
                story.append(Paragraph(f"<b>Raster:</b> {raster_name}", styles['Normal']))
                if raster_path:
                    story.append(Paragraph(f"<b>Path:</b> {str(raster_path)}", styles['Normal']))
                story.append(Spacer(1, 0.2*inch))
                story.append(Paragraph(f"<b>Export ID:</b> {export_id}", styles['Normal']))
                story.append(Spacer(1, 0.3*inch))
                
                story.append(Paragraph("For full report details, see the JSON metadata file.", styles['Normal']))
                
                doc.build(story)
                output_files["report_pdf"] = f"/static/exports/{export_id}/{sidecar_pdf_name}"
            except Exception as pdf_err:
                print(f"Warning: Could not create sidecar PDF: {pdf_err}")
    except Exception as sidecar_err:
        print(f"Warning: Could not create sidecar report files: {sidecar_err}")
    
    # Return results
    print(f"\n[EXPORT] Export complete. Generated {len(output_files)} files.")
    print(f"[EXPORT] Output files: {list(output_files.keys())}")
    if errors:
        print(f"[EXPORT] Errors: {errors}")
    
    response = {
        "status": "success" if output_files and not errors else ("partial" if output_files else "failed"),
        "files": output_files,
    }
    
    if errors:
        response["errors"] = errors
    
    return response


# ============================================================
# DEDICATED PDF EXPORT ENDPOINT
# ============================================================
@router.post("/export/pdf", summary="Generate PDF report with raster map and statistics")
async def export_pdf_report(req: PDFExportRequest):
    """
    Generate a professional PDF report with:
    - Clipped raster map visualization (same colors as UI)
    - Statistics summary (exactly matching UI values)
    - Auto-generated filename based on dataset selection
    - Clean, professional report-style layout (landscape orientation)
    
    This endpoint reuses the same PNG overlay and statistics from clip_raster_for_layer()
    to ensure PDF matches the web UI exactly.
    """
    if not HAS_REPORTLAB:
        raise HTTPException(
            status_code=503,
            detail="PDF export requires reportlab. Install with: pip install reportlab"
        )
    
    try:
        print(f"\n[PDF EXPORT] Starting PDF generation...")
        print(f"[PDF EXPORT] Raster layer ID: {req.raster_layer_id}")
        print(f"[PDF EXPORT] AOI name: {req.aoi_name}")
        print(f"[PDF EXPORT] Context: {req.context}")
        
        # ============================================================
        # STEP 1: Get PNG overlay and stats (reuse existing logic)
        # ============================================================
        png_bytes = None
        stats = None
        bounds = None
        clip_result = None  # kept for histogram / expanded stats when we re-clip
        raster_crs = None
        raster_name = None
        
        if req.overlay_url and req.stats:
            # Use provided overlay and stats (from frontend createdRasters)
            print(f"[PDF EXPORT] Using provided overlay_url and stats")
            overlay_filename = Path(req.overlay_url).name
            overlay_path = Path("static/overlays") / overlay_filename
            
            if overlay_path.exists():
                with open(overlay_path, "rb") as f:
                    png_bytes = f.read()
                stats = req.stats
                print(f"[PDF EXPORT] ✓ Loaded PNG overlay ({len(png_bytes)} bytes)")
                print(f"[PDF EXPORT] ✓ Using provided stats: {stats}")
            else:
                print(f"[PDF EXPORT] Warning: Overlay file not found, will re-clip")
        
        if not png_bytes or not stats:
            # Re-clip raster to get PNG overlay and stats
            print(f"[PDF EXPORT] Clipping raster to generate PNG overlay and stats...")
            from app.services.raster_service import clip_raster_for_layer
            
            clip_result = clip_raster_for_layer(
                raster_layer_id=req.raster_layer_id,
                user_clip_geojson=req.user_clip_geojson,
                zoom=None  # Use native resolution for PDF (no zoom-based resampling)
            )
            
            # Extract PNG overlay
            overlay_url = clip_result.get("overlay_url", "")
            if overlay_url:
                overlay_filename = Path(overlay_url).name
                overlay_path = Path("static/overlays") / overlay_filename
                if overlay_path.exists():
                    with open(overlay_path, "rb") as f:
                        png_bytes = f.read()
                    print(f"[PDF EXPORT] ✓ Generated PNG overlay ({len(png_bytes)} bytes)")
            
            # Extract stats (exactly as computed for UI)
            stats = clip_result.get("stats", {})
            bounds = clip_result.get("bounds", {})
            print(f"[PDF EXPORT] ✓ Extracted stats: {stats}")
        
        if not png_bytes:
            raise HTTPException(
                status_code=500,
                detail="Failed to generate or load PNG overlay for PDF"
            )
        
        if not stats:
            raise HTTPException(
                status_code=500,
                detail="Failed to compute statistics for PDF"
            )
        
        # Bounds (for center caption) — from clip_result when we re-clipped
        bounds = clip_result.get("bounds", {}) if clip_result else {}
        
        # Get raster info for footer and pixel area for Acres
        raster_path = None
        try:
            from app.services.raster_service import resolve_raster_path
            from app.services.raster_index import RASTER_LOOKUP_LIST
            
            raster_path = resolve_raster_path(req.raster_layer_id)
            raster_item = next((r for r in RASTER_LOOKUP_LIST if r["id"] == req.raster_layer_id), None)
            raster_name = raster_item.get("name", "Unknown") if raster_item else "Unknown"
            
            # Get CRS from raster file
            with rasterio.open(raster_path) as src:
                raster_crs = src.crs
        except Exception as e:
            print(f"[PDF EXPORT] Warning: Could not get raster info: {e}")
            raster_crs = None
            raster_name = "Unknown"
        
        # ============================================================
        # STEP 2: Generate filename from actual raster filename (matches Raster Overview)
        # ============================================================
        if req.filename:
            pdf_filename = sanitize_filename(req.filename)
            if not pdf_filename.endswith(".pdf"):
                pdf_filename += ".pdf"
        else:
            # Use filter-based filename (with HSL/WH rules)
            pdf_filename = build_export_filename(req.context, ".pdf")
        
        print(f"[PDF EXPORT] PDF filename: {pdf_filename}")
        
        # ============================================================
        # STEP 3: Build title from context
        # ============================================================
        title_text = "VMRC Seedling Mortality Simulator"
        context = req.context or {}
        if context:
            parts = [v for (_, v) in format_report_selections(context) if v and v != "—"]
            if parts:
                title_text = " · ".join(parts)
        
        # ============================================================
        # STEP 4: Prepare stats for PDF (ensure median is included)
        # ============================================================
        pdf_stats = {
            "min": stats.get("min", 0),
            "max": stats.get("max", 0),
            "mean": stats.get("mean", 0),
            "median": stats.get("median"),  # May be None
            "std": stats.get("std", 0),
            "count": stats.get("count", 0),
        }
        
        # Calculate median if not in stats
        if pdf_stats["median"] is None and pdf_stats["count"] > 0:
            # Try to get pixel values from clip_result if available
            # Otherwise, median will be "N/A" in PDF
            pass
        
        # Merge expanded stats (area_by_mortality_class, etc.) when we have histogram
        histogram = clip_result.get("histogram") if clip_result else (context.get("histogram") if isinstance(context, dict) else None)
        expanded_stats = compute_expanded_stats(pdf_stats, histogram=histogram)
        pdf_stats.update(expanded_stats)
        
        # Pixel area (m²) for Acres in PDF
        if raster_path and Path(raster_path).exists():
            try:
                res = compute_pixel_size(Path(raster_path))
                pdf_stats["pixel_area_m2"] = (float(res[0]) * float(res[1])) if res and len(res) >= 2 else 0.0
            except Exception:
                pdf_stats["pixel_area_m2"] = 0.0
        else:
            pdf_stats["pixel_area_m2"] = 0.0
        
        center_lon, center_lat = _bounds_to_center(bounds)
        
        # ============================================================
        # STEP 5: Generate PDF with landscape orientation
        # ============================================================
        print("[PDF EXPORT] 🔵 PDF export: START")
        print("[PDF EXPORT] 🔵 About to call build_pdf_report_landscape")
        
        legend_bins = [
            {"range": "0–10", "color": "#006400", "label": "0–10"},
            {"range": "10–20", "color": "#228B22", "label": "10–20"},
            {"range": "20–30", "color": "#9ACD32", "label": "20–30"},
            {"range": "30–40", "color": "#FFD700", "label": "30–40"},
            {"range": "40–50", "color": "#FFA500", "label": "40–50"},
            {"range": "50–60", "color": "#FF8C00", "label": "50–60"},
            {"range": "60–70", "color": "#FF6B00", "label": "60–70"},
            {"range": "70–80", "color": "#FF4500", "label": "70–80"},
            {"range": "80–90", "color": "#DC143C", "label": "80–90"},
            {"range": "90–100", "color": "#B22222", "label": "90–100"},
        ]
        
        pdf_bytes = build_pdf_report_landscape(
            title=title_text,
            png_bytes=png_bytes,
            stats=pdf_stats,
            legend_bins=legend_bins,
            aoi_name=req.aoi_name,
            raster_name=raster_name,
            raster_crs=raster_crs,
            context=context,
            center_lon=center_lon,
            center_lat=center_lat,
        )
        
        print(f"[PDF EXPORT] 🔵 PDF export: COMPLETE - Generated PDF ({len(pdf_bytes)} bytes)")
        
        # ============================================================
        # STEP 6: Return PDF as streaming response
        # ============================================================
        from fastapi.responses import Response
        
        return Response(
            content=pdf_bytes,
            media_type="application/pdf",
            headers={
                "Content-Disposition": f'attachment; filename="{pdf_filename}"'
            }
        )
        
    except HTTPException:
        raise
    except Exception as e:
        import traceback
        error_msg = f"PDF export failed: {str(e)}"
        print(f"[PDF EXPORT] ERROR: {error_msg}")
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=error_msg)
