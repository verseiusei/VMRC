from pathlib import Path

RASTER_ROOT = Path(r"D:\VMRC_Project\Data_Analysis!!\Nov20\Mortality")

RASTER_LOOKUP_LIST = []

# walk through root folder and find all .tif
for tif in RASTER_ROOT.rglob("*.tif"):
    RASTER_LOOKUP_LIST.append({
        "id": len(RASTER_LOOKUP_LIST) + 1,
        "name": tif.stem,
        "path": str(tif)
    })
