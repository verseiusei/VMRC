# app/api/v1/routes_raster_list.py

from fastapi import APIRouter
from app.services.raster_index import RASTER_LOOKUP_LIST

router = APIRouter(tags=["rasters"])

@router.get("/list")
def list_rasters():
    return {"items": RASTER_LOOKUP_LIST}
