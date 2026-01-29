from fastapi import APIRouter

from app.api.v1.routes_raster_list import router as raster_list_router
from app.api.v1.routes_raster import router as raster_clip_router
from app.api.v1.routes_aoi import router as aoi_router
from app.api.v1.routes_raster_sample import router as raster_sample_router
from app.api.v1.routes_raster_export import router as export_router
from app.api.v1.routes_geopdf import router as geopdf_router
from app.api.v1.routes_geopdf_import import router as geopdf_import_router
from app.api.v1.routes_layers import router as layers_router
from app.api.v1.routes_elevation import router as elevation_router


api_router = APIRouter()

api_router.include_router(raster_list_router,  prefix="/rasters", tags=["rasters"])
api_router.include_router(raster_clip_router,  prefix="/rasters", tags=["rasters"])
api_router.include_router(raster_sample_router, prefix="/rasters", tags=["rasters"])
api_router.include_router(export_router, prefix="/rasters", tags=["rasters"])

api_router.include_router(aoi_router, prefix="/aoi", tags=["aoi"])

# GeoPDF routes (existing)
api_router.include_router(geopdf_router, prefix="", tags=["geopdf"])

# GeoPDF import/export routes (new endpoints per spec)
api_router.include_router(geopdf_import_router, prefix="", tags=["geopdf"])

# Layer metadata routes
api_router.include_router(layers_router, prefix="", tags=["layers"])

# Elevation lookup (for map status bar)
api_router.include_router(elevation_router, prefix="", tags=["elevation"])
