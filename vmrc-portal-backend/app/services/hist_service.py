# File: app/services/hist_service.py

"""
Histogram service.

Will:
  - Open rasters (via rasterio / rio-tiler)
  - Compute histograms for AOI or full extent
  - Return bin counts and ranges

Currently just stubbed out.
"""

from typing import Any, Sequence


def compute_histogram(
    raster_path: str,
    *,
    bins: int = 32,
    aoi_geojson: dict | None = None,
) -> dict[str, Any]:
    """
    Placeholder histogram computation.

    We'll implement this with rasterio / numpy once you give the go-ahead.
    """
    return {
        "bins": bins,
        "counts": [0] * bins,
        "range": (0.0, 1.0),
        "aoi_applied": aoi_geojson is not None,
    }
