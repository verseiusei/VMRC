# app/services/raster_index.py
from pathlib import Path
import hashlib

# NEW ROOT FOLDER
RASTER_ROOT = Path(r"D:\VMRC_Project\Data_Analysis!!\Nov20\Mortality-DEC30")

RASTER_LOOKUP_LIST = []


def generate_stable_id(file_path: Path) -> int:
    """
    Generate a stable integer ID from file path using hash.
    Uses first 8 bytes of SHA256 hash converted to unsigned int.
    """
    path_str = str(file_path.absolute()).lower()
    hash_bytes = hashlib.sha256(path_str.encode()).digest()[:8]
    # Convert to unsigned int (0 to 2^64-1), then take modulo to keep reasonable size
    return int.from_bytes(hash_bytes, byteorder='big') % (2**31 - 1)


def discover_rasters():
    r"""
    Discover all raster files in the new directory structure.
    
    NEW ROOT: D:\VMRC_Project\Data_Analysis!!\Nov20\Mortality-DEC30
    
    Scans three datasets:
    A1) DF Monthly Mortality rasters: {ROOT}/Douglas_Fir/{Cover}/{StressClass}/M2.5_DF_*.tif
        Examples: .../Douglas_Fir/0/h/M2.5_DF_D04_h.tif
                  .../Douglas_Fir/75/vh/M2.5_DF_N09_vh.tif
       
    A2) WH Monthly Mortality rasters: {ROOT}/Western_Hemlock/M_WH_*.tif
        Examples: .../Western_Hemlock/M_WH_D04.tif
                  .../Western_Hemlock/M_WH_N07.tif
                  .../Western_Hemlock/M_WH_W09.tif
        (No stress classes, no cover % - files are directly in Western_Hemlock folder)
       
    B) High Stress Mortality rasters: {ROOT}/HighStressMortality/{SpeciesFolder}/{Cover}/HSL2.5_*.tif
       Examples: .../HighStressMortality/Douglas_Fir/25/HSL2.5_DF_25_D_h.tif
    
    Returns list of raster items with {id, name, path, dataset_type}
    - name: filename without extension (e.g., "M2.5_DF_D04_h", "M_WH_D04", "HSL2.5_DF_25_D_h")
    - dataset_type: "mortality" for A1 and A2, "hsl" for B
    """
    raster_list = []
    mortality_count = 0
    hsl_count = 0
    
    if not RASTER_ROOT.exists():
        print(f"[WARNING] Raster root does not exist: {RASTER_ROOT}")
        print(f"[WARNING] Please verify the path is correct")
        return raster_list
    
    print(f"\n[INFO] Starting raster discovery...")
    print(f"[INFO] Root directory: {RASTER_ROOT}")
    
    # Dataset A: Monthly Mortality rasters
    # A1) DF Mortality: {ROOT}/{SpeciesFolder}/{Cover}/{StressClass}/M2.5_*.tif
    #     SpeciesFolder: Douglas_Fir
    #     Cover: 0, 25, 50, 75, 100
    #     StressClass: l, ml, m, mh, h, vh
    # A2) WH Mortality: {ROOT}/Western_Hemlock/M_WH_*.tif
    #     Filenames: M_WH_D04.tif, M_WH_N07.tif, M_WH_W09.tif (no stress, no cover)
    print(f"[INFO] Scanning Monthly Mortality rasters in: {RASTER_ROOT}")
    
    # A1) DF Mortality rasters (M2.5_DF_*.tif in nested structure)
    for tif_file in RASTER_ROOT.rglob("M2.5_*.tif"):
        # Skip if this is in HighStressMortality folder (those are HSL rasters)
        if "HighStressMortality" in str(tif_file):
            continue
        # Skip if this is in Western_Hemlock folder (those are M_WH_*.tif, handled separately)
        if "Western_Hemlock" in str(tif_file):
            continue
            
        raster_id = generate_stable_id(tif_file)
        raster_list.append({
            "id": raster_id,
            "name": tif_file.stem,  # filename without extension (e.g., M2.5_DF_D04_h)
            "path": str(tif_file.absolute()),
            "dataset_type": "mortality"
        })
        mortality_count += 1
    
    # A2) WH Mortality rasters (M_WH_*.tif in Western_Hemlock folder)
    # Path: {ROOT}/Western_Hemlock/M_WH_*.tif
    # Files are directly in Western_Hemlock folder (no nested structure)
    wh_mortality_base = RASTER_ROOT / "Western_Hemlock"
    wh_mortality_count = 0
    if wh_mortality_base.exists():
        print(f"[INFO] Scanning Western Hemlock Mortality rasters in: {wh_mortality_base}")
        # Search recursively in case files are in subdirectories, but typically they're directly in Western_Hemlock
        for tif_file in wh_mortality_base.rglob("M_WH_*.tif"):
            raster_id = generate_stable_id(tif_file)
            raster_name = tif_file.stem  # filename without extension (e.g., M_WH_D04)
            raster_list.append({
                "id": raster_id,
                "name": raster_name,
                "path": str(tif_file.absolute()),
                "dataset_type": "mortality"
            })
            mortality_count += 1
            wh_mortality_count += 1
            print(f"[DEBUG] Found WH raster: {raster_name} at {tif_file}")
        
        if wh_mortality_count > 0:
            print(f"[INFO] ✓ Found {wh_mortality_count} Western Hemlock Mortality rasters")
        else:
            print(f"[WARNING] No Western Hemlock Mortality rasters found in: {wh_mortality_base}")
            print(f"[WARNING] Expected files: M_WH_*.tif (e.g., M_WH_D04.tif)")
            print(f"[WARNING] Searched pattern: {wh_mortality_base}/**/M_WH_*.tif")
    else:
        print(f"[WARNING] Western Hemlock Mortality directory not found: {wh_mortality_base}")
        print(f"[WARNING] Expected structure: {RASTER_ROOT}/Western_Hemlock/M_WH_*.tif")
    
    if mortality_count > 0:
        print(f"[INFO] ✓ Found {mortality_count} total Monthly Mortality rasters (DF + WH)")
    else:
        print(f"[WARNING] No Monthly Mortality rasters found")
        print(f"[WARNING] Expected DF structure: {RASTER_ROOT}/Douglas_Fir/{{Cover}}/{{StressClass}}/M2.5_*.tif")
        print(f"[WARNING] Expected WH structure: {RASTER_ROOT}/Western_Hemlock/M_WH_*.tif")
    
    # Dataset B: High Stress Mortality rasters
    # B1) DF HSL: {ROOT}/HighStressMortality/Douglas_Fir/{Cover}/HSL2.5_DF_*.tif
    #     Pattern: HSL2.5_DF_{Cover}_{Condition}_{Class}
    # B2) WH HSL: {ROOT}/HighStressMortality/Western_Hemlock/HSL_WH_*.tif
    #     Pattern: HSL_WH_{Condition} (no cover, no class, no month)
    hsl_base = RASTER_ROOT / "HighStressMortality"
    hsl_df_count = 0
    hsl_wh_count = 0
    if hsl_base.exists():
        print(f"[INFO] Scanning High Stress Mortality rasters in: {hsl_base}")
        
        # B1) DF HSL rasters: HSL2.5_DF_*.tif (with cover, condition, class)
        for tif_file in hsl_base.rglob("HSL2.5_*.tif"):
            raster_id = generate_stable_id(tif_file)
            raster_name = tif_file.stem  # filename without extension (e.g., HSL2.5_DF_25_D_h)
            raster_list.append({
                "id": raster_id,
                "name": raster_name,
                "path": str(tif_file.absolute()),
                "dataset_type": "hsl"
            })
            hsl_count += 1
            hsl_df_count += 1
        
        # B2) WH HSL rasters: HSL_WH_*.tif (simple pattern, no cover/class)
        for tif_file in hsl_base.rglob("HSL_WH_*.tif"):
            raster_id = generate_stable_id(tif_file)
            raster_name = tif_file.stem  # filename without extension (e.g., HSL_WH_D, HSL_WH_W, HSL_WH_N)
            raster_list.append({
                "id": raster_id,
                "name": raster_name,
                "path": str(tif_file.absolute()),
                "dataset_type": "hsl"
            })
            hsl_count += 1
            hsl_wh_count += 1
            print(f"[DEBUG] Found WH HSL raster: {raster_name} at {tif_file}")
        
        print(f"[INFO] ✓ Found {hsl_count} total High Stress Mortality rasters")
        if hsl_df_count > 0:
            print(f"[INFO]   - Douglas-fir HSL (HSL2.5_DF_*): {hsl_df_count}")
        if hsl_wh_count > 0:
            print(f"[INFO]   - Western Hemlock HSL (HSL_WH_*): {hsl_wh_count}")
        else:
            print(f"[INFO]   - Western Hemlock HSL: 0 (no HSL_WH_*.tif files found)")
    else:
        print(f"[WARNING] High Stress Mortality base directory not found: {hsl_base}")
        print(f"[WARNING] Expected DF structure: {RASTER_ROOT}/HighStressMortality/Douglas_Fir/{{Cover}}/HSL2.5_DF_*.tif")
        print(f"[WARNING] Expected WH structure: {RASTER_ROOT}/HighStressMortality/Western_Hemlock/HSL_WH_*.tif")
    
    print(f"\n[INFO] {'='*60}")
    print(f"[INFO] RASTER INDEX SUMMARY")
    print(f"[INFO] {'='*60}")
    print(f"[INFO] Total rasters discovered: {len(raster_list)}")
    print(f"[INFO]   - Monthly Mortality (dataset_type='mortality'): {mortality_count}")
    print(f"[INFO]   - High Stress Mortality (dataset_type='hsl'): {hsl_count}")
    print(f"[INFO] Root directory: {RASTER_ROOT}")
    print(f"[INFO] {'='*60}\n")
    
    return raster_list


# Discover rasters on module import
RASTER_LOOKUP_LIST = discover_rasters()
