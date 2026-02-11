// src/components/raster/CreatedRastersList.jsx

import { apiUrl } from "../../lib/rasterApi";
import "./CreatedRastersList.css";

// Color ramp matching BaseMap.jsx LEGEND_ITEMS
const LEGEND_COLORS = [
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
];

const LEGEND_LABELS = [
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
];

// Helpers for metadata display (match MapExplorer logic)
function getMonthName(monthCode) {
  const monthMap = { "04": "April", "05": "May", "06": "June", "07": "July", "08": "August", "09": "September" };
  return monthMap[monthCode] || monthCode;
}
function getStressDisplayName(stressCode) {
  const stressMap = { l: "Low", ml: "Medium-Low", m: "Medium", mh: "Medium-High", h: "High", vh: "Very High" };
  return stressMap[stressCode] || stressCode;
}

// Build metadata rows from raster.filtersUsed / raster.meta (exact order per spec)
function getMetadataRows(raster) {
  const f = raster?.filtersUsed || raster?.meta || {};
  const mapType = f.mapType || (f.timeOfYear === "HSL" ? "hsl" : "mortality");
  const stressLabel = mapType === "hsl" ? getStressDisplayName(f.hslClass || "m") : (f.dfStress || "—");
  const timeLabel = f.timeOfYear === "HSL" ? "High Stress Level" : getMonthName(f.month || "04");
  const climateLabel = mapType === "hsl"
    ? ({ D: "Dry", W: "Wet", N: "Normal" }[f.hslCondition] || f.hslCondition || "—")
    : (f.condition || "—");
  return [
    { label: "Species", value: f.species || "—" },
    { label: "Seedling Drought Resistance Category", value: stressLabel },
    { label: "Time of the Year", value: timeLabel },
    { label: "Climate Scenario", value: climateLabel },
    { label: "Maximum Vegetation Cover (%)", value: f.coverPercent != null ? String(f.coverPercent) : "—" },
  ];
}

// Color bar with range labels above each segment (0–10, 10–20, …)
function LegendBar({ ramp }) {
  const colors = ramp?.colors || LEGEND_COLORS;
  const labels = ramp?.labels || LEGEND_LABELS;

  return (
    <div style={{ marginTop: "8px" }}>
      {/* Range labels row above the bar */}
      <div
        style={{
          display: "flex",
          marginBottom: "2px",
          fontSize: "8px",
          fontWeight: 600,
          color: "#374151",
          lineHeight: 1,
        }}
      >
        {labels.map((lbl, i) => (
          <div key={i} style={{ flex: 1, textAlign: "center", overflow: "hidden" }} title={lbl}>
            {lbl}
          </div>
        ))}
      </div>
      <div
        style={{
          display: "flex",
          height: "20px",
          borderRadius: "2px",
          overflow: "hidden",
          border: "1px solid #e5e7eb",
        }}
      >
        {colors.map((color, i) => (
          <div
            key={i}
            style={{
              flex: 1,
              backgroundColor: color,
            }}
            title={labels[i] || `${i * 10}–${(i + 1) * 10}`}
          />
        ))}
      </div>
    </div>
  );
}

