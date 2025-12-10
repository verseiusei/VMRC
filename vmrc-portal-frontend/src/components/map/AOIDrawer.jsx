// src/components/map/AOIDrawer.jsx
// Export + Generate + Custom AOI upload (GeoJSON / Shapefile ZIP / PDF)

import { useState } from "react";
import PropTypes from "prop-types";
import shp from "shpjs";

export default function AOIDrawer({
  hasClip,
  onExport,
  onGenerate,
  onCustomAoiChange, // optional callback for uploaded AOI
}) {
  const [exportPng, setExportPng] = useState(true);
  const [exportTif, setExportTif] = useState(false);
  const [exportCsv, setExportCsv] = useState(false);

  // ---------------------------
  // GENERATE MAP
  // ---------------------------
  const handleGenerateClick = () => {
    if (!hasClip) return;
    onGenerate?.();
  };

  // ---------------------------
  // EXPORT
  // ---------------------------
  const handleExport = () => {
    const formats = [];
    if (exportPng) formats.push("png");
    if (exportTif) formats.push("tif");
    if (exportCsv) formats.push("csv");

    if (formats.length === 0) {
      alert("Select at least one format to export.");
      return;
    }

    onExport?.(formats);
  };

  // ---------------------------
  // CUSTOM AOI UPLOAD
  // ---------------------------
  const handleAoiUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const nameLower = file.name.toLowerCase();
    const ext = nameLower.split(".").pop();

    try {
      // 1) GeoJSON / JSON
      if (ext === "geojson" || ext === "json") {
        const text = await file.text();
        const geo = JSON.parse(text);

        if (onCustomAoiChange) {
          onCustomAoiChange(geo);
        } else {
          console.warn("Custom AOI uploaded but onCustomAoiChange is not provided.");
        }
        return;
      }

      // 2) Shapefile (ZIP)
      if (ext === "zip") {
        const buf = await file.arrayBuffer();
        const geo = await shp(buf); // shpjs handles the zip → GeoJSON

        if (onCustomAoiChange) {
          onCustomAoiChange(geo);
        } else {
          console.warn("Shapefile uploaded but onCustomAoiChange is not provided.");
        }
        return;
      }

      // 3) PDF (placeholder behaviour)
      if (ext === "pdf") {
        alert(
          "PDF AOIs are not fully supported yet. " +
            "Please upload a GeoJSON or a zipped Shapefile for now."
        );
        return;
      }

      alert("Unsupported file type. Please upload .geojson, .json, .zip or .pdf.");
    } catch (err) {
      console.error("Failed to load custom AOI:", err);
      alert("Could not read AOI file. Check the format and try again.");
    } finally {
      // Reset input so uploading the same file twice still triggers onChange
      e.target.value = "";
    }
  };

  return (
    <div className="aoi-section">
      {/* --------- EXPORT / GENERATE BLOCK --------- */}
      <h2 className="section-title">Export</h2>

      <p className="section-help">
        Draw a clip region on the map and generate a mortality map for the
        selected filters.
      </p>

      <button
        type="button"
        className="btn-primary"
        onClick={handleGenerateClick}
        disabled={!hasClip}
        style={{ marginBottom: "14px" }}
      >
        Generate Map
      </button>

      {!hasClip && (
        <p className="section-status">
          No clip region yet. Draw an area on the map to enable Generate.
        </p>
      )}

      {/* --------- EXPORT OPTIONS --------- */}
      <h3 className="section-title" style={{ marginTop: "10px" }}>
        Export Results
      </h3>

      <p className="section-help">
        Save the current clipped raster and statistics in one or more formats.
      </p>

      <div className="export-options">
        <label className="export-option">
          <input
            type="checkbox"
            checked={exportPng}
            onChange={(e) => setExportPng(e.target.checked)}
          />
          <span>PNG (map image)</span>
        </label>

        <label className="export-option">
          <input
            type="checkbox"
            checked={exportTif}
            onChange={(e) => setExportTif(e.target.checked)}
          />
          <span>GeoTIFF (.tif raster)</span>
        </label>

        <label className="export-option">
          <input
            type="checkbox"
            checked={exportCsv}
            onChange={(e) => setExportCsv(e.target.checked)}
          />
          <span>CSV (summary statistics)</span>
        </label>
      </div>

      {!hasClip && (
        <p className="section-status">
          Export is disabled until a clip region is generated.
        </p>
      )}

      <button
        type="button"
        className="btn-secondary"
        onClick={handleExport}
        disabled={!hasClip}
        style={{ marginTop: "10px", opacity: hasClip ? 1 : 0.6 }}
      >
        Export Selection
      </button>

      {/* --------- CUSTOM AOI UPLOAD --------- */}
      <div style={{ marginTop: "18px" }}>
        <h3 className="section-title">Custom AOI (Upload)</h3>
        <p className="section-help">
          Upload a custom AOI. The VMRC AOI will remain visible.
          <br />
          <strong>Supported:</strong>{" "}
          <code>.geojson</code>, <code>.json</code>,{" "}
          <code>.zip</code> (Shapefile bundle), <code>.pdf</code>
        </p>

        <input
          type="file"
          accept=".geojson,.json,.zip,.pdf"
          onChange={handleAoiUpload}
          className="input-file"
        />
      </div>
    </div>
  );
}

AOIDrawer.propTypes = {
  hasClip: PropTypes.bool,
  onExport: PropTypes.func,
  onGenerate: PropTypes.func,
  onCustomAoiChange: PropTypes.func, // optional
};
