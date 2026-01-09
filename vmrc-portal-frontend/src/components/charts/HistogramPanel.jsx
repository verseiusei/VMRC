// src/components/charts/HistogramPanel.jsx

// X-axis labels: ranges for each bin (0–10, 10–20, ..., 90–100)
const X_AXIS_LABELS = [
  "10",
  "20",
  "30",
  "40",
  "50",
  "60",
  "70",
  "80",
  "90",
  "100",
];

// Matching the value scale: green → yellow → orange → red
const BAR_COLORS = [
  "#006400", // 0–10
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

export default function HistogramPanel({ values, pixels, pixelValues }) {
  const raw = values ?? pixels ?? pixelValues ?? [];

  if (!raw || raw.length === 0) {
    return (
      <div className="panel-body">
        <p style={{ color: "#64748b", fontSize: 13 }}>
          No data available. Draw a clip region.
        </p>
      </div>
    );
  }

  const numeric = raw
    .map((v) => Number(v))
    .filter((v) => Number.isFinite(v));

  if (!numeric.length) {
    return (
      <div className="panel-body">
        <p style={{ color: "#64748b", fontSize: 13 }}>
          No numeric data available.
        </p>
      </div>
    );
  }

  // --- 10 bins: [0,10), [10,20), ..., [90,100] (100 inclusive in last bin) ---
  const binCounts = new Array(10).fill(0);

  numeric.forEach((v) => {
    const clamped = Math.max(0, Math.min(100, v));
    const idx = clamped === 100 ? 9 : Math.max(0, Math.min(9, Math.floor(clamped / 10)));
    binCounts[idx] += 1;
  });

  const total = binCounts.reduce((a, b) => a + b, 0) || 1;
  const binPercentages = binCounts.map((count) => (count / total) * 100);

  // --------------------------------------------------------------------
  // VISUAL LAYOUT CONSTANTS (this is where the prettiness happens)
  // --------------------------------------------------------------------
  const CHART_HEIGHT = 180;        // less empty space
  const Y_AXIS_WIDTH = 44;         // tighter
  const GAP_AXIS_TO_PLOT = 10;
  const BIN_GAP_PX = 2;            // tiny spacing between bins
  const yTicks = [0, 25, 50, 75, 100];

  return (
    <div className="panel-body" style={{ padding: 12, width: "100%" }}>
      <h3 style={{ color: "#111827", fontSize: 25, fontWeight: 700, marginBottom: 0 }}>
        Histogram
      </h3>
      <div
          style={{
            background: "#fff",
            border: "1px solid #e5e7eb",
            borderRadius: 0,
            padding: "6px 10px 10px 0px", // less top padding
          }}
        >

        {/* Plot Row */}
        <div style={{ display: "flex", alignItems: "stretch", gap: GAP_AXIS_TO_PLOT }}>
          {/* Y axis */}
          <div
            style={{
              width: Y_AXIS_WIDTH,
              position: "relative",
              height: CHART_HEIGHT,
              flexShrink: 0,
            }}
          >
            {yTicks.map((tick) => {
              const top = CHART_HEIGHT - (tick / 100) * CHART_HEIGHT;
              return (
                <div
                  key={tick}
                  style={{
                    position: "absolute",
                    top: top - 7,
                    right: 0,
                    fontSize: 10,
                    color: "#6b7280",
                    fontWeight: 600,
                  }}
                >
                  {tick}%
                </div>
              );
            })}

            {/* Y axis label */}
            <div
              style={{
                position: "absolute",
                left: -34,
                top: "50%",
                transform: "rotate(-90deg) translateX(50%)",
                transformOrigin: "left center",
                fontSize: 11,
                color: "#374151",
                fontWeight: 700,
                whiteSpace: "nowrap",
              }}
            >
            </div>
          </div>

          {/* Plot area */}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                position: "relative",
                height: CHART_HEIGHT,
                borderLeft: "1px solid #9ca3af",
                borderBottom: "1px solid #9ca3af",
                paddingLeft: 0,
                paddingBottom: 0,
              }}
            >
              {/* horizontal gridlines (inside plot only) */}
              {yTicks.slice(1).map((tick) => (
                <div
                  key={tick}
                  style={{
                    position: "absolute",
                    left: 0,
                    right: 0,
                    bottom: `${(tick / 100) * CHART_HEIGHT}px`,
                    height: 1,
                    background: "#e5e7eb",
                    opacity: 0.9,
                    pointerEvents: "none",
                  }}
                />
              ))}

              {/* Bars */}
              <div
                style={{
                  position: "absolute",
                  left: 0,
                  right: 0,
                  bottom: 0,
                  top: 0,
                  display: "flex",
                  alignItems: "flex-end",
                  gap: BIN_GAP_PX,
                  padding: "0 2px 0 2px", // small breathing room
                }}
              >
                {binPercentages.map((pct, i) => {
                  const h = Math.max(2, (pct / 100) * CHART_HEIGHT);
                  return (
                    <div
                      key={i}
                      style={{
                        flex: 1,
                        height: h,
                        background: BAR_COLORS[i],
                        borderRadius: 0,
                        cursor: "pointer",
                      }}
                      title={`${X_AXIS_LABELS[i]}: ${pct.toFixed(2)}% (${binCounts[i]} pixels)`}
                      onMouseEnter={(e) => (e.currentTarget.style.opacity = "0.85")}
                      onMouseLeave={(e) => (e.currentTarget.style.opacity = "1")}
                    />
                  );
                })}
              </div>
            </div>

            {/* X labels */}
            <div
              style={{
                display: "flex",
                gap: BIN_GAP_PX,
                marginTop: 6,
                padding: "0 2px",
              }}
            >
              {X_AXIS_LABELS.map((lbl, i) => (
                <div
                  key={i}
                  style={{
                    flex: 1,
                    textAlign: "center",
                    fontSize: 9,
                    color: "#6b7280",
                    fontWeight: 600,
                    lineHeight: 1.1,
                  }}
                >
                  {lbl}
                </div>
              ))}
            </div>

            <div style={{ textAlign: "center", marginTop: 8, fontSize: 11, color: "#374151", fontWeight: 700 }}>
              Value Range (%)
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
