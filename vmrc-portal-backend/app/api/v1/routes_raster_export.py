# app/api/v1/routes_raster_export.py
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from app.services.raster_service import clip_raster_for_layer, resolve_raster_path
from pathlib import Path
import rasterio
from rasterio.mask import mask
from shapely.geometry import shape, mapping, Polygon, MultiPolygon
from shapely.validation import make_valid
from shapely.ops import transform as shapely_transform, unary_union
from pyproj import Transformer
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

# Try to import requests for image fetching
try:
    import requests
    HAS_REQUESTS = True
except ImportError:
    HAS_REQUESTS = False
    print("WARNING: requests not installed. Preview image embedding in PDF may not work.")

# PDF generation imports
try:
    from reportlab.lib.pagesizes import letter, A4
    from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
    from reportlab.lib.units import inch
    from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, Image, PageBreak
    from reportlab.lib import colors
    from reportlab.pdfgen import canvas
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


def get_histogram_bin_ranges() -> List[str]:
    """Get histogram bin range labels with en dash (prevents Excel auto-formatting)."""
    return ["0–10", "10–20", "20–30", "30–40", "40–50",
            "50–60", "60–70", "70–80", "80–90", "90–100"]


def build_arcgis_metadata(context: Optional[Dict[str, Any]], raster_name: str) -> Dict[str, str]:
    """
    Build ArcGIS-readable metadata tags from context and raster information.
    
    Args:
        context: Filter selections from the UI
        raster_name: Name of the raster file
        
    Returns:
        Dictionary of GDAL metadata tags for ArcGIS
    """
    context = context or {}
    
    # Build title
    map_type = expand_map_type(context.get("mapType", ""))
    species = context.get("species", "Unknown Species")
    title_parts = []
    if map_type:
        title_parts.append(map_type)
    title_parts.append(species)
    if context.get("month"):
        title_parts.append(f"Month {context.get('month')}")
    title = " - ".join(title_parts) if title_parts else raster_name
    
    # Build summary (2-3 sentences)
    summary_parts = []
    if map_type:
        summary_parts.append(f"This dataset represents {map_type.lower()} data for {species}.")
    condition = expand_condition(context.get("condition", ""))
    if condition:
        summary_parts.append(f"Climate condition: {condition}.")
    if context.get("coverPercent"):
        summary_parts.append(f"Cover percentage: {context.get('coverPercent')}%.")
    summary = " ".join(summary_parts) if summary_parts else f"VMRC raster dataset: {raster_name}"
    
    # Build full description
    desc_lines = []
    desc_lines.append("VMRC (Vegetation Mortality Risk Calculator) Export Dataset")
    desc_lines.append("")
    if map_type:
        desc_lines.append(f"Map Type: {map_type}")
    if species:
        desc_lines.append(f"Species: {species}")
    if condition:
        desc_lines.append(f"Climate Condition: {condition}")
    if context.get("coverPercent"):
        desc_lines.append(f"Cover Percentage: {context.get('coverPercent')}%")
    if context.get("month"):
        desc_lines.append(f"Month: {context.get('month')}")
    if context.get("stressLevel"):
        desc_lines.append(f"Stress Level: {context.get('stressLevel')}")
    if context.get("hslClass"):
        desc_lines.append(f"HSL Class: {context.get('hslClass')}")
    desc_lines.append("")
    desc_lines.append("This dataset was clipped to a user-defined Area of Interest (AOI) for analysis and visualization.")
    description = "\n".join(desc_lines)
    
    # Build tags (comma-separated keywords)
    tags_list = ["VMRC"]
    if map_type:
        if "Mortality" in map_type:
            tags_list.append("Mortality")
        if "High Stress Level" in map_type or "HSL" in map_type:
            tags_list.append("HSL")
    if species:
        # Add species as tag (simplified)
        species_tag = species.replace(" ", "_").replace("-", "_")
        tags_list.append(species_tag)
    if condition:
        tags_list.append(condition)
    if context.get("coverPercent"):
        tags_list.append(f"Cover_{context.get('coverPercent')}%")
    tags = ", ".join(tags_list)
    
    # Credits
    credits = "VMRC Project, University of Idaho"
    
    # Use limitations
    use_limitations = "For research and visualization purposes only."
    
    return {
        "TITLE": title,
        "SUMMARY": summary,
        "DESCRIPTION": description,
        "TAGS": tags,
        "CREDITS": credits,
        "USE_LIMITATIONS": use_limitations,
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


@router.post("/export")
def export_raster(req: ExportRequest):
    """Exports clipped raster in multiple formats: PNG, TIF, CSV, GeoJSON, JSON, PDF."""
    
    if not req.formats:
        raise HTTPException(status_code=400, detail="At least one format must be selected")

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
    base_filename = sanitize_filename(req.filename) if req.filename else generate_default_filename()

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
                    raster_crs = src.crs
                    print(f"[EXPORT] Raster CRS: {raster_crs}")
                    
                    # Reproject geometry to raster CRS (same as clip_raster_for_layer)
                    if raster_crs and raster_crs.to_string() != "EPSG:4326":
                        print(f"[EXPORT] Reprojecting geometry from EPSG:4326 to {raster_crs}")
                        transformer = Transformer.from_crs(
                            "EPSG:4326",
                            raster_crs,
                            always_xy=True
                        )
                        geom_for_mask = shapely_transform(transformer.transform, user_geom_4326)
                    else:
                        print(f"[EXPORT] No reprojection needed (raster is EPSG:4326)")
                        geom_for_mask = user_geom_4326
                    
                    print(f"[EXPORT] Clipping raster with geometry...")
                    geom_dict = mapping(geom_for_mask)
                    clipped, out_transform = mask(
                        src,
                        [geom_dict],
                        crop=True,
                        filled=False  # Preserve NoData
                    )
                    print(f"[EXPORT] Clipped shape: {clipped.shape}")

                    meta = src.meta.copy()
                    meta.update({
                        "height": clipped.shape[1],
                        "width": clipped.shape[2],
                        "transform": out_transform,
                        "driver": "GTiff",
                        "compress": "lzw",
                    })
                    
                    # Preserve nodata value
                    if src.nodata is not None:
                        meta["nodata"] = src.nodata
                    
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
                        dst.write(clipped)
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
                    output_files["tif"] = f"/static/exports/{export_id}/{tif_name}"
                    
                    # Include XML metadata path in response for debugging
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
                writer.writerow(["# VMRC Export Report"])
                writer.writerow([f"# Export Date: {report_metadata['export_date']}"])
                writer.writerow([f"# Export ID: {export_id}"])
                writer.writerow([f"# Software: {report_metadata['software']}"])
                writer.writerow([f"# Raster: {raster_name}"])
                if raster_path:
                    writer.writerow([f"# Raster Path: {raster_path}"])
                
                context = req.context or {}
                if context:
                    writer.writerow(["# Filter Selections:"])
                    if context.get("mapType"):
                        writer.writerow([f"#   Map Type: {expand_map_type(context.get('mapType'))}"])
                    if context.get("species"):
                        writer.writerow([f"#   Species: {context.get('species')}"])
                    if context.get("condition"):
                        writer.writerow([f"#   Condition: {expand_condition(context.get('condition'))}"])
                    if context.get("month"):
                        writer.writerow([f"#   Month: {context.get('month')}"])
                    if context.get("coverPercent"):
                        writer.writerow([f"#   Cover %: {context.get('coverPercent')}"])
                    if context.get("stressLevel"):
                        writer.writerow([f"#   Stress Level: {context.get('stressLevel')}"])
                    if context.get("hslClass"):
                        writer.writerow([f"#   HSL Class: {context.get('hslClass')}"])
                
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
                print(f"[EXPORT] Generating PDF report...")
                pdf_name = f"{base_filename}_report.pdf"
                pdf_path = out_dir / pdf_name
                
                # Create PDF
                doc = SimpleDocTemplate(str(pdf_path), pagesize=letter, topMargin=0.5*inch)
                story = []
                styles = getSampleStyleSheet()
                
                # Title
                title_style = ParagraphStyle(
                    'CustomTitle',
                    parent=styles['Heading1'],
                    fontSize=24,
                    textColor=colors.HexColor('#111827'),
                    spaceAfter=30,
                )
                story.append(Paragraph("VMRC Export Report", title_style))
                story.append(Spacer(1, 0.2*inch))
                
                # Date/Time
                story.append(Paragraph(f"<b>Export Date:</b> {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}", styles['Normal']))
                story.append(Spacer(1, 0.3*inch))
                
                # Raster Info
                story.append(Paragraph("<b>Raster Information</b>", styles['Heading2']))
                raster_table_data = [
                    ["Raster Name:", raster_name],
                ]
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
                
                # Filter Selections (Context)
                if req.context:
                    story.append(Paragraph("<b>Filter Selections</b>", styles['Heading2']))
                    context_data = []
                    if req.context.get("mapType"):
                        context_data.append(["Map Type:", expand_map_type(req.context.get("mapType"))])
                    if req.context.get("species"):
                        context_data.append(["Species:", str(req.context.get("species"))])
                    if req.context.get("condition"):
                        context_data.append(["Condition:", expand_condition(req.context.get("condition"))])
                    if req.context.get("month"):
                        context_data.append(["Month:", str(req.context.get("month"))])
                    if req.context.get("coverPercent"):
                        context_data.append(["Cover %:", str(req.context.get("coverPercent"))])
                    if req.context.get("stressLevel"):
                        context_data.append(["Stress Level:", str(req.context.get("stressLevel"))])
                    if req.context.get("hslClass"):
                        context_data.append(["HSL Class:", str(req.context.get("hslClass"))])
                    
                    if context_data:
                        context_table = Table(context_data, colWidths=[2*inch, 4.5*inch])
                        context_table.setStyle(TableStyle([
                            ('BACKGROUND', (0, 0), (0, -1), colors.HexColor('#f9fafb')),
                            ('TEXTCOLOR', (0, 0), (-1, -1), colors.HexColor('#111827')),
                            ('ALIGN', (0, 0), (-1, -1), 'LEFT'),
                            ('FONTNAME', (0, 0), (0, -1), 'Helvetica-Bold'),
                            ('FONTSIZE', (0, 0), (-1, -1), 10),
                            ('BOTTOMPADDING', (0, 0), (-1, -1), 6),
                            ('TOPPADDING', (0, 0), (-1, -1), 6),
                            ('GRID', (0, 0), (-1, -1), 0.5, colors.HexColor('#e5e7eb')),
                        ]))
                        story.append(context_table)
                        story.append(Spacer(1, 0.3*inch))
                
                # AOI Summary
                story.append(Paragraph("<b>AOI Summary</b>", styles['Heading2']))
                aoi_data = [
                    ["Bounds (West):", f"{bounds.get('west', 0):.6f}"],
                    ["Bounds (South):", f"{bounds.get('south', 0):.6f}"],
                    ["Bounds (East):", f"{bounds.get('east', 0):.6f}"],
                    ["Bounds (North):", f"{bounds.get('north', 0):.6f}"],
                ]
                # Normalize GeoJSON to single Feature before parsing geometry
                try:
                    export_feature = normalize_for_export(req.user_clip_geojson)
                    geom_dict = export_feature.get("geometry")
                    if not geom_dict:
                        raise ValueError("Normalized feature has no geometry")
                    geom = shape(geom_dict)
                except Exception as norm_err:
                    print(f"[EXPORT] PDF: Failed to normalize GeoJSON: {norm_err}")
                    # Fallback: try to extract geometry directly (may fail for FeatureCollection)
                    if "geometry" in req.user_clip_geojson:
                        geom = shape(req.user_clip_geojson["geometry"])
                    elif req.user_clip_geojson.get("type") == "Feature":
                        geom = shape(req.user_clip_geojson.get("geometry", req.user_clip_geojson))
                    else:
                        raise ValueError(f"Cannot parse geometry from GeoJSON: {norm_err}")
                
                if hasattr(geom, 'area'):
                    aoi_data.append(["Approximate Area (deg²):", f"{geom.area:.8f}"])
                if hasattr(geom, 'exterior') and hasattr(geom.exterior, 'coords'):
                    vertex_count = len(geom.exterior.coords)
                    aoi_data.append(["Vertex Count:", str(vertex_count)])
                elif hasattr(geom, 'boundary') and hasattr(geom.boundary, 'coords'):
                    # For MultiPolygon or other complex geometries
                    try:
                        vertex_count = sum(len(part.exterior.coords) for part in geom.geoms if hasattr(part, 'exterior'))
                        if vertex_count > 0:
                            aoi_data.append(["Vertex Count (approx):", str(vertex_count)])
                    except:
                        pass
                
                aoi_table = Table(aoi_data, colWidths=[2*inch, 4.5*inch])
                aoi_table.setStyle(TableStyle([
                    ('BACKGROUND', (0, 0), (0, -1), colors.HexColor('#f9fafb')),
                    ('TEXTCOLOR', (0, 0), (-1, -1), colors.HexColor('#111827')),
                    ('ALIGN', (0, 0), (-1, -1), 'LEFT'),
                    ('FONTNAME', (0, 0), (0, -1), 'Helvetica-Bold'),
                    ('FONTSIZE', (0, 0), (-1, -1), 10),
                    ('BOTTOMPADDING', (0, 0), (-1, -1), 6),
                    ('TOPPADDING', (0, 0), (-1, -1), 6),
                    ('GRID', (0, 0), (-1, -1), 0.5, colors.HexColor('#e5e7eb')),
                ]))
                story.append(aoi_table)
                story.append(Spacer(1, 0.3*inch))
                
                # Statistics
                story.append(Paragraph("<b>Statistics</b>", styles['Heading2']))
                
                # Calculate median and percentiles
                median = None
                percentiles_dict = {}
                if len(valid_pixels) > 0:
                    sorted_pixels = np.sort(valid_pixels)
                    median = float(np.median(sorted_pixels))
                    for p in [10, 25, 50, 75, 90]:
                        idx = max(0, min(len(sorted_pixels) - 1, int((p / 100) * (len(sorted_pixels) - 1))))
                        percentiles_dict[p] = float(sorted_pixels[idx])
                
                stats_data = [
                    ["Count:", str(stats.get("count", len(valid_pixels)))],
                    ["Min:", f"{stats.get('min', 0):.2f}"],
                    ["Max:", f"{stats.get('max', 0):.2f}"],
                    ["Mean:", f"{stats.get('mean', 0):.2f}"],
                    ["Median:", f"{median:.2f}" if median is not None else "N/A"],
                    ["Std Dev:", f"{stats.get('std', 0):.2f}"],
                ]
                
                # Add percentiles if available
                if percentiles_dict:
                    for p in [10, 25, 50, 75, 90]:
                        val = percentiles_dict.get(p, 0)
                        stats_data.append([f"{p}th Percentile:", f"{val:.2f}"])
                
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
                
                # Histogram bin table
                story.append(Paragraph("<b>Histogram Bins</b>", styles['Heading2']))
                bin_counts = np.zeros(10, dtype=int)
                if len(valid_pixels) > 0:
                    for v in valid_pixels:
                        clamped = max(0, min(100, v))
                        idx = 9 if clamped == 100 else max(0, min(9, int(np.floor(clamped / 10))))
                        bin_counts[idx] += 1
                
                total_count = bin_counts.sum() or 1
                histogram_data = [["Range", "Count", "Percentage"]]
                bin_ranges = get_histogram_bin_ranges()
                
                for range_label, count in zip(bin_ranges, bin_counts):
                    percentage = (count / total_count) * 100 if total_count > 0 else 0
                    histogram_data.append([range_label, str(count), f"{percentage:.2f}%"])
                
                histogram_table = Table(histogram_data, colWidths=[1.5*inch, 1.5*inch, 1.5*inch])
                histogram_table.setStyle(TableStyle([
                    ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor('#374151')),
                    ('TEXTCOLOR', (0, 0), (-1, 0), colors.whitesmoke),
                    ('ALIGN', (0, 0), (-1, -1), 'CENTER'),
                    ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
                    ('FONTSIZE', (0, 0), (-1, -1), 9),
                    ('BOTTOMPADDING', (0, 0), (-1, -1), 6),
                    ('TOPPADDING', (0, 0), (-1, -1), 6),
                    ('GRID', (0, 0), (-1, -1), 0.5, colors.HexColor('#e5e7eb')),
                    ('ROWBACKGROUNDS', (0, 1), (-1, -1), [colors.white, colors.HexColor('#f9fafb')]),
                ]))
                story.append(histogram_table)
                story.append(Spacer(1, 0.3*inch))
                
                # Preview image (if PNG overlay exists from clip)
                story.append(PageBreak())
                story.append(Paragraph("<b>Preview Image</b>", styles['Heading2']))
                story.append(Spacer(1, 0.2*inch))
                
                try:
                    overlay_url = clip_result.get("overlay_url", "")
                    if overlay_url:
                        # Try to fetch image as base64 data URL
                        # First try local file path
                        overlay_filename = Path(overlay_url).name
                        overlay_path = Path("static/overlays") / overlay_filename
                        
                        if overlay_path.exists():
                            # Use local file
                            print(f"[EXPORT] Using local overlay file: {overlay_path}")
                            try:
                                # Resize image to fit page width (6.5 inches max, maintain aspect)
                                img = Image(str(overlay_path), width=6.5*inch, height=6.5*inch, kind='proportional')
                                # Wrap image in a table to add border
                                img_table = Table([[img]], colWidths=[6.5*inch])
                                img_table.setStyle(TableStyle([
                                    ('GRID', (0, 0), (-1, -1), 1, colors.HexColor('#d1d5db')),  # Light gray border
                                    ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
                                ]))
                                story.append(img_table)
                                print(f"[EXPORT] ✓ Preview image embedded from local file")
                            except Exception as local_err:
                                print(f"[EXPORT] Warning: Failed to load local image: {local_err}")
                                # Fallback: try fetching as URL
                                data_url = fetch_image_as_base64(overlay_url)
                                if data_url:
                                    img = Image(data_url, width=6.5*inch, height=6.5*inch, kind='proportional')
                                    # Wrap image in a table to add border
                                    img_table = Table([[img]], colWidths=[6.5*inch])
                                    img_table.setStyle(TableStyle([
                                        ('GRID', (0, 0), (-1, -1), 1, colors.HexColor('#d1d5db')),  # Light gray border
                                        ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
                                    ]))
                                    story.append(img_table)
                                    print(f"[EXPORT] ✓ Preview image embedded from URL")
                                else:
                                    story.append(Paragraph("No preview available", styles['Normal']))
                        else:
                            # Try fetching as URL
                            print(f"[EXPORT] Local file not found, fetching from URL: {overlay_url}")
                            data_url = fetch_image_as_base64(overlay_url)
                            if data_url:
                                img = Image(data_url, width=6.5*inch, height=6.5*inch, kind='proportional')
                                # Wrap image in a table to add border
                                img_table = Table([[img]], colWidths=[6.5*inch])
                                img_table.setStyle(TableStyle([
                                    ('GRID', (0, 0), (-1, -1), 1, colors.HexColor('#d1d5db')),  # Light gray border
                                    ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
                                ]))
                                story.append(img_table)
                                print(f"[EXPORT] ✓ Preview image embedded from URL")
                            else:
                                story.append(Paragraph("No preview available", styles['Normal']))
                    else:
                        story.append(Paragraph("No preview available", styles['Normal']))
                except Exception as img_err:
                    import traceback
                    print(f"[EXPORT] Warning: Could not embed preview image: {img_err}")
                    traceback.print_exc()
                    story.append(Paragraph("No preview available", styles['Normal']))
                
                # Build PDF
                print(f"[EXPORT] Building PDF document...")
                doc.build(story)
                print(f"[EXPORT] ✓ PDF exported successfully: {pdf_path}")
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
                
                story.append(Paragraph("VMRC Export Report", styles['Heading1']))
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
