#!/usr/bin/env python3
"""
Quick test to check if GeoPDF functionality is available.
This tests GDAL availability without importing the full app.
"""

import subprocess
import sys

def test_gdal_cli():
    """Test if GDAL command-line tools are available."""
    try:
        result = subprocess.run(
            ["gdalwarp", "--version"],
            capture_output=True,
            text=True,
            timeout=5
        )
        if result.returncode == 0:
            version = result.stdout.strip()
            print(f"✓ GDAL CLI tools: {version}")
            return True
        else:
            print("✗ GDAL CLI tools: Not working")
            return False
    except (FileNotFoundError, subprocess.TimeoutExpired):
        print("✗ GDAL CLI tools: Not found")
        return False

def test_gdal_python():
    """Test if GDAL Python bindings are available."""
    try:
        from osgeo import gdal
        version = gdal.__version__
        print(f"✓ GDAL Python bindings: {version}")
        return True
    except ImportError:
        print("✗ GDAL Python bindings: Not installed")
        return False

def test_geopdf_commands():
    """Test if specific GDAL commands needed for GeoPDF work."""
    commands = {
        "gdalwarp": "Used for clipping rasters to AOI",
        "gdal_translate": "Used for converting to/from GeoPDF",
        "gdalinfo": "Used for extracting bounds from GeoPDF"
    }
    
    all_ok = True
    for cmd, purpose in commands.items():
        try:
            result = subprocess.run(
                [cmd, "--version"],
                capture_output=True,
                text=True,
                timeout=5
            )
            if result.returncode == 0:
                print(f"  ✓ {cmd}: Available ({purpose})")
            else:
                print(f"  ✗ {cmd}: Not working")
                all_ok = False
        except (FileNotFoundError, subprocess.TimeoutExpired):
            print(f"  ✗ {cmd}: Not found")
            all_ok = False
    
    return all_ok

if __name__ == "__main__":
    print("=" * 60)
    print("GeoPDF Functionality Status Check")
    print("=" * 60)
    print()
    
    cli_ok = test_gdal_cli()
    python_ok = test_gdal_python()
    
    print()
    print("Required GDAL commands:")
    commands_ok = test_geopdf_commands()
    
    print()
    print("=" * 60)
    if cli_ok and python_ok and commands_ok:
        print("✓ STATUS: GeoPDF should work!")
        print("  Both GDAL CLI and Python bindings are available.")
        sys.exit(0)
    else:
        print("✗ STATUS: GeoPDF may not work")
        if not cli_ok:
            print("  - GDAL command-line tools are missing")
        if not python_ok:
            print("  - GDAL Python bindings are missing")
        if not commands_ok:
            print("  - Some required GDAL commands are missing")
        sys.exit(1)

