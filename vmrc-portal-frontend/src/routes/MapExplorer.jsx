// src/routes/MapExplorer.jsx
import { useEffect, useState, useRef } from "react";

import BaseMap from "../components/map/BaseMap";
import SlidingPanel from "../components/ui/SlidingPanel";
import HistogramPanel from "../components/charts/HistogramPanel";
import StatsTable from "../components/charts/StatsTable";

import { fetchGlobalAOI, clipRaster, exportRaster } from "../lib/rasterApi";
import { parseAOIFile, getGeoJSONBounds, normalizeGeoJSON } from "../lib/aoiParser";
import { FaChartBar, FaTable } from "react-icons/fa";
import { FiChevronDown, FiChevronUp } from "react-icons/fi";

export default function MapExplorer() {
  // ======================================================
  // STATE
  // ======================================================
  const [globalAoi, setGlobalAoi] = useState(null);
  const [userClip, setUserClip] = useState(null);
  const [uploadedAois, setUploadedAois] = useState([]);

  const [overlayUrl, setOverlayUrl] = useState(null);
  const [overlayBounds, setOverlayBounds] = useState(null);

  const [activeRasterId, setActiveRasterId] = useState(null);
  const [pixelValues, setPixelValues] = useState([]);
  const [stats, setStats] = useState(null);

  const [activeTab, setActiveTab] = useState("table");

  // Raster metadata from backend
  const [rasters, setRasters] = useState([]);
  const [hasWhHslRasters, setHasWhHslRasters] = useState(false); // Track if WH HSL rasters exist

  // Selected raster display info
  const [selectedRasterLabel, setSelectedRasterLabel] = useState(null);
  const [selectedRasterName, setSelectedRasterName] = useState(null);
  const [selectedRasterPath, setSelectedRasterPath] = useState(null); // Full absolute path
  const [selectedRasterDetails, setSelectedRasterDetails] = useState(null); // Full details for debugging

  // Map Type selector: "mortality" or "hsl"
  const [mapType, setMapType] = useState("hsl");

  // Species selector (comes after Map Type)
  const [species, setSpecies] = useState("Douglas-fir");

  // Mortality filters
  const [month, setMonth] = useState("04");
  const [condition, setCondition] = useState("Dry");

  // DF-only filters for Mortality
  const [dfStress, setDfStress] = useState("Low Stress"); // For DF Mortality only
  const [coverPercent, setCoverPercent] = useState("0"); // For DF Mortality and HSL only

  // HSL filters (DF-only)
  const [hslCondition, setHslCondition] = useState("D"); // D/W/N
  const [hslClass, setHslClass] = useState("l"); // l/ml/m/mh/h/vh

  // Export options
  const [exportFormats, setExportFormats] = useState({
    png: true,
    tif: false,
    csv: false,
    geojson: false,
    json: false,
    pdf: false,
  });
  const [filename, setFilename] = useState("");
  const [exportResults, setExportResults] = useState(null);
  const [isExporting, setIsExporting] = useState(false);
  const [exportSectionExpanded, setExportSectionExpanded] = useState(false);

  // Map instance ref for zoom checking
  const mapInstanceRef = useRef(null);

  // AOI upload
  const [aoiFileName, setAoiFileName] = useState("");
  const fileInputRef = useRef(null);

  // ======================================================
  // EFFECT: Clear stale filter state when switching map type or species
  // ======================================================
  useEffect(() => {
    // When switching map type or species, clear selected raster info
    setSelectedRasterLabel(null);
    setSelectedRasterName(null);
    setSelectedRasterPath(null);
    setSelectedRasterDetails(null);
  }, [mapType, species]);

  // ======================================================
  // LOAD AOI + RASTER LIST
  // ======================================================
  useEffect(() => {
    fetchGlobalAOI()
      .then((data) => {
        const geo = data?.geojson ?? data;
        setGlobalAoi(geo);
      })
      .catch((err) => console.error("Failed to load global AOI:", err));

    fetch("http://127.0.0.1:8000/api/v1/rasters/list")
      .then((res) => res.json())
      .then((data) => {
        console.log("Loaded rasters:", data);
        const rasterItems = data.items ?? [];
        setRasters(rasterItems);
        
        // Check if WH HSL rasters exist by looking for HSL_WH_* or HSL2.5_WH_* in the list
        const hslRasters = rasterItems.filter((r) => r.dataset_type === "hsl");
        const whHslRasters = hslRasters.filter((r) => {
          const name = r.name.replace(/\.tif$/, "").toUpperCase();
          // WH HSL files are named HSL_WH_D, HSL_WH_W, HSL_WH_N (or HSL2.5_WH_* if they exist)
          return name.startsWith("HSL_WH_") || name.startsWith("HSL2.5_WH_");
        });
        
        const hasWhHsl = whHslRasters.length > 0;
        setHasWhHslRasters(hasWhHsl);
        console.log(`[INFO] WH HSL rasters detected: ${hasWhHsl ? "YES" : "NO"} (found ${whHslRasters.length} WH HSL files)`);
        if (hasWhHsl) {
          console.log("[INFO] WH HSL raster examples:", whHslRasters.slice(0, 5).map((r) => r.name));
        }
      })
      .catch((err) => {
        console.error("Failed to load raster list:", err);
      });
  }, []);

  // ======================================================
  // HELPER: Ensure GeoJSON is FeatureCollection
  // ======================================================
  function ensureFeatureCollection(input) {
    if (!input) return null;
    try {
      return normalizeGeoJSON(input);
    } catch (err) {
      console.error("Failed to normalize GeoJSON:", err);
      return null;
    }
  }

  // ======================================================
  // CLIP HANDLER
  // ======================================================
  function handleUserClipChange(nextClip) {
    setUserClip(nextClip);

    if (!nextClip) {
      setOverlayUrl(null);
      setOverlayBounds(null);
      setPixelValues([]);
      setStats(null);
      setActiveRasterId(null);
      // Clear raster labels when clip is cleared
      setSelectedRasterLabel(null);
      setSelectedRasterName(null);
      setSelectedRasterPath(null);
      setSelectedRasterDetails(null);
    }
  }

  // ======================================================
  // LABEL BUILDING HELPERS
  // ======================================================

  // Convert month code to display name
  function getMonthName(monthCode) {
    const monthMap = {
      "04": "April",
      "05": "May",
      "06": "June",
      "07": "July",
      "08": "August",
      "09": "September"
    };
    return monthMap[monthCode] || monthCode;
  }

  // Convert stress code to display name
  function getStressDisplayName(stressCode) {
    const stressMap = {
      "l": "Low",
      "ml": "Medium-Low",
      "m": "Medium",
      "mh": "Medium-High",
      "h": "High",
      "vh": "Very High"
    };
    return stressMap[stressCode] || stressCode;
  }

  // Extract stress code from DF stress string
  function extractDfStressCode(stressString) {
    if (stressString.includes("Low Stress")) return "l";
    else if (stressString.includes("Medium-Low Stress")) return "ml";
    else if (stressString.includes("Medium Stress") && !stressString.includes("High")) return "m";
    else if (stressString.includes("Medium-High Stress")) return "mh";
    else if (stressString.includes("High Stress")) return "h";
    else if (stressString.includes("Very High")) return "vh";
    return "l"; // Default
  }

  // Build raster label from current filters
  // Format examples:
  // - WH Mortality: "Mortality • Western Hemlock • Dry • April"
  // - DF Mortality: "Mortality • Douglas-fir • Dry • April • Low • Cover 0%"
  // - HSL: "High Stress Level • Douglas-fir • Dry • Low • Cover 0%"
  function buildRasterLabel(mapType, species, month, condition, dfStress, coverPercent, hslCondition, hslClass) {
    const parts = [];

    // Dataset type (shortened for HSL)
    if (mapType === "mortality") {
      parts.push("Mortality");
    } else if (mapType === "hsl") {
      parts.push("HSL");
    }

    // Species
    parts.push(species);

    // Condition
    if (mapType === "mortality") {
      parts.push(condition);
    } else if (mapType === "hsl") {
      // Convert HSL condition code to display name
      const condMap = { "D": "Dry", "W": "Wet", "N": "Normal" };
      parts.push(condMap[hslCondition] || hslCondition);
    }

    // Month (only for mortality) - format: month name (e.g., "April")
    if (mapType === "mortality") {
      parts.push(getMonthName(month));
    }

    // Stress level / HSL class
    if (mapType === "mortality" && species === "Douglas-fir") {
      // DF Mortality: show stress class
      const stressCode = extractDfStressCode(dfStress);
      parts.push(getStressDisplayName(stressCode));
    } else if (mapType === "hsl" && species === "Douglas-fir") {
      // DF HSL: show HSL class
      parts.push(getStressDisplayName(hslClass));
    }
    // WH HSL: no class shown (files don't have class)

    // Cover percent (only for DF Mortality and DF HSL, not WH HSL)
    if ((mapType === "mortality" && species === "Douglas-fir") || (mapType === "hsl" && species === "Douglas-fir")) {
      if (coverPercent) {
        parts.push(`Cover ${coverPercent}%`);
      }
    }
    // WH HSL: no cover shown (files don't have cover)

    // Use middle dot separator: "Mortality · Western Hemlock · Dry · April"
    return parts.join(" · ");
  }

  // ======================================================
  // RASTER FINDER LOGIC
  // ======================================================

  // Build WH Mortality filename: M_WH_{COND}{MONTH}
  // Example: M_WH_D04
  function buildWhMortalityName(condition, month) {
    let condCode = "";
    if (condition === "Dry") condCode = "D";
    else if (condition === "Wet") condCode = "W";
    else if (condition === "Normal") condCode = "N";
    else condCode = condition[0]; // Fallback

    return `M_WH_${condCode}${month}`;
  }

  // Find raster ID for Mortality (Monthly) maps
  // DF pattern: M2.5_{SPECIES}_{COND}{MONTH}_{STRESS}
  // WH pattern: M_WH_{COND}{MONTH}
  // Returns {id, name} or null
  function findMortalityRasterId(species, month, condition, dfStress, coverPercent) {
    if (!rasters.length) {
      console.warn("No rasters loaded");
      return null;
    }

    // Filter to mortality rasters only
    const mortalityRasters = rasters.filter((r) => r.dataset_type === "mortality" || !r.dataset_type);

    let expectedName = "";
    
    if (species === "Western Hemlock") {
      // WH Mortality: M_WH_{COND}{MONTH}
      expectedName = buildWhMortalityName(condition, month);
      console.log("WH Mortality pattern:", expectedName);
      console.log("  Species: WH | Condition:", condition, "| Month:", month);
    } else {
      // DF Mortality: M2.5_DF_{COND}{MONTH}_{STRESS}
      // Require coverPercent for DF Mortality
      if (!coverPercent || coverPercent.trim() === "") {
        alert("Please select a Cover % value for Douglas-fir mortality rasters.");
        return null;
      }

      // Extract stress code
      const stressCode = extractDfStressCode(dfStress);

      // Condition code: D/W/N
      let condCode = "";
      if (condition === "Dry") condCode = "D";
      else if (condition === "Wet") condCode = "W";
      else if (condition === "Normal") condCode = "N";
      else condCode = condition[0]; // Fallback

      expectedName = `M2.5_DF_${condCode}${month}_${stressCode}`;
      console.log("DF Mortality pattern:", expectedName);
      console.log("  Species: DF | Condition:", condCode, "| Month:", month, "| Stress:", stressCode, "| Cover:", coverPercent + "%");
      
      // CRITICAL: Filter by cover folder in path before matching by name
      // Path structure: .../Douglas_Fir/{coverPercent}/{stressClass}/M2.5_DF_*.tif
      // We must match BOTH the cover folder AND the filename
      const coverFolderPattern = `\\${coverPercent}\\`; // Windows path separator: \50\
      const coverFolderPatternAlt = `/${coverPercent}/`; // Forward slash: /50/
      
      console.log(`[DEBUG] Filtering rasters by cover folder: ${coverPercent} (looking for ${coverFolderPattern} or ${coverFolderPatternAlt} in path)`);
      
      // First filter to only rasters in the correct cover folder
      const coverFilteredRasters = mortalityRasters.filter((r) => {
        if (!r.path) {
          console.warn(`[WARN] Raster ${r.name} has no path property`);
          return false;
        }
        // Check for cover folder in path (both \ and / separators)
        const hasCoverFolder = r.path.includes(coverFolderPattern) || r.path.includes(coverFolderPatternAlt);
        if (hasCoverFolder) {
          console.log(`[DEBUG] Raster ${r.name} matches cover folder: ${r.path}`);
        }
        return hasCoverFolder;
      });
      
      console.log(`[DEBUG] Found ${coverFilteredRasters.length} rasters in cover ${coverPercent}% folder`);
      
      if (coverFilteredRasters.length === 0) {
        console.error(`❌ No rasters found in cover ${coverPercent}% folder`);
        alert(`No raster found for Cover ${coverPercent}%. Please check if this cover value exists in the dataset.`);
        return null;
      }
      
      // Now find exact name match within the cover-filtered rasters
      const exactMatch = coverFilteredRasters.find((r) => {
        const name = r.name.replace(/\.tif$/, "");
        return name === expectedName;
      });

      if (exactMatch) {
        const matchedName = exactMatch.name.replace(/\.tif$/, "");
        console.log("✓ Found exact match:", matchedName, "| Cover:", coverPercent + "%", "| ID:", exactMatch.id);
        console.log("  Full path:", exactMatch.path);
        
        // Verify the path actually contains the selected cover
        if (!exactMatch.path.includes(coverFolderPattern) && !exactMatch.path.includes(coverFolderPatternAlt)) {
          console.error(`❌ CRITICAL: Matched raster path does not contain cover ${coverPercent}% folder:`, exactMatch.path);
          alert(`Error: Matched raster does not match selected cover ${coverPercent}%. This is a bug.`);
          return null;
        }
        
        return { id: exactMatch.id, name: matchedName, path: exactMatch.path };
      }
      
      // No match found in the correct cover folder
      console.error(`❌ No raster found matching pattern "${expectedName}" in cover ${coverPercent}% folder`);
      console.error(`   Searched ${coverFilteredRasters.length} rasters in cover ${coverPercent}% folder`);
      const availableNames = coverFilteredRasters.slice(0, 10).map(r => r.name.replace(/\.tif$/, ""));
      console.error(`   Available files in cover ${coverPercent}% folder (first 10):`, availableNames);
      alert(`No raster found matching pattern "${expectedName}" for Cover ${coverPercent}%. Available files: ${availableNames.slice(0, 5).join(", ")}`);
      return null;
    }

    // For Western Hemlock (no cover folders), just match by name
    // Find exact name match (remove .tif extension if present)
    // Backend stores names without .tif extension (using .stem)
    const exactMatch = mortalityRasters.find((r) => {
      const name = r.name.replace(/\.tif$/, "");
      return name === expectedName;
    });

    if (exactMatch) {
      const matchedName = exactMatch.name.replace(/\.tif$/, "");
      console.log("✓ Found exact match:", matchedName, "ID:", exactMatch.id, "Path:", exactMatch.path);
      return { id: exactMatch.id, name: matchedName, path: exactMatch.path };
    }

    // Show helpful warning with closest matches (for error reporting only, not fuzzy matching)
    let condCode = "";
    if (condition === "Dry") condCode = "D";
    else if (condition === "Wet") condCode = "W";
    else if (condition === "Normal") condCode = "N";
    else condCode = condition[0] || condition;
    
    const searchParts = species === "Western Hemlock" 
      ? ["M_WH", condCode, month]
      : ["M2.5_DF", condCode, month];
    
    const closestMatches = mortalityRasters
      .filter((r) => {
        const name = r.name.replace(/\.tif$/, "");
        return searchParts.some((part) => name.includes(part));
      })
      .slice(0, 10)
      .map((r) => r.name.replace(/\.tif$/, ""));

    if (closestMatches.length > 0) {
      console.warn("Closest matches (first 10):", closestMatches);
      alert(
        `No raster found matching: ${expectedName}\n\n` +
        `Closest matches:\n${closestMatches.slice(0, 5).join("\n")}\n\n` +
        `Please check your filter selections.`
      );
    } else {
      console.warn("No similar rasters found");
      alert(`No raster found matching: ${expectedName}\n\nPlease check your filter selections.`);
    }

    return null;
  }

  // Find raster ID for HSL (High Stress Level) maps
  // DF Pattern: HSL2.5_DF_{Cover}_{ConditionCode}_{HslClass}
  //   Example: HSL2.5_DF_0_D_l, HSL2.5_DF_25_W_mh
  // WH Pattern: HSL_WH_{ConditionCode} (no cover, no class)
  //   Example: HSL_WH_D, HSL_WH_W, HSL_WH_N
  // Returns {id, name} or null
  function findHslRasterId(cover, condCode, hslCode, speciesForHsl = null) {
    if (!rasters.length) return null;

    // Determine species code based on current species selection
    const isWh = speciesForHsl === "Western Hemlock" || species === "Western Hemlock";

    let expectedName = "";
    if (isWh) {
      // WH HSL: HSL_WH_{ConditionCode} (simple pattern, no cover/class)
      expectedName = `HSL_WH_${condCode}`;
      console.log("WH HSL pattern:", expectedName);
      console.log("  Species: WH | Condition:", condCode);
    } else {
      // DF HSL: HSL2.5_DF_{Cover}_{ConditionCode}_{HslClass}
      expectedName = `HSL2.5_DF_${cover}_${condCode}_${hslCode}`;
      console.log("DF HSL pattern:", expectedName);
      console.log("  Species: DF | Cover:", cover, "| Condition:", condCode, "| Class:", hslCode);
    }

    // Filter to HSL rasters only
    const hslRasters = rasters.filter((r) => {
      const name = r.name.replace(/\.tif$/, "").toUpperCase();
      return r.dataset_type === "hsl" || name.includes("HSL");
    });
    console.log(`[DEBUG] Searching in ${hslRasters.length} HSL rasters for: ${expectedName}`);
    
    // Log first few HSL raster names for debugging
    if (hslRasters.length > 0) {
      console.log("[DEBUG] Available HSL raster names (first 20):", 
        hslRasters.slice(0, 20).map((r) => r.name.replace(/\.tif$/, "")));
    }

    // Search for raster matching the pattern (exact match only)
    // Backend stores names without .tif extension (using .stem)
    const match = hslRasters.find((r) => {
      const name = r.name.replace(/\.tif$/, "");
      return name === expectedName;
    });

    if (match) {
      const matchedName = match.name.replace(/\.tif$/, "");
      console.log("✓ Found HSL raster:", matchedName, "ID:", match.id, "Path:", match.path);
      return { id: match.id, name: matchedName, path: match.path };
    }

    // Try case-insensitive match as fallback
    const caseInsensitiveMatch = hslRasters.find((r) => {
      const name = r.name.replace(/\.tif$/, "").toUpperCase();
      return name === expectedName.toUpperCase();
    });

    if (caseInsensitiveMatch) {
      const matchedName = caseInsensitiveMatch.name.replace(/\.tif$/, "");
      console.log("✓ Found HSL raster (case-insensitive):", matchedName, "ID:", caseInsensitiveMatch.id, "Path:", caseInsensitiveMatch.path);
      return { id: caseInsensitiveMatch.id, name: matchedName, path: caseInsensitiveMatch.path };
    }

    console.warn("❌ No HSL raster found matching pattern:", expectedName);
    console.warn("   Checked", hslRasters.length, "HSL rasters");
    return null;
  }

  // ======================================================
  // GENERATE MAP (CLIP)
  // ======================================================
  async function handleGenerate() {
    if (!userClip) {
      alert("Please draw a clip region or upload an AOI first.");
      return;
    }

    // Check HSL + WH combination (only block if WH HSL rasters don't exist)
    if (mapType === "hsl" && species === "Western Hemlock" && !hasWhHslRasters) {
      alert("HSL is only available for Douglas-fir. Please select Douglas-fir or switch to Mortality map type.");
      setSelectedRasterLabel(null);
      setSelectedRasterName(null);
      setSelectedRasterPath(null);
      setSelectedRasterDetails(null);
      return;
    }

    // Select raster based on map type
    let rasterResult = null;
    
    if (mapType === "mortality") {
      // Use mortality finder
      rasterResult = findMortalityRasterId(species, month, condition, dfStress, coverPercent);
    } else if (mapType === "hsl") {
      // Use HSL finder (supports both DF and WH)
      const condCode = hslCondition; // Already D/W/N
      
      // DF HSL requires cover% and class, WH HSL does not
      if (species === "Douglas-fir") {
        if (!coverPercent || coverPercent.trim() === "") {
          alert("Please select a Cover % value for Douglas-fir HSL rasters.");
          setSelectedRasterLabel(null);
          setSelectedRasterName(null);
          setSelectedRasterPath(null);
          setSelectedRasterDetails(null);
      return;
        }
        rasterResult = findHslRasterId(coverPercent, condCode, hslClass, species);
      } else if (species === "Western Hemlock") {
        // WH HSL: no cover, no class needed - only condition
        rasterResult = findHslRasterId(null, condCode, null, species);
      }
    }

    if (!rasterResult || !rasterResult.id) {
      // No raster found - clear labels and show message
      setSelectedRasterLabel(null);
      setSelectedRasterName(null);
      setSelectedRasterPath(null);
      setSelectedRasterDetails(null);
      
      // Log detailed error for debugging
      console.error("❌ No raster found matching filters");
      console.error("   Map Type:", mapType);
      console.error("   Species:", species);
      if (mapType === "mortality") {
        console.error("   Month:", month, "| Condition:", condition);
        if (species === "Douglas-fir") {
          console.error("   Stress:", dfStress, "| Cover:", coverPercent);
        }
      } else if (mapType === "hsl") {
        console.error("   Condition:", hslCondition, "| Class:", hslClass, "| Cover:", coverPercent);
      }
      alert("No raster found matching filters. Check console for details.");
      return;
    }

    // Raster found - store full absolute path for display
    const fullPath = rasterResult.path || null;
    const filename = rasterResult.name.endsWith('.tif') ? rasterResult.name : `${rasterResult.name}.tif`;
    setSelectedRasterPath(fullPath);
    setSelectedRasterName(filename);
    setSelectedRasterLabel(null); // No longer using human-readable label
    
    // Clear details (no longer needed for display)
    setSelectedRasterDetails(null);
    console.log("[INFO] Selected Raster - Path:", fullPath, "| Filename:", filename);

    const rasterLayerId = rasterResult.id;

    // Check zoom level and auto-zoom if needed
    if (mapInstanceRef.current) {
      const map = mapInstanceRef.current;
      const zoom = map.getZoom();
      const center = map.getCenter();
      
      // Raster pixel size: ~700-800m (average 750m)
      const RASTER_PIXEL_SIZE_M = 750;
      const MAX_PIXEL_SCREEN_SIZE = 90; // threshold: 80-100px
      
      // Calculate meters per screen pixel at current zoom
      // Leaflet formula: metersPerPixel = 156543.03392 * cos(lat) / 2^zoom
      const metersPerScreenPixel = (156543.03392 * Math.cos(center.lat * Math.PI / 180)) / Math.pow(2, zoom);
      
      // Estimate how big a raster pixel would appear on screen
      const pixelScreenSize = RASTER_PIXEL_SIZE_M / metersPerScreenPixel;
      
      if (pixelScreenSize > MAX_PIXEL_SCREEN_SIZE) {
        // Calculate recommended max zoom
        const metersPerPixelAtZoom0 = 156543.03392 * Math.cos(center.lat * Math.PI / 180);
        const maxZoom = Math.floor(Math.log2((MAX_PIXEL_SCREEN_SIZE * metersPerPixelAtZoom0) / RASTER_PIXEL_SIZE_M));
        
        // Show message and auto-zoom
        alert(
          "You're zoomed in too far. Each raster pixel is huge at this zoom, so the overlay won't look true-to-size. " +
          "We'll zoom out to the closest valid level so pixels cover the triangle correctly."
        );
        
        map.setZoom(maxZoom);
        
        // Wait a moment for zoom animation to complete
        await new Promise(resolve => setTimeout(resolve, 300));
      }
    }

    try {
      // Ensure userClip is a FeatureCollection before sending
      const clipGeoJSON = ensureFeatureCollection(userClip);
      if (!clipGeoJSON) {
        alert("Invalid clip geometry. Please draw or upload a valid AOI.");
        return;
      }

      const result = await clipRaster({
        rasterLayerId,
        userClipGeoJSON: clipGeoJSON,
      });

      const overlay = result.overlay_url ?? result.overlayUrl ?? null;
      const bounds = result.bounds ?? result.overlayBounds ?? null;
      const statsFromApi = result.stats ?? null;
      const pixels =
        result.pixel_values ?? result.pixelValues ?? result.values ?? [];

      setActiveRasterId(rasterLayerId);
      setOverlayUrl(overlay);
      setOverlayBounds(bounds);
      setStats(statsFromApi);
      setPixelValues(Array.isArray(pixels) ? pixels : []);
    } catch (err) {
      console.error("Clip failed:", err);
      alert(err?.message || "Clip failed — check backend.");
    }
  }

  // ======================================================
  // EXPORT RESULT
  // ======================================================
  async function handleExport() {
    if (!userClip) {
      alert("Draw a clip region or upload an AOI before exporting.");
      return;
    }

    // Check HSL + WH combination
    if (mapType === "hsl" && species === "Western Hemlock" && !hasWhHslRasters) {
      alert("High Stress Level (HSL) is only available for Douglas-fir.");
      return;
    }

    // Get selected formats
    const selectedFormats = Object.entries(exportFormats)
      .filter(([_, selected]) => selected)
      .map(([format, _]) => format);

    if (selectedFormats.length === 0) {
      alert("Please select at least one export format.");
      return;
    }

    // Select raster based on map type
    let rasterResult = null;
    
    if (mapType === "mortality") {
      rasterResult = findMortalityRasterId(species, month, condition, dfStress, coverPercent);
    } else if (mapType === "hsl") {
      const condCode = hslCondition;
      if (species === "Douglas-fir") {
        rasterResult = findHslRasterId(coverPercent, condCode, hslClass, species);
      } else {
        rasterResult = findHslRasterId(null, condCode, null, species);
      }
    }

    if (!rasterResult || !rasterResult.id) {
      alert("No raster found matching filters.");
      return;
    }

    const rasterLayerId = rasterResult.id;

    // Build context for PDF report
    const context = {
      mapType,
      species,
      coverPercent: (mapType === "mortality" && species === "Douglas-fir") || (mapType === "hsl" && species === "Douglas-fir") ? coverPercent : null,
      condition: mapType === "mortality" ? condition : (mapType === "hsl" ? hslCondition : null),
      month: mapType === "mortality" ? month : null,
      stressLevel: mapType === "mortality" && species === "Douglas-fir" ? dfStress : null,
      hslClass: mapType === "hsl" && species === "Douglas-fir" ? hslClass : null,
      selectedRasterName: selectedRasterName || rasterResult.name,
      selectedRasterPath: selectedRasterPath || rasterResult.path,
    };

    setIsExporting(true);
    setExportResults(null);

    try {
      // Ensure userClip is a FeatureCollection before sending
      const clipGeoJSON = ensureFeatureCollection(userClip);
      if (!clipGeoJSON) {
        alert("Invalid clip geometry. Please draw or upload a valid AOI.");
        return;
      }

      const res = await exportRaster({
        rasterLayerId,
        userClipGeoJSON: clipGeoJSON,
        formats: selectedFormats,
        filename: filename.trim() || null,
        context,
      });

      // Handle response format
      const files = res.files || {};
      setExportResults(files);
      
      if (res.errors && Object.keys(res.errors).length > 0) {
        console.warn("Export had some errors:", res.errors);
      }
    } catch (err) {
      console.error("Export failed:", err);
      alert(err?.message || "Export failed. Check console for details.");
      setExportResults(null);
    } finally {
      setIsExporting(false);
    }
  }

  // ======================================================
  // AOI UPLOAD - Frontend-only parsing
  // ======================================================
async function handleUploadAoi(event) {
  const file = event.target.files?.[0];
  if (!file) return;

    setAoiFileName(file.name);

    try {
      // Parse file on frontend (Shapefile, GeoJSON, KML)
      const featureCollections = await parseAOIFile(file);

      if (featureCollections.length === 0) {
        alert("No valid features found in the uploaded file.");
        return;
      }

      // Add all layers to uploaded AOIs
      const newAois = featureCollections.map((geo, idx) => ({
        ...geo,
        _uploadId: `${file.name}-${idx}-${Date.now()}`, // Unique ID for each layer
        _fileName: file.name,
      }));

      setUploadedAois((prev) => [...prev, ...newAois]);

      // Set the first uploaded layer as userClip (most recent upload becomes active clip)
      // If multiple layers, use the first one
      const firstAoi = newAois[0];
      if (firstAoi) {
        const featureCollection = ensureFeatureCollection(firstAoi);
        if (featureCollection) {
          setUserClip(featureCollection);
        }
      }

      // Auto-zoom to bounds of all uploaded layers
      if (mapInstanceRef.current && newAois.length > 0) {
        const allBounds = newAois
          .map((geo) => getGeoJSONBounds(geo))
          .filter((b) => b !== null);

        if (allBounds.length > 0) {
          // Combine all bounds
          let minLat = Infinity;
          let maxLat = -Infinity;
          let minLon = Infinity;
          let maxLon = -Infinity;

          allBounds.forEach(([[south, west], [north, east]]) => {
            minLat = Math.min(minLat, south);
            maxLat = Math.max(maxLat, north);
            minLon = Math.min(minLon, west);
            maxLon = Math.max(maxLon, east);
          });

          if (minLat !== Infinity) {
            mapInstanceRef.current.fitBounds(
              [[minLat, minLon], [maxLat, maxLon]],
              { padding: [50, 50], maxZoom: 12 }
            );
          }
        }
      }

      // Show success message
      const layerCount = featureCollections.length;
      if (layerCount > 1) {
        alert(`Successfully uploaded ${layerCount} layers from ${file.name}`);
      } else {
        alert(`Successfully uploaded AOI from ${file.name}`);
      }
  } catch (err) {
      console.error("AOI upload error:", err);
      alert(`Failed to upload AOI: ${err.message || "Unknown error"}`);
    }

    // Reset file input to allow re-uploading the same file
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }

  // Clear all uploaded AOIs
  function handleClearUploadedAois() {
    setUploadedAois([]);
    setAoiFileName("");
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }

  // Clear a specific uploaded AOI by index
  function handleRemoveUploadedAoi(index) {
    setUploadedAois((prev) => {
      const newList = prev.filter((_, i) => i !== index);
      // If the removed AOI was the current userClip, clear userClip
      const removedAoi = prev[index];
      if (userClip === removedAoi) {
        setUserClip(null);
      }
      return newList;
    });
  }

  // Tabs
  const tabs = [
    { id: "table", icon: <FaTable size={18} />, label: "Statistics" },
    { id: "histogram", icon: <FaChartBar size={20} />, label: "Histogram" },
  ];

  // Check if HSL + WH combination is invalid (WH HSL rasters don't exist)
  const isHslWhInvalid = mapType === "hsl" && species === "Western Hemlock" && !hasWhHslRasters;

  // ======================================================
  // RENDER
  // ======================================================
  return (
    <div className="layout-3col">
      {/* LEFT PANEL */}
      <aside className="panel-left card">
        <h2 className="panel-title">Filters</h2>

        {/* MAP TYPE SELECTOR */}
        <div className="filter-block">
          <label>Map Type</label>
          <select
            value={mapType}
            onChange={(e) => setMapType(e.target.value)}
            className="input"
          >
            <option value="mortality">Mortality (Monthly)</option>
            <option value="hsl">High Stress Level (HSL)</option>
          </select>
        </div>

        {/* SPECIES SELECTOR (always shown, after Map Type) */}
        <div className="filter-block">
          <label>Species</label>
          <select
            value={species}
            onChange={(e) => setSpecies(e.target.value)}
            className="input"
          >
            <option value="Douglas-fir">Douglas-fir</option>
            <option value="Western Hemlock">Western Hemlock</option>
          </select>
        </div>

        {/* HSL WARNING (if HSL + WH selected and WH HSL rasters don't exist) */}
        {isHslWhInvalid && (
          <div className="filter-block" style={{
            backgroundColor: "#fef2f2",
            border: "1px solid #fecaca",
            borderRadius: 0, // Sharp edges
            padding: "10px",
            marginBottom: "12px",
            fontSize: "12px",
            color: "#991b1b"
          }}>
            ⚠️ HSL is only available for Douglas-fir. Please select Douglas-fir or switch to Mortality map type.
          </div>
        )}

        {/* HSL FILTERS */}
        {/* For DF: Show Condition, Class, Cover */}
        {/* For WH: Show only Condition (no Class, no Cover) */}
        {mapType === "hsl" && species === "Douglas-fir" && (
          <>
            {/* HSL CONDITION */}
        <div className="filter-block">
              <label>HSL Condition</label>
          <select
                value={hslCondition}
                onChange={(e) => setHslCondition(e.target.value)}
            className="input"
          >
                <option value="D">D (Dry)</option>
                <option value="W">W (Wet)</option>
                <option value="N">N (Normal)</option>
              </select>
            </div>

            {/* HSL CLASS (DF only) */}
            <div className="filter-block">
              <label>HSL Class</label>
              <select
                value={hslClass}
                onChange={(e) => setHslClass(e.target.value)}
                className="input"
              >
                <option value="l">l (Low)</option>
                <option value="ml">ml (Medium-Low)</option>
                <option value="m">m (Medium)</option>
                <option value="mh">mh (Medium-High)</option>
                <option value="h">h (High)</option>
                <option value="vh">vh (Very High)</option>
          </select>
        </div>

            {/* COVER % (DF only) */}
        <div className="filter-block">
              <label>Cover %</label>
          <select
                value={coverPercent}
                onChange={(e) => setCoverPercent(e.target.value)}
            className="input"
          >
                <option value="0">0%</option>
                <option value="25">25%</option>
                <option value="50">50%</option>
                <option value="75">75%</option>
                <option value="100">100%</option>
              </select>
            </div>
          </>
        )}

        {/* HSL FILTERS FOR WH (only Condition) */}
        {mapType === "hsl" && species === "Western Hemlock" && hasWhHslRasters && (
          <>
            {/* HSL CONDITION (WH only) */}
            <div className="filter-block">
              <label>HSL Condition</label>
              <select
                value={hslCondition}
                onChange={(e) => setHslCondition(e.target.value)}
                className="input"
              >
                <option value="D">D (Dry)</option>
                <option value="W">W (Wet)</option>
                <option value="N">N (Normal)</option>
              </select>
            </div>
          </>
        )}

        {/* MORTALITY FILTERS (shown when mapType === "mortality") */}
        {mapType === "mortality" && (
          <>
            {/* MONTH */}
            <div className="filter-block">
              <label>Month</label>
          <select
            value={month}
            onChange={(e) => setMonth(e.target.value)}
            className="input"
          >
            <option value="04">April</option>
            <option value="05">May</option>
            <option value="06">June</option>
            <option value="07">July</option>
            <option value="08">August</option>
            <option value="09">September</option>
          </select>
        </div>

        {/* CONDITION */}
        <div className="filter-block">
          <label>Condition</label>
          <select
            value={condition}
            onChange={(e) => setCondition(e.target.value)}
            className="input"
          >
            <option value="Dry">Dry</option>
            <option value="Wet">Wet</option>
            <option value="Normal">Normal</option>
          </select>
        </div>

            {/* DF-ONLY FILTERS (Cover % and Stress Level) */}
            {species === "Douglas-fir" && (
              <>
                {/* COVER % (for DF Mortality) */}
        <div className="filter-block">
          <label>Cover %</label>
          <select
            value={coverPercent}
            onChange={(e) => setCoverPercent(e.target.value)}
            className="input"
          >
            <option value="0">0%</option>
            <option value="25">25%</option>
            <option value="50">50%</option>
            <option value="75">75%</option>
            <option value="100">100%</option>
          </select>
        </div>

                {/* STRESS LEVEL (for DF Mortality) */}
                <div className="filter-block">
                  <label>Stress Level</label>
                  <select
                    value={dfStress}
                    onChange={(e) => setDfStress(e.target.value)}
                    className="input"
                  >
                    <option value="Low Stress">Low Stress</option>
                    <option value="Medium-Low Stress">Medium-Low Stress</option>
                    <option value="Medium Stress">Medium Stress</option>
                    <option value="Medium-High Stress">Medium-High Stress</option>
                    <option value="High Stress">High Stress</option>
                  </select>
                </div>
              </>
            )}
          </>
        )}

        {/* SELECTED RASTER DISPLAY (full absolute path, only shown when raster is selected) */}
        {selectedRasterPath && (
          <div className="filter-block" style={{
            backgroundColor: "#ffffff",
            border: "1px solid #e2e8f0",
            borderRadius: 0, // Sharp edges
            padding: "10px 12px",
            marginBottom: "12px"
          }}>
            <div style={{ 
              fontSize: "12px", 
              color: "#1e293b",
              lineHeight: "1.5",
              fontFamily: "monospace",
              wordBreak: "break-all",
              whiteSpace: "pre-wrap"
            }}>
              <div style={{ fontWeight: 600, marginBottom: "4px", fontSize: "11px", color: "#64748b", textTransform: "uppercase", letterSpacing: "0.5px" }}>
                Raster:
              </div>
              {selectedRasterPath}
            </div>
          </div>
        )}

        {/* GENERATE BUTTON */}
        <div className="filter-block">
          <button 
            className="btn-primary full-width" 
            onClick={handleGenerate}
            disabled={isHslWhInvalid || !userClip}
            style={{ opacity: (isHslWhInvalid || !userClip) ? 0.5 : 1 }}
          >
            Generate Map
          </button>
        </div>

        {/* AOI UPLOAD */}
        <div className="filter-section">
          <h3 className="section-title">Upload AOI</h3>
          <p className="section-help">
            Upload Shapefile (.zip), GeoJSON (.geojson, .json), or KML (.kml).
            Uploaded AOIs are displayed but not editable.
          </p>

          <div className="file-input-wrapper">
            <button
              type="button"
              className="btn-secondary"
              onClick={() => fileInputRef.current?.click()}
            >
              {aoiFileName || "Choose file"}
            </button>
            <span className="file-hint">.zip / .geojson / .json / .kml</span>

            <input
              ref={fileInputRef}
              type="file"
              accept=".geojson,.json,.zip,.kml"
              onChange={handleUploadAoi}
              className="file-input-hidden"
            />
          </div>

          {/* Show uploaded AOIs list */}
          {uploadedAois.length > 0 && (
            <div style={{ marginTop: "12px" }}>
              <div style={{ fontSize: "12px", color: "#64748b", marginBottom: "6px" }}>
                Uploaded ({uploadedAois.length}):
              </div>
              {uploadedAois.map((aoi, i) => (
                <div
                  key={i}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    padding: "4px 8px",
                    marginBottom: "4px",
                    background: "#f1f5f9",
                    fontSize: "11px",
                  }}
                >
                  <span style={{ color: "#475569" }}>
                    {aoi._fileName || `AOI ${i + 1}`}
                  </span>
                  <button
                    type="button"
                    onClick={() => handleRemoveUploadedAoi(i)}
                    style={{
                      background: "none",
                      border: "none",
                      color: "#ef4444",
                      cursor: "pointer",
                      fontSize: "12px",
                      padding: "2px 6px",
                    }}
                    title="Remove this AOI"
                  >
                    ×
                  </button>
                </div>
              ))}
              <button
                type="button"
                onClick={handleClearUploadedAois}
                className="btn-secondary"
                style={{ marginTop: "8px", width: "100%", fontSize: "11px" }}
              >
                Clear All
              </button>
            </div>
          )}
        </div>

        {/* EXPORT - Collapsible */}
        <div className="filter-section">
          <div
            style={{
              background: "#ffffff",
              border: "1px solid #e2e8f0",
              borderRadius: 0,
              boxSizing: "border-box",
              width: "100%",
            }}
          >
            {/* Collapsible Header */}
            <button
              onClick={() => setExportSectionExpanded(!exportSectionExpanded)}
              style={{
                width: "100%",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "12px",
                background: "transparent",
                border: "none",
                cursor: "pointer",
                textAlign: "left",
              }}
            >
              <h3 className="section-title" style={{ margin: 0 }}>
                Export Results
              </h3>
              {exportSectionExpanded ? (
                <FiChevronUp size={18} style={{ color: "#64748b" }} />
              ) : (
                <FiChevronDown size={18} style={{ color: "#64748b" }} />
              )}
            </button>

            {/* Collapsible Content */}
            {exportSectionExpanded && (
              <div
                style={{
                  padding: "0 12px 12px 12px",
                  boxSizing: "border-box",
                  width: "100%",
                }}
              >
                <p className="section-help" style={{ marginTop: 0 }}>
                  Export clipped raster and statistics in multiple formats.
                </p>
                
          {/* Filename Input */}
          <div className="sidebar-field" style={{ marginBottom: "14px" }}>
            <label className="sidebar-label">Filename (optional)</label>
            <input
              type="text"
              className="input"
              placeholder="e.g., dry_df_04"
              value={filename}
              onChange={(e) => setFilename(e.target.value)}
                    style={{ width: "100%", boxSizing: "border-box" }}
            />
                  <p className="sidebar-help">Base name only (extensions added automatically).</p>
          </div>

                {/* Export Format Checkboxes */}
                <div style={{ marginBottom: "16px" }}>
          <label className="checkbox-row">
            <input
              type="checkbox"
                      checked={exportFormats.png}
                      onChange={(e) => setExportFormats({ ...exportFormats, png: e.target.checked })}
            />
            <span>PNG</span>
          </label>

          <label className="checkbox-row">
            <input
              type="checkbox"
                      checked={exportFormats.tif}
                      onChange={(e) => setExportFormats({ ...exportFormats, tif: e.target.checked })}
            />
            <span>GeoTIFF (.tif)</span>
          </label>

          <label className="checkbox-row">
            <input
              type="checkbox"
                      checked={exportFormats.csv}
                      onChange={(e) => setExportFormats({ ...exportFormats, csv: e.target.checked })}
            />
            <span>CSV</span>
          </label>

                  <label className="checkbox-row">
                    <input
                      type="checkbox"
                      checked={exportFormats.geojson}
                      onChange={(e) => setExportFormats({ ...exportFormats, geojson: e.target.checked })}
                    />
                    <span>GeoJSON (AOI)</span>
                  </label>

                  <label className="checkbox-row">
                    <input
                      type="checkbox"
                      checked={exportFormats.json}
                      onChange={(e) => setExportFormats({ ...exportFormats, json: e.target.checked })}
                    />
                    <span>JSON (metadata)</span>
                  </label>

                  <label className="checkbox-row">
                    <input
                      type="checkbox"
                      checked={exportFormats.pdf}
                      onChange={(e) => setExportFormats({ ...exportFormats, pdf: e.target.checked })}
                    />
                    <span>PDF (report)</span>
                  </label>
                </div>

                <button
                  className="btn-primary full-width"
                  disabled={!userClip || isHslWhInvalid || isExporting}
                  onClick={handleExport}
                  style={{ 
                    display: "block",
                    width: "100%",
                    boxSizing: "border-box",
                    opacity: (userClip && !isHslWhInvalid && !isExporting) ? 1 : 0.5,
                    marginTop: "8px"
                  }}
                >
                  {isExporting ? "Exporting..." : "Export"}
          </button>

                {/* Export Results */}
                {exportResults && Object.keys(exportResults).length > 0 && (
                  <div
                    style={{
                      marginTop: "16px",
                      padding: "12px",
                      background: "#f9fafb",
                      border: "1px solid #e5e7eb",
                      borderRadius: 0,
                      boxSizing: "border-box",
                      width: "100%",
                    }}
                  >
                    <h4
                      style={{
                        color: "#374151",
                        fontSize: 12,
                        fontWeight: 700,
                        marginBottom: "10px",
                        textTransform: "uppercase",
                        letterSpacing: "0.5px",
                      }}
                    >
                      Export Results
                    </h4>
                    <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                      {exportResults.png && (
                        <a
                          href={`http://127.0.0.1:8000${exportResults.png}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{ fontSize: 12, color: "#2563eb", textDecoration: "underline" }}
                        >
                          Download PNG
                        </a>
                      )}
                      {exportResults.tif && (
                        <a
                          href={`http://127.0.0.1:8000${exportResults.tif}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{ fontSize: 12, color: "#2563eb", textDecoration: "underline" }}
                        >
                          Download TIF
                        </a>
                      )}
                      {exportResults.csv && (
                        <a
                          href={`http://127.0.0.1:8000${exportResults.csv}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{ fontSize: 12, color: "#2563eb", textDecoration: "underline" }}
                        >
                          Download CSV
                        </a>
                      )}
                      {exportResults.geojson && (
                        <a
                          href={`http://127.0.0.1:8000${exportResults.geojson}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{ fontSize: 12, color: "#2563eb", textDecoration: "underline" }}
                        >
                          Download GeoJSON
                        </a>
                      )}
                      {exportResults.json && (
                        <a
                          href={`http://127.0.0.1:8000${exportResults.json}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{ fontSize: 12, color: "#2563eb", textDecoration: "underline" }}
                        >
                          Download JSON
                        </a>
                      )}
                      {exportResults.pdf && (
                        <a
                          href={`http://127.0.0.1:8000${exportResults.pdf}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{ fontSize: 12, color: "#2563eb", textDecoration: "underline", fontWeight: 600 }}
                        >
                          Download PDF Report
                        </a>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </aside>

      {/* MAP */}
      <section className="panel-map card">
        <BaseMap
          globalAoi={globalAoi}
          uploadedAois={uploadedAois}
          userClip={userClip}
          overlayUrl={overlayUrl}
          overlayBounds={overlayBounds}
          onUserClipChange={handleUserClipChange}
          activeRasterId={activeRasterId}
          onMapReady={(map) => {
            mapInstanceRef.current = map;
          }}
        />
      </section>

      {/* RIGHT PANEL */}
      <SlidingPanel width={550}>
        <div className="tab-bar">
          {tabs.map((t) => (
            <button
              key={t.id}
              className={`tab-button ${activeTab === t.id ? "active" : ""}`}
              onClick={() => setActiveTab(t.id)}
              title={t.label}
            >
              {t.icon}
            </button>
          ))}
        </div>

        <div className="tab-content">
          {activeTab === "table" && (
            <StatsTable 
              stats={stats} 
              values={pixelValues}
              rasterName={selectedRasterName}
              rasterPath={selectedRasterPath}
            />
          )}
          {activeTab === "histogram" && (
            <HistogramPanel values={pixelValues} />
          )}
        </div>
      </SlidingPanel>
    </div>
  );
}

// These maps are no longer used, but harmless to keep
const SPECIES_MAP = {
  Douglas_Fir: "DF",
  Western_Hemlock: "WH",
};

const CONDITION_MAP = {
  Dry: "D",
  Wet: "W",
  Normal: "N",
};

const SEVERITY_MAP = {
  Low: "l",
  "Medium Low": "ml",
  Medium: "m",
  "Medium High": "mh",
  High: "h",
};
