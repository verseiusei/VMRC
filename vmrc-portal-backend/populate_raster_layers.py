"""
Bulk-populate the raster_layers table from mortality raster files.

Run this from the backend root:

    (.venv) python populate_raster_layers.py

It will scan the Mortality directory, find all .tif files,
and insert a RasterLayer row for each one that is not already in the DB.
"""

import os
from pathlib import Path

from app.db.session import SessionLocal
from app.models.raster_layer import RasterLayer

# 👇 CHANGE THIS IF YOUR ROOT MOVES
MORTALITY_ROOT = Path(
    r"D:\VMRC_Project\Data_Analysis!!\Dec 9\Mortality"
)



def main() -> None:
    db = SessionLocal()
    try:
        count_total = 0
        count_new = 0

        if not MORTALITY_ROOT.exists():
            print(f"[ERROR] Mortality root does not exist: {MORTALITY_ROOT}")
            return

        print(f"[INFO] Scanning {MORTALITY_ROOT} for .tif rasters...")

        for tif_path in MORTALITY_ROOT.rglob("*.tif"):
            count_total += 1

            # Normalize to Windows full path string
            full_path = str(tif_path)

            # Check if this path is already in the DB
            existing = (
                db.query(RasterLayer)
                .filter(RasterLayer.storage_path == full_path)
                .first()
            )
            if existing:
                # Already there, skip
                continue

            # Build a simple name and description from the file path
            fname = tif_path.name  # e.g., "M_DF_D04_h.tif"
            name = os.path.splitext(fname)[0]

            # Example: "Douglas_Fir/h/M_DF_D04_h.tif" or "Western_Hemlock/M_WH_N05.tif"
            rel_parts = tif_path.relative_to(MORTALITY_ROOT).parts
            description = " / ".join(rel_parts)

            layer = RasterLayer(
                name=name,
                description=description,
                storage_path=full_path,
            )

            db.add(layer)
            count_new += 1

        db.commit()
        print(f"[INFO] Found {count_total} .tif files under {MORTALITY_ROOT}")
        print(f"[INFO] Inserted {count_new} new raster_layers rows")
        print("[INFO] Done.")
    finally:
        db.close()


if __name__ == "__main__":
    main()
