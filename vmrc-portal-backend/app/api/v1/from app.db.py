from app.db.session import SessionLocal
from app.models.raster_layer import RasterLayer

db = SessionLocal()

layer = RasterLayer(
    name="DF Dry April demo",
    description="Demo raster for clipping",
    storage_path=r"D:\VMRC_Project\Data_Analysis!!\Nov20\Mortality\Douglas_Fir\h\M_DF_D04_h.tif",  # <-- change to a real .tif you have
)

db.add(layer)
db.commit()
db.refresh(layer)
print(layer.id)

db.close()
