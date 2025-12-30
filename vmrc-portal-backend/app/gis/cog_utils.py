# File: app/gis/cog_utils.py

"""
COG (Cloud-Optimized GeoTIFF) helpers.

This module will:
  - Validate that rasters are COGs
  - Build rio-tiler readers
  - Construct tile/overview URLs as needed
"""

from typing import Any


def validate_cog(path_or_url: str) -> bool:
    """
    Placeholder COG validator.

    Later we'll:
      - Use rasterio / rio-tiler to check overviews, tiling, etc.
    """
    # For now, just check extension.
    return path_or_url.lower().endswith((".tif", ".tiff", ".cog.tif", ".cog.tiff"))


def open_cog(path_or_url: str) -> Any:
    """
    Placeholder COG opener.

    Eventually will return a rio-tiler reader / dataset.
    """
    raise NotImplementedError("COG opening is not implemented yet.")
