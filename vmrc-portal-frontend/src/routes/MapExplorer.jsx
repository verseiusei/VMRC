// src/routes/MapExplorer.jsx
import { useEffect, useState, useRef } from "react";

import BaseMap from "../components/map/BaseMap";
import SlidingPanel from "../components/ui/SlidingPanel";
import HistogramPanel from "../components/charts/HistogramPanel";
import HeatmapPanel from "../components/charts/HeatmapPanel";
import StatsTable from "../components/charts/StatsTable";

import { fetchGlobalAOI, clipRaster, exportRaster } from "../lib/rasterApi";
import { FaChartBar, FaFire, FaTable } from "react-icons/fa";

export default function MapExplorer() {
  // ======================================================
  // STATE
  // ======================================================
  const [globalAoi, setGlobalAoi] = useState(null);
  const [userClip, setUserClip] = useState(null);

  const [overlayUrl, setOverlayUrl] = useState(null);
  const [overlayBounds, setOverlayBounds] = useState(null);

  const [activeRasterId, setActiveRasterId] = useState(null);
  const [pixelValues, setPixelValues] = useState([]);
  const [stats, setStats] = useState(null);

  const [activeTab, setActiveTab] = useState("histogram");

  // Raster metadata from backend
  const [rasters, setRasters] = useState([]);

  // Filters
  const [month, setMonth] = useState("04");
  const [condition, setCondition] = useState("Dry");

  // Unified Species + Stress Level dropdown
  const [speciesStress, setSpeciesStress] = useState(
    "Douglas-fir (Low Stress)"
  );

  // Not used in backend yet, but UI keeps these
  const [stressScenario, setStressScenario] = useState("");
  const [coverPercent, setCoverPercent] = useState("");

  // Export options
  const [exportPng, setExportPng] = useState(true);
  const [exportTif, setExportTif] = useState(false);
  const [exportCsv, setExportCsv] = useState(false);

  // AOI upload
  const [aoiFileName, setAoiFileName] = useState("");
  const fileInputRef = useRef(null);

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
        setRasters(data.items ?? []);
      })
      .catch((err) => {
        console.error("Failed to load raster list:", err);
      });
  }, []);

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
    }
  }

  // ======================================================
  // RASTER FINDER LOGIC (Species + Stress → filename)
  // ======================================================
  function findRasterId(month, condition, speciesStress) {
    if (!rasters.length) return null;

    // Species code
    const speciesCode = speciesStress.includes("Douglas-fir") ? "DF" : "WH";

    // Stress suffix (_l, _ml, _m, _mh, _h)
    let stressCode = "";
    if (speciesStress.includes("Low Stress")) stressCode = "l";
    else if (speciesStress.includes("Medium-Low Stress")) stressCode = "ml";
    else if (
      speciesStress.includes("Medium Stress") &&
      !speciesStress.includes("High")
    )
      stressCode = "m";
    else if (speciesStress.includes("Medium-High Stress")) stressCode = "mh";
    else if (speciesStress.includes("High Stress")) stressCode = "h";

    // Condition code D/W/N
    const condCode = condition[0]; // "Dry" -> "D", etc.

    const base = `M_${speciesCode}_${condCode}${month}`;
    console.log("Pattern:", base, "| Stress:", stressCode);

    // Match all rasters that start with the pattern
    const candidates = rasters.filter((r) => r.name.startsWith(base));
    if (!candidates.length) {
      console.warn("No rasters match:", base);
      return null;
    }

    // Example
const handleGenerate = async (layerId, clipGeoJson) => {
  const data = await clipRaster(layerId, clipGeoJson);

  setOverlayUrl(data.overlay_url);
  setOverlayBounds([
    [data.bounds.south, data.bounds.west],
    [data.bounds.north, data.bounds.east],
  ]);
  setStats(data.stats || null);


  setPixelValues(data.pixels || data.values || []);
};



    // Now match severity-specific file
    const expectedName = `${base}_${stressCode}`;
    const match = candidates.find((r) => r.name === expectedName);

    if (match) return match.id;

    console.warn("Severity not found, falling back to first candidate.");
    return candidates[0].id;
  }

  // ======================================================
  // GENERATE MAP (CLIP)
  // ======================================================
  async function handleGenerate() {
    if (!userClip) {
      alert("Please draw a clip region first.");
      return;
    }

    const rasterLayerId = findRasterId(month, condition, speciesStress);

    if (!rasterLayerId) {
      alert("No raster found matching filters.");
      return;
    }

    try {
      const result = await clipRaster({
        rasterLayerId,
        userClipGeoJSON: userClip,
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
  async function handleExport(formats) {
    if (!userClip) {
      alert("Draw a clip region before exporting.");
      return;
    }

    const rasterLayerId = findRasterId(month, condition, speciesStress);
    if (!rasterLayerId) {
      alert("No raster found matching filters.");
      return;
    }

    try {
      const res = await exportRaster({
        rasterLayerId,
        userClipGeoJSON: userClip,
        formats,
      });

      const links = [];
      if (res.png_url || res.pngUrl)
        links.push("PNG: " + (res.png_url || res.pngUrl));
      if (res.tif_url || res.tifUrl)
        links.push("GeoTIFF: " + (res.tif_url || res.tifUrl));
      if (res.csv_url || res.csvUrl)
        links.push("CSV: " + (res.csv_url || res.csvUrl));

      alert(
        links.length ? "Export ready:\n" + links.join("\n") : "Export completed."
      );
    } catch (err) {
      console.error("Export failed:", err);
      alert(err?.message || "Export failed.");
    }
  }

  // ======================================================
  // AOI UPLOAD
  // ======================================================
  async function handleUploadAoi(event) {
    const file = event.target.files?.[0];
    if (!file) return;

    setAoiFileName(file.name);

    const formData = new FormData();
    formData.append("file", file);

    try {
      const res = await fetch("http://127.0.0.1:8000/api/v1/aoi/upload", {
        method: "POST",
        body: formData,
      });

      const data = await res.json();
      setGlobalAoi(data.geojson);
    } catch (err) {
      console.error(err);
      alert("AOI upload failed.");
    }
  }

  // Tabs
  const tabs = [
    { id: "histogram", icon: <FaChartBar size={20} />, label: "Histogram" },
    { id: "heatmap", icon: <FaFire size={20} />, label: "Heatmap" },
    { id: "table", icon: <FaTable size={18} />, label: "Stats Table" },
  ];

  // ======================================================
  // RENDER
  // ======================================================
  return (
    <div className="layout-3col">
      {/* LEFT PANEL */}
      <aside className="panel-left card">
        <h2 className="panel-title">Filters</h2>

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

        {/* SPECIES + STRESS */}
        <div className="filter-block">
          <label>Species & Stress Level</label>
          <select
            value={speciesStress}
            onChange={(e) => setSpeciesStress(e.target.value)}
            className="input"
          >
            <optgroup label="Douglas-fir">
              <option>Douglas-fir (Low Stress)</option>
              <option>Douglas-fir (Medium-Low Stress)</option>
              <option>Douglas-fir (Medium Stress)</option>
              <option>Douglas-fir (Medium-High Stress)</option>
              <option>Douglas-fir (High Stress)</option>
            </optgroup>

            <optgroup label="Western Hemlock">
              <option>Western Hemlock</option>
            </optgroup>
          </select>
        </div>

        {/* UNUSED BUT PRESENT IN UI */}
        <div className="filter-block">
          <label>High Stress Level (Scenario)</label>
          <select
            value={stressScenario}
            onChange={(e) => setStressScenario(e.target.value)}
            className="input"
          >
            <option value="">-- Select --</option>
            <option value="Dry">Dry</option>
            <option value="Wet">Wet</option>
            <option value="Normal">Normal</option>
          </select>
        </div>

        {/* UNUSED COVER % */}
        <div className="filter-block">
          <label>Cover %</label>
          <select
            value={coverPercent}
            onChange={(e) => setCoverPercent(e.target.value)}
            className="input"
          >
            <option value="">-- Select --</option>
            <option value="0">0%</option>
            <option value="25">25%</option>
            <option value="50">50%</option>
            <option value="75">75%</option>
            <option value="100">100%</option>
          </select>
        </div>

        {/* GENERATE BUTTON */}
        <div className="filter-block">
          <button className="btn-primary full-width" onClick={handleGenerate}>
            Generate Map
          </button>
        </div>

        {/* AOI UPLOAD */}
        <div className="filter-section">
          <h3 className="section-title">Custom AOI (GeoJSON)</h3>
          <p className="section-help">
            Upload a custom AOI. VMRC AOI stays visible.
          </p>

          <div className="file-input-wrapper">
            <button
              type="button"
              className="btn-secondary"
              onClick={() => fileInputRef.current?.click()}
            >
              {aoiFileName || "Choose file"}
            </button>
            <span className="file-hint">shp.zip / .geojson / .json</span>

            <input
              ref={fileInputRef}
              type="file"
              accept=".geojson,.json,.zip"
              onChange={handleUploadAoi}
              className="file-input-hidden"
            />
          </div>
        </div>

        {/* EXPORT */}
        <div className="filter-section">
          <h3 className="section-title">Export Results</h3>
          <p className="section-help">Save clipped raster and statistics.</p>

          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={exportPng}
              onChange={(e) => setExportPng(e.target.checked)}
            />
            <span>PNG</span>
          </label>

          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={exportTif}
              onChange={(e) => setExportTif(e.target.checked)}
            />
            <span>GeoTIFF (.tif)</span>
          </label>

          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={exportCsv}
              onChange={(e) => setExportCsv(e.target.checked)}
            />
            <span>CSV</span>
          </label>

          <button
            className="btn-secondary full-width"
            disabled={!userClip}
            onClick={() =>
              handleExport(
                [
                  exportPng ? "png" : null,
                  exportTif ? "tif" : null,
                  exportCsv ? "csv" : null,
                ].filter(Boolean)
              )
            }
            style={{ opacity: userClip ? 1 : 0.5 }}
          >
            Export Selection
          </button>
        </div>
      </aside>

      {/* MAP */}
      <section className="panel-map card">
        <BaseMap
          globalAoi={globalAoi}
          userClip={userClip}
          overlayUrl={overlayUrl}
          overlayBounds={overlayBounds}
          onUserClipChange={handleUserClipChange}
          activeRasterId={activeRasterId}
        />
      </section>

      {/* RIGHT PANEL */}
      <SlidingPanel width={350}>
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
          {activeTab === "histogram" && (
            <HistogramPanel values={pixelValues} />
          )}
          {activeTab === "heatmap" && <HeatmapPanel values={pixelValues} />}
          {activeTab === "table" && <StatsTable stats={stats} />}
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
