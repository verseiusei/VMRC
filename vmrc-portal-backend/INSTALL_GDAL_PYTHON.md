# Installing GDAL Python Bindings

## Problem
You have GDAL installed (command-line tools work), but Python cannot import GDAL:
```
ImportError: No module named 'osgeo'
```

## Solution by Installation Method

### If you used OSGeo4W (Windows)

1. **Open OSGeo4W Setup**
   - Find "OSGeo4W Setup" in your Start menu
   - Or run: `C:\OSGeo4W64\bin\osgeo4w-setup.exe`

2. **Install Python Package**
   - Select "Advanced Install"
   - Search for: `gdal-python`
   - Check the box to install it
   - Click "Next" and complete installation

3. **Verify Installation**
   ```bash
   python -c "from osgeo import gdal; print(gdal.__version__)"
   ```
   Should print a version number.

4. **Restart Backend Server**

### If you used Conda

```bash
conda install -c conda-forge gdal python-gdal
```

Or if GDAL is already installed:
```bash
conda install -c conda-forge python-gdal
```

Verify:
```bash
python -c "from osgeo import gdal; print(gdal.__version__)"
```

### If you installed GDAL via pip/system packages

**Option 1: Match system GDAL version**
```bash
# First, find your GDAL version
gdalinfo --version

# Then install matching Python bindings
pip install gdal==<version>
```

**Option 2: Use conda (recommended)**
```bash
conda install -c conda-forge gdal python-gdal
```

### Quick Test

After installation, test in Python:
```python
from osgeo import gdal
print(gdal.__version__)
```

If this works, restart your backend server.

## Common Issues

### "ModuleNotFoundError: No module named 'osgeo'"
- Python bindings are not installed
- Follow the installation steps above

### "DLL load failed" (Windows)
- GDAL DLLs are not in PATH
- Add `C:\OSGeo4W64\bin` to your system PATH
- Restart terminal/IDE

### Version Mismatch
- Python GDAL version must match system GDAL version
- Use conda to manage both together (recommended)
- Or manually match versions

## Recommended: Use Conda

The easiest way to ensure everything works:
```bash
conda create -n vmrc python=3.10
conda activate vmrc
conda install -c conda-forge gdal python-gdal rasterio pyproj pillow numpy
```

This installs GDAL CLI, Python bindings, and all dependencies in one go.

