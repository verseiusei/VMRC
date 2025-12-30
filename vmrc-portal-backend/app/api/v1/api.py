from fastapi import APIRouter

from app.api.v1.routes_raster_list import router as raster_list_router
from app.api.v1.routes_raster import router as raster_clip_router
from app.api.v1.routes_aoi import router as aoi_router
from app.api.v1.routes_raster_sample import router as raster_sample_router
from app.api.v1.routes_raster_export import router as export_router



api_router = APIRouter()

api_router.include_router(raster_list_router,  prefix="/rasters", tags=["rasters"])
api_router.include_router(raster_clip_router,  prefix="/rasters", tags=["rasters"])
api_router.include_router(raster_sample_router, prefix="/rasters", tags=["rasters"])
api_router.include_router(export_router, prefix="/rasters", tags=["rasters"])

api_router.include_router(aoi_router, prefix="/aoi", tags=["aoi"])
