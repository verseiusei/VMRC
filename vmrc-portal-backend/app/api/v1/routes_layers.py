# app/api/v1/routes_layers.py
"""
Layer metadata endpoints for uploaded GeoPDFs and processed layers.
"""

from fastapi import APIRouter, HTTPException
from pathlib import Path

from app.services.layer_metadata import load_metadata, cleanup_old_uploads

router = APIRouter(tags=["layers"])

# Run cleanup on module load
cleanup_old_uploads()


@router.get("/layers/{layer_id}/metadata")
async def get_layer_metadata(layer_id: str):
    """
    Get metadata for a layer (uploaded GeoPDF or processed layer).
    
    GET /api/v1/layers/{layer_id}/metadata
    
    Returns:
        JSON metadata object
    """
    # Validate layer_id format (prevent directory traversal)
    if ".." in layer_id or "/" in layer_id or "\\" in layer_id:
        raise HTTPException(status_code=400, detail="Invalid layer_id format")
    
    metadata = load_metadata(layer_id)
    
    if not metadata:
        raise HTTPException(
            status_code=404,
            detail=f"Metadata not found for layer {layer_id}"
        )
    
    return metadata

