// src/routes/MapExplorer.jsx
import { useEffect, useState, useRef } from "react";

import BaseMap from "../components/map/BaseMap";
import SlidingPanel from "../components/ui/SlidingPanel";
import HistogramPanel from "../components/charts/HistogramPanel";
import StatsTable from "../components/charts/StatsTable";
import CreatedRastersList from "../components/raster/CreatedRastersList";

import { fetchGlobalAOI, clipRaster, exportRaster, exportGeoPDF, exportGeoPDFNew, importGeoPDF, downloadGeoPDF, uploadGeoPDF, listDatasets, downloadDataset, getDatasetPreview, deleteGeoPDF, apiUrl, API_BASE } from "../lib/rasterApi";
import { parseAOIFile, getGeoJSONBounds, normalizeGeoJSON } from "../lib/aoiParser";
import { FaChartBar, FaTable } from "react-icons/fa";
import { FiChevronDown, FiChevronUp } from "react-icons/fi";

export default function MapExplorer() {
  // ======================================================
  // STATE
  // ======================================================
  const [globalAoi, setGlobalAoi] = useState(null);
  const [overlayUrl, setOverlayUrl] = useState(null);
  const [overlayBounds, setOverlayBounds] = useState(null);

  // Unified AOI array: contains both drawn and uploaded AOIs, each with its own overlay
  const [aois, setAois] = useState([]);
  const [activeRasterId, setActiveRasterId] = useState(null);

  // Legacy state for backward compatibility (will be removed)
  const [userClip, setUserClip] = useState(null); // Keep for Generate button check
  const [uploadedAois, setUploadedAois] = useState([]); // Keep for display list

  const [activeTab, setActiveTab] = useState("table");

  // ✅ FIX: Right panel data (was missing, caused "stats is not defined")
  const [stats, setStats] = useState(null);
  const [pixelValues, setPixelValues] = useState([]);
  const [histogram, setHistogram] = useState(null);

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
  const [coverPercent, setCoverPercent] = useState("50"); // For DF Mortality, WH Mortality, DF HSL, and WH HSL

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
    geopdf: false,
  });
  const [filename, setFilename] = useState("");
  const [exportResults, setExportResults] = useState(null);
  const [isExporting, setIsExporting] = useState(false);
  const [exportSectionExpanded, setExportSectionExpanded] = useState(false);

  // Map instance ref for zoom checking
  const mapInstanceRef = useRef(null);

  // Created rasters list
  const [createdRasters, setCreatedRasters] = useState([]);

  // AOI upload
  const fileInputRef = useRef(null);
  
  // GeoPDF upload and datasets
  const geopdfUploadRef = useRef(null);
  const [datasets, setDatasets] = useState([]);
  const [isUploadingGeoPDF, setIsUploadingGeoPDF] = useState(false);
  const [activeDatasetPreview, setActiveDatasetPreview] = useState(null); // { id, preview_url, preview_bounds }

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

    fetch(apiUrl("/rasters/list"))
      .then((res) => res.json())
      .then((data) => {
        console.log("Loaded rasters:", data);
        const rasterItems = data.items ?? [];
        setRasters(rasterItems);

        // Check if WH HSL rasters exist by looking for HSL_*_* pattern (HSL_{cover}_{COND})
        const hslRasters = rasterItems.filter((r) => r.dataset_type === "hsl");
        const whHslRasters = hslRasters.filter((r) => {
          const name = r.name.replace(/\.tif$/, "").toUpperCase();
          // WH HSL files are named HSL_{cover}_{COND} (e.g., HSL_0_DRY, HSL_75_WET)
          // Pattern: HSL_ followed by a number, underscore, and condition word
          return /^HSL_\d+_(DRY|WET|NORMAL)$/.test(name);
        });

        const hasWhHsl = whHslRasters.length > 0;
        setHasWhHslRasters(hasWhHsl);
        console.log(
          `[INFO] WH HSL rasters detected: ${hasWhHsl ? "YES" : "NO"} (found ${whHslRasters.length} WH HSL files)`
        );
        if (hasWhHsl) {
          console.log("[INFO] WH HSL raster examples:", whHslRasters.slice(0, 5).map((r) => r.name));
        }
      })
      .catch((err) => {
        console.error("Failed to load raster list:", err);
      });
    
    // Load datasets (including uploaded GeoPDFs)
    listDatasets()
      .then((data) => {
        console.log("Loaded datasets:", data);
        setDatasets(data.datasets || []);
      })
      .catch((err) => {
        console.error("Failed to load datasets:", err);
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

      // ✅ clear right panel too
      setPixelValues([]);
      setStats(null);
      setHistogram(null);

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
      "09": "September",
    };
    return monthMap[monthCode] || monthCode;
  }

  // Convert stress code to display name
  function getStressDisplayName(stressCode) {
    const stressMap = {
      l: "Low",
      ml: "Medium-Low",
      m: "Medium",
      mh: "Medium-High",
      h: "High",
      vh: "Very High",
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
  function buildRasterLabel(mapType, species, month, condition, dfStress, coverPercent, hslCondition, hslClass) {
    const parts = [];

    if (mapType === "mortality") parts.push("Mortality");
    else if (mapType === "hsl") parts.push("HSL");

    parts.push(species);

    if (mapType === "mortality") {
      parts.push(condition);
      parts.push(getMonthName(month));
    } else if (mapType === "hsl") {
      const condMap = { D: "Dry", W: "Wet", N: "Normal" };
      parts.push(condMap[hslCondition] || hslCondition);
    }

    if (mapType === "mortality" && species === "Douglas-fir") {
      const stressCode = extractDfStressCode(dfStress);
      parts.push(getStressDisplayName(stressCode));
    } else if (mapType === "hsl" && species === "Douglas-fir") {
      parts.push(getStressDisplayName(hslClass));
    }

    if (
      (mapType === "mortality" && species === "Douglas-fir") ||
      (mapType === "hsl" && species === "Douglas-fir")
    ) {
      if (coverPercent) parts.push(`Cover ${coverPercent}%`);
    }

    return parts.join(" · ");
  }

  // ======================================================
  // RASTER FINDER LOGIC
  // ======================================================

  // Build WH Mortality filename: M2.5_{COND_INIT}{MONTH}
  // Example: M2.5_D04.tif
  function buildWhMortalityName(condition, month) {
    let condCode = "";
    if (condition === "Dry") condCode = "D";
    else if (condition === "Wet") condCode = "W";
    else if (condition === "Normal") condCode = "N";
    else condCode = condition[0];

    return `M2.5_${condCode}${month}`;
  }

  // Find raster ID for Mortality (Monthly) maps
  function findMortalityRasterId(species, month, condition, dfStress, coverPercent) {
    if (!rasters.length) {
      console.warn("No rasters loaded");
      return null;
    }

    const mortalityRasters = rasters.filter((r) => r.dataset_type === "mortality" || !r.dataset_type);

    let expectedName = "";

    if (species === "Western Hemlock") {
      if (!coverPercent || coverPercent.trim() === "") {
        alert("Please select a Cover % value for Western Hemlock mortality rasters.");
        return null;
      }

      expectedName = buildWhMortalityName(condition, month);
      console.log("WH Mortality pattern:", expectedName);
      console.log("  Species: WH | Condition:", condition, "| Month:", month, "| Cover:", coverPercent + "%");

      const coverFolderPattern = `\\${coverPercent}\\`;
      const coverFolderPatternAlt = `/${coverPercent}/`;

      console.log(
        `[DEBUG] Filtering WH rasters by cover folder: ${coverPercent} (looking for ${coverFolderPattern} or ${coverFolderPatternAlt} in path)`
      );

      const coverFilteredRasters = mortalityRasters.filter((r) => {
        if (!r.path) {
          console.warn(`[WARN] Raster ${r.name} has no path property`);
          return false;
        }
        const hasCoverFolder = r.path.includes(coverFolderPattern) || r.path.includes(coverFolderPatternAlt);
        if (hasCoverFolder) console.log(`[DEBUG] Raster ${r.name} matches cover folder: ${r.path}`);
        return hasCoverFolder;
      });

      console.log(`[DEBUG] Found ${coverFilteredRasters.length} WH rasters in cover ${coverPercent}% folder`);

      if (coverFilteredRasters.length === 0) {
        console.error(`❌ No WH rasters found in cover ${coverPercent}% folder`);
        alert(`No raster found for Cover ${coverPercent}%. Please check if this cover value exists in the dataset.`);
        return null;
      }

      const exactMatch = coverFilteredRasters.find((r) => {
        const name = r.name.replace(/\.tif$/, "");
        return name === expectedName;
      });

      if (exactMatch) {
        const matchedName = exactMatch.name.replace(/\.tif$/, "");
        console.log("✓ Found exact match:", matchedName, "| Cover:", coverPercent + "%", "| ID:", exactMatch.id);
        console.log("  Full path:", exactMatch.path);

        if (!exactMatch.path.includes(coverFolderPattern) && !exactMatch.path.includes(coverFolderPatternAlt)) {
          console.error(`❌ CRITICAL: Matched raster path does not contain cover ${coverPercent}% folder:`, exactMatch.path);
          alert(`Error: Matched raster does not match selected cover ${coverPercent}%. This is a bug.`);
          return null;
        }

        return { id: exactMatch.id, name: matchedName, path: exactMatch.path };
      }

      console.error(`❌ No WH raster found matching pattern "${expectedName}" in cover ${coverPercent}% folder`);
      console.error(`   Searched ${coverFilteredRasters.length} rasters in cover ${coverPercent}% folder`);
      const availableNames = coverFilteredRasters.slice(0, 10).map((r) => r.name.replace(/\.tif$/, ""));
      console.error(`   Available files in cover ${coverPercent}% folder (first 10):`, availableNames);
      alert(
        `No raster found matching pattern "${expectedName}" for Cover ${coverPercent}%. Available files: ${availableNames
          .slice(0, 5)
          .join(", ")}`
      );
      return null;
    } else {
      if (!coverPercent || coverPercent.trim() === "") {
        alert("Please select a Cover % value for Douglas-fir mortality rasters.");
        return null;
      }

      const stressCode = extractDfStressCode(dfStress);

      let condCode = "";
      if (condition === "Dry") condCode = "D";
      else if (condition === "Wet") condCode = "W";
      else if (condition === "Normal") condCode = "N";
      else condCode = condition[0];

      expectedName = `M2.5_DF_${condCode}${month}_${stressCode}`;
      console.log("DF Mortality pattern:", expectedName);
      console.log("  Species: DF | Condition:", condCode, "| Month:", month, "| Stress:", stressCode, "| Cover:", coverPercent + "%");

      const coverFolderPattern = `\\${coverPercent}\\`;
      const coverFolderPatternAlt = `/${coverPercent}/`;

      console.log(
        `[DEBUG] Filtering rasters by cover folder: ${coverPercent} (looking for ${coverFolderPattern} or ${coverFolderPatternAlt} in path)`
      );

      const coverFilteredRasters = mortalityRasters.filter((r) => {
        if (!r.path) {
          console.warn(`[WARN] Raster ${r.name} has no path property`);
          return false;
        }
        const hasCoverFolder = r.path.includes(coverFolderPattern) || r.path.includes(coverFolderPatternAlt);
        if (hasCoverFolder) console.log(`[DEBUG] Raster ${r.name} matches cover folder: ${r.path}`);
        return hasCoverFolder;
      });

      console.log(`[DEBUG] Found ${coverFilteredRasters.length} rasters in cover ${coverPercent}% folder`);

      if (coverFilteredRasters.length === 0) {
        console.error(`❌ No rasters found in cover ${coverPercent}% folder`);
        alert(`No raster found for Cover ${coverPercent}%. Please check if this cover value exists in the dataset.`);
        return null;
      }

      const exactMatch = coverFilteredRasters.find((r) => {
        const name = r.name.replace(/\.tif$/, "");
        return name === expectedName;
      });

      if (exactMatch) {
        const matchedName = exactMatch.name.replace(/\.tif$/, "");
        console.log("✓ Found exact match:", matchedName, "| Cover:", coverPercent + "%", "| ID:", exactMatch.id);
        console.log("  Full path:", exactMatch.path);

        if (!exactMatch.path.includes(coverFolderPattern) && !exactMatch.path.includes(coverFolderPatternAlt)) {
          console.error(`❌ CRITICAL: Matched raster path does not contain cover ${coverPercent}% folder:`, exactMatch.path);
          alert(`Error: Matched raster does not match selected cover ${coverPercent}%. This is a bug.`);
          return null;
        }

        return { id: exactMatch.id, name: matchedName, path: exactMatch.path };
      }

      console.error(`❌ No raster found matching pattern "${expectedName}" in cover ${coverPercent}% folder`);
      console.error(`   Searched ${coverFilteredRasters.length} rasters in cover ${coverPercent}% folder`);
      const availableNames = coverFilteredRasters.slice(0, 10).map((r) => r.name.replace(/\.tif$/, ""));
      console.error(`   Available files in cover ${coverPercent}% folder (first 10):`, availableNames);
      alert(
        `No raster found matching pattern "${expectedName}" for Cover ${coverPercent}%. Available files: ${availableNames
          .slice(0, 5)
          .join(", ")}`
      );
      return null;
    }

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
  function findHslRasterId(cover, condCode, hslCode, speciesForHsl = null) {
    if (!rasters.length) return null;

    const isWh = speciesForHsl === "Western Hemlock" || species === "Western Hemlock";

    let expectedName = "";
    if (isWh) {
      if (!cover || cover.trim() === "") {
        alert("Please select a Cover % value for Western Hemlock HSL rasters.");
        return null;
      }

      // WH HSL: HSL_{cover}_{COND}.tif
      // COND is DRY/WET/NORMAL (full words)
      let condFull = "";
      if (condCode === "D" || condCode === "DRY") condFull = "DRY";
      else if (condCode === "W" || condCode === "WET") condFull = "WET";
      else if (condCode === "N" || condCode === "NORMAL") condFull = "NORMAL";
      else condFull = condCode.toUpperCase();

      expectedName = `HSL_${cover}_${condFull}`;
      console.log("WH HSL pattern:", expectedName);
      console.log("  Species: WH | Cover:", cover, "| Condition:", condFull);

      const coverFolderPattern = `\\${cover}\\`;
      const coverFolderPatternAlt = `/${cover}/`;

      console.log(
        `[DEBUG] Filtering WH HSL rasters by cover folder: ${cover} (looking for ${coverFolderPattern} or ${coverFolderPatternAlt} in path)`
      );

      const hslRasters = rasters.filter((r) => {
        const name = r.name.replace(/\.tif$/, "").toUpperCase();
        return r.dataset_type === "hsl" || name.includes("HSL");
      });

      const coverFilteredRasters = hslRasters.filter((r) => {
        if (!r.path) {
          console.warn(`[WARN] Raster ${r.name} has no path property`);
          return false;
        }
        const hasCoverFolder = r.path.includes(coverFolderPattern) || r.path.includes(coverFolderPatternAlt);
        if (hasCoverFolder) console.log(`[DEBUG] Raster ${r.name} matches cover folder: ${r.path}`);
        return hasCoverFolder;
      });

      console.log(`[DEBUG] Found ${coverFilteredRasters.length} WH HSL rasters in cover ${cover}% folder`);

      if (coverFilteredRasters.length === 0) {
        console.error(`❌ No WH HSL rasters found in cover ${cover}% folder`);
        alert(`No raster found for Cover ${cover}%. Please check if this cover value exists in the dataset.`);
        return null;
      }

      const match = coverFilteredRasters.find((r) => {
        const name = r.name.replace(/\.tif$/, "");
        return name === expectedName;
      });

      if (match) {
        const matchedName = match.name.replace(/\.tif$/, "");
        console.log("✓ Found WH HSL raster:", matchedName, "| Cover:", cover + "%", "| ID:", match.id, "Path:", match.path);

        if (!match.path.includes(coverFolderPattern) && !match.path.includes(coverFolderPatternAlt)) {
          console.error(`❌ CRITICAL: Matched raster path does not contain cover ${cover}% folder:`, match.path);
          alert(`Error: Matched raster does not match selected cover ${cover}%. This is a bug.`);
          return null;
        }

        return { id: match.id, name: matchedName, path: match.path };
      }

      const caseInsensitiveMatch = coverFilteredRasters.find((r) => {
        const name = r.name.replace(/\.tif$/, "").toUpperCase();
        return name === expectedName.toUpperCase();
      });

      if (caseInsensitiveMatch) {
        const matchedName = caseInsensitiveMatch.name.replace(/\.tif$/, "");
        console.log("✓ Found WH HSL raster (case-insensitive):", matchedName, "| Cover:", cover + "%", "| ID:", caseInsensitiveMatch.id, "Path:", caseInsensitiveMatch.path);
        return { id: caseInsensitiveMatch.id, name: matchedName, path: caseInsensitiveMatch.path };
      }

      console.warn("❌ No WH HSL raster found matching pattern:", expectedName);
      console.warn("   Checked", coverFilteredRasters.length, "WH HSL rasters in cover", cover + "%");
      return null;
    } else {
      expectedName = `HSL2.5_DF_${cover}_${condCode}_${hslCode}`;
      console.log("DF HSL pattern:", expectedName);
      console.log("  Species: DF | Cover:", cover, "| Condition:", condCode, "| Class:", hslCode);
    }

      const hslRasters = rasters.filter((r) => {
        const name = r.name.replace(/\.tif$/, "").toUpperCase();
        return r.dataset_type === "hsl" || name.includes("HSL");
      });
      console.log(`[DEBUG] Searching in ${hslRasters.length} HSL rasters for: ${expectedName}`);

      if (hslRasters.length > 0) {
        console.log(
          "[DEBUG] Available HSL raster names (first 20):",
          hslRasters.slice(0, 20).map((r) => r.name.replace(/\.tif$/, ""))
        );
      }

      const match = hslRasters.find((r) => {
        const name = r.name.replace(/\.tif$/, "");
        return name === expectedName;
      });

      if (match) {
        const matchedName = match.name.replace(/\.tif$/, "");
        console.log("✓ Found HSL raster:", matchedName, "ID:", match.id, "Path:", match.path);
        return { id: match.id, name: matchedName, path: match.path };
      }

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

    // Pick a target AOI to attach results to:
    // - newest AOI if available, otherwise fallback to legacy userClip
    const targetAoi =
      aois.length > 0
        ? aois[aois.length - 1]
        : { id: "__legacy__", geojson: ensureFeatureCollection(userClip) };

    const clipGeoJSON = ensureFeatureCollection(targetAoi.geojson);
    if (!clipGeoJSON) {
      alert("Invalid clip geometry. Please draw or upload a valid AOI.");
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
      rasterResult = findMortalityRasterId(species, month, condition, dfStress, coverPercent);
    } else if (mapType === "hsl") {
      const condCode = hslCondition;

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
        if (!coverPercent || coverPercent.trim() === "") {
          alert("Please select a Cover % value for Western Hemlock HSL rasters.");
          setSelectedRasterLabel(null);
          setSelectedRasterName(null);
          setSelectedRasterPath(null);
          setSelectedRasterDetails(null);
          return;
        }
        rasterResult = findHslRasterId(coverPercent, condCode, null, species);
      }
    }

    if (!rasterResult || !rasterResult.id) {
      setSelectedRasterLabel(null);
      setSelectedRasterName(null);
      setSelectedRasterPath(null);
      setSelectedRasterDetails(null);

      console.error("❌ No raster found matching filters");
      console.error("   Map Type:", mapType);
      console.error("   Species:", species);
      if (mapType === "mortality") {
        console.error("   Month:", month, "| Condition:", condition);
        if (species === "Douglas-fir") console.error("   Stress:", dfStress, "| Cover:", coverPercent);
      } else if (mapType === "hsl") {
        console.error("   Condition:", hslCondition, "| Class:", hslClass, "| Cover:", coverPercent);
      }
      alert("No raster found matching filters. Check console for details.");
      return;
    }

    // Raster found - store full absolute path for display
    const fullPath = rasterResult.path || null;
    const filenameWithExt = rasterResult.name.endsWith(".tif") ? rasterResult.name : `${rasterResult.name}.tif`;
    setSelectedRasterPath(fullPath);
    setSelectedRasterName(filenameWithExt);
    setSelectedRasterLabel(null);
    setSelectedRasterDetails(null);
    console.log("[INFO] Selected Raster - Path:", fullPath, "| Filename:", filenameWithExt);

    const rasterLayerId = rasterResult.id;

    // Zoom check (keep your existing logic)
    if (mapInstanceRef.current) {
      const map = mapInstanceRef.current;
      const zoom = map.getZoom();
      const center = map.getCenter();

      const RASTER_PIXEL_SIZE_M = 750;
      const MAX_PIXEL_SCREEN_SIZE = 90;

      const metersPerScreenPixel =
        (156543.03392 * Math.cos((center.lat * Math.PI) / 180)) / Math.pow(2, zoom);

      const pixelScreenSize = RASTER_PIXEL_SIZE_M / metersPerScreenPixel;

      if (pixelScreenSize > MAX_PIXEL_SCREEN_SIZE) {
        const metersPerPixelAtZoom0 = 156543.03392 * Math.cos((center.lat * Math.PI) / 180);
        const maxZoom = Math.floor(
          Math.log2((MAX_PIXEL_SCREEN_SIZE * metersPerPixelAtZoom0) / RASTER_PIXEL_SIZE_M)
        );

        alert(
          "You're zoomed in too far. Each raster pixel is huge at this zoom, so the overlay won't look true-to-size. " +
            "We'll zoom out to the closest valid level so pixels cover the triangle correctly."
        );

        map.setZoom(maxZoom);
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    }

    try {
      const result = await clipRaster({
        rasterLayerId,
        userClipGeoJSON: clipGeoJSON,
      });

      const overlay = result.overlay_url ?? result.overlayUrl ?? null;
      const bounds = result.bounds ?? result.overlayBounds ?? null;
      const statsFromApi = result.stats ?? null;
      const pixels = result.pixel_values ?? result.pixelValues ?? result.pixels ?? result.values ?? [];
      const histogramFromApi = result.histogram ?? null;

      // ✅ RIGHT PANEL (this is what your StatsTable/Histogram uses)
      setStats(statsFromApi);
      setPixelValues(Array.isArray(pixels) ? pixels : []);
      setHistogram(histogramFromApi);
      setActiveRasterId(rasterLayerId);

      // ✅ keep legacy overlay props working too (if BaseMap still uses these)
      setOverlayUrl(overlay);
      setOverlayBounds(bounds);

      // Attach overlay data to the specific AOI (your new architecture)
      setAois((prev) =>
        prev.map((aoi) =>
          aoi.id === targetAoi.id
            ? {
                ...aoi,
                overlayUrl: overlay,
                overlayBounds: bounds,
                stats: statsFromApi,
                pixelValues: Array.isArray(pixels) ? pixels : [],
                activeRasterId: rasterLayerId,
              }
            : aoi
        )
      );

      // ✅ Add to created rasters list
      const rasterName = buildRasterLabel(mapType, species, month, condition, dfStress, coverPercent, hslCondition, hslClass);
      const aoiName = targetAoi.name || (targetAoi.type === "upload" ? "Uploaded AOI" : "Drawn AOI");
      const timestamp = new Date().toISOString();
      const timeStr = new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      const dateStr = new Date(timestamp).toLocaleDateString([], { month: "short", day: "numeric" });
      const createdRasterName = `${rasterName} · ${aoiName} · ${dateStr} ${timeStr}`;
      
      // Color ramp matching BaseMap.jsx LEGEND_ITEMS
      const ramp = {
        colors: [
          "#006400", // 0–10  dark green
          "#228B22", // 10–20
          "#9ACD32", // 20–30
          "#FFD700", // 30–40
          "#FFA500", // 40–50
          "#FF8C00", // 50–60
          "#FF6B00", // 60–70
          "#FF4500", // 70–80
          "#DC143C", // 80–90
          "#B22222", // 90–100
        ],
        labels: [
          "0–10",
          "10–20",
          "20–30",
          "30–40",
          "40–50",
          "50–60",
          "60–70",
          "70–80",
          "80–90",
          "90–100",
        ],
      };

      const newRaster = {
        id: `raster-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        name: createdRasterName,
        createdAt: timestamp,
        overlayUrl: overlay,
        overlayBounds: bounds,
        stats: statsFromApi,
        pixelValues: Array.isArray(pixels) ? pixels : [],
        histogram: histogramFromApi,
        activeRasterId: rasterLayerId,
        ramp: ramp,
        aoiId: targetAoi.id,
      };

      setCreatedRasters((prev) => [...prev, newRaster]);
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

    if (mapType === "hsl" && species === "Western Hemlock" && !hasWhHslRasters) {
      alert("High Stress Level (HSL) is only available for Douglas-fir.");
      return;
    }

    let selectedFormats = Object.entries(exportFormats)
      .filter(([_, selected]) => selected)
      .map(([format, _]) => format);

    if (selectedFormats.length === 0) {
      alert("Please select at least one export format.");
      return;
    }

    let rasterResult = null;

    if (mapType === "mortality") {
      rasterResult = findMortalityRasterId(species, month, condition, dfStress, coverPercent);
    } else if (mapType === "hsl") {
      const condCode = hslCondition;
      if (species === "Douglas-fir") {
        rasterResult = findHslRasterId(coverPercent, condCode, hslClass, species);
      } else {
        if (!coverPercent || coverPercent.trim() === "") {
          alert("Please select a Cover % value for Western Hemlock HSL rasters.");
          return;
        }
        rasterResult = findHslRasterId(coverPercent, condCode, null, species);
      }
    }

    if (!rasterResult || !rasterResult.id) {
      alert("No raster found matching filters.");
      return;
    }

    const rasterLayerId = rasterResult.id;

    const context = {
      mapType,
      species,
      coverPercent:
        (mapType === "mortality" && (species === "Douglas-fir" || species === "Western Hemlock")) ||
        (mapType === "hsl" && (species === "Douglas-fir" || species === "Western Hemlock"))
          ? coverPercent
          : null,
      condition: mapType === "mortality" ? condition : mapType === "hsl" ? hslCondition : null,
      month: mapType === "mortality" ? month : null,
      stressLevel: mapType === "mortality" && species === "Douglas-fir" ? dfStress : null,
      hslClass: mapType === "hsl" && species === "Douglas-fir" ? hslClass : null,
      selectedRasterName: selectedRasterName || rasterResult.name,
      selectedRasterPath: selectedRasterPath || rasterResult.path,
    };

    // Handle GeoPDF export separately (it uses a different endpoint)
    if (selectedFormats.includes("geopdf")) {
      setIsExporting(true);
      setExportResults(null);
      
      try {
        const clipGeoJSON = ensureFeatureCollection(userClip);
        if (!clipGeoJSON) {
          alert("Invalid clip geometry. Please draw or upload a valid AOI.");
          setIsExporting(false);
          return;
        }
        
        const title = filename.trim() || `${mapType}_${species}_${new Date().toISOString().split('T')[0]}`;
        
        // Use new exportGeoPDFNew API
        await exportGeoPDFNew({
          rasterId: rasterLayerId,
          aoiGeoJSON: clipGeoJSON,
          title: title,
          author: "VMRC Portal",
        });
        
        setExportResults({
          geopdf: "downloaded",
        });
        
        alert(`GeoPDF exported successfully! Download started.`);
      } catch (err) {
        console.error("GeoPDF export failed:", err);
        alert(err?.message || "GeoPDF export failed. Check console for details.");
        setExportResults(null);
      } finally {
        setIsExporting(false);
      }
      
      // If other formats are also selected, export them too
      const otherFormats = selectedFormats.filter(f => f !== "geopdf");
      if (otherFormats.length === 0) {
        setIsExporting(false);
        return; // Only GeoPDF was selected, we're done
      }
      // Continue with regular export for other formats (fall through)
    }
    
    // Regular export for non-GeoPDF formats
    setIsExporting(true);
    setExportResults(null);

    try {
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

      const files = res.files || {};
      setExportResults(files);

      // Log export results for debugging
      console.log("[MapExplorer] Export results:", {
        status: res.status,
        files: Object.keys(files),
        errors: res.errors || {},
      });

      if (res.errors && Object.keys(res.errors).length > 0) {
        console.warn("Export had some errors:", res.errors);
        // Show user-friendly error messages
        const errorMessages = Object.entries(res.errors)
          .map(([format, error]) => `${format.toUpperCase()}: ${error}`)
          .join("\n");
        alert(`Some exports failed:\n\n${errorMessages}`);
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

    try {
      const featureCollections = await parseAOIFile(file);

      if (featureCollections.length === 0) {
        alert("No valid features found in the uploaded file.");
        return;
      }

      const newAois = featureCollections.map((geo, idx) => {
        const aoiId = `upload-${file.name}-${idx}-${Date.now()}`;
        const featureCollection = ensureFeatureCollection(geo);

        return {
          id: aoiId,
          geojson: featureCollection,
          name: file.name + (featureCollections.length > 1 ? ` (Layer ${idx + 1})` : ""),
          type: "upload",
          overlayUrl: null,
          overlayBounds: null,
          stats: null,
          pixelValues: [],
          activeRasterId: null,
          visible: true,
          _fileName: file.name,
        };
      });

      setAois((prev) => [...prev, ...newAois]);
      setUploadedAois((prev) => [...prev, ...newAois]);

      if (newAois.length > 0) {
        setUserClip(newAois[0].geojson);
      }

      if (mapInstanceRef.current && newAois.length > 0) {
        const allBounds = newAois
          .map((geo) => getGeoJSONBounds(geo))
          .filter((b) => b !== null);

        if (allBounds.length > 0) {
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
              [
                [minLat, minLon],
                [maxLat, maxLon],
              ],
              { padding: [50, 50], maxZoom: 12 }
            );
          }
        }
      }

      const layerCount = featureCollections.length;
      if (layerCount > 1) alert(`Successfully uploaded ${layerCount} layers from ${file.name}`);
      else alert(`Successfully uploaded AOI from ${file.name}`);
    } catch (err) {
      console.error("AOI upload error:", err);
      alert(`Failed to upload AOI: ${err.message || "Unknown error"}`);
    }

    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }

  // Clear all AOIs (both drawn and uploaded)
  function handleClearUploadedAois() {
    setAois([]);
    setUploadedAois([]);
    setUserClip(null);

    // ✅ clear right panel too
    setStats(null);
    setPixelValues([]);
    setHistogram(null);
    setActiveRasterId(null);
    setOverlayUrl(null);
    setOverlayBounds(null);

    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }

  // Remove a specific AOI by ID (called from erase tool or remove button)
  function handleRemoveAoi(aoiId) {
    setAois((prev) => {
      const newList = prev.filter((aoi) => aoi.id !== aoiId);

      const removedAoi = prev.find((aoi) => aoi.id === aoiId);
      if (removedAoi && removedAoi.type === "upload") {
        setUploadedAois((prevUploaded) => prevUploaded.filter((aoi) => aoi.id !== aoiId));
      }

      if (removedAoi && userClip && JSON.stringify(removedAoi.geojson) === JSON.stringify(userClip)) {
        setUserClip(null);
        setStats(null);
        setPixelValues([]);
        setHistogram(null);
        setActiveRasterId(null);
      }

      return newList;
    });
  }

  // Clear a specific uploaded AOI by index (for remove button in UI)
  function handleRemoveUploadedAoi(index) {
    const uploadedAoi = uploadedAois[index];
    if (uploadedAoi && uploadedAoi.id) handleRemoveAoi(uploadedAoi.id);
  }

  // ======================================================
  // CREATED RASTERS LIST HANDLERS
  // ======================================================
  function handleShowRaster(rasterId) {
    const raster = createdRasters.find((r) => r.id === rasterId);
    if (!raster) return;

    // Set this raster as active
    setActiveRasterId(raster.activeRasterId);
    setOverlayUrl(raster.overlayUrl);
    setOverlayBounds(raster.overlayBounds);
    setStats(raster.stats);
    setPixelValues(raster.pixelValues);
    setHistogram(raster.histogram);

    // Update AOI if it still exists
    if (raster.aoiId) {
      setAois((prev) =>
        prev.map((aoi) =>
          aoi.id === raster.aoiId
            ? {
                ...aoi,
                overlayUrl: raster.overlayUrl,
                overlayBounds: raster.overlayBounds,
                stats: raster.stats,
                pixelValues: raster.pixelValues,
                activeRasterId: raster.activeRasterId,
              }
            : aoi
        )
      );
    }
  }

  function handleRemoveRaster(rasterId) {
    const raster = createdRasters.find((r) => r.id === rasterId);
    if (!raster) return;

    const wasActive = raster.activeRasterId === activeRasterId;

    // Remove from list
    setCreatedRasters((prev) => prev.filter((r) => r.id !== rasterId));

    // If it was active, clear or select previous
    if (wasActive) {
      const remaining = createdRasters.filter((r) => r.id !== rasterId);
      if (remaining.length > 0) {
        // Select the most recent remaining raster
        const previousRaster = remaining[remaining.length - 1];
        handleShowRaster(previousRaster.id);
      } else {
        // Clear everything
        setActiveRasterId(null);
        setOverlayUrl(null);
        setOverlayBounds(null);
        setStats(null);
        setPixelValues([]);
        setHistogram(null);

        // Clear from AOI if it exists
        if (raster.aoiId) {
          setAois((prev) =>
            prev.map((aoi) =>
              aoi.id === raster.aoiId
                ? {
                    ...aoi,
                    overlayUrl: null,
                    overlayBounds: null,
                    stats: null,
                    pixelValues: [],
                    activeRasterId: null,
                  }
                : aoi
            )
          );
        }
      }
    }
  }

  // ======================================================
  // GEOPDF UPLOAD HANDLER
  // ======================================================
  async function handleUploadGeoPDF(event) {
    const file = event.target.files?.[0];
    if (!file) return;

    if (!file.name.toLowerCase().endsWith(".pdf")) {
      alert("Please select a PDF file.");
      if (geopdfUploadRef.current) {
        geopdfUploadRef.current.value = "";
      }
      return;
    }

    setIsUploadingGeoPDF(true);
    try {
      // Use new importGeoPDF API
      const result = await importGeoPDF(file);
      
      // New API returns: { layer_id, overlay_url, bounds, crs }
      if (result.layer_id && result.overlay_url && result.bounds) {
        // Construct full URL for overlay
        const overlayUrl = result.overlay_url.startsWith("http") 
          ? result.overlay_url 
          : apiUrl(result.overlay_url);
        
        // Add overlay to map immediately
        setActiveDatasetPreview({
          id: result.layer_id,
          preview_url: overlayUrl,
          preview_bounds: result.bounds,
        });
        alert(`GeoPDF imported successfully! Preview is now displayed on the map.`);
      } else {
        throw new Error("Invalid response from server");
      }
    } catch (err) {
      console.error("GeoPDF import failed:", err);
      
      // Provide user-friendly error message for GDAL issues
      let errorMessage = err?.message || "Failed to import GeoPDF. Check console for details.";
      if (errorMessage.includes("GDAL is not available") || errorMessage.includes("503")) {
        errorMessage = "GeoPDF import requires GDAL to be installed on the server.\n\n" +
          "Please contact your system administrator to install GDAL.\n\n" +
          "Installation instructions:\n" +
          "• Windows: Install OSGeo4W or use conda install -c conda-forge gdal\n" +
          "• Linux: sudo apt-get install gdal-bin\n" +
          "• macOS: brew install gdal\n\n" +
          "After installation, restart the backend server.";
      }
      
      alert(errorMessage);
    } finally {
      setIsUploadingGeoPDF(false);
      if (geopdfUploadRef.current) {
        geopdfUploadRef.current.value = "";
      }
    }
  }

  // ======================================================
  // GEOPDF DATASET PREVIEW HANDLERS
  // ======================================================
  function handleToggleDatasetPreview(dataset) {
    if (!dataset.preview_url || !dataset.preview_bounds) {
      alert("Preview not available for this dataset. The GeoPDF may not have georeferencing information.");
      return;
    }

    // If this dataset is already active, toggle it off
    if (activeDatasetPreview && activeDatasetPreview.id === dataset.id) {
      setActiveDatasetPreview(null);
    } else {
      // Set this dataset as active (only one at a time)
      setActiveDatasetPreview({
        id: dataset.id,
        preview_url: dataset.preview_url,
        preview_bounds: dataset.preview_bounds,
      });
    }
  }

  async function handleDeleteDataset(datasetId) {
    if (!confirm("Are you sure you want to delete this dataset? This action cannot be undone.")) {
      return;
    }

    try {
      await deleteGeoPDF(datasetId);
      
      // Remove from UI immediately
      setDatasets((prev) => prev.filter((ds) => ds.id !== datasetId));
      
      // Clear preview if this was the active one
      if (activeDatasetPreview && activeDatasetPreview.id === datasetId) {
        setActiveDatasetPreview(null);
      }
      
      alert("Dataset deleted successfully");
    } catch (err) {
      console.error("Failed to delete dataset:", err);
      alert(err?.message || "Failed to delete dataset. Check console for details.");
    }
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
          <select value={mapType} onChange={(e) => setMapType(e.target.value)} className="input">
            <option value="mortality">Mortality (Monthly)</option>
            <option value="hsl">High Stress Level (HSL)</option>
          </select>
        </div>

        {/* SPECIES SELECTOR */}
        <div className="filter-block">
          <label>Species</label>
          <select value={species} onChange={(e) => setSpecies(e.target.value)} className="input">
            <option value="Douglas-fir">Douglas-fir</option>
            <option value="Western Hemlock">Western Hemlock</option>
          </select>
        </div>

        {/* HSL WARNING */}
        {isHslWhInvalid && (
          <div
            className="filter-block"
            style={{
              backgroundColor: "#fef2f2",
              border: "1px solid #fecaca",
              borderRadius: 0,
              padding: "10px",
              marginBottom: "12px",
              fontSize: "12px",
              color: "#991b1b",
            }}
          >
            ⚠️ HSL is only available for Douglas-fir. Please select Douglas-fir or switch to Mortality map type.
          </div>
        )}

        {/* HSL FILTERS (DF) */}
        {mapType === "hsl" && species === "Douglas-fir" && (
          <>
            <div className="filter-block">
              <label>HSL Condition</label>
              <select value={hslCondition} onChange={(e) => setHslCondition(e.target.value)} className="input">
                <option value="D">D (Dry)</option>
                <option value="W">W (Wet)</option>
                <option value="N">N (Normal)</option>
              </select>
            </div>

            <div className="filter-block">
              <label>HSL Class</label>
              <select value={hslClass} onChange={(e) => setHslClass(e.target.value)} className="input">
                <option value="l">l (Low)</option>
                <option value="ml">ml (Medium-Low)</option>
                <option value="m">m (Medium)</option>
                <option value="mh">mh (Medium-High)</option>
                <option value="h">h (High)</option>
                <option value="vh">vh (Very High)</option>
              </select>
            </div>

            <div className="filter-block">
              <label>Cover %</label>
              <select value={coverPercent} onChange={(e) => setCoverPercent(e.target.value)} className="input">
                <option value="0">0%</option>
                <option value="25">25%</option>
                <option value="50">50%</option>
                <option value="75">75%</option>
                <option value="100">100%</option>
              </select>
            </div>
          </>
        )}

        {/* HSL FILTERS (WH - condition + cover) */}
        {mapType === "hsl" && species === "Western Hemlock" && hasWhHslRasters && (
          <>
            <div className="filter-block">
              <label>HSL Condition</label>
              <select value={hslCondition} onChange={(e) => setHslCondition(e.target.value)} className="input">
                <option value="D">D (Dry)</option>
                <option value="W">W (Wet)</option>
                <option value="N">N (Normal)</option>
              </select>
            </div>

            <div className="filter-block">
              <label>Cover %</label>
              <select value={coverPercent} onChange={(e) => setCoverPercent(e.target.value)} className="input">
                <option value="0">0%</option>
                <option value="25">25%</option>
                <option value="50">50%</option>
                <option value="75">75%</option>
                <option value="100">100%</option>
              </select>
            </div>
          </>
        )}

        {/* MORTALITY FILTERS */}
        {mapType === "mortality" && (
          <>
            <div className="filter-block">
              <label>Month</label>
              <select value={month} onChange={(e) => setMonth(e.target.value)} className="input">
                <option value="04">April</option>
                <option value="05">May</option>
                <option value="06">June</option>
                <option value="07">July</option>
                <option value="08">August</option>
                <option value="09">September</option>
              </select>
            </div>

            <div className="filter-block">
              <label>Condition</label>
              <select value={condition} onChange={(e) => setCondition(e.target.value)} className="input">
                <option value="Dry">Dry</option>
                <option value="Wet">Wet</option>
                <option value="Normal">Normal</option>
              </select>
            </div>

            {species === "Douglas-fir" && (
              <>
                <div className="filter-block">
                  <label>Cover %</label>
                  <select value={coverPercent} onChange={(e) => setCoverPercent(e.target.value)} className="input">
                    <option value="0">0%</option>
                    <option value="25">25%</option>
                    <option value="50">50%</option>
                    <option value="75">75%</option>
                    <option value="100">100%</option>
                  </select>
                </div>

                <div className="filter-block">
                  <label>Stress Level</label>
                  <select value={dfStress} onChange={(e) => setDfStress(e.target.value)} className="input">
                    <option value="Low Stress">Low Stress</option>
                    <option value="Medium-Low Stress">Medium-Low Stress</option>
                    <option value="Medium Stress">Medium Stress</option>
                    <option value="Medium-High Stress">Medium-High Stress</option>
                    <option value="High Stress">High Stress</option>
                  </select>
                </div>
              </>
            )}

            {species === "Western Hemlock" && (
              <div className="filter-block">
                <label>Cover %</label>
                <select value={coverPercent} onChange={(e) => setCoverPercent(e.target.value)} className="input">
                  <option value="0">0%</option>
                  <option value="25">25%</option>
                  <option value="50">50%</option>
                  <option value="75">75%</option>
                  <option value="100">100%</option>
                </select>
              </div>
            )}
          </>
        )}

        {/* SELECTED RASTER DISPLAY */}
        {selectedRasterPath && (
          <div
            className="filter-block"
            style={{
              backgroundColor: "#ffffff",
              border: "1px solid #e2e8f0",
              borderRadius: 0,
              padding: "10px 12px",
              marginBottom: "12px",
            }}
          >
            <div
              style={{
                fontSize: "12px",
                color: "#1e293b",
                lineHeight: "1.5",
                fontFamily: "monospace",
                wordBreak: "break-all",
                whiteSpace: "pre-wrap",
              }}
            >
              <div
                style={{
                  fontWeight: 600,
                  marginBottom: "4px",
                  fontSize: "11px",
                  color: "#64748b",
                  textTransform: "uppercase",
                  letterSpacing: "0.5px",
                }}
              >
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
            style={{ opacity: isHslWhInvalid || !userClip ? 0.5 : 1 }}
          >
            Generate Map
          </button>
        </div>

        {/* AOI UPLOAD */}
        <div className="filter-section">
          <h3 className="section-title">Upload AOI</h3>
          <p className="section-help">
            Upload Shapefile (.zip), GeoJSON (.geojson, .json), or KML (.kml). Uploaded AOIs are displayed but not
            editable.
          </p>

          <div className="file-input-wrapper">
            <input
              ref={fileInputRef}
              type="file"
              accept=".geojson,.json,.zip,.kml"
              onChange={handleUploadAoi}
              style={{ display: "none" }}
              id="aoi-file-input"
            />
            <button type="button" className="btn-secondary" onClick={() => fileInputRef.current?.click()}>
              Upload
            </button>
            <span className="file-hint">.zip / .geojson / .json / .kml</span>
          </div>

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
                  <span style={{ color: "#475569" }}>{aoi._fileName || `AOI ${i + 1}`}</span>
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

        {/* GEOPDF UPLOAD */}
        <div className="filter-section">
          <h3 className="section-title">Import GeoPDF (Preview on Map)</h3>
          <p className="section-help">
            Upload a GeoPDF to preview it as an overlay on the map. The GeoPDF will be converted to a PNG overlay with geographic bounds.
          </p>

          <div className="file-input-wrapper">
            <input
              ref={geopdfUploadRef}
              type="file"
              accept=".pdf"
              onChange={handleUploadGeoPDF}
              style={{ display: "none" }}
              id="geopdf-file-input"
              disabled={isUploadingGeoPDF}
            />
            <button
              type="button"
              className="btn-secondary"
              onClick={() => geopdfUploadRef.current?.click()}
              disabled={isUploadingGeoPDF}
            >
              {isUploadingGeoPDF ? "Uploading..." : "Upload GeoPDF"}
            </button>
            <span className="file-hint">.pdf (max 200MB)</span>
          </div>
        </div>

        {/* DATASETS LIST */}
        {datasets.length > 0 && (
          <div className="filter-section">
            <h3 className="section-title">Datasets ({datasets.length})</h3>
            <div style={{ maxHeight: "300px", overflowY: "auto" }}>
              {datasets.map((dataset) => (
                <div
                  key={dataset.id}
                  style={{
                    padding: "8px",
                    marginBottom: "8px",
                    background: "#f9fafb",
                    border: "1px solid #e5e7eb",
                    borderRadius: 0,
                    fontSize: "12px",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "4px" }}>
                    {dataset.preview_url && (
                      <img
                        src={apiUrl(dataset.preview_url)}
                        alt="Preview"
                        style={{
                          width: "40px",
                          height: "40px",
                          objectFit: "cover",
                          border: "1px solid #d1d5db",
                        }}
                        onError={(e) => {
                          e.target.style.display = "none";
                        }}
                      />
                    )}
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 600, color: "#111827", marginBottom: "2px" }}>
                        {dataset.name}
                      </div>
                      <div style={{ color: "#6b7280", fontSize: "11px" }}>
                        {dataset.type_label || dataset.type}
                        {dataset.size_bytes && ` • ${(dataset.size_bytes / 1024 / 1024).toFixed(1)} MB`}
                        {dataset.created_at && ` • ${new Date(dataset.created_at).toLocaleDateString()}`}
                      </div>
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: "6px", marginTop: "6px", flexWrap: "wrap" }}>
                    <button
                      type="button"
                      onClick={() => downloadDataset(dataset.id)}
                      style={{
                        padding: "4px 8px",
                        fontSize: "11px",
                        background: "#2563eb",
                        color: "white",
                        border: "none",
                        borderRadius: 0,
                        cursor: "pointer",
                      }}
                    >
                      Download
                    </button>
                    <button
                      type="button"
                      onClick={() => handleToggleDatasetPreview(dataset)}
                      disabled={!dataset.preview_url || !dataset.preview_bounds}
                      title={!dataset.preview_url || !dataset.preview_bounds ? "Preview not available" : activeDatasetPreview?.id === dataset.id ? "Hide preview" : "Show preview on map"}
                      style={{
                        padding: "4px 8px",
                        fontSize: "11px",
                        background: activeDatasetPreview?.id === dataset.id ? "#10b981" : "#6b7280",
                        color: "white",
                        border: "none",
                        borderRadius: 0,
                        cursor: (!dataset.preview_url || !dataset.preview_bounds) ? "not-allowed" : "pointer",
                        opacity: (!dataset.preview_url || !dataset.preview_bounds) ? 0.5 : 1,
                      }}
                    >
                      {activeDatasetPreview?.id === dataset.id ? "Hide" : "Preview"}
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDeleteDataset(dataset.id)}
                      style={{
                        padding: "4px 8px",
                        fontSize: "11px",
                        background: "#ef4444",
                        color: "white",
                        border: "none",
                        borderRadius: 0,
                        cursor: "pointer",
                      }}
                    >
                      Remove
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* EXPORT - Collapsible (unchanged UI, still functional) */}
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

            {exportSectionExpanded && (
              <div style={{ padding: "0 12px 12px 12px", boxSizing: "border-box", width: "100%" }}>
                <p className="section-help" style={{ marginTop: 0 }}>
                  Export clipped raster and statistics in multiple formats.
                </p>

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

                  <label className="checkbox-row">
                    <input
                      type="checkbox"
                      checked={exportFormats.geopdf}
                      onChange={(e) => setExportFormats({ ...exportFormats, geopdf: e.target.checked })}
                    />
                    <span>
                      GeoPDF (Avenza Maps)
                      <span
                        title="A GeoPDF is a georeferenced PDF that preserves coordinates so it works offline in Avenza Maps with GPS."
                        style={{ marginLeft: "4px", cursor: "help", fontSize: "12px", color: "#6b7280" }}
                      >
                        ⓘ
                      </span>
                    </span>
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
                    opacity: userClip && !isHslWhInvalid && !isExporting ? 1 : 0.5,
                    marginTop: "8px",
                  }}
                >
                  {isExporting ? "Exporting..." : "Export"}
                </button>

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
                          href={`${API_BASE}${exportResults.png}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{ fontSize: 12, color: "#2563eb", textDecoration: "underline" }}
                        >
                          Download PNG
                        </a>
                      )}
                      {exportResults.tif && (
                        <a
                          href={`${API_BASE}${exportResults.tif}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{ fontSize: 12, color: "#2563eb", textDecoration: "underline" }}
                        >
                          Download TIF
                        </a>
                      )}
                      {exportResults.csv && (
                        <a
                          href={`${API_BASE}${exportResults.csv}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{ fontSize: 12, color: "#2563eb", textDecoration: "underline" }}
                        >
                          Download CSV
                        </a>
                      )}
                      {exportResults.geojson && (
                        <a
                          href={`${API_BASE}${exportResults.geojson}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{ fontSize: 12, color: "#2563eb", textDecoration: "underline" }}
                        >
                          Download GeoJSON
                        </a>
                      )}
                      {exportResults.json && (
                        <a
                          href={`${API_BASE}${exportResults.json}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{ fontSize: 12, color: "#2563eb", textDecoration: "underline" }}
                        >
                          Download JSON
                        </a>
                      )}
                      {exportResults.pdf && (
                        <a
                          href={`${API_BASE}${exportResults.pdf}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{ fontSize: 12, color: "#2563eb", textDecoration: "underline", fontWeight: 600 }}
                        >
                          Download PDF Report
                        </a>
                      )}
                      {exportResults.geopdf && (
                        <a
                          href={`${API_BASE}${exportResults.geopdf}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{ fontSize: 12, color: "#2563eb", textDecoration: "underline", fontWeight: 600 }}
                        >
                          Download GeoPDF (Avenza Maps)
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
          aois={aois}
          userClip={userClip}
          overlayUrl={overlayUrl || null}
          overlayBounds={overlayBounds || null}
          onUserClipChange={handleUserClipChange}
          onRemoveAoi={handleRemoveAoi}
          activeRasterId={activeRasterId}
          datasetPreview={activeDatasetPreview}
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
            <>
              <HistogramPanel values={pixelValues} stats={stats} histogram={histogram} />
              <CreatedRastersList
                rasters={createdRasters}
                activeRasterId={createdRasters.find((r) => r.activeRasterId === activeRasterId)?.id || null}
                onShowRaster={handleShowRaster}
                onRemoveRaster={handleRemoveRaster}
              />
            </>
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
