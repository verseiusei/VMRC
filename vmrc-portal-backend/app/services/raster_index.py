# app/services/raster_index.py
from pathlib import Path
import hashlib

# NEW ROOT FOLDER
RASTER_ROOT = Path(r"D:\VMRC_Project\Data_Analysis!!\Nov20")

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
    
    NEW ROOT: D:\VMRC_Project\Data_Analysis!!\Nov20
    
    Scans three datasets:
    A1) DF Monthly Mortality rasters: {ROOT}/Mortality-DEC30/Douglas_Fir/{Cover}/{StressClass}/M2.5_DF_*.tif
        Examples: .../Mortality-DEC30/Douglas_Fir/0/h/M2.5_DF_D04_h.tif
                  .../Mortality-DEC30/Douglas_Fir/75/vh/M2.5_DF_N09_vh.tif
       
    A2) WH Monthly Mortality rasters: {ROOT}/Mortality2.5-Dec26/Western_Hemlock/{Cover}/M2.5_{COND_INIT}{MM}.tif
        Examples: .../Mortality2.5-Dec26/Western_Hemlock/75/M2.5_D04.tif
                  .../Mortality2.5-Dec26/Western_Hemlock/50/M2.5_N07.tif
        - cover in {0,25,50,75,100}
        - MM in {04,05,06,07,08,09}
        - COND_INIT is D/W/N mapped from Dry/Wet/Normal
       
    B1) DF High Stress Mortality rasters: {ROOT}/HighStressMortality/Douglas_Fir/{Cover}/HSL2.5_DF_*.tif
        Examples: .../HighStressMortality/Douglas_Fir/25/HSL2.5_DF_25_D_h.tif
    
    B2) WH High Stress Mortality rasters: {ROOT}/HighStressMortality/Western_Hemlock/{Cover}/HSL_{cover}_{COND}.tif
        Examples: .../HighStressMortality/Western_Hemlock/0/HSL_0_DRY.tif
                  .../HighStressMortality/Western_Hemlock/75/HSL_75_WET.tif
        - cover in {0,25,50,75,100}
        - COND is DRY/WET/NORMAL (full words)
    
    Returns list of raster items with {id, name, path, dataset_type}
    - name: filename without extension (e.g., "M2.5_DF_D04_h", "M2.5_D04", "HSL2.5_DF_25_D_h", "HSL_0_DRY")
    - dataset_type: "mortality" for A1 and A2, "hsl" for B1 and B2
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
    # A1) DF Mortality: {ROOT}/Mortality-DEC30/Douglas_Fir/{Cover}/{StressClass}/M2.5_DF_*.tif
    mortality_df_base = RASTER_ROOT / "Mortality-DEC30"
    # A2) WH Mortality: {ROOT}/Mortality2.5-Dec26/Western_Hemlock/{Cover}/M2.5_{COND_INIT}{MM}.tif
    mortality_wh_base = RASTER_ROOT / "Mortality2.5-Dec26"
    
    print(f"[INFO] Scanning Monthly Mortality rasters...")
    
    # A1) DF Mortality rasters (M2.5_DF_*.tif in nested structure)
    if mortality_df_base.exists():
        print(f"[INFO] Scanning DF Mortality rasters in: {mortality_df_base}")
        for tif_file in mortality_df_base.rglob("M2.5_DF_*.tif"):
            # Skip if this is in HighStressMortality folder (those are HSL rasters)
            if "HighStressMortality" in str(tif_file):
                continue
            raster_id = generate_stable_id(tif_file)
            raster_list.append({
                "id": raster_id,
                "name": tif_file.stem,  # filename without extension (e.g., M2.5_DF_D04_h)
                "path": str(tif_file.absolute()),
                "dataset_type": "mortality"
            })
            mortality_count += 1
    else:
        print(f"[WARNING] DF Mortality base directory not found: {mortality_df_base}")
    
    # A2) WH Mortality rasters (M2.5_{COND_INIT}{MM}.tif in Western_Hemlock/{Cover}/ folders)
    # Path: {ROOT}/Mortality2.5-Dec26/Western_Hemlock/{Cover}/M2.5_{COND_INIT}{MM}.tif
    wh_mortality_base = mortality_wh_base / "Western_Hemlock" if mortality_wh_base.exists() else None
    wh_mortality_count = 0
    if wh_mortality_base and wh_mortality_base.exists():
        print(f"[INFO] Scanning Western Hemlock Mortality rasters in: {wh_mortality_base}")
        # Search for M2.5_*.tif files in Western_Hemlock/{Cover}/ subdirectories
        for tif_file in wh_mortality_base.rglob("M2.5_*.tif"):
            # Only match files that are M2.5_{COND}{MM}.tif (not M2.5_DF_*)
            if "M2.5_DF_" in tif_file.name:
                continue
            raster_id = generate_stable_id(tif_file)
            raster_name = tif_file.stem  # filename without extension (e.g., M2.5_D04)
            raster_list.append({
                "id": raster_id,
                "name": raster_name,
                "path": str(tif_file.absolute()),
                "dataset_type": "mortality"
            })
            mortality_count += 1
            wh_mortality_count += 1
            print(f"[DEBUG] Found WH Mortality raster: {raster_name} at {tif_file}")
        
        if wh_mortality_count > 0:
            print(f"[INFO] ✓ Found {wh_mortality_count} Western Hemlock Mortality rasters")
        else:
            print(f"[WARNING] No Western Hemlock Mortality rasters found in: {wh_mortality_base}")
            print(f"[WARNING] Expected files: M2.5_*.tif in Western_Hemlock/{{Cover}}/ folders (e.g., M2.5_D04.tif)")
            print(f"[WARNING] Searched pattern: {wh_mortality_base}/**/M2.5_*.tif")
    else:
        print(f"[WARNING] Western Hemlock Mortality directory not found: {wh_mortality_base}")
        print(f"[WARNING] Expected structure: {RASTER_ROOT}/Mortality2.5-Dec26/Western_Hemlock/{{Cover}}/M2.5_*.tif")
    
    if mortality_count > 0:
        print(f"[INFO] ✓ Found {mortality_count} total Monthly Mortality rasters (DF + WH)")
    else:
        print(f"[WARNING] No Monthly Mortality rasters found")
        print(f"[WARNING] Expected DF structure: {RASTER_ROOT}/Mortality-DEC30/Douglas_Fir/{{Cover}}/{{StressClass}}/M2.5_DF_*.tif")
        print(f"[WARNING] Expected WH structure: {RASTER_ROOT}/Mortality2.5-Dec26/Western_Hemlock/{{Cover}}/M2.5_*.tif")
    
    # Dataset B: High Stress Mortality rasters
    # B1) DF HSL: {ROOT}/HighStressMortality/Douglas_Fir/{Cover}/HSL2.5_DF_*.tif
    #     Pattern: HSL2.5_DF_{Cover}_{Condition}_{Class}
    # B2) WH HSL: {ROOT}/HighStressMortality/Western_Hemlock/{Cover}/HSL_{cover}_{COND}.tif
    #     Pattern: HSL_{cover}_{COND} where COND is DRY/WET/NORMAL (full words)
    hsl_base = RASTER_ROOT / "HighStressMortality"
    hsl_df_count = 0
    hsl_wh_count = 0
    if hsl_base.exists():
        print(f"[INFO] Scanning High Stress Mortality rasters in: {hsl_base}")
        
        # B1) DF HSL rasters: HSL2.5_DF_*.tif (with cover, condition, class)
        for tif_file in hsl_base.rglob("HSL2.5_DF_*.tif"):
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
        
        # B2) WH HSL rasters: HSL_{cover}_{COND}.tif (with cover, condition as full word)
        # Pattern: HSL_{cover}_{COND} where cover is 0,25,50,75,100 and COND is DRY/WET/NORMAL
        wh_hsl_base = hsl_base / "Western_Hemlock"
        if wh_hsl_base.exists():
            print(f"[INFO] Scanning Western Hemlock HSL rasters in: {wh_hsl_base}")
            for tif_file in wh_hsl_base.rglob("HSL_*.tif"):
                # Only match HSL_{cover}_{COND}.tif pattern (not HSL2.5_DF_*)
                if "HSL2.5_DF_" in tif_file.name:
                    continue
                raster_id = generate_stable_id(tif_file)
                raster_name = tif_file.stem  # filename without extension (e.g., HSL_0_DRY, HSL_75_WET)
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
            print(f"[INFO]   - Western Hemlock HSL (HSL_<cover>_<COND>): {hsl_wh_count}")
        else:
            print(f"[INFO]   - Western Hemlock HSL: 0 (no HSL_*.tif files found in Western_Hemlock/<Cover>/)")
    else:
        print(f"[WARNING] High Stress Mortality base directory not found: {hsl_base}")
        print(f"[WARNING] Expected DF structure: {RASTER_ROOT}/HighStressMortality/Douglas_Fir/<Cover>/HSL2.5_DF_*.tif")
        print(f"[WARNING] Expected WH structure: {RASTER_ROOT}/HighStressMortality/Western_Hemlock/<Cover>/HSL_<cover>_<COND>.tif")
    
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
