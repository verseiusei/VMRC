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

// Small legend bar component
function LegendBar({ ramp }) {
  // Use provided ramp if available, otherwise use default
  const colors = ramp?.colors || LEGEND_COLORS;
  const labels = ramp?.labels || LEGEND_LABELS;

  return (
    <div
      style={{
        display: "flex",
        height: "20px",
        borderRadius: "2px",
        overflow: "hidden",
        border: "1px solid #e5e7eb",
        marginTop: "8px",
      }}
    >
      {colors.map((color, i) => (
        <div
          key={i}
          style={{
            flex: 1,
            backgroundColor: color,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
          title={labels[i] || `${i * 10}–${(i + 1) * 10}`}
        />
      ))}
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
      className={`raster-item ${isActive ? "raster-item-active" : ""}`}
      style={{
        padding: "10px",
        border: `1px solid ${isActive ? "#2563eb" : "#e5e7eb"}`,
        borderRadius: "4px",
        backgroundColor: isActive ? "#eff6ff" : "#ffffff",
        marginBottom: "8px",
      }}
    >
      {/* Name */}
      <div style={{ display: "flex", flexDirection: "column", gap: 4, marginBottom: "8px" }}>
        <div
          style={{
            fontSize: "13px",
            fontWeight: 600,
            color: "#111827",
            wordBreak: "break-word",
          }}
        >
          {raster.label || raster.name}
        </div>
        <div style={{ fontSize: 11, color: "#6b7280" }}>
          {raster.name}
        </div>
      </div>

      {/* PNG Thumbnail with checkerboard background */}
      {overlayImageUrl && (
        <div
          className="raster-thumbnail-container"
          onClick={onShow}
          style={{
            cursor: "pointer",
            marginBottom: "8px",
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
      style={{
        maxHeight: "400px",
        overflowY: "auto",
        padding: "12px",
      }}
    >
      <div
        style={{
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
  );
}
