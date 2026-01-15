# Quick GDAL Installation Guide for Windows

## Error Message
If you see: `"GDAL is not available. GeoPDF import requires GDAL to be installed"`

This means GDAL is not installed or not in your system PATH.

## Installation Options

### Option 1: OSGeo4W (Recommended for Windows)

1. **Download OSGeo4W**
   - Go to: https://trac.osgeo.org/osgeo4w/
   - Download the installer (64-bit recommended)

2. **Run Installer**
   - Choose "Express Desktop Install"
   - Select the following packages:
     - `gdal` (GDAL library)
     - `gdal-python` (Python bindings)
     - `python3-pip` (if not already installed)

3. **Add to PATH**
   - After installation, add to your system PATH:
     - `C:\OSGeo4W64\bin` (or `C:\OSGeo4W\bin` for 32-bit)
   - To add to PATH:
     1. Open "Environment Variables" (search in Start menu)
     2. Edit "Path" under "System variables"
     3. Add `C:\OSGeo4W64\bin`
     4. Click OK and restart your terminal/IDE

4. **Verify Installation**
   ```bash
   gdalwarp --version
   gdal_translate --version
   ```
   You should see version information.

5. **Restart Backend Server**
   - Close and restart your Python backend server
   - The server checks for GDAL on startup

### Option 2: Conda (If using Anaconda/Miniconda)

```bash
conda install -c conda-forge gdal
```

Then verify:
```bash
gdalwarp --version
```

### Option 3: Pre-built Binaries

1. Download from: https://www.lfd.uci.edu/~gohlke/pythonlibs/#gdal
2. Install the wheel file matching your Python version:
   ```bash
   pip install GDAL-<version>-cp<pyversion>-cp<pyversion>m-win_amd64.whl
   ```

## Verify Installation

After installation, test in a new terminal:

```bash
gdalwarp --version
gdal_translate --version
gdalinfo --version
```

All three commands should show version numbers.

## Restart Backend

**Important**: After installing GDAL, you must:
1. Close your current backend server (Ctrl+C)
2. Restart the backend server
3. Check the startup logs - you should see:
   ```
   [GEOPDF] GDAL is available
   ```
   Instead of:
   ```
   ERROR: GDAL is not available
   ```

## Troubleshooting

### "Command not found" after adding to PATH
- Restart your terminal/IDE completely
- Verify PATH: `echo %PATH%` (should include OSGeo4W bin directory)
- Try using full path: `C:\OSGeo4W64\bin\gdalwarp.exe --version`

### Backend still shows "GDAL not available"
- Make sure you restarted the backend server
- Check backend logs for the GDAL check message
- Verify GDAL is in PATH from the backend's perspective (may need to restart IDE)

### Python can't find GDAL
- If using OSGeo4W, ensure `gdal-python` package was installed
- Try: `pip install gdal` (may need to match system GDAL version)
- Or use conda: `conda install -c conda-forge gdal`

## Testing GeoPDF After Installation

Once GDAL is installed and backend is restarted:

1. Try importing a GeoPDF again
2. The error should be gone
3. You should see the overlay appear on the map

## Need Help?

- GDAL Documentation: https://gdal.org/
- OSGeo4W Help: https://trac.osgeo.org/osgeo4w/wiki
- Check backend logs for detailed error messages

