# File: app/models/raster_layer.py

"""
RasterLayer model.

Represents a single raster / COG in storage with metadata for the API.
For now we keep it minimal and focus on wiring storage_path so clipping works.
You can always extend this later with condition, species, month, etc.
"""

from datetime import datetime

from sqlalchemy import DateTime, Integer, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class RasterLayer(Base):
    __tablename__ = "raster_layers"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)

    # Full path or URL to the raster file that rasterio can open
    # e.g. "C:/Users/.../rasters/M_DF_DRY04.tif" or "s3://bucket/path.tif"
    storage_path: Mapped[str] = mapped_column(String(1024), nullable=False)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
    )
