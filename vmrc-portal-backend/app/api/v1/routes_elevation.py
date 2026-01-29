"""
Elevation lookup: proxy to a public elevation API.
Returns elevation in meters and feet; frontend can display "elev ___ ft".
"""
import json
import urllib.request
from fastapi import APIRouter, Query

router = APIRouter(tags=["elevation"])


@router.get("/elevation")
def get_elevation(
    lat: float = Query(..., ge=-90, le=90),
    lng: float = Query(..., ge=-180, le=180),
):
    """
    Return elevation at (lat, lng) in meters and feet.
    Proxies to Open-Meteo elevation API (free, no key). On failure returns null.
    """
    elevation_m = None
    try:
        url = f"https://api.open-meteo.com/v1/elevation?latitude={lat}&longitude={lng}"
        req = urllib.request.Request(url)
        with urllib.request.urlopen(req, timeout=3) as r:
            data = json.loads(r.read().decode())
            elev_list = data.get("elevation")
            if elev_list is not None and len(elev_list) > 0 and elev_list[0] is not None:
                elevation_m = float(elev_list[0])
    except Exception:
        pass

    if elevation_m is None:
        return {"elevation_m": None, "elevation_ft": None}

    elevation_ft = round(elevation_m * 3.28084, 1)
    return {"elevation_m": round(elevation_m, 2), "elevation_ft": elevation_ft}
