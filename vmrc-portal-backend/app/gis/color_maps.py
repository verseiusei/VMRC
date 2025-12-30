# File: app/gis/color_maps.py

"""
Central place for color maps.

We'll define:
  - Discrete color ramps (e.g., dry/moist/wet zones)
  - Continuous palettes for ET, PDWP, mortality, etc.

For now, just some placeholders so imports won't break.
"""

from typing import Dict, Tuple


ColorMap = Dict[int, Tuple[int, int, int, int]]  # value -> (R, G, B, A)


def get_default_colormap() -> ColorMap:
    """
    Simple grayscale placeholder colormap.
    """
    return {
        0: (0, 0, 0, 0),       # transparent
        1: (50, 50, 50, 255),
        2: (100, 100, 100, 255),
        3: (150, 150, 150, 255),
        4: (200, 200, 200, 255),
        5: (240, 240, 240, 255),
    }
