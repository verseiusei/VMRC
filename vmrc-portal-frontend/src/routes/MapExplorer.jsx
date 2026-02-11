// src/routes/MapExplorer.jsx
import { useEffect, useState, useRef, useCallback } from "react";

import BaseMap from "../components/map/BaseMap";
import SlidingPanel from "../components/ui/SlidingPanel";
import HistogramPanel from "../components/charts/HistogramPanel";
import StatsTable from "../components/charts/StatsTable";
import CreatedRastersList from "../components/raster/CreatedRastersList";
import LayerInfoPanel from "../components/ui/LayerInfoPanel";
import FilterLabelWithInfo from "../components/ui/FilterLabelWithInfo";

import { fetchGlobalAOI, clipRaster, exportRaster, downloadBlob, downloadGeoPDF, listDatasets, downloadDataset, getDatasetPreview, deleteGeoPDF, fetchLayerMetadata, fetchRasterMetadata, deleteOverlay, apiUrl, API_BASE } from "../lib/rasterApi";
import { parseAOIFile, getGeoJSONBounds, normalizeGeoJSON } from "../lib/aoiParser";
import shp from "shpjs";
import * as turf from "@turf/turf";
import { FaChartBar, FaTable } from "react-icons/fa";

// Single source of truth: Time of the Year -> product (HSL | MORTALITY) + month (04-09 | null)
const TIME_OF_YEAR_MAP = {
  HSL: { product: "HSL", month: null },
  APR: { product: "MORTALITY", month: "04" },
  MAY: { product: "MORTALITY", month: "05" },
  JUN: { product: "MORTALITY", month: "06" },
  JUL: { product: "MORTALITY", month: "07" },
  AUG: { product: "MORTALITY", month: "08" },
  SEP: { product: "MORTALITY", month: "09" },
};

