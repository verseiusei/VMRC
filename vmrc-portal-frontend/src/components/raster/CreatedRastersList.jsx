// src/components/raster/CreatedRastersList.jsx

import { useState } from "react";

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
        marginTop: "4px",
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
function RasterItem({ raster, isActive, onShow, onRemove }) {
  const createdTime = new Date(raster.createdAt);
  const timeStr = createdTime.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
  const dateStr = createdTime.toLocaleDateString([], {
    month: "short",
    day: "numeric",
  });

  return (
    <div
      style={{
        padding: "10px",
        border: `1px solid ${isActive ? "#2563eb" : "#e5e7eb"}`,
        borderRadius: "4px",
        backgroundColor: isActive ? "#eff6ff" : "#ffffff",
        marginBottom: "8px",
      }}
    >
      {/* Name */}
      <div
        style={{
          fontSize: "13px",
          fontWeight: 600,
          color: "#111827",
          marginBottom: "6px",
          wordBreak: "break-word",
        }}
      >
        {raster.name}
      </div>

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

        <div style={{ display: "flex", gap: "6px" }}>
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
  onRemoveRaster,
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
      <h3
        style={{
          fontSize: "16px",
          fontWeight: 700,
          color: "#111827",
          marginBottom: "12px",
        }}
      >
        Created Rasters ({rasters.length})
      </h3>

      {rasters.map((raster) => (
        <RasterItem
          key={raster.id}
          raster={raster}
          isActive={raster.id === activeRasterId}
          onShow={() => onShowRaster(raster.id)}
          onRemove={() => onRemoveRaster(raster.id)}
        />
      ))}
    </div>
  );
}