// Individual raster item component
function RasterItem({ raster, isActive, onShow, onToggleVisibility, onRemove }) {
  const createdTime = new Date(raster.createdAt);
  const timeStr = createdTime.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
  const dateStr = createdTime.toLocaleDateString([], {
    month: "short",
    day: "numeric",
  });

  // Convert overlayUrl to absolute URL
  const overlayImageUrl = raster.overlayUrl
    ? raster.overlayUrl.startsWith("http")
      ? raster.overlayUrl
      : apiUrl(raster.overlayUrl)
    : null;

  return (
    <div
      className={`raster-item raster-card ${isActive ? "raster-item-active" : ""}`}
      style={{
        padding: "10px",
        border: `1px solid ${isActive ? "#2563eb" : "#e5e7eb"}`,
        borderRadius: "4px",
        backgroundColor: isActive ? "#eff6ff" : "#ffffff",
        marginBottom: "8px",
        display: "flex",
        flexDirection: "column",
      }}
    >
      {/* Metadata box: filter + value pairs (no redundant header; metadata is the identity) */}
      <div
        style={{
          marginBottom: "8px",
          padding: "8px 10px",
          background: "#f9fafb",
          border: "1px solid #e5e7eb",
          borderRadius: 0,
        }}
      >
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
          <tbody>
            {getMetadataRows(raster).map(({ label, value }) => (
              <tr key={label}>
                <td style={{ padding: "2px 6px 2px 0", color: "#6b7280", fontWeight: 600, verticalAlign: "top", width: "52%" }}>
                  {label}
                </td>
                <td style={{ padding: "2px 0", color: "#111827", fontWeight: 500 }}>
                  {value}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Raster preview: fills available space within card */}
      {overlayImageUrl && (
        <div
          className="raster-thumbnail-container raster-preview-wrap"
          onClick={onShow}
          style={{
            cursor: "pointer",
            marginBottom: "8px",
            width: "100%",
          }}
          title="Click to activate this raster"
        >
          <div className="raster-thumbnail-checkerboard">
            <img
              src={overlayImageUrl}
              alt="Raster preview"
              className="raster-thumbnail-image"
              onError={(e) => {
                e.target.style.display = "none";
              }}
            />
          </div>
        </div>
      )}

      {/* Legend Bar */}
      <LegendBar ramp={raster.ramp} />

      {/* Created time and buttons */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginTop: "8px",
        }}
      >
        <div
          style={{
            fontSize: "11px",
            color: "#6b7280",
          }}
        >
          {dateStr} {timeStr}
        </div>

        <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
          <button
            onClick={onShow}
            style={{
              padding: "4px 10px",
              fontSize: "11px",
              background: isActive ? "#2563eb" : "#f3f4f6",
              color: isActive ? "#ffffff" : "#374151",
              border: "none",
              borderRadius: "3px",
              cursor: "pointer",
              fontWeight: 500,
            }}
            disabled={isActive}
          >
            {isActive ? "Active" : "Show"}
          </button>
          <button
            onClick={onToggleVisibility}
            style={{
              padding: "4px 10px",
              fontSize: "11px",
              background: raster.isVisible ? "#10b981" : "#f3f4f6",
              color: raster.isVisible ? "#ffffff" : "#374151",
              border: "none",
              borderRadius: "3px",
              cursor: "pointer",
              fontWeight: 500,
            }}
          >
            {raster.isVisible ? "Hide" : "Show"}
          </button>
          <button
            onClick={onRemove}
            style={{
              padding: "4px 10px",
              fontSize: "11px",
              background: "#ef4444",
              color: "#ffffff",
              border: "none",
              borderRadius: "3px",
              cursor: "pointer",
              fontWeight: 500,
            }}
          >
            Remove
          </button>
        </div>
      </div>
    </div>
  );
}

// Main component
export default function CreatedRastersList({
  rasters = [],
  activeRasterId = null,
  onShowRaster,
  onToggleVisibility,
  onRemoveRaster,
  onClearAll = null,
}) {
  if (rasters.length === 0) {
    return (
      <div
        style={{
          padding: "12px",
          fontSize: "12px",
          color: "#6b7280",
          textAlign: "center",
        }}
      >
        No rasters created yet. Generate a map to add rasters to this list.
      </div>
    );
  }

  return (
    <div
      className="created-rasters-list-root"
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        minHeight: 0,
        padding: "12px",
      }}
    >
      <div
        style={{
          flexShrink: 0,
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: "12px",
        }}
      >
        <h3
          style={{
            fontSize: "16px",
            fontWeight: 700,
            color: "#111827",
            margin: 0,
          }}
        >
          Created Rasters ({rasters.length})
        </h3>
        {onClearAll && (
          <button
            onClick={onClearAll}
            style={{
              padding: "6px 12px",
              fontSize: "12px",
              background: "#ef4444",
              color: "#ffffff",
              border: "none",
              borderRadius: "4px",
              cursor: "pointer",
              fontWeight: 500,
            }}
            title="Remove all rasters from map and list"
          >
            Clear All
          </button>
        )}
      </div>

      <div className="created-rasters-list-scroll">
        {Object.values(
          rasters.reduce((acc, r) => {
            const key = r.aoiId || "unknown";
            if (!acc[key]) {
              acc[key] = { aoiId: key, aoiName: r.aoiName || `AOI ${key}`, items: [] };
            }
            acc[key].items.push(r);
            return acc;
          }, {})
        ).map((group) => (
          <div key={group.aoiId} style={{ marginBottom: "14px" }}>
            <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 8, color: "#111827" }}>
              {group.aoiName}
            </div>
            {group.items.map((raster) => (
              <RasterItem
                key={raster.id}
                raster={raster}
                isActive={raster.id === activeRasterId}
                onShow={() => onShowRaster(raster.id)}
                onToggleVisibility={() => onToggleVisibility?.(raster.id)}
                onRemove={() => onRemoveRaster(raster.id)}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
