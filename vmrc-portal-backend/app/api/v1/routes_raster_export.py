# app/api/v1/routes_raster_export.py
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from app.services.raster_service import clip_raster_for_layer, resolve_raster_path
from pathlib import Path
import rasterio
from rasterio.mask import mask
from shapely.geometry import shape, mapping
from shapely.validation import make_valid
from shapely.ops import transform as shapely_transform
from pyproj import Transformer
import numpy as np
import csv
import json
import uuid
import re
from datetime import datetime
from typing import List, Optional, Dict, Any

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
                ["0-10", "10-20", "20-30", "30-40", "40-50",
                 "50-60", "60-70", "70-80", "80-90", "90-100"],
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
            if not raster_path:
                errors["tif"] = "Raster path not available"
            else:
                tif_name = f"{base_filename}.tif"
                tif_path = out_dir / tif_name

                # Parse geometry from GeoJSON
                if "geometry" in req.user_clip_geojson:
                    user_geom_4326 = shape(req.user_clip_geojson["geometry"])
                else:
                    user_geom_4326 = shape(req.user_clip_geojson)
                
                # Ensure geometry is valid
                if not user_geom_4326.is_valid:
                    user_geom_4326 = make_valid(user_geom_4326)

                with rasterio.open(raster_path) as src:
                    raster_crs = src.crs
                    
                    # Reproject geometry to raster CRS (same as clip_raster_for_layer)
                    if raster_crs and raster_crs.to_string() != "EPSG:4326":
                        transformer = Transformer.from_crs(
                            "EPSG:4326",
                            raster_crs,
                            always_xy=True
                        )
                        geom_for_mask = shapely_transform(transformer.transform, user_geom_4326)
                    else:
                        geom_for_mask = user_geom_4326
                    
                    clipped, out_transform = mask(
                        src,
                        [geom_for_mask],
                        crop=True,
                        filled=False  # Preserve NoData
                    )

                    meta = src.meta.copy()
                    meta.update({
                        "height": clipped.shape[1],
                        "width": clipped.shape[2],
                        "transform": out_transform,
                        "driver": "GTiff",
                        "compress": "lzw",
                    })
                    
                    # Build tags for metadata embedding
                    tags = {}
                    
                    # ImageDescription: compact JSON report
                    report_json_compact = json.dumps(report_metadata, separators=(',', ':'))
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
                    
                    with rasterio.open(tif_path, "w", **meta) as dst:
                        dst.write(clipped)
                        # Write tags
                        dst.update_tags(**tags)

                output_files["tif"] = f"/static/exports/{export_id}/{tif_name}"
        except Exception as e:
            import traceback
            traceback.print_exc()
            errors["tif"] = str(e)

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
                        writer.writerow([f"#   Map Type: {context.get('mapType')}"])
                    if context.get("species"):
                        writer.writerow([f"#   Species: {context.get('species')}"])
                    if context.get("condition"):
                        writer.writerow([f"#   Condition: {context.get('condition')}"])
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
                bin_ranges = [
                    "0-10", "10-20", "20-30", "30-40", "40-50",
                    "50-60", "60-70", "70-80", "80-90", "90-100"
                ]
                
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
            
            # Create FeatureCollection with AOI geometry
            # Handle both Feature and raw Geometry
            if req.user_clip_geojson.get("type") == "Feature":
                geometry = req.user_clip_geojson.get("geometry", req.user_clip_geojson)
            elif req.user_clip_geojson.get("type") == "FeatureCollection":
                # Use first feature if FeatureCollection
                features = req.user_clip_geojson.get("features", [])
                geometry = features[0].get("geometry") if features else req.user_clip_geojson
            else:
                # Assume raw geometry or try geometry field
                geometry = req.user_clip_geojson.get("geometry", req.user_clip_geojson)
            
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
            # Parse geometry type
            if "geometry" in req.user_clip_geojson:
                geom_type = req.user_clip_geojson["geometry"].get("type", "Unknown")
            elif req.user_clip_geojson.get("type") in ["Feature", "FeatureCollection"]:
                geom_type = req.user_clip_geojson.get("type", "Unknown")
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
            errors["pdf"] = "reportlab not installed. Install with: pip install reportlab"
        else:
            try:
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
                    ["Full Path:", str(raster_path)],
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
                        context_data.append(["Map Type:", str(req.context.get("mapType")).title()])
                    if req.context.get("species"):
                        context_data.append(["Species:", str(req.context.get("species"))])
                    if req.context.get("condition"):
                        context_data.append(["Condition:", str(req.context.get("condition"))])
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
                # Parse geometry for AOI info
                if "geometry" in req.user_clip_geojson:
                    geom = shape(req.user_clip_geojson["geometry"])
                elif req.user_clip_geojson.get("type") == "Feature":
                    geom = shape(req.user_clip_geojson.get("geometry", req.user_clip_geojson))
                else:
                    geom = shape(req.user_clip_geojson)
                
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
                bin_ranges = ["0-10", "10-20", "20-30", "30-40", "40-50",
                             "50-60", "60-70", "70-80", "80-90", "90-100"]
                
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
                
                # Preview image (if PNG overlay exists from clip)
                try:
                    overlay_url = clip_result.get("overlay_url", "")
                    if overlay_url:
                        # Extract filename from overlay_url (e.g., "/static/overlays/abc123.png")
                        overlay_filename = Path(overlay_url).name
                        overlay_path = Path("static/overlays") / overlay_filename
                        if overlay_path.exists():
                            story.append(PageBreak())
                            story.append(Paragraph("<b>Preview Image</b>", styles['Heading2']))
                            # Resize image to fit page (max width 6 inches, maintain aspect)
                            img = Image(str(overlay_path), width=6*inch, height=6*inch, kind='proportional')
                            story.append(img)
                except Exception as img_err:
                    print(f"Warning: Could not embed preview image: {img_err}")
                
                # Build PDF
                doc.build(story)
                output_files["pdf"] = f"/static/exports/{export_id}/{pdf_name}"
                
            except Exception as e:
                import traceback
                traceback.print_exc()
                errors["pdf"] = str(e)

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
    response = {
        "status": "success" if output_files else "partial",
        "files": output_files,
    }
    
    if errors:
        response["errors"] = errors
    
    return response