export default function MapExplorer() {
  // ======================================================
  // STATE
  // ======================================================
  const [globalAoi, setGlobalAoi] = useState(null);
  // Legacy state (kept for backward compatibility, but createdRasters is primary)
  const [overlayUrl, setOverlayUrl] = useState(null);
  const [overlayBounds, setOverlayBounds] = useState(null);

  // Export UI state (MUST exist)
  const [filename, setFilename] = useState("");
  const [exportFormats, setExportFormats] = useState({
    png: true,
    tif: true,
    geojson: false,
    pdf: false,
  });
  const [isExporting, setIsExporting] = useState(false);
  const [exportResults, setExportResults] = useState(null);

  // Unified AOI array: contains both drawn and uploaded AOIs, each with its own overlay
  const [aois, setAois] = useState([]);
  const [activeRasterId, setActiveRasterId] = useState(null); // Backend raster layer ID (for click sampling)
  const [activeCreatedRasterId, setActiveCreatedRasterId] = useState(null); // Created raster ID (for histogram display)

  // Generation state
  const [isGenerating, setIsGenerating] = useState(false);
  const [generationProgress, setGenerationProgress] = useState({ current: 0, total: 0 });

  // Legacy state for backward compatibility (will be removed)
  const [userClip, setUserClip] = useState(null); // Keep for Generate button check
  const userClipRef = useRef(null); // Persistent ref for drawn AOI (survives state loss)
  const drawnAoiIdRef = useRef(null); // Persistent ref for drawn AOI ID (for pairing)
  const [uploadedAois, setUploadedAois] = useState([]); // Keep for display list
  
  // Ref to track previous createdRasters for change detection
  const prevCreatedRastersRef = useRef([]);
  
  // Ref to track export state (prevents cleanup functions from running during export)
  const isExportingRef = useRef(false);
  
  // ✅ Ref to track last AOI ID that triggered cleanup (prevents cleanup on UI clicks)
  const lastCleanupAoiIdRef = useRef(null);
  
  // ============================================================
  // PERSISTENT AOI STORE - True source of truth that survives all renders
  // ============================================================
  // These refs store AOI data independently of React state
  // They are ONLY updated on explicit user actions (draw/edit/remove)
  // They are NEVER cleared by filter changes, export dropdown, or overlay clearing
  // ============================================================
  const persistentDrawnAoiRef = useRef(null); // Stores drawn AOI GeoJSON FeatureCollection
  const persistentDrawnAoiIdRef = useRef(null); // Stores drawn AOI stable ID
  const persistentAoisRef = useRef([]); // Stores all AOIs (drawn + uploaded) as backup
  
  // Selected AOIs: tracks currently selected AOIs (both drawn and uploaded) for overlap detection
  // Format: [{ id, source: "uploaded"|"drawn", geojson }]
  const [selectedAois, setSelectedAois] = useState([]);

  // ======================================================
  // ACTIVE AOI STATE - Persists across filter changes
  // ======================================================
  // The active AOI is used for Generate Map requests
  // Users can change filters and regenerate without redrawing
  // ======================================================
  const [activeAoi, setActiveAoi] = useState({
    source: null, // "drawn" | "uploaded" | null
    id: null, // id of the AOI in state (matches aoi.id in aois array)
    geoJSON: null, // canonical GeoJSON geometry (normalized FeatureCollection in EPSG:4326)
    name: null, // display name
  });

  // ======================================================
  // ACTIVE AOI ID - Single source of truth for "only one AOI"
  // ======================================================
  // Only ONE AOI can be active at a time
  // Sidebar (Histogram + Created Rasters) shows data ONLY for activeAoiId
  // ======================================================
  const [activeAoiId, setActiveAoiId] = useState(null); // string | null

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

  // Time of the Year: "HSL" | "APR" | "MAY" | "JUN" | "JUL" | "AUG" | "SEP" (single dropdown)
  const [timeOfYear, setTimeOfYear] = useState("HSL");

  // Species selector
  const [species, setSpecies] = useState("Douglas-fir");

  // Derived from timeOfYear (used everywhere mapType/month were used)
  const timeOfYearConfig = TIME_OF_YEAR_MAP[timeOfYear] ?? TIME_OF_YEAR_MAP.HSL;
  const mapType = (timeOfYearConfig.product || "HSL").toLowerCase(); // "hsl" | "mortality"
  const month = timeOfYearConfig.month; // "04"-"09" | null (null for HSL)

  // Mortality/condition filters
  const [condition, setCondition] = useState("Dry");

  // DF-only filters for Mortality
  const [dfStress, setDfStress] = useState("Low Stress"); // For DF Mortality only
  const [coverPercent, setCoverPercent] = useState("50"); // For DF Mortality, WH Mortality, DF HSL, and WH HSL

  // HSL filters (DF-only)
  const [hslCondition, setHslCondition] = useState("D"); // D/W/N
  const [hslClass, setHslClass] = useState("l"); // l/ml/m/mh/h/vh

  // Map instance ref for zoom checking
  const mapInstanceRef = useRef(null);
  
  // Persistent ref to last drawn AOI GeoJSON (from BaseMap)
  // This survives state loss and is used as fallback when userClip is empty
  // Note: This is a ref to a ref - BaseMap passes its ref object to us
  const lastDrawnAoiRefWrapper = useRef(null);

  // Created rasters list
  const [createdRasters, setCreatedRasters] = useState([]);

  // Layer metadata
  const [layerMetadata, setLayerMetadata] = useState(null);
  const [isLoadingMetadata, setIsLoadingMetadata] = useState(false);

  // AOI upload
  const fileInputRef = useRef(null);
  
  // Datasets
  const [datasets, setDatasets] = useState([]);
  const [activeDatasetPreview, setActiveDatasetPreview] = useState(null); // { id, preview_url, preview_bounds }

  // ======================================================
  // SESSION PERSISTENCE: Load created rasters from sessionStorage on mount
  // ======================================================
  useEffect(() => {
    try {
      const savedRasters = sessionStorage.getItem("vmrc_created_rasters");
      const savedActiveId = sessionStorage.getItem("vmrc_active_created_raster_id");
      const savedActiveAoiId = sessionStorage.getItem("vmrc_active_aoi_id");
      
      let parsedRasters = null;
      
      if (savedRasters) {
        parsedRasters = JSON.parse(savedRasters);
        if (Array.isArray(parsedRasters)) {
          console.log(`[Session] Restored ${parsedRasters.length} created raster(s) from sessionStorage`);
          setCreatedRasters(parsedRasters);
        } else {
          console.warn("[Session] Invalid saved rasters format, skipping restore");
          parsedRasters = null;
        }
      }
      
      if (savedActiveAoiId) {
        const parsedAoiId = JSON.parse(savedActiveAoiId);
        console.log(`[Session] Restored active AOI ID: ${parsedAoiId}`);
        setActiveAoiId(parsedAoiId);
      }
      
      if (savedActiveId) {
        const parsedId = JSON.parse(savedActiveId);
        console.log(`[Session] Restored active raster ID: ${parsedId}`);
        setActiveCreatedRasterId(parsedId);
        
        // Also restore the active raster's data if it exists in saved rasters
        if (parsedRasters) {
          const activeRaster = parsedRasters.find((r) => r.id === parsedId);
          if (activeRaster) {
            setActiveRasterId(activeRaster.activeRasterId);
            setStats(activeRaster.stats || null);
            setPixelValues(activeRaster.pixelValues || []);
            setHistogram(activeRaster.histogram || null);
          }
        }
      }
    } catch (err) {
      console.error("[Session] Failed to load from sessionStorage:", err);
      // Clear corrupted data
      sessionStorage.removeItem("vmrc_created_rasters");
      sessionStorage.removeItem("vmrc_active_created_raster_id");
      sessionStorage.removeItem("vmrc_active_aoi_id");
    }
  }, []); // Run only on mount

  // ======================================================
  // SESSION PERSISTENCE: Save created rasters to sessionStorage on change
  // ======================================================
  useEffect(() => {
    try {
      // Only store metadata (id, name, overlayUrl, overlayBounds, histogram, stats, etc.)
      // overlayUrl is just a URL string, so it's safe to store
      sessionStorage.setItem("vmrc_created_rasters", JSON.stringify(createdRasters));
      console.log(`[Session] Saved ${createdRasters.length} created raster(s) to sessionStorage`);
    } catch (err) {
      console.error("[Session] Failed to save createdRasters to sessionStorage:", err);
      // sessionStorage might be full - try to clear old data
      try {
        sessionStorage.removeItem("vmrc_created_rasters");
        sessionStorage.setItem("vmrc_created_rasters", JSON.stringify(createdRasters));
      } catch (clearErr) {
        console.error("[Session] Failed to clear and retry:", clearErr);
      }
    }
  }, [createdRasters]);

  // ======================================================
  // SESSION PERSISTENCE: Save active raster ID to sessionStorage on change
  // ======================================================
  useEffect(() => {
    try {
      sessionStorage.setItem("vmrc_active_created_raster_id", JSON.stringify(activeCreatedRasterId));
    } catch (err) {
      console.error("[Session] Failed to save activeCreatedRasterId to sessionStorage:", err);
    }
  }, [activeCreatedRasterId]);

  // ======================================================
  // SESSION PERSISTENCE: Save active AOI ID to sessionStorage on change
  // ======================================================
  useEffect(() => {
    try {
      sessionStorage.setItem("vmrc_active_aoi_id", JSON.stringify(activeAoiId));
    } catch (err) {
      console.error("[Session] Failed to save activeAoiId to sessionStorage:", err);
    }
  }, [activeAoiId]);

  // ======================================================
  // EFFECT: Restore active raster overlay when map is ready
  // ======================================================
  // When activeCreatedRasterId is set and map is ready, show the active raster overlay
  useEffect(() => {
    if (!activeCreatedRasterId || !mapInstanceRef.current) return;
    
    const raster = createdRasters.find((r) => r.id === activeCreatedRasterId);
    if (!raster) return;
    
    // Wait a bit for LayerGroupManager to initialize
    const timer = setTimeout(() => {
      if (mapInstanceRef.current && mapInstanceRef.current._layerGroupManager) {
        const manager = mapInstanceRef.current._layerGroupManager;
        
        // Show the active raster overlay
        if (raster.aoiId) {
          manager.setActiveRasterForAoi(raster.aoiId, activeCreatedRasterId);
        } else {
          manager.showRasterOverlay(activeCreatedRasterId);
        }
        
        console.log(`[MapExplorer] ✅ Restored active raster overlay: rasterId=${activeCreatedRasterId}`);
      }
    }, 100);
    
    return () => clearTimeout(timer);
  }, [activeCreatedRasterId, createdRasters]);

  // ======================================================
  // EFFECT: Sync selection when selected raster is removed (e.g. user deletes it)
  // ======================================================
  // Only run fallback when activeCreatedRasterId was set but is no longer in the list.
  // Do NOT set a default when activeCreatedRasterId is null (e.g. after filter change);
  // the generate handler will set the newest raster after successful generate.
  // Fallback to NEWEST (last) raster, not first, to avoid flashback to overlay #1.
  // ======================================================
  useEffect(() => {
    if (createdRasters.length === 0) return;
    if (activeCreatedRasterId == null) return; // Leave null; generate will set newest after success
    const found = createdRasters.find((r) => r.id === activeCreatedRasterId);
    if (found) return;
    const newest = createdRasters[createdRasters.length - 1];
    setActiveCreatedRasterId(newest.id);
    setActiveRasterId(newest.activeRasterId);
    setStats(newest.stats || null);
    setPixelValues(newest.pixelValues || []);
    setHistogram(newest.histogram || null);
  }, [createdRasters, activeCreatedRasterId]);

  // ======================================================
  // EFFECT: Clear stale filter state when switching map type or species
  // ======================================================
  useEffect(() => {
    // When switching map type or species, clear selected raster info
    setSelectedRasterLabel(null);
    setSelectedRasterName(null);
    setSelectedRasterPath(null);
    setSelectedRasterDetails(null);
  }, [timeOfYear, species]);

  // ======================================================
  // EFFECT: Clear overlays/stats when filters change (but keep AOIs)
  // ======================================================
  // When any filter changes, we should clear overlays and stats
  // but NOT clear AOI state (userClip, aois, uploadedAois)
  // This allows regeneration with same AOI but new filters
  // ======================================================
  useEffect(() => {
    // ============================================================
    // INSTRUMENTATION: Log AOI state before filter change cleanup
    // ============================================================
    const beforeState = {
      userClip: !!userClip,
      userClipRef: !!userClipRef.current,
      uploadedAois: uploadedAois?.length || 0,
      aois: aois.length,
      activeAoi: activeAoi.geoJSON ? true : false,
      activeAoiId: activeAoi.id,
      createdRasters: createdRasters.length,
      overlayUrl: !!overlayUrl,
    };
    console.log("[FilterChange] 🔍 BEFORE cleanup:", beforeState);
    
    // Only clear stats state, NOT AOI state, createdRasters, or overlay state
    // This runs when filters change to prepare for regeneration
    // CRITICAL: We do NOT clear createdRasters, overlayUrl, or overlayBounds here
    // - createdRasters: overlays should remain visible until user explicitly clears or regenerates
    // - overlayUrl/overlayBounds: legacy state preserved, only cleared on explicit user actions
    console.trace("[CLEAR_OVERLAYS] Filter change useEffect - clearing stats ONLY (preserving overlay state)");
    
    // CRITICAL: We do NOT clear overlayUrl/overlayBounds here - they are only cleared on explicit user actions
    // The real overlays are in createdRasters, which we preserve
    
    // Clear active raster selection (user can select again after regenerating)
    setActiveRasterId(null);
    setActiveCreatedRasterId(null);
    
    // Clear stats (will be regenerated when user clicks Generate)
    setStats(null);
    setPixelValues([]);
    setHistogram(null);
    
    // CRITICAL: We do NOT clear:
    // - userClip (drawn AOI state)
    // - userClipRef (persistent ref for drawn AOI)
    // - drawnAoiIdRef (persistent ref for drawn AOI ID)
    // - aois (AOI array - contains both drawn and uploaded)
    // - uploadedAois (uploaded AOI list - legacy but keep for compatibility)
    // - selectedAois (selected AOIs for overlap detection)
    // - activeAoi (active AOI state)
    // - lastDrawnAoiRef (persistent ref in BaseMap)
    // - createdRasters (rasters remain visible until explicitly cleared or regenerated)
    // - overlayUrl/overlayBounds (legacy overlay state preserved, only cleared on explicit user actions)
    
    // ============================================================
    // INSTRUMENTATION: Log AOI state after filter change cleanup
    // ============================================================
    // Note: State values here are from closure, so they won't reflect React updates
    // But we can verify the setState calls didn't touch AOI state
    console.log("[FilterChange] ✅ AFTER cleanup - State setters called for overlays/stats only, AOI state preserved in closure");
    console.log("[FilterChange] 📊 Closure state (may be stale):", {
      userClip: !!userClip,
      userClipRef: !!userClipRef.current,
      uploadedAois: uploadedAois?.length || 0,
      aois: aois.length,
      activeAoi: activeAoi.geoJSON ? true : false,
    });
  }, [timeOfYear, species, condition, dfStress, coverPercent, hslCondition, hslClass]);

  // When Species = Western Hemlock, force stress/category to "Medium" for consistent UI (backend ignores for WH)
  useEffect(() => {
    if (species === "Western Hemlock") {
      setDfStress("Medium Stress");
      setHslClass("m");
    }
  }, [species]);

  // ======================================================
  // INSTRUMENTATION: Track AOI state changes
  // ======================================================
  // This will help us identify what's clearing AOI state
  useEffect(() => {
    const stackTrace = new Error().stack;
    const caller = stackTrace?.split('\n')[2]?.trim() || 'unknown';
    console.log("[AOIState] 🔍 AOI state changed:", {
      aois: aois.length,
      aoisDetails: aois.map(a => ({ id: a.id, type: a.type })),
      uploadedAois: uploadedAois?.length || 0,
      userClip: !!userClip,
      userClipRef: !!userClipRef.current,
      activeAoi: activeAoi.geoJSON ? true : false,
      activeAoiId: activeAoi.id,
      caller: caller.substring(0, 100), // First 100 chars of stack frame
    });
  }, [aois, uploadedAois, userClip, activeAoi]);

  // ======================================================
  // INSTRUMENTATION: Track overlay state changes
  // ======================================================
  // This will help us identify what's clearing overlay state
  useEffect(() => {
    const stackTrace = new Error().stack;
    const caller = stackTrace?.split('\n')[2]?.trim() || 'unknown';
    
    // Log with special attention to createdRasters being cleared
    const wasCleared = prevCreatedRastersRef.current?.length > 0 && createdRasters.length === 0;
    
    if (wasCleared) {
      console.error("[OverlayState] ⚠️ WARNING: createdRasters was cleared!", {
        previousCount: prevCreatedRastersRef.current?.length || 0,
        currentCount: createdRasters.length,
        caller: caller.substring(0, 150),
        fullStack: stackTrace,
      });
    }
    
    console.log("[OverlayState] 🔍 Overlay state changed:", {
      overlayUrl: !!overlayUrl,
      overlayBounds: !!overlayBounds,
      createdRasters: createdRasters.length,
      activeRasterId,
      activeCreatedRasterId,
      caller: caller.substring(0, 100),
    });
    
    prevCreatedRastersRef.current = createdRasters;
  }, [overlayUrl, overlayBounds, createdRasters, activeRasterId, activeCreatedRasterId]);


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

    fetch(apiUrl("/api/v1/rasters/list"))
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
  // ======================================================
  // CLEAR OVERLAYS ON NEW AOI START
  // ======================================================
  // When user starts drawing a new AOI (pm:drawstart event),
  // clear all overlays so the map is clean for the next clip
  // NOTE: This is called when user STARTS drawing a NEW AOI
  // It should NOT be called after successful generation - AOIs should persist for regeneration
  // CRITICAL: This must NEVER be called during export UI changes - export is read-only
  // ======================================================
  function handleStartNewAoi(reason = "draw-start") {
    // CRITICAL GUARD: Do NOT clear overlays if export is active
    if (isExportingRef.current) {
      console.warn("[MapExplorer] ⚠️ BLOCKED: handleStartNewAoi called during export - export must not clear overlays");
      console.trace("[CLEAR_OVERLAY] ⚠️ BLOCKED: setCreatedRasters([]) prevented during export");
      return; // Early return - do NOT clear overlays
    }
    
    // CRITICAL GUARD: Do NOT clear overlays if this is triggered by export UI or other non-draw actions
    if (reason === "export-ui" || reason === "ui-render") {
      console.warn("[MapExplorer] ⚠️ BLOCKED: handleStartNewAoi called with reason:", reason, "- export UI must not clear overlays");
      return; // Early return - do NOT clear overlays
    }
    
    console.log("[MapExplorer] Starting new AOI - enforcing only one AOI at a time");
    console.log("[MapExplorer] Reason:", reason);
    
    // ============================================================
    // ENFORCE "ONLY ONE AOI" - Clear old AOI and all its data
    // ============================================================
    const oldActiveAoiId = activeAoiId;
    
    if (oldActiveAoiId && mapInstanceRef.current?._layerGroupManager) {
      console.log(`[MapExplorer] Removing old active AOI ${oldActiveAoiId} before starting new one`);
      // Remove old AOI and all its rasters from map
      mapInstanceRef.current._layerGroupManager.removeAoiAndAllRasters(oldActiveAoiId);
    }
    
    // Clear all created rasters (overlays) when starting a NEW draw
    // This ensures the map is clean for the new AOI
    console.trace("[CLEAR_OVERLAYS] handleStartNewAoi - clearing createdRasters");
    console.log("[CLEAR_OVERLAY] ⚠️ setCreatedRasters([]) called from handleStartNewAoi");
    setCreatedRasters([]);
    
    // Clear active raster state
    setActiveRasterId(null);
    setActiveCreatedRasterId(null);
    
    // Clear right panel data
    setStats(null);
    setPixelValues([]);
    setHistogram(null);
    
    // Clear active AOI ID (will be set when new AOI is created)
    setActiveAoiId(null);
    
    // Clear sessionStorage (only overlay-related data)
    try {
      sessionStorage.removeItem("vmrc_created_rasters");
      sessionStorage.removeItem("vmrc_active_created_raster_id");
      sessionStorage.removeItem("vmrc_active_aoi_id");
      console.log("[Session] Cleared sessionStorage for new AOI");
    } catch (err) {
      console.error("[Session] Failed to clear sessionStorage:", err);
    }
    
    // Clear legacy overlay state
    setOverlayUrl(null);
    setOverlayBounds(null);
    
    // Clear raster labels
    setSelectedRasterLabel(null);
    setSelectedRasterName(null);
    setSelectedRasterPath(null);
    setSelectedRasterDetails(null);
    
    // Note: activeAoi will be updated when the new AOI is actually created (pm:create event)
    // We don't clear it here because the user might cancel the draw, and we want to preserve
    // the previous active AOI in that case.
  }

  // ======================================================
  // CLEAR DRAWN AOI GEOMETRY
  // ======================================================
  // This is called when user starts drawing to clear old drawn shapes
  // The actual clearing happens in BaseMap component, this is just a placeholder
  // for future use if we need to clear state
  // ======================================================
  function handleClearDrawnAoi() {
    console.log("[MapExplorer] Clearing drawn AOI geometry (handled by BaseMap)");
    // The actual layer clearing happens in BaseMap component
    // This callback can be used to clear any related state if needed
  }

  // ======================================================
  // RESET FOR NEW AOI (draw or upload)
  // ======================================================
  // Clears Created rasters list, all raster overlays from map, and raster-related state.
  // Call when a new AOI is created (draw finished, upload success) so only rasters
  // from the current AOI appear in the list. Does NOT remove AOI layers.
  // ======================================================
  const resetForNewAOI = useCallback(() => {
    if (isExportingRef.current) {
      console.warn("[MapExplorer] ⚠️ BLOCKED: resetForNewAOI during export");
      return;
    }
    console.log("[MapExplorer] resetForNewAOI: Clearing created rasters and overlays for new AOI");
    if (mapInstanceRef.current?._layerGroupManager?.removeAllRasterOverlaysOnly) {
      mapInstanceRef.current._layerGroupManager.removeAllRasterOverlaysOnly();
    }
    setCreatedRasters([]);
    setActiveCreatedRasterId(null);
    setActiveRasterId(null);
    setStats(null);
    setPixelValues([]);
    setHistogram(null);
    setOverlayUrl(null);
    setOverlayBounds(null);
    setSelectedRasterLabel(null);
    setSelectedRasterName(null);
    setSelectedRasterPath(null);
    setSelectedRasterDetails(null);
    try {
      sessionStorage.removeItem("vmrc_created_rasters");
      sessionStorage.removeItem("vmrc_active_created_raster_id");
    } catch (err) {
      console.error("[MapExplorer] Failed to clear sessionStorage:", err);
    }
  }, []);

  // ======================================================
  // HANDLE USER CLIP CHANGE (Drawn AOI)
  // ======================================================
  // Called when user finishes drawing a new AOI
  // Updates BOTH state and ref for persistence
  // Checks for overlaps before adding to selectedAois
  // ======================================================
  const handleUserClipChange = useCallback((nextClip) => {
    // Only clear legacy overlay state if clip is explicitly cleared (null)
    if (!nextClip) {
      console.log("[MapExplorer] 🗑️ EXPLICIT CLEAR: userClip cleared (both state and ref)");
      console.trace("[AOI_CLEAR] handleUserClipChange(null) - explicit user action");
      
      setUserClip(null);
      userClipRef.current = null; // Clear ref too
      drawnAoiIdRef.current = null; // Clear aoiId ref too
      
      // CRITICAL: Also clear persistent refs (this is an explicit user action)
      persistentDrawnAoiRef.current = null;
      persistentDrawnAoiIdRef.current = null;
      
      // Clear legacy single overlay state (for backward compatibility)
      setOverlayUrl(null);
      setOverlayBounds(null);

      // Clear right panel data
      setPixelValues([]);
      setStats(null);
      setHistogram(null);

      setActiveRasterId(null);
      setActiveCreatedRasterId(null);

      // Clear raster labels when clip is cleared
      setSelectedRasterLabel(null);
      setSelectedRasterName(null);
      setSelectedRasterPath(null);
      setSelectedRasterDetails(null);

      // ============================================================
      // CLEAR ACTIVE AOI when clip is explicitly cleared
      // ============================================================
      setActiveAoi({
        source: null,
        id: null,
        geoJSON: null,
        name: null,
      });
      console.log("[MapExplorer] Cleared active AOI (clip cleared)");
      return;
    }
    
    // ============================================================
    // AOI SET/UPDATE - Update ALL persistent stores
    // ============================================================
    console.log("[MapExplorer] ✅ AOI SET/UPDATE: handleUserClipChange with GeoJSON");
    console.trace("[AOI_SET] handleUserClipChange(GeoJSON) - explicit user action");

    // Check for overlaps with existing selected AOIs
    const overlapCheck = checkAoiOverlap(nextClip, aois);
    if (overlapCheck.overlaps) {
      alert(overlapCheck.message || "This AOI overlaps with an existing selected AOI. Please choose a different area.");
      // Don't add the AOI - user needs to draw a different one
      // Clear the drawn layer from map (handled by BaseMap)
      return;
    }

    // Normalize to FeatureCollection
    const featureCollection = ensureFeatureCollection(nextClip);
    if (!featureCollection) {
      console.error("[handleUserClipChange] Failed to normalize GeoJSON");
      return;
    }

    // New AOI created: clear previous AOI's rasters and overlays so list and map match current AOI only
    resetForNewAOI();

    // Create drawn AOI entry (will use stable aoiId from GeoJSON properties below)
    const drawnAoi = {
      id: null, // Will be set to stable aoiId below
      geojson: featureCollection,
      name: "Drawn AOI",
      type: "draw",
      overlayUrl: null,
      overlayBounds: null,
      stats: null,
      pixelValues: [],
      activeRasterId: null,
      visible: true,
    };

    // Extract aoiId from GeoJSON properties (stable ID from BaseMap)
    const aoiId = featureCollection?.features?.[0]?.properties?.__aoiId || null;
    drawnAoiIdRef.current = aoiId;
    console.log("[MapExplorer] Extracted aoiId from GeoJSON:", aoiId);
    
    // CRITICAL: Use the stable aoiId as the aoi.id (not a new timestamp)
    // This ensures pairing works correctly when erasing
    // If aoiId is not found in GeoJSON properties, generate a new one (shouldn't happen, but fallback)
    const stableAoiId = aoiId || `drawn-${Date.now()}`;
    
    // Update the drawnAoi object to use stable aoiId
    const drawnAoiWithStableId = {
      ...drawnAoi,
      id: stableAoiId, // Use stable aoiId from BaseMap
    };
    
    // CRITICAL: Update persistent refs FIRST (these survive all renders)
    persistentDrawnAoiRef.current = featureCollection;
    persistentDrawnAoiIdRef.current = stableAoiId;
    console.log("[MapExplorer] ✅ Updated persistent AOI refs:", {
      hasGeoJSON: !!persistentDrawnAoiRef.current,
      aoiId: persistentDrawnAoiIdRef.current,
    });
    
    // Add to aois array with stable ID
    setAois((prev) => {
      // Remove previous drawn AOI (only one drawn AOI at a time)
      const filtered = prev.filter((aoi) => aoi.type !== "draw");
      const updated = [...filtered, drawnAoiWithStableId];
      // Also update persistent ref
      persistentAoisRef.current = updated;
      return updated;
    });
    
    setSelectedAois((prev) => {
      // Remove previous drawn AOI from selectedAois
      const filtered = prev.filter((aoi) => aoi.source !== "drawn");
      return [...filtered, { id: stableAoiId, source: "drawn", geojson: featureCollection }];
    });
    
    // Update BOTH state and ref for persistence
    setUserClip(featureCollection);
    userClipRef.current = featureCollection;
    console.log("[MapExplorer] userClip updated:", !!featureCollection, "with stable aoiId:", stableAoiId);

    // ============================================================
    // SET ACTIVE AOI when user finishes drawing
    // ============================================================
    // ✅ Set activeAoiId as single source of truth
    setActiveAoiId(stableAoiId);
    
    setActiveAoi({
      source: "drawn",
      id: stableAoiId, // Use stable aoiId (matches aoi.id in aois array)
      geoJSON: featureCollection, // Already normalized FeatureCollection
      name: "Drawn AOI",
    });
    console.log("[MapExplorer] Set active AOI to drawn AOI:", stableAoiId);
  }, [selectedAois, resetForNewAOI]);

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

  // Build raster label from current filters (month may be null for HSL)
  function buildRasterLabel(mapType, species, month, condition, dfStress, coverPercent, hslCondition, hslClass) {
    const parts = [];

    if (mapType === "mortality") parts.push("Mortality");
    else if (mapType === "hsl") parts.push("HSL");

    parts.push(species);

    if (mapType === "mortality" && month) {
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

  // Extract base filename from raster name (matches Raster Overview exactly)
  // This is the ONLY source of truth - uses the same value shown in "Raster Name:" in StatsTable
  // Example: "HSL2.5_DF_50_D_l.tif" -> "HSL2.5_DF_50_D_l"
  // Handles filenames with dots in the name (e.g., "HSL2.5") correctly
  function getExportBaseFromRasterName(rasterPath) {
    if (!rasterPath) {
      console.warn("[Export] No raster name available, using default");
      return "export";
    }
    
    // 1) Extract basename (handle Windows paths: split on / or \ and take last part)
    const base = String(rasterPath).split(/[\\/]/).pop();
    
    // 2) Strip ONLY the FINAL extension using lastIndexOf(".")
    // This preserves dots in the filename (e.g., "HSL2.5")
    const idx = base.lastIndexOf(".");
    const exportBase = idx > 0 ? base.slice(0, idx) : base;
    
    // 3) Sanitize for Windows (remove invalid chars: : / \ * ? " < > |)
    // But keep the name structure otherwise identical
    const sanitized = exportBase.replace(/[:/\\*?"<>|]/g, '_');
    
    console.log(`[Export] getExportBaseFromRasterName:`);
    console.log(`  rasterPath: ${rasterPath}`);
    console.log(`  basename: ${base}`);
    console.log(`  exportBase: ${sanitized}`);
    
    return sanitized || "export";
  }

  // Build export filename from current filters
  // Format: {MapType}_{Species}_{Cover}_{Climate}_{Month}
  // Example: HSL_DF_50_DRY_04
  // Note: Backend adds file extensions automatically (.tif, .pdf, etc.)
  // DEPRECATED: Use getRasterBaseFilename() instead to match Raster Overview
  function buildExportName(mapType, species, month, condition, coverPercent, hslCondition, fileExtension = "") {
    // Map type prefix
    const mapTypePrefix = mapType === "hsl" ? "HSL" : "Mortality";

    // Species code: DF or WH
    const speciesCode = species === "Douglas-fir" ? "DF" : "WH";

    // Cover percent (use as-is: 0, 25, 50, 75, 100)
    const cover = coverPercent || "0";

    // Climate: DRY/WET/NORMAL
    let climateCode = "DRY";
    if (mapType === "hsl") {
      // For HSL, use hslCondition (D/W/N)
      if (hslCondition === "W") climateCode = "WET";
      else if (hslCondition === "N") climateCode = "NORMAL";
      else climateCode = "DRY";
    } else {
      // For Mortality, use condition (Dry/Wet/Normal)
      if (condition === "Wet") climateCode = "WET";
      else if (condition === "Normal") climateCode = "NORMAL";
      else climateCode = "DRY";
    }

    // Month: only for Mortality; HSL must exclude month
    const monthPart = mapType === "hsl" ? "" : `_${month || "04"}`;

    // Build filename (without extension - backend adds it)
    const filename = `${mapTypePrefix}_${speciesCode}_${cover}_${climateCode}${monthPart}${fileExtension ? `.${fileExtension}` : ""}`;
    return filename;
  }

  // Build export filename for PDF downloads matching selected parameters
  // Format: HSL_DF_DRY_M04_Cover50_ClassI.pdf or HSL_WH_WET_M09_Cover100_ClassII.pdf
  // Uses the SAME filter snapshot as PDF metadata
  function buildExportFilename({ mapType, species, condition, month, coverPercent, hslCondition, hslClass, dfStress }) {
    const parts = [];

    // Map Type
    if (mapType === "hsl") {
      parts.push("HSL");
    } else if (mapType === "mortality") {
      parts.push("Mortality");
    }

    // Species code: DF or WH
    const speciesCode = species === "Douglas-fir" ? "DF" : "WH";
    parts.push(speciesCode);

    // Condition/Climate
    let climateCode = "DRY";
    if (mapType === "hsl" && hslCondition) {
      // For HSL, use hslCondition (D/W/N)
      if (hslCondition === "W" || hslCondition === "Wet") climateCode = "WET";
      else if (hslCondition === "N" || hslCondition === "Normal") climateCode = "NORMAL";
      else climateCode = "DRY";
    } else if (condition) {
      // For Mortality, use condition (Dry/Wet/Normal)
      if (condition === "Wet") climateCode = "WET";
      else if (condition === "Normal") climateCode = "NORMAL";
      else climateCode = "DRY";
    }
    parts.push(climateCode);

    // Month (zero-padded, with M prefix) - include if available
    if (month) {
      const monthCode = String(month).padStart(2, "0");
      parts.push(`M${monthCode}`);
    }

    // Cover Percent
    if (coverPercent) {
      parts.push(`Cover${coverPercent}`);
    }

    // Class/Stress Level
    if (mapType === "hsl" && hslClass) {
      // Map class codes to Roman numerals
      const classMap = {
        l: "ClassI",
        ml: "ClassII",
        m: "ClassIII",
        mh: "ClassIV",
        h: "ClassV",
        vh: "ClassVI"
      };
      const classLabel = classMap[hslClass.toLowerCase()] || `Class${hslClass}`;
      parts.push(classLabel);
    } else if (mapType === "mortality" && dfStress && species === "Douglas-fir") {
      // Extract stress code from dfStress string
      const stressCode = extractDfStressCode(dfStress);
      const classMap = {
        l: "ClassI",
        ml: "ClassII",
        m: "ClassIII",
        mh: "ClassIV",
        h: "ClassV",
        vh: "ClassVI"
      };
      const classLabel = classMap[stressCode] || `Class${stressCode}`;
      parts.push(classLabel);
    }

    // Join with underscores and add .pdf extension
    return `${parts.join("_")}.pdf`;
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
        alert("Please select a Cover (%) value for Western Hemlock mortality rasters.");
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
        alert("Please select a Cover (%) value for Douglas-fir mortality rasters.");
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
        alert("Please select a Cover (%) value for Western Hemlock HSL rasters.");
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
  // GENERATE MAP (CLIP) - MULTI-AOI SUPPORT
  // ======================================================
  // Helper: Deep compare filters to detect if they're the same
  // ======================================================
  // Normalize filters to canonical form (timeOfYear) for comparison; supports legacy mapType+month
  const normalizeFiltersForCompare = useCallback((f) => {
    if (!f) return null;
    if (f.timeOfYear) return { ...f, timeOfYear: f.timeOfYear };
    const mapType = f.mapType || "";
    const month = f.month;
    const timeOfYear = mapType === "hsl" ? "HSL" : month === "04" ? "APR" : month === "05" ? "MAY" : month === "06" ? "JUN" : month === "07" ? "JUL" : month === "08" ? "AUG" : month === "09" ? "SEP" : "APR";
    return { ...f, timeOfYear };
  }, []);
  const sameFilters = useCallback((filtersA, filtersB) => {
    if (!filtersA || !filtersB) return false;
    const a = normalizeFiltersForCompare(filtersA);
    const b = normalizeFiltersForCompare(filtersB);
    if (!a || !b) return false;
    return a.timeOfYear === b.timeOfYear && a.species === b.species && a.condition === b.condition && a.dfStress === b.dfStress && a.coverPercent === b.coverPercent && a.hslCondition === b.hslCondition && a.hslClass === b.hslClass;
  }, [normalizeFiltersForCompare]);

  // ======================================================
  // Add function: Append a raster instance (do NOT replace existing for same AOI)
  // ======================================================
  const addCreatedRaster = useCallback((newRaster) => {
    setCreatedRasters((prev) => [...prev, newRaster]);
  }, []);

  // ======================================================
  // Generates clipped rasters for ALL non-base AOIs (uploaded + drawn)
  // Each AOI produces one created raster entry
  // ======================================================
  async function handleGenerate() {
    // ============================================================
    // INSTRUMENTATION: Log AOI state BEFORE any checks
    // ============================================================
    const generateState = {
      userClip: !!userClip,
      userClipRef: !!userClipRef.current,
      uploadedAois: uploadedAois?.length || 0,
      aois: aois.length,
      aoisDetails: aois.map(a => ({ id: a.id, type: a.type, hasGeojson: !!a.geojson })),
      activeAoi: activeAoi.geoJSON ? true : false,
      activeAoiId: activeAoi.id,
      createdRasters: createdRasters.length,
      drawnAoiIdRef: drawnAoiIdRef.current,
    };
    console.log("[Generate] 🔍 START - Full state:", generateState);
    console.log("[Generate] activeAoiId:", activeAoi.id, "createdRasters keys:", createdRasters.map((r) => ({ id: r.id, aoiId: r.aoiId })));

    // ============================================================
    // CHECK AOI SOURCES (must check actual AOI state, not createdRasters)
    // ============================================================
    // CRITICAL: Use persistent refs as PRIMARY source of truth (survive all renders)
    // Fallback to React state only if persistent refs are empty
    // ============================================================
    
    // PRIMARY: Check persistent refs (survive filter changes, export opens, etc.)
    const persistentDrawnGeo = persistentDrawnAoiRef.current;
    const persistentAois = persistentAoisRef.current;
    
    // SECONDARY: Check React state (may be cleared by remounts/filter changes)
    const aoisInState = aois.filter(a => a.type !== "base" && a.geojson);
    const hasAoisInState = aoisInState.length > 0;
    
    // FALLBACK: Check refs/state for drawn AOI
    const drawnGeo = persistentDrawnGeo || userClipRef.current || userClip;
    const hasDrawn = !!drawnGeo;
    
    // FALLBACK: Check uploadedAois array (legacy, but keep for compatibility)
    const hasUploads = (uploadedAois?.length ?? 0) > 0;
    
    // CRITICAL: Do NOT restore from refs if aois array is empty
    // If aois array is empty, it means either:
    // 1. No AOIs have been created yet, OR
    // 2. All AOIs were explicitly erased
    // Restoring from refs would bring back erased AOIs (ghost AOIs)
    // Only restore if we're sure the state was lost due to a remount, not erasure
    // For now, we skip restoration to prevent ghost AOIs
    // If persistent refs have data but React state is empty, DO NOT restore automatically
    // The user should re-draw or re-upload if they want to regenerate
    if (persistentDrawnGeo && !userClip && !userClipRef.current && aois.length > 0) {
      // Only restore if there are other AOIs in state (means state wasn't cleared by erasure)
      console.log("[Generate] 🔄 RESTORING: React state lost, restoring from persistent refs (other AOIs exist)");
      setUserClip(persistentDrawnGeo);
      userClipRef.current = persistentDrawnGeo;
      drawnAoiIdRef.current = persistentDrawnAoiIdRef.current;
    }
    
    // Only restore aois array if it's not empty (means state wasn't cleared by erasure)
    if (persistentAois.length > 0 && aois.length === 0) {
      // DO NOT restore - if aois is empty, all AOIs were likely erased
      console.warn("[Generate] ⚠️ Skipping restore: aois array is empty (likely all AOIs were erased)");
    }
    
    // INSTRUMENTATION: Log detection decision
    console.log("[Generate] 🔍 Detection check:", {
      aoisInState: hasAoisInState,
      aoisInStateCount: aoisInState.length,
      hasDrawn: hasDrawn,
      hasUploads: hasUploads,
      decision: hasAoisInState || hasDrawn || hasUploads ? "HAS_AOI" : "NO_AOI",
    });
    
    // CRITICAL: Get targets ONLY from aois array (primary source of truth)
    // Do NOT use refs as fallback - if AOI was erased, it should NOT be in aois array
    // Using refs as fallback causes "ghost" AOIs to regenerate after erasure
    let targets = aoisInState;
    
    // Check if drawn AOI is in aois array (if it was erased, it won't be here)
    const drawnInAois = aois.find(a => a.type === "draw");
    const drawnInTargets = targets.some(t => t.type === "draw");
    
    // Only add drawn AOI if it exists in aois array (not from refs)
    if (drawnInAois && !drawnInTargets) {
      // Drawn AOI exists in aois array but not in targets - add it
      console.log("[Generate] ✅ Adding drawn AOI from aois array to targets");
      targets.push(drawnInAois);
    } else if (!drawnInAois && hasDrawn && drawnGeo) {
      // Drawn AOI not in aois array but refs have data
      // This means the AOI was likely erased but refs weren't cleared properly
      // DO NOT add it - only use AOIs from the aois array
      console.warn("[Generate] ⚠️ WARNING: Drawn AOI found in refs but NOT in aois array - skipping (likely erased)");
      console.warn("[Generate] This AOI should have been removed from state. Ref data:", {
        persistentDrawnGeo: !!persistentDrawnGeo,
        userClipRef: !!userClipRef.current,
        userClip: !!userClip,
        drawnAoiIdRef: drawnAoiIdRef.current,
      });
    }
    
    // If still no targets found, show error
    if (targets.length === 0) {
      console.error("[Generate] ❌ NO TARGETS - Decision breakdown:", {
        aoisInState: hasAoisInState,
        aoisInStateCount: aoisInState.length,
        hasDrawn: hasDrawn,
        hasUploads: hasUploads,
        aoisArray: aois.map(a => ({ id: a.id, type: a.type, hasGeojson: !!a.geojson })),
        userClip: !!userClip,
        userClipRef: !!userClipRef.current,
      });
      alert("Draw or upload an AOI first.");
      return;
    }
    
    // Log which AOIs will be generated
    console.log(`[Generate] Will generate for ${targets.length} AOI(s):`, targets.map(a => ({ id: a.id, name: a.name, type: a.type })));

    console.log(`[MapExplorer] Generating rasters for ${targets.length} AOI(s)`);

    // Check HSL + WH combination (only block if WH HSL rasters don't exist)
    if (mapType === "hsl" && species === "Western Hemlock" && !hasWhHslRasters) {
      alert("HSL is only available for Douglas-fir. Please select Douglas-fir or switch to Mortality map type.");
      setSelectedRasterLabel(null);
      setSelectedRasterName(null);
      setSelectedRasterPath(null);
      setSelectedRasterDetails(null);
      return;
    }

    // Select raster based on map type (same for all AOIs)
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

    // Optional UI-only zoom warning (do NOT block generation or force zoom changes).
    // Generation must be zoom-independent; backend clips/statistics use AOI geometry only.
    if (mapInstanceRef.current) {
      try {
        const map = mapInstanceRef.current;
        const zoom = map.getZoom();
        const center = map.getCenter();

        const RASTER_PIXEL_SIZE_M = 750;
        const MAX_PIXEL_SCREEN_SIZE = 90;

        const metersPerScreenPixel =
          (156543.03392 * Math.cos((center.lat * Math.PI) / 180)) / Math.pow(2, zoom);

        const pixelScreenSize = RASTER_PIXEL_SIZE_M / metersPerScreenPixel;

        if (pixelScreenSize > MAX_PIXEL_SCREEN_SIZE) {
          console.warn(
            `[MapExplorer] Generating at high zoom (z=${zoom}). Overlay may look blocky at this view resolution, but generation will proceed.`
          );
        }
      } catch (e) {
        // Never block generation due to UI warning calculation issues
        console.warn("[MapExplorer] Zoom warning calculation failed (ignored):", e);
      }
    }

    // ============================================================
    // GENERATE FOR EACH AOI (LOOP)
    // ============================================================
    setIsGenerating(true);
    setGenerationProgress({ current: 0, total: targets.length });

    const successfulRasters = [];
    const failedAois = [];

    // Current filters object for comparison (timeOfYear is source of truth; mapType+month derived)
    const currentFilters = {
      timeOfYear,
      mapType,
      month,
      species,
      condition,
      dfStress,
      coverPercent,
      hslCondition,
      hslClass,
    };

    // Generate sequentially (safer than parallel for now)
    // Do NOT clear overlays before the loop - upsert will handle replacement
    // Do NOT clear or remove AOIs - they should persist for regeneration
    // IMPORTANT: Use try/finally to ensure isGenerating is always reset
    try {
      for (let i = 0; i < targets.length; i++) {
        const aoi = targets[i];
        setGenerationProgress({ current: i + 1, total: targets.length });

        try {
        // Check if raster already exists for this AOI with same filters
        // Read from current state to ensure we have the latest data
        // Use stable aoiId for comparison (for drawn AOIs, use drawnAoiIdRef.current)
        const stableAoiIdForCheck = aoi.type === "draw" ? (drawnAoiIdRef.current || aoi.id) : aoi.id;
        const existingRaster = createdRasters.find(r => r.aoiId === stableAoiIdForCheck && sameFilters(r.filtersUsed, currentFilters));
        if (existingRaster) {
          console.log(`[MapExplorer] ⏭️ Skipping AOI ${aoi.name || aoi.id}: Already generated with same filters`);
          // Show toast notification (optional - user can still regenerate by changing filters)
          // Note: We skip generation but don't add to failedAois since it's intentional
          // The existing raster will remain visible
          continue;
        }

        // Use drawnGeo if this is a drawn target (from ref/state)
        const aoiGeojson = aoi.geojson || (aoi.type === "draw" && (userClipRef.current || userClip) ? (userClipRef.current || userClip) : null);
        if (!aoiGeojson) {
          console.warn(`[MapExplorer] Skipping AOI ${aoi.id}: No geometry available`);
          failedAois.push({ aoi, error: "No geometry available" });
          continue;
        }
        
        const clipGeoJSON = ensureFeatureCollection(aoiGeojson);
        if (!clipGeoJSON) {
          console.warn(`[MapExplorer] Skipping AOI ${aoi.id}: Invalid geometry`);
          failedAois.push({ aoi, error: "Invalid geometry" });
          continue;
        }

        console.log(`[MapExplorer] Generating raster ${i + 1}/${targets.length} for AOI: ${aoi.name || aoi.id}`);

      const result = await clipRaster({
        rasterLayerId,
        userClipGeoJSON: clipGeoJSON,
      });

        // ============================================================
        // DEBUG: Log generate response to verify stats are returned
        // ============================================================
        console.log("[MapExplorer] GENERATE RESPONSE for AOI:", aoi.name || aoi.id, result);

      const overlay = result.overlay_url ?? result.overlayUrl ?? null;
      const bounds = result.bounds ?? result.overlayBounds ?? null;
        let statsFromApi = result.stats ?? null;
      const pixels = result.pixel_values ?? result.pixelValues ?? result.pixels ?? result.values ?? [];
        let histogramFromApi = result.histogram ?? null;

        // ============================================================
        // VERIFY STATS: If stats are missing, log error
        // ============================================================
        if (!statsFromApi) {
          console.error("[MapExplorer] ⚠️ WARNING: No stats in generate response for AOI:", aoi.name || aoi.id);
          console.error("[MapExplorer] Response keys:", Object.keys(result));
          // TODO: If backend doesn't return stats, we could fetch them here
          // For now, we'll store null and show an error in the UI
        } else {
          console.log("[MapExplorer] ✓ Stats received:", statsFromApi);
        }

        // Build raster name with AOI name
      const rasterName = buildRasterLabel(mapType, species, month, condition, dfStress, coverPercent, hslCondition, hslClass);
        const aoiName = aoi.name || (aoi.type === "upload" ? "Uploaded AOI" : "Drawn AOI");
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

      // Ensure bounds is in array format [[south, west], [north, east]] for consistency
      let boundsArray = bounds;
      if (bounds && typeof bounds === 'object' && !Array.isArray(bounds)) {
        // Convert object format to array format
        if (bounds.south !== undefined) {
          boundsArray = [
            [bounds.south, bounds.west],
            [bounds.north, bounds.east]
          ];
        }
      }

      // CRITICAL: Use aoi.id directly (matches activeAoi.id for drawn AOIs)
      // For drawn AOIs, aoi.id is set to drawn-${timestamp} in handleUserClipChange
      // For uploaded AOIs, aoi.id is set when uploaded
      const aoiId = aoi.id;
      if (!aoiId) {
        console.error("[MapExplorer] ⚠️ WARNING: AOI missing id:", aoi);
        throw new Error(`AOI missing id (type: ${aoi.type})`);
      }
      console.log("[PAIR] register overlay for aoiId:", aoiId, "aoiType:", aoi.type);

      const newRaster = {
        id: `raster-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        name: createdRasterName,
        label: rasterName, // concise label derived from filters
        createdAt: timestamp,
        overlayUrl: overlay,
        overlayBounds: boundsArray, // Store bounds in array format [[south, west], [north, east]]
        bounds: boundsArray, // Also store as 'bounds' for consistency
        stats: statsFromApi,
        pixelValues: Array.isArray(pixels) ? pixels : [],
        histogram: histogramFromApi,
        activeRasterId: rasterLayerId,
        ramp: ramp,
        aoiId: aoiId, // CRITICAL: Use aoi.id directly (matches activeAoi.id)
        aoiName: aoiName,
        aoiType: aoi.type || "draw", // Store AOI type: "upload" or "draw"
        aoiGeojson: aoi.geojson, // Store AOI GeoJSON for export
        isVisible: true,
        filtersUsed: {
          timeOfYear,
          mapType,
          month,
          species,
          condition,
          dfStress,
          coverPercent,
          hslCondition,
          hslClass,
        },
        meta: {
          timeOfYear,
          mapType,
          month,
          species,
          condition,
          dfStress,
          coverPercent,
          hslCondition,
          hslClass,
        },
      };

        // Upsert: Replace existing raster for this aoiId, or add new one
        addCreatedRaster(newRaster);
        successfulRasters.push(newRaster);
        console.log(`[MapExplorer] ✓ Successfully generated raster for AOI: ${aoiName}`);
      } catch (error) {
        console.error(`[MapExplorer] ✗ Failed to generate raster for AOI ${aoi.name || aoi.id}:`, error);
        
        // Extract error message and check for 422 status (validation errors)
        let errorMessage = error.message || "Unknown error";
        
        // Check if this is a 422 error (Unprocessable Entity) with specific message
        if (error.status === 422 || error.detail) {
          const detail = error.detail || error.message || "";
          
          // Show friendly toast message for 422 errors (no data / outside extent)
          if (detail.includes("AOI contains no raster data") || detail.includes("no raster data for this layer") || 
              detail.includes("AOI outside raster extent") || detail.includes("AOI too small") || detail.includes("no intersect")) {
            alert("AOI doesn't overlap this raster. Try a different area.");
            errorMessage = "AOI doesn't overlap this raster";
          } else {
            // For other 422 errors, show the detail message
            errorMessage = detail;
          }
        }
        
          failedAois.push({ aoi, error: errorMessage });
        }
      }
    } finally {
      // CRITICAL: Always reset isGenerating even if error occurs
      // This ensures the Generate button is re-enabled after generation completes or fails
      setIsGenerating(false);
      setGenerationProgress({ current: 0, total: 0 });
    }

    // Debug log after generate - verify AOI state is preserved
    console.log("[Generate] AFTER - AOI state preserved:", { 
      userClip: !!userClip, 
      lastDrawnAoiRef: !!lastDrawnAoiRefWrapper.current?.current,
      uploadedAoisLen: uploadedAois?.length,
      aoisLen: aois.length,
      hasDrawn: aois.some(a => a.type === "draw"),
      hasUploads: aois.some(a => a.type === "upload")
    });

    // After successful generate, auto-select the newest raster for that AOI (no flashback to #1).
    if (successfulRasters.length > 0) {
      const lastRaster = successfulRasters[successfulRasters.length - 1];
      setActiveRasterId(rasterLayerId);
      setActiveCreatedRasterId(lastRaster.id);
      setStats(lastRaster.stats || null);
      setPixelValues(lastRaster.pixelValues || []);
      setHistogram(lastRaster.histogram || null);
      console.log("[MapExplorer] Set active raster:", lastRaster.id, "with stats:", lastRaster.stats ? "✓" : "✗");
    }

    // Show summary message
    if (successfulRasters.length === targets.length) {
      if (targets.length === 1) {
        alert(`Successfully generated raster for ${targets[0].name || "AOI"}.`);
      } else {
        alert(`Successfully generated ${successfulRasters.length} raster(s) for ${targets.length} AOI(s).`);
      }
    } else if (successfulRasters.length > 0) {
      const failedNames = failedAois.map(f => f.aoi.name || f.aoi.id).join(", ");
      alert(
        `${successfulRasters.length}/${targets.length} AOI(s) generated successfully.\n\n` +
        `Failed: ${failedNames}\n` +
        failedAois.map(f => `- ${f.aoi.name || f.aoi.id}: ${f.error}`).join("\n")
      );
    } else {
      alert(`Failed to generate rasters for all ${targets.length} AOI(s).\n\n` +
        failedAois.map(f => `- ${f.aoi.name || f.aoi.id}: ${f.error}`).join("\n"));
    }
  }

  // ======================================================
  // AOI UPLOAD - Frontend-only parsing
  // ======================================================
  // ======================================================
  // OVERLAP DETECTION
  // ======================================================
  // Checks if a new AOI geometry overlaps with any existing AOIs (drawn + uploaded).
  // Uses Turf.js geometry-level intersection; checks ALL features in new vs ALL in each existing.
  // Returns { overlaps: boolean, message: string }
  // ======================================================
  const OVERLAP_ERROR_MSG = "Uploaded AOI overlaps an existing AOI. Please upload a non-overlapping area.";

  function checkAoiOverlap(newGeojson, existingAois) {
    if (!newGeojson || !existingAois || existingAois.length === 0) {
      return { overlaps: false, message: null };
    }

    const newFeatures = [];
    if (newGeojson.type === "FeatureCollection" && newGeojson.features?.length) {
      newFeatures.push(...newGeojson.features);
    } else if (newGeojson.type === "Feature") {
      newFeatures.push(newGeojson);
    } else if (newGeojson.type === "Polygon" || newGeojson.type === "MultiPolygon") {
      newFeatures.push({ type: "Feature", geometry: newGeojson, properties: {} });
    }
    if (newFeatures.length === 0) return { overlaps: false, message: null };

    try {
      for (const existingAoi of existingAois) {
        const existingGeojson = existingAoi?.geojson;
        if (!existingGeojson) continue;

        const existingFeatures = [];
        if (existingGeojson.type === "FeatureCollection" && existingGeojson.features?.length) {
          existingFeatures.push(...existingGeojson.features);
        } else if (existingGeojson.type === "Feature") {
          existingFeatures.push(existingGeojson);
        } else if (existingGeojson.type === "Polygon" || existingGeojson.type === "MultiPolygon") {
          existingFeatures.push({ type: "Feature", geometry: existingGeojson, properties: {} });
        }

        for (const nf of newFeatures) {
          for (const ef of existingFeatures) {
            try {
              const intersection = turf.intersect(nf, ef);
              if (intersection && turf.area(intersection) > 0) {
                return { overlaps: true, message: OVERLAP_ERROR_MSG };
              }
            } catch (err) {
              // No intersection or invalid geom – continue
            }
          }
        }
      }
      return { overlaps: false, message: null };
    } catch (err) {
      console.error("[Overlap check] Error:", err);
      return { overlaps: false, message: null };
    }
  }

  // ======================================================
  // VALIDATE GEOJSON
  // ======================================================
  // Validates that parsed JSON is valid GeoJSON
  // Accepts: FeatureCollection, Feature, Polygon, MultiPolygon
  // ======================================================
  function validateGeoJSON(geo) {
    if (!geo || typeof geo !== "object") {
      return { valid: false, error: "Invalid GeoJSON: must be an object" };
    }

    // Check for valid GeoJSON types
    const validTypes = ["FeatureCollection", "Feature", "Polygon", "MultiPolygon"];
    
    if (!geo.type || !validTypes.includes(geo.type)) {
      return {
        valid: false,
        error: `Invalid GeoJSON type: "${geo.type}". Supported types: ${validTypes.join(", ")}`,
      };
    }

    // Validate FeatureCollection
    if (geo.type === "FeatureCollection") {
      if (!Array.isArray(geo.features)) {
        return { valid: false, error: "Invalid FeatureCollection: features must be an array" };
      }
      if (geo.features.length === 0) {
        return { valid: false, error: "Invalid FeatureCollection: must contain at least one feature" };
      }
      // Validate each feature
      for (const feature of geo.features) {
        if (feature.type !== "Feature") {
          return { valid: false, error: "Invalid FeatureCollection: all items must be Features" };
        }
        if (!feature.geometry || !feature.geometry.type) {
          return { valid: false, error: "Invalid Feature: geometry is required" };
        }
        // Ensure geometry is Polygon or MultiPolygon
        const geomType = feature.geometry.type;
        if (geomType !== "Polygon" && geomType !== "MultiPolygon") {
          return {
            valid: false,
            error: `Invalid geometry type: "${geomType}". Only Polygon and MultiPolygon are supported for AOI.`,
          };
        }
      }
    }

    // Validate Feature
    if (geo.type === "Feature") {
      if (!geo.geometry || !geo.geometry.type) {
        return { valid: false, error: "Invalid Feature: geometry is required" };
      }
      const geomType = geo.geometry.type;
      if (geomType !== "Polygon" && geomType !== "MultiPolygon") {
        return {
          valid: false,
          error: `Invalid geometry type: "${geomType}". Only Polygon and MultiPolygon are supported for AOI.`,
        };
      }
    }

    // Validate Polygon or MultiPolygon (raw geometry)
    if (geo.type === "Polygon" || geo.type === "MultiPolygon") {
      if (!geo.coordinates || !Array.isArray(geo.coordinates)) {
        return { valid: false, error: `Invalid ${geo.type}: coordinates must be an array` };
      }
    }

    return { valid: true };
  }

  // ======================================================
  // PROCESS SINGLE FILE UPLOAD
  // ======================================================
  // Processes a single file and adds AOIs to the map
  // Returns { success: boolean, added: number, skipped: number, errors: string[] }
  // ======================================================
  async function processSingleFile(file) {
    const fileName = file.name.toLowerCase();
    const ext = fileName.split(".").pop();
    const allowedExtensions = ["geojson", "json", "kml", "zip"];
    
    // Validate file extension
    if (!allowedExtensions.includes(ext)) {
      return {
        success: false,
        added: 0,
        skipped: 0,
        errors: [`Invalid file type: .${ext}. Please upload a GeoJSON (.geojson/.json), KML (.kml), or Shapefile (.zip) file.`],
      };
    }

    try {
      // Parse file (parseAOIFile handles .geojson/.json/.kml/.zip)
      const featureCollections = await parseAOIFile(file);

      if (featureCollections.length === 0) {
        return {
          success: false,
          added: 0,
          skipped: 0,
          errors: [`No valid features found in ${file.name}.`],
        };
      }

      // Validate each feature collection
      const validCollections = [];
      const errors = [];
      
      for (const geo of featureCollections) {
        const validation = validateGeoJSON(geo);
        if (!validation.valid) {
          let formatName = ext === "zip" ? "Shapefile" : ext === "kml" ? "KML" : "GeoJSON";
          errors.push(`${file.name}: ${validation.error}`);
          continue;
        }
        validCollections.push(geo);
      }

      if (validCollections.length === 0) {
        return {
          success: false,
          added: 0,
          skipped: 0,
          errors,
        };
      }

      // Check for overlaps and collect valid AOIs
      // Split FeatureCollections with multiple features into separate AOIs (one per feature)
      const newAois = [];
      const baseFileName = file.name.replace(/\.[^/.]+$/, ""); // Remove extension for naming
      let featureIndex = 0;
      
      for (const geo of validCollections) {
        const featureCollection = ensureFeatureCollection(geo);
        
        // If FeatureCollection has multiple features, split them into separate AOIs
        if (featureCollection.features && featureCollection.features.length > 1) {
          for (let i = 0; i < featureCollection.features.length; i++) {
            const feature = featureCollection.features[i];
            
            // Create a FeatureCollection with just this one feature
            const singleFeatureCollection = {
              type: "FeatureCollection",
              features: [feature],
            };
            
            // Check for overlaps with existing AOIs
            const existingPlusNew = [...aois, ...newAois];
            const overlapCheck = checkAoiOverlap(singleFeatureCollection, existingPlusNew);
            if (overlapCheck.overlaps) {
              errors.push(`${file.name} #${i + 1}: ${overlapCheck.message || OVERLAP_ERROR_MSG}`);
              continue;
            }
            
            featureIndex++;
            const aoiId = `upload-${baseFileName}-${featureIndex}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
            
            newAois.push({
              id: aoiId,
              geojson: singleFeatureCollection,
              name: `${baseFileName} #${featureIndex}`,
              type: "upload",
              overlayUrl: null,
              overlayBounds: null,
              stats: null,
              pixelValues: [],
              activeRasterId: null,
              visible: true,
              _fileName: file.name,
            });
          }
        } else {
          // Single feature or single FeatureCollection - create one AOI
          const existingPlusNew = [...aois, ...newAois];
          const overlapCheck = checkAoiOverlap(featureCollection, existingPlusNew);
          if (overlapCheck.overlaps) {
            errors.push(`${file.name}: ${overlapCheck.message || OVERLAP_ERROR_MSG}`);
            continue;
          }
          
          featureIndex++;
          const aoiId = `upload-${baseFileName}-${featureIndex}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
          
          newAois.push({
            id: aoiId,
            geojson: featureCollection,
            name: featureIndex === 1 && validCollections.length === 1 ? baseFileName : `${baseFileName} #${featureIndex}`,
            type: "upload",
            overlayUrl: null,
            overlayBounds: null,
            stats: null,
            pixelValues: [],
            activeRasterId: null,
            visible: true,
            _fileName: file.name,
          });
        }
      }

      if (newAois.length === 0) {
        return {
          success: false,
          added: 0,
          skipped: validCollections.length,
          errors,
        };
      }

      // ============================================================
      // New AOI(s) added via upload: clear previous rasters and overlays so list matches current AOI only
      // ============================================================
      resetForNewAOI();

      // ============================================================
      // Multiple AOIs allowed: append new AOI(s) (overlap already rejected above)
      // ============================================================
      setAois((prev) => [...prev, ...newAois]);
      setUploadedAois((prev) => [...prev, ...newAois]);
      setSelectedAois((prev) => [
        ...prev,
        ...newAois.map((aoi) => ({
          id: aoi.id,
          source: "uploaded",
          geojson: aoi.geojson,
        })),
      ]);
      persistentAoisRef.current = [...(persistentAoisRef.current || []), ...newAois];

      const firstAoi = newAois[0];
      setUserClip(firstAoi.geojson);
      setActiveAoiId(firstAoi.id);
      setActiveAoi({
        source: "uploaded",
        id: firstAoi.id,
        geoJSON: firstAoi.geojson,
        name: firstAoi.name || firstAoi._fileName || "Uploaded AOI",
      });
      console.log("[MapExplorer] Upload AOI: added", newAois.length, "AOI(s), active set to:", firstAoi.id);

      return {
        success: true,
        added: newAois.length,
        skipped: validCollections.length - newAois.length,
        errors,
        newAois, // Return the new AOIs for bounds calculation
      };
    } catch (err) {
      console.error(`AOI upload error for ${file.name}:`, err);
      const formatName = ext === "zip" ? "Shapefile" : ext === "kml" ? "KML" : "GeoJSON";
      let errorMessage = err.message || "Unknown error";
      
      // Provide more specific error messages for shapefiles
      if (ext === "zip") {
        if (errorMessage.toLowerCase().includes("shp") || errorMessage.toLowerCase().includes("shx") || errorMessage.toLowerCase().includes("dbf")) {
          errorMessage = `Invalid shapefile: ${errorMessage}\n\nA valid shapefile ZIP must contain .shp, .shx, and .dbf files.`;
        } else if (!errorMessage.includes("shapefile")) {
          errorMessage = `Invalid shapefile: ${errorMessage}\n\nPlease ensure the ZIP file contains a valid shapefile with .shp, .shx, and .dbf files.`;
        }
      }
      
      return {
        success: false,
        added: 0,
        skipped: 0,
        errors: [`${file.name}: ${errorMessage}`],
      };
    }
  }

  // ======================================================
  // HANDLE MULTI-FILE UPLOAD
  // ======================================================
  // Processes multiple files and adds all valid AOIs to the map
  // Does NOT clear existing uploaded AOIs
  // ======================================================
  async function handleUploadAoi(event) {
    const files = Array.from(event.target.files || []);
    if (files.length === 0) return;

    // Process all files
    const results = [];
    for (const file of files) {
      const result = await processSingleFile(file);
      results.push({ file: file.name, ...result });
    }

    // Calculate totals
    const totalAdded = results.reduce((sum, r) => sum + r.added, 0);
    const totalSkipped = results.reduce((sum, r) => sum + r.skipped, 0);
    const allErrors = results.flatMap((r) => r.errors);

    // Show summary message
    if (totalAdded > 0) {
      let message = `Successfully uploaded ${totalAdded} AOI(s)`;
      if (totalSkipped > 0) {
        message += ` (${totalSkipped} skipped due to overlaps or validation errors)`;
      }
      if (allErrors.length > 0 && allErrors.length <= 3) {
        message += `\n\nErrors:\n${allErrors.join("\n")}`;
      } else if (allErrors.length > 3) {
        message += `\n\n${allErrors.length} error(s) occurred. Check console for details.`;
        console.warn("Upload errors:", allErrors);
      }
      alert(message);
    } else {
      // All files failed
      const errorMsg = allErrors.length > 0 
        ? `Failed to upload AOIs:\n\n${allErrors.slice(0, 5).join("\n")}${allErrors.length > 5 ? `\n... and ${allErrors.length - 5} more` : ""}`
        : "No valid AOIs found in uploaded files.";
      alert(errorMsg);
    }

    // Fit map to all newly added AOIs if any were added
    if (totalAdded > 0 && mapInstanceRef.current) {
      // Collect all newly added AOIs from results
      const allNewAois = [];
      for (const result of results) {
        if (result.newAois && result.newAois.length > 0) {
          allNewAois.push(...result.newAois);
        }
      }
      
      // Calculate bounds from newly added AOIs
      if (allNewAois.length > 0) {
        const allBounds = allNewAois
          .map((aoi) => getGeoJSONBounds(aoi.geojson))
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
    }

    // Clear file input
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }

  // Clear all AOIs and all created rasters (removes everything from map and state)
  async function handleClearUploadedAois() {
    console.log("[MapExplorer] 🗑️ EXPLICIT CLEAR ALL: handleClearUploadedAois");
    console.trace("[AOI_CLEAR] handleClearUploadedAois - explicit user action");

    // Clear all rasters + overlays from map and reset full state (AOIs, created rasters, etc.)
    await handleClearAllRasters();

    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }

  // Remove raster overlay by AOI ID (used when AOI is erased)
  // Must be declared BEFORE handleAoiErased to avoid TDZ error
  const onRemoveRasterByAoiId = useCallback((aoiId) => {
    // ✅ DEBUG: Stack trace to find who's calling this
    console.error("[DEBUG] onRemoveRasterByAoiId CALLED", aoiId, new Error().stack);
    
    // CRITICAL GUARD: Do NOT clear overlays if export is active
    if (isExportingRef.current) {
      console.warn("[MapExplorer] ⚠️ BLOCKED: onRemoveRasterByAoiId called during export - export must not clear overlays");
      console.trace("[CLEAR_OVERLAY] ⚠️ BLOCKED: setCreatedRasters prevented during export");
      return; // Early return - do NOT clear overlays
    }
    
    console.log(`[MapExplorer] onRemoveRasterByAoiId: Removing rasters with aoiId=${aoiId} from createdRasters state`);
    setCreatedRasters((prev) => {
      const filtered = prev.filter((r) => r.aoiId !== aoiId);
      console.log(`[MapExplorer] onRemoveRasterByAoiId: State updated - ${prev.length} -> ${filtered.length} rasters`);
      
      // ✅ CRITICAL: Update sessionStorage immediately to prevent rehydration
      try {
        sessionStorage.setItem("vmrc_created_rasters", JSON.stringify(filtered));
        console.log(`[Session] Updated sessionStorage: removed rasters for AOI ${aoiId}, ${filtered.length} rasters remaining`);
      } catch (err) {
        console.error("[Session] Failed to update sessionStorage after removing rasters:", err);
      }
      
      return filtered;
    });
  }, []);

  // Erase ONE AOI: remove only that AOI and its created rasters (do not clear other AOIs).
  const handleAoiErased = useCallback((aoiId) => {
    if (isExportingRef.current) {
      console.warn("[MapExplorer] ⚠️ BLOCKED: handleAoiErased during export");
      return;
    }
    console.log("[MapExplorer] handleAoiErased: removing single AOI", aoiId);

    const wasActiveAoi = aoiId === activeAoiId;

    // 1) Remove AOI layers and raster overlays from map
    if (mapInstanceRef.current?._layerGroupManager) {
      mapInstanceRef.current._layerGroupManager.removeAoiAndAllRasters(aoiId);
    }

    // 2) Remove created rasters for this AOI only
    onRemoveRasterByAoiId(aoiId);

    // 3) Remove AOI from state (handleRemoveAoi clears refs if drawn)
    handleRemoveAoi(aoiId);

    // 4) If this was the active AOI, clear active state and optionally set another
    if (wasActiveAoi) {
      setActiveRasterId(null);
      setActiveCreatedRasterId(null);
      setStats(null);
      setPixelValues([]);
      setHistogram(null);
      try {
        sessionStorage.removeItem("vmrc_active_aoi_id");
        sessionStorage.removeItem("vmrc_active_created_raster_id");
      } catch (err) {
        console.error("[Session] Failed to clear sessionStorage:", err);
      }
      const remaining = aois.filter((a) => a.id !== aoiId);
      if (remaining.length > 0) {
        const next = remaining[0];
        setActiveAoiId(next.id);
        setActiveAoi({
          source: next.type === "upload" ? "uploaded" : "drawn",
          id: next.id,
          geoJSON: next.geojson,
          name: next.name || (next.type === "upload" ? "Uploaded AOI" : "Drawn AOI"),
        });
        setUserClip(next.geojson);
      } else {
        setActiveAoiId(null);
        setActiveAoi({ source: null, id: null, geoJSON: null, name: null });
        setUserClip(null);
      }
    }
  }, [activeAoiId, aois, onRemoveRasterByAoiId, handleRemoveAoi]);

  // Remove a specific AOI by ID (called from erase tool or remove button)
  // NOTE: This does NOT remove AOI_diss (globalAoi) - that is permanent
  // CRITICAL: This must handle both the stable aoiId (from BaseMap) and the aoi.id in state
  function handleRemoveAoi(aoiId) {
    console.log("[MapExplorer] handleRemoveAoi called with aoiId:", aoiId);

    setAois((prev) => {
      const removedAoi = prev.find((aoi) => aoi.id === aoiId);
      
      // Also check if this is the drawn AOI by comparing with drawnAoiIdRef
      const isDrawnAoi = removedAoi?.type === "draw" || drawnAoiIdRef.current === aoiId;
      
      if (removedAoi || isDrawnAoi) {
        // Clear drawn AOI refs if this was the drawn AOI
        if (isDrawnAoi) {
          console.log("[MapExplorer] Removing drawn AOI - clearing refs");
          drawnAoiIdRef.current = null;
          userClipRef.current = null;
          setUserClip(null);
          
          // CRITICAL: Also clear persistent refs to prevent ghost AOIs
          persistentDrawnAoiRef.current = null;
          persistentDrawnAoiIdRef.current = null;
        }
        
        // Remove from uploadedAois if it was uploaded
        if (removedAoi?.type === "upload") {
        setUploadedAois((prevUploaded) => prevUploaded.filter((aoi) => aoi.id !== aoiId));
      }

        // Remove from selectedAois
        setSelectedAois((prevSelected) => prevSelected.filter((aoi) => aoi.id !== aoiId));
        
        // Clear stats/overlay if this was the active AOI
      if (removedAoi && userClip && JSON.stringify(removedAoi.geojson) === JSON.stringify(userClip)) {
        setStats(null);
        setPixelValues([]);
        setHistogram(null);
        setActiveRasterId(null);
          setActiveCreatedRasterId(null);
        }
      }

      // Remove from aois array
      const newList = prev.filter((aoi) => aoi.id !== aoiId);
      console.log(`[MapExplorer] Removed AOI ${aoiId} from aois array: ${prev.length} -> ${newList.length}`);
      return newList;
    });
  }

  // Note: handleRemoveUploadedAoi removed - use handleRemoveAoi(aoi.id) directly

  // ======================================================
  // CREATED RASTERS LIST HANDLERS
  // ======================================================
  function handleShowRaster(rasterId) {
    // Set this raster as active (for histogram display and map overlay)
    const raster = createdRasters.find((r) => r.id === rasterId);
    if (!raster) return;

    // Ensure raster is visible when activating
    setCreatedRasters((prev) =>
      prev.map((r) => (r.id === rasterId ? { ...r, isVisible: true } : r))
    );

    // Set as active raster (updates histogram panel and click sampling)
    setActiveCreatedRasterId(rasterId); // Created raster ID (for histogram)
    setActiveRasterId(raster.activeRasterId); // Backend raster layer ID (for click sampling)
    
    // Update right panel with this raster's data
    setStats(raster.stats);
    setPixelValues(raster.pixelValues || []);
    setHistogram(raster.histogram);

    // ✅ CRITICAL: Show this raster overlay on the map and hide others for the same AOI
    if (mapInstanceRef.current && mapInstanceRef.current._layerGroupManager) {
      const manager = mapInstanceRef.current._layerGroupManager;
      
      // If raster has aoiId, use setActiveRasterForAoi to hide others for same AOI
      if (raster.aoiId) {
        manager.setActiveRasterForAoi(raster.aoiId, rasterId);
      } else {
        // Fallback: just show this raster
        manager.showRasterOverlay(rasterId);
      }
      
      console.log(`[MapExplorer] ✅ Activated raster overlay: rasterId=${rasterId}, aoiId=${raster.aoiId}`);
    } else {
      console.warn("[MapExplorer] LayerGroupManager not available - overlay may not update");
    }
  }

  function handleToggleRasterVisibility(rasterId) {
    const raster = createdRasters.find((r) => r.id === rasterId);
    if (!raster) return;
    
    const newVisibility = !raster.isVisible;
    
    // Update state
    setCreatedRasters((prev) =>
      prev.map((r) => (r.id === rasterId ? { ...r, isVisible: newVisibility } : r))
    );

    // ✅ CRITICAL: Show/hide overlay on map using LayerGroupManager
    if (mapInstanceRef.current && mapInstanceRef.current._layerGroupManager) {
      const manager = mapInstanceRef.current._layerGroupManager;
      
      if (newVisibility) {
        // Show the overlay
        if (raster.aoiId) {
          manager.setActiveRasterForAoi(raster.aoiId, rasterId);
        } else {
          manager.showRasterOverlay(rasterId);
        }
        console.log(`[MapExplorer] ✅ Showed raster overlay: rasterId=${rasterId}`);
      } else {
        // Hide the overlay (but keep it in registry)
        manager.hideRasterOverlay(rasterId);
        console.log(`[MapExplorer] ✅ Hid raster overlay: rasterId=${rasterId}`);
      }
    } else {
      console.warn("[MapExplorer] LayerGroupManager not available - overlay may not update");
    }
  }

  async function handleRemoveRaster(rasterId) {
    // CRITICAL GUARD: Do NOT clear overlays if export is active
    if (isExportingRef.current) {
      console.warn("[MapExplorer] ⚠️ BLOCKED: handleRemoveRaster called during export - export must not clear overlays");
      console.trace("[CLEAR_OVERLAY] ⚠️ BLOCKED: setCreatedRasters prevented during export");
      return; // Early return - do NOT clear overlays
    }
    
    const raster = createdRasters.find((r) => r.id === rasterId);
    if (!raster) return;

    const wasActive = rasterId === activeCreatedRasterId;
    const aoiId = raster.aoiId; // Get the linked AOI ID

    // Delete overlay file from server (if overlayUrl exists)
    if (raster.overlayUrl) {
      try {
        await deleteOverlay(raster.overlayUrl);
        console.log(`[MapExplorer] Deleted overlay file: ${raster.overlayUrl}`);
      } catch (err) {
        console.warn(`[MapExplorer] Failed to delete overlay file: ${err.message}`);
        // Continue with removal even if delete fails (file might already be deleted)
      }
    }

    // ✅ CRITICAL: Remove overlay from map using LayerGroupManager
    if (mapInstanceRef.current && mapInstanceRef.current._layerGroupManager) {
      const manager = mapInstanceRef.current._layerGroupManager;
      manager.removeRasterOverlay(rasterId);
      console.log(`[MapExplorer] ✅ Removed raster overlay from map: rasterId=${rasterId}`);
    }

    // Remove from list (this also triggers LayerGroupManager cleanup via useEffect)
    // CRITICAL: This removes ONLY the raster overlay, NOT the AOI
    // The AOI should remain visible - only the overlay is removed
    console.log(`[MapExplorer] handleRemoveRaster: Removing raster ${rasterId} (aoiId: ${aoiId}) from createdRasters state - AOI preserved`);
    setCreatedRasters((prev) => {
      const filtered = prev.filter((r) => r.id !== rasterId);
      console.log(`[MapExplorer] handleRemoveRaster: State updated - ${prev.length} -> ${filtered.length} rasters`);
      return filtered;
    });

    // CRITICAL: Do NOT remove the AOI from state here
    // The "Remove" button in CreatedRastersList should only remove the raster overlay
    // The AOI should remain visible on the map
    // AOI removal should only happen via eraser tool or explicit "Remove AOI" action

    // If it was active, switch to another raster or clear
    if (wasActive) {
      const remaining = createdRasters.filter((r) => r.id !== rasterId);
      if (remaining.length > 0) {
        // Select the most recent remaining raster (first in array)
        const nextRaster = remaining[0];
        handleShowRaster(nextRaster.id);
      } else {
        // No rasters left - clear histogram panel
        setActiveCreatedRasterId(null);
        setActiveRasterId(null);
        setStats(null);
        setPixelValues([]);
        setHistogram(null);
      }
    }
  }

  // ======================================================
  // CLEAR ALL STATE (called by LayerGroupManager.clearAll)
  // ======================================================
  const onClearAll = useCallback(() => {
    // CRITICAL GUARD: Do NOT clear overlays if export is active
    if (isExportingRef.current) {
      console.warn("[MapExplorer] ⚠️ BLOCKED: onClearAll called during export - export must not clear overlays");
      return;
    }

    console.log("[MapExplorer] onClearAll: Resetting all state (no AOI / no rasters)");
    
    // Clear all rasters from state
    setCreatedRasters([]);
    setActiveCreatedRasterId(null);
    setActiveRasterId(null);
    setStats(null);
    setPixelValues([]);
    setHistogram(null);
    
    // Clear active AOI
    setActiveAoiId(null);
    setActiveAoi({
      source: null,
      id: null,
      geoJSON: null,
      name: null,
    });
    
    // Clear all AOIs and refs (full reset)
    setAois([]);
    setUploadedAois([]);
    setSelectedAois([]);
    setUserClip(null);
    userClipRef.current = null;
    drawnAoiIdRef.current = null;
    persistentDrawnAoiRef.current = null;
    persistentDrawnAoiIdRef.current = null;
    persistentAoisRef.current = [];
    
    // Clear sessionStorage
    try {
      sessionStorage.removeItem("vmrc_created_rasters");
      sessionStorage.removeItem("vmrc_active_created_raster_id");
      sessionStorage.removeItem("vmrc_active_aoi_id");
      console.log("[Session] Cleared sessionStorage (Clear All)");
    } catch (err) {
      console.error("[Session] Failed to clear sessionStorage:", err);
    }
  }, []);

  async function handleClearAllRasters() {
    // CRITICAL GUARD: Do NOT clear overlays if export is active
    if (isExportingRef.current) {
      console.warn("[MapExplorer] ⚠️ BLOCKED: handleClearAllRasters called during export - export must not clear overlays");
      console.trace("[CLEAR_OVERLAY] ⚠️ BLOCKED: setCreatedRasters([]) prevented during export");
      return; // Early return - do NOT clear overlays
    }
    
    // Delete all overlay files from server first
    const deletePromises = createdRasters
      .filter((r) => r.overlayUrl)
      .map((r) => 
        deleteOverlay(r.overlayUrl).catch((err) => {
          console.warn(`[MapExplorer] Failed to delete overlay ${r.overlayUrl}: ${err.message}`);
        })
      );
    
    await Promise.all(deletePromises);
    
    // ✅ CRITICAL: Call LayerGroupManager.clearAll() to remove all layers from map
    // This will also call onClearAll() to reset React state
    if (mapInstanceRef.current && mapInstanceRef.current._layerGroupManager) {
      const manager = mapInstanceRef.current._layerGroupManager;
      console.log("[MapExplorer] Calling LayerGroupManager.clearAll() to remove all layers from map");
      manager.clearAll();
    } else {
      console.warn("[MapExplorer] LayerGroupManager not available - clearing state only");
      // Fallback: just clear state if manager not available
      onClearAll();
    }
    
    // Clear Geoman temp/hint layers
    if (mapInstanceRef.current && (mapInstanceRef.current._clearPmTempLayers || mapInstanceRef.current._clearGeomanTempLayers)) {
      const clearFunc = mapInstanceRef.current._clearPmTempLayers || mapInstanceRef.current._clearGeomanTempLayers;
      clearFunc();
    }
    
    console.log("[MapExplorer] Cleared all rasters");
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

  // ======================================================
  // EXPORT HANDLER
  // ======================================================
  const handleExport = async (e) => {
    e?.preventDefault?.();
    e?.stopPropagation?.();
  
    // ✅ REGRESSION CHECK: Assert createdRasters and overlayUrl are preserved
    const initialRastersCount = createdRasters?.length || 0;
    const initialOverlayUrl = overlayUrl;
    console.log("[Export] ✅ REGRESSION CHECK: Export starting", {
      createdRastersCount: initialRastersCount,
      overlayUrl: !!initialOverlayUrl,
    });
    if (initialRastersCount === 0) {
      console.error("[Export] ❌ REGRESSION: createdRasters is already empty before export!");
    }
  
    console.log("[Export] api base:", API_BASE);
    console.log("[Export] full url:", apiUrl("/api/v1/rasters/export"));
    console.log("[Export] clicked", {
      createdRastersLen: createdRasters?.length,
      exportFormats,
      filename,
      activeCreatedRasterId,
      activeRasterId,
    });
  
    try {
      if (!createdRasters || createdRasters.length === 0) {
        alert("Generate a map first.");
        return;
      }
  
      const anySelected = Object.values(exportFormats || {}).some(Boolean);
      if (!anySelected) {
        alert("Select at least one export format.");
        return;
      }
  
      console.log("[Export] Starting export...");
      // ✅ CRITICAL: Set export guard BEFORE any async operations
      isExportingRef.current = true; // Set ref guard FIRST
      setIsExporting(true);
      
      // pick the active raster or last created one
      const raster =
        createdRasters.find((r) => r.id === activeCreatedRasterId) ||
        createdRasters[createdRasters.length - 1];
  
      if (!raster) throw new Error("No raster selected to export.");

      // ✅ LOGGING: Log active raster and stats before export
      console.log("[Export] 📊 Active raster for export:", {
        activeRasterId: activeCreatedRasterId,
        rasterId: raster.id,
        rasterName: raster.name,
        hasStats: !!raster.stats,
        stats: raster.stats,
        hasHistogram: !!raster.histogram,
        hasBounds: !!raster.bounds,
      });

      // Convert exportFormats (object of booleans) into an array of strings
      const selectedFormats = Object.entries(exportFormats || {})
        .filter(([_, v]) => Boolean(v))
        .map(([k]) => k);

      // Build filename from raster name (matches Raster Overview exactly)
      // Use selectedRasterName as PRIMARY source (same value shown in "Raster Name:" in StatsTable)
      // This is the ONLY source of truth for the export filename
      let exportBaseName;
      
      // Priority 1: Use selectedRasterName (exactly what's shown in Raster Overview)
      if (selectedRasterName) {
        exportBaseName = getExportBaseFromRasterName(selectedRasterName);
        console.log(`[Export] Using selectedRasterName (Raster Overview): ${selectedRasterName} -> ${exportBaseName}`);
      } else if (selectedRasterPath) {
        // Priority 2: Use selectedRasterPath (full path) if name not available
        exportBaseName = getExportBaseFromRasterName(selectedRasterPath);
        console.log(`[Export] Using selectedRasterPath: ${selectedRasterPath} -> ${exportBaseName}`);
      } else {
        // Last resort: build from selected raster's filters (not current UI state)
        const f = raster.filtersUsed || raster.meta || {};
        console.warn("[Export] selectedRasterName not available (Raster Overview), falling back to filter-based filename");
        exportBaseName = buildExportName(f.mapType ?? mapType, f.species ?? species, f.month ?? month, f.condition ?? condition, f.coverPercent ?? coverPercent, f.hslCondition ?? hslCondition, "").replace(/\.\w+$/, "");
      }
      
      // Use user-provided filename if set, otherwise use raster base name
      const exportFilename = (filename || "").trim() || exportBaseName;

      // Build context with filters, stats, histogram, bounds, and pixelValues
      // ✅ CRITICAL: Include stats from createdRaster so PDF matches UI
      const exportContext = {
        ...(raster.filtersUsed || raster.context || {
          mapType,
          species,
          month,
          condition,
          coverPercent,
          hslCondition,
        }),
        // ✅ Include stats, histogram, bounds, and pixelValues so PDF matches UI panel
        stats: raster.stats || null,
        histogram: raster.histogram || null,
        bounds: raster.bounds || raster.overlayBounds || null,
        pixelValues: raster.pixelValues || [],
      };

      // Build payload matching backend ExportRequest
      const payload = {
        raster_layer_id: raster.activeRasterId ?? raster.raster_layer_id ?? raster.layerId ?? raster.layer_id ?? raster.id,
        user_clip_geojson: raster.aoiGeojson ?? raster.user_clip_geojson ?? raster.userClipGeojson ?? activeAoi?.geoJSON ?? userClip,
        filename: exportFilename,
        formats: selectedFormats,
        context: exportContext,
        overlay_url: raster.overlayUrl ?? raster.overlay_url ?? null,
        aoi_name: raster.aoiName ?? raster.aoi_name ?? activeAoi?.name ?? null,
      };
  
      console.log("[Export] payload:", payload);
  
      const res = await fetch(apiUrl("/api/v1/rasters/export"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
  
      if (!res.ok) {
        const txt = await res.text();
        throw new Error(`Export failed (${res.status}): ${txt}`);
      }
  
      const data = await res.json();
      console.log("[Export] ✅ Export request successful:", data);
      
      // Backend returns {status: "success", files: {png: "...", tif: "...", ...}}
      // Frontend expects flat structure {png: "...", tif: "...", ...}
      const exportFiles = data.files || data;
      const exportErrors = data.errors || {};
      console.log("[Export] Export files:", exportFiles);
      if (Object.keys(exportErrors).length > 0) console.log("[Export] Export errors:", exportErrors);
      
      // Store export context, errors, and raster name with results for filename generation on download
      const exportResultsWithContext = {
        ...exportFiles,
        _exportContext: exportContext,
        _rasterBaseName: exportBaseName,
        _errors: exportErrors,
      };
      
      setExportResults(exportResultsWithContext);
      
      // Note: Files are downloaded via download buttons in the UI
      // We don't auto-download here to avoid multiple downloads
      console.log("[Export] Export complete. Download links available in UI.");
    } catch (err) {
      console.error("[Export] ❌ Export failed:", err);
      alert(err?.message || String(err));
    } finally {
      console.log("[Export] Export finished. Clearing export guard.");
      isExportingRef.current = false; // Clear ref guard
      setIsExporting(false);
    }
  };
  

  // Tabs
  const tabs = [
    { id: "table", icon: <FaTable size={18} />, label: "Statistics" },
    { id: "histogram", icon: <FaChartBar size={20} />, label: "Histogram" },
  ];

  // Check if HSL + WH combination is invalid (WH HSL rasters don't exist)
  const isHslWhInvalid = mapType === "hsl" && species === "Western Hemlock" && !hasWhHslRasters;

  // Single helper for stress/category dropdown: label, value, options, disabled (WH = Medium only, UI-only)
  const getStressControlConfig = (mode) => {
    const isHSL = mode === "hsl";
    const isWH = species === "Western Hemlock";
    if (isHSL) {
      return {
        label: "Seedling Drought Resistance Category",
        value: isWH ? "m" : hslClass,
        options: isWH
          ? [{ value: "m", label: "Medium (PLC 2.5 = # Mpa)" }]
          : [
              { value: "l", label: "Low (PLC 2.5 = # Mpa)" },
              { value: "ml", label: "Medium-Low (PLC 2.5 = # Mpa)" },
              { value: "m", label: "Medium (PLC 2.5 = # Mpa)" },
              { value: "mh", label: "Medium-High (PLC 2.5 = # Mpa)" },
              { value: "h", label: "High (PLC 2.5 = # Mpa)" },
              { value: "vh", label: "Very High (PLC 2.5 = # Mpa)" },
            ],
        disabled: isWH,
        onChange: (e) => setHslClass(e.target.value),
      };
    }
    return {
      label: "Seedling Drought Resistance Category",
      value: isWH ? "Medium Stress" : dfStress,
      options: isWH
        ? [{ value: "Medium Stress", label: "Medium (PLC 2.5 = # Mpa)" }]
        : [
            { value: "Low Stress", label: "Low (PLC 2.5 = # Mpa)" },
            { value: "Medium-Low Stress", label: "Medium-Low (PLC 2.5 = # Mpa)" },
            { value: "Medium Stress", label: "Medium (PLC 2.5 = # Mpa)" },
            { value: "Medium-High Stress", label: "Medium-High (PLC 2.5 = # Mpa)" },
            { value: "High Stress", label: "High (PLC 2.5 = # Mpa)" },
          ],
      disabled: isWH,
      onChange: (e) => setDfStress(e.target.value),
    };
  };

  // ======================================================
  // RENDER
  // ======================================================
  return (
    <div className="layout-3col">
      {/* LEFT PANEL */}
      <aside className="panel-left card">
        <h2 className="panel-title">Filters</h2>

        {/* TIME OF THE YEAR (single dropdown: HSL or April–September) */}
        <div className="filter-block">
          <FilterLabelWithInfo id="timeOfYear" />
          <select value={timeOfYear} onChange={(e) => setTimeOfYear(e.target.value)} className="input">
            <option value="HSL">High Stress Level</option>
            <option value="APR">April</option>
            <option value="MAY">May</option>
            <option value="JUN">June</option>
            <option value="JUL">July</option>
            <option value="AUG">August</option>
            <option value="SEP">September</option>
          </select>
        </div>

        {/* SPECIES SELECTOR */}
        <div className="filter-block">
          <FilterLabelWithInfo id="species" />
          <select value={species} onChange={(e) => setSpecies(e.target.value)} className="input">
            <option value="Douglas-fir">Douglas-fir</option>
            <option value="Western Hemlock">Western hemlock</option>
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

        {/* HSL FILTERS (DF) - Climate + Cover; stress category row is below for both species */}
        {mapType === "hsl" && species === "Douglas-fir" && (
          <>
            <div className="filter-block">
              <FilterLabelWithInfo id="climateScenario" />
              <select value={hslCondition} onChange={(e) => setHslCondition(e.target.value)} className="input">
                <option value="N">Normal</option>
                <option value="D">Dry</option>
                <option value="W">Wet</option>
              </select>
            </div>

            <div className="filter-block">
              <FilterLabelWithInfo id="coverPercent" />
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

        {/* HSL FILTERS (WH - condition + cover); stress category row is below for both species */}
        {mapType === "hsl" && species === "Western Hemlock" && hasWhHslRasters && (
          <>
            <div className="filter-block">
              <FilterLabelWithInfo id="hslCondition" />
              <select value={hslCondition} onChange={(e) => setHslCondition(e.target.value)} className="input">
                <option value="N">Normal</option>
                <option value="D">Dry</option>
                <option value="W">Wet</option>
              </select>
            </div>

            <div className="filter-block">
              <FilterLabelWithInfo id="coverPercent" />
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

        {/* HSL: Stress / Seedling Drought Resistance Category — always shown for both species (WH = Medium only, disabled) */}
        {mapType === "hsl" && (() => {
          const c = getStressControlConfig("hsl");
          return (
            <div className="filter-block" key="hsl-stress">
              <FilterLabelWithInfo id="seedlingDroughtCategory" label={c.label} />
              <select
                value={c.value}
                onChange={(e) => !c.disabled && c.onChange(e)}
                className="input"
                disabled={c.disabled}
              >
                {c.options.map((opt) => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </div>
          );
        })()}

        {/* MORTALITY FILTERS (month is fixed by Time of the Year selection; no separate Month dropdown) */}
        {mapType === "mortality" && (
          <>
            <div className="filter-block">
              <FilterLabelWithInfo id="condition" />
              <select value={condition} onChange={(e) => setCondition(e.target.value)} className="input">
                <option value="Normal">Normal</option>
                <option value="Dry">Dry</option>
                <option value="Wet">Wet</option>
              </select>
            </div>

            {species === "Douglas-fir" && (
              <div className="filter-block">
                <FilterLabelWithInfo id="coverPercent" />
                <select value={coverPercent} onChange={(e) => setCoverPercent(e.target.value)} className="input">
                  <option value="0">0%</option>
                  <option value="25">25%</option>
                  <option value="50">50%</option>
                  <option value="75">75%</option>
                  <option value="100">100%</option>
                </select>
              </div>
            )}

            {species === "Western Hemlock" && (
              <div className="filter-block">
                <FilterLabelWithInfo id="coverPercent" />
                <select value={coverPercent} onChange={(e) => setCoverPercent(e.target.value)} className="input">
                  <option value="0">0%</option>
                  <option value="25">25%</option>
                  <option value="50">50%</option>
                  <option value="75">75%</option>
                  <option value="100">100%</option>
                </select>
              </div>
            )}

            {/* Stress Level: always shown for Mortality; DF = full options, WH = "Medium" only (UI-only, backend unchanged) */}
            {(() => {
              const c = getStressControlConfig("mortality");
              return (
                <div className="filter-block" key="mortality-stress">
                  <FilterLabelWithInfo id="stressLevel" label={c.label} />
                  <select
                    value={c.value}
                    onChange={(e) => !c.disabled && c.onChange(e)}
                    className="input"
                    disabled={c.disabled}
                  >
                    {c.options.map((opt) => (
                      <option key={opt.value} value={opt.value}>{opt.label}</option>
                    ))}
                  </select>
                </div>
              );
            })()}
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
          {(() => {
            // Compute if there's at least one AOI to generate
            // Check: drawn AOI exists OR uploaded AOIs exist OR aois array has non-base AOIs
            const hasAnyAoi = Boolean(
              aois?.length > 0 && aois.some(a => a.type !== "base" && a.geojson) ||
              uploadedAois?.length > 0 ||
              activeAoi?.key
            );
            
            // Button is disabled ONLY if:
            // 1. HSL + WH invalid combination (validation check)
            // 2. No AOIs available to generate
            // 3. Currently generating (request in flight)
            const isDisabled = isHslWhInvalid || !hasAnyAoi || isGenerating;
            
            return (
          <button
            className="btn-primary full-width"
            onClick={handleGenerate}
                disabled={isDisabled}
                style={{ opacity: isDisabled ? 0.5 : 1 }}
          >
                {isGenerating 
                  ? `Generating ${generationProgress.current}/${generationProgress.total}...` 
                  : "Generate Map"}
          </button>
            );
          })()}
        </div>

                  {/* EXPORT SECTION */}
          <div className="filter-section">
            <h3 className="section-title">Export</h3>

            {createdRasters.length === 0 ? (
              <div style={{ padding: "12px", textAlign: "center", color: "#6b7280", fontSize: "13px" }}>
                Generate a map first.
              </div>
            ) : (
              <>
              {/* Filename input */}
                <div
                  className="filter-block"
                  style={{ marginBottom: "14px" }}
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={(e) => e.stopPropagation()}
                >
                <FilterLabelWithInfo id="exportFilename" />
                <input
                  type="text"
                  className="input"
                  placeholder="e.g., dry_df_04"
                  value={filename}
                  onChange={(e) => setFilename(e.target.value)}
                  style={{ width: "100%", boxSizing: "border-box" }}
                />
                <p className="sidebar-help" style={{ marginTop: "4px", marginBottom: 0 }}>Base name only (extensions added automatically).</p>
              </div>

              {/* Export format checkboxes */}
              <div
                  className="filter-block"
                  style={{ marginBottom: "14px" }}
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={(e) => e.stopPropagation()}
                >
                <div style={{ marginBottom: "8px" }}>
                  <FilterLabelWithInfo id="exportFormats" label="Export Formats" />
                </div>
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
                    checked={exportFormats.geojson}
                    onChange={(e) => setExportFormats({ ...exportFormats, geojson: e.target.checked })}
                  />
                  <span>GeoJSON (AOI)</span>
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

              {/* Export button */}
              <div className="filter-block">
                <button
                  type="button"
                  className="btn-primary full-width"
                  disabled={createdRasters.length === 0 || isHslWhInvalid || isExporting}
                  onClick={handleExport}
                  style={{
                    display: "block",
                    width: "100%",
                    boxSizing: "border-box",
                    opacity: createdRasters.length > 0 && !isHslWhInvalid && !isExporting ? 1 : 0.5,
                  }}
                >
                  {isExporting ? "Exporting..." : "Export"}
                </button>
              </div>

              {/* Export results */}
              {exportResults && Object.keys(exportResults).length > 0 && (
                <div
                  className="filter-block"
                  style={{
                    marginTop: "12px",
                    padding: "12px",
                    background: "#f9fafb",
                    border: "1px solid #e5e7eb",
                    borderRadius: "4px",
                    boxSizing: "border-box",
                    width: "100%",
                  }}
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={(e) => e.stopPropagation()}
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

                  {exportResults._errors && Object.keys(exportResults._errors).length > 0 && (
                    <div style={{ marginBottom: 8, fontSize: 12, color: "#b91c1c" }}>
                      {Object.entries(exportResults._errors).map(([fmt, msg]) => (
                        <div key={fmt}>{(fmt || "export").toUpperCase()}: {String(msg)}</div>
                      ))}
                    </div>
                  )}

                  <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                    {exportResults.png && (
                      <button
                        type="button"
                        onClick={async (e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          try {
                            const url = apiUrl(exportResults.png);
                            // Use raster base name from export results, or extract from URL as fallback
                            const baseName = exportResults._rasterBaseName || getExportBaseFromRasterName(exportResults.png.split('/').pop() || '') || 'export';
                            const downloadName = `${baseName}.png`;
                            console.log(`[Export] Downloading PNG as: ${downloadName}`);
                            await downloadBlob(url, downloadName);
                          } catch (err) {
                            console.error("[Export] Failed to download PNG:", err);
                            alert(`Failed to download PNG: ${err.message}`);
                          }
                        }}
                        style={{ 
                          fontSize: 12, 
                          color: "#2563eb", 
                          textDecoration: "underline",
                          background: "none",
                          border: "none",
                          padding: 0,
                          cursor: "pointer",
                          textAlign: "left"
                        }}
                      >
                        Download PNG
                      </button>
                    )}
                    {exportResults.tif && (
                      <button
                        type="button"
                        onClick={async (e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          try {
                            const url = apiUrl(exportResults.tif);
                            // Use raster base name from export results, or extract from URL as fallback
                            const baseName = exportResults._rasterBaseName || getExportBaseFromRasterName(exportResults.tif.split('/').pop() || '') || 'export';
                            const downloadName = `${baseName}.zip`;
                            console.log(`[Export] Downloading GeoTIFF (ZIP) as: ${downloadName}`);
                            await downloadBlob(url, downloadName);
                          } catch (err) {
                            console.error("[Export] Failed to download GeoTIFF:", err);
                            alert(`Failed to download GeoTIFF: ${err.message}`);
                          }
                        }}
                        style={{ 
                          fontSize: 12, 
                          color: "#2563eb", 
                          textDecoration: "underline",
                          background: "none",
                          border: "none",
                          padding: 0,
                          cursor: "pointer",
                          textAlign: "left"
                        }}
                      >
                        Download GeoTIFF (ZIP with metadata)
                      </button>
                    )}
                    {exportResults.geojson && (
                      <button
                        type="button"
                        onClick={async (e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          try {
                            const url = apiUrl(exportResults.geojson);
                            // Use raster base name from export results, or extract from URL as fallback
                            const baseName = exportResults._rasterBaseName || getExportBaseFromRasterName(exportResults.geojson.split('/').pop() || '') || 'export';
                            const downloadName = `${baseName}.geojson`;
                            console.log(`[Export] Downloading GeoJSON as: ${downloadName}`);
                            await downloadBlob(url, downloadName);
                          } catch (err) {
                            console.error("[Export] Failed to download GeoJSON:", err);
                            alert(`Failed to download GeoJSON: ${err.message}`);
                          }
                        }}
                        style={{ 
                          fontSize: 12, 
                          color: "#2563eb", 
                          textDecoration: "underline",
                          background: "none",
                          border: "none",
                          padding: 0,
                          cursor: "pointer",
                          textAlign: "left"
                        }}
                      >
                        Download GeoJSON
                      </button>
                    )}
                    {exportResults.pdf && (
                      <button
                        type="button"
                        onClick={async (e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          try {
                            const url = apiUrl(exportResults.pdf);
                            
                            // Use raster base name from export results (matches Raster Overview exactly)
                            const baseName = exportResults._rasterBaseName || getExportBaseFromRasterName(exportResults.pdf.split('/').pop() || '') || 'export';
                            const downloadName = `${baseName}.pdf`;
                            console.log(`[Export] Downloading PDF as: ${downloadName}`);
                            
                            await downloadBlob(url, downloadName);
                          } catch (err) {
                            console.error("[Export] Failed to download PDF:", err);
                            alert(`Failed to download PDF: ${err.message}`);
                          }
                        }}
                        style={{ 
                          fontSize: 12, 
                          color: "#2563eb", 
                          textDecoration: "underline",
                          fontWeight: 600,
                          background: "none",
                          border: "none",
                          padding: 0,
                          cursor: "pointer",
                          textAlign: "left"
                        }}
                      >
                        Download PDF Report
                      </button>
                    )}
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {/* AOI UPLOAD */}
        <div className="filter-section">
          <h3 className="section-title">Upload AOI</h3>
          <p className="section-help">
            Upload GeoJSON (.geojson/.json), KML (.kml), or Shapefile (.zip). Uploaded AOIs are displayed but not editable.
          </p>

          <div className="file-input-wrapper">
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept=".geojson,.json,.kml,.zip,application/geo+json,application/json,application/vnd.google-earth.kml+xml,application/zip"
              onChange={handleUploadAoi}
              style={{ display: "none" }}
              id="aoi-file-input"
            />
            <button type="button" className="btn-secondary" onClick={() => fileInputRef.current?.click()}>
              Upload
            </button>
            <span className="file-hint">.geojson / .kml / .zip</span>
          </div>

          {uploadedAois.length > 0 && (
            <div style={{ marginTop: "12px" }}>
              <div style={{ fontSize: "12px", color: "#64748b", marginBottom: "6px" }}>
                Uploaded ({uploadedAois.length}):
              </div>

              {uploadedAois.map((aoi) => (
                <div
                  key={aoi.id}
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
                  <span style={{ color: "#475569" }}>{aoi.name || aoi._fileName || `AOI ${aoi.id}`}</span>
                  <button
                    type="button"
                    onClick={() => handleRemoveAoi(aoi.id)}
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

      </aside>

      {/* MAP */}
      {/* CRITICAL: BaseMap must NEVER remount - stable key prevents remounting */}
      <section className="panel-map card">
        <BaseMap
          key="base-map-persistent"
          globalAoi={globalAoi}
          uploadedAois={uploadedAois}
          aois={aois}
          userClip={userClip}
          overlayUrl={overlayUrl || null}
          overlayBounds={overlayBounds || null}
          createdRasters={createdRasters}
          onUserClipChange={handleUserClipChange}
          onRemoveAoi={handleRemoveAoi}
          onRemoveRaster={handleRemoveRaster}
          onRemoveRasterByAoiId={onRemoveRasterByAoiId}
          onClearAll={onClearAll}
          onDrawStart={handleStartNewAoi}
          onClearDrawnAoi={handleClearDrawnAoi}
          activeRasterId={activeRasterId}
          activeCreatedRasterId={activeCreatedRasterId}
          datasetPreview={activeDatasetPreview}
          onMapReady={(map) => {
            mapInstanceRef.current = map;
          }}
          onAoiErased={handleAoiErased}
        />
      </section>

      {/* RIGHT PANEL (fixed, narrower width) */}
      <SlidingPanel width={380}>
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
          {/* Layer Info Panel - Always visible when metadata is available */}
          {(activeRasterId || activeDatasetPreview) && (
            <div style={{ marginBottom: "16px" }}>
              <LayerInfoPanel metadata={layerMetadata} isLoading={isLoadingMetadata} />
            </div>
          )}

          {activeTab === "table" && (
            <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
              {/* Dropdown to select which AOI's stats to display */}
              {createdRasters.length > 0 && (
                <div style={{ marginBottom: "16px" }}>
                  <label style={{ display: "block", marginBottom: "6px", fontSize: "13px", fontWeight: 500, color: "#374151" }}>
                    Statistics for:
                  </label>
                  <select
                    value={activeCreatedRasterId || ""}
                    onChange={(e) => {
                      const selectedId = e.target.value;
                      if (selectedId) {
                        handleShowRaster(selectedId);
                      }
                    }}
            style={{
              width: "100%",
                      padding: "8px 12px",
                      fontSize: "13px",
                      border: "1px solid #d1d5db",
                      borderRadius: "4px",
                      backgroundColor: "#ffffff",
                      color: "#111827",
                    }}
                  >
                    {createdRasters.map((raster) => (
                      <option key={raster.id} value={raster.id}>
                        {raster.aoiName || raster.name || `Raster ${raster.id}`}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              
              {/* Stats table - only show for active AOI */}
              {activeAoiId ? (
                (() => {
                  const activeAoiRasters = createdRasters.filter(r => r.aoiId === activeAoiId);
                  if (activeAoiRasters.length === 0) {
                    return (
                      <div style={{ padding: "20px", textAlign: "center", color: "#6b7280", fontSize: "13px" }}>
                        Generate a map to see statistics.
                      </div>
                    );
                  }
                  return (
                    <>
                      {/* Warning if stats are missing */}
                      {activeCreatedRasterId && !stats && (
                        <div style={{ 
                          padding: "12px", 
                          marginBottom: "16px", 
                          backgroundColor: "#fef3c7", 
                          border: "1px solid #fbbf24", 
                          borderRadius: "4px",
                          fontSize: "13px",
                          color: "#92400e"
                        }}>
                          ⚠️ Statistics not available for this raster. The backend may not have returned stats in the generate response. Check the console for details.
                        </div>
                      )}
                      <StatsTable
                        stats={stats}
                        values={pixelValues}
                        rasterName={selectedRasterName || (activeCreatedRasterId ? activeAoiRasters.find(r => r.id === activeCreatedRasterId)?.name : null)}
                        rasterPath={selectedRasterPath}
                      />
                    </>
                  );
                })()
              ) : (
                <div style={{ padding: "20px", textAlign: "center", color: "#6b7280", fontSize: "13px" }}>
                  Draw or upload an AOI to begin.
                </div>
              )}
            </div>
          )}
          {activeTab === "histogram" && (
            <>
              {/* Histogram for: dropdown — same list as Stats / Created Rasters */}
              {createdRasters.length > 0 ? (
                <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
                  <div style={{ flexShrink: 0 }}>
                    <div style={{ marginBottom: "6px" }}>
                      <label style={{ display: "block", marginBottom: "4px", fontSize: "13px", fontWeight: 500, color: "#374151" }}>
                        Histogram for:
                      </label>
                      <select
                        value={activeCreatedRasterId || ""}
                        onChange={(e) => {
                          const selectedId = e.target.value;
                          if (selectedId) handleShowRaster(selectedId);
                        }}
                        style={{
                          width: "100%",
                          padding: "8px 12px",
                          fontSize: "13px",
                          border: "1px solid #d1d5db",
                          borderRadius: "4px",
                          backgroundColor: "#ffffff",
                          color: "#111827",
                        }}
                      >
                        <option value="">Select a raster…</option>
                        {createdRasters.map((raster) => (
                          <option key={raster.id} value={raster.id}>
                            {raster.name || raster.aoiName || `Raster ${raster.id}`}
                          </option>
                        ))}
                      </select>
                    </div>
                    {/* Show histogram for selected raster */}
                    {activeCreatedRasterId && createdRasters.find((r) => r.id === activeCreatedRasterId) ? (
                      <HistogramPanel
                        values={pixelValues}
                        stats={stats}
                        histogram={histogram}
                      />
                    ) : (
                      <div style={{ padding: "20px", textAlign: "center", color: "#6b7280", fontSize: "13px" }}>
                        Select a raster from the dropdown above to view its histogram.
                      </div>
                    )}
                  </div>
                  {/* Created Rasters section — fills remaining height, list scrolls inside */}
                  <div className="created-rasters-section">
                    <CreatedRastersList
                      rasters={createdRasters}
                      activeRasterId={activeCreatedRasterId}
                      onShowRaster={handleShowRaster}
                      onToggleVisibility={handleToggleRasterVisibility}
                      onRemoveRaster={handleRemoveRaster}
                      onClearAll={createdRasters.length > 0 ? handleClearAllRasters : null}
                    />
                  </div>
                </div>
              ) : (
                <div style={{ padding: "20px", textAlign: "center", color: "#6b7280", fontSize: "13px" }}>
                  Generate a raster to view a histogram.
                </div>
              )}
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
