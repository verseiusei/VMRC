// src/components/charts/HistogramPanel.jsx

// X-axis labels: ranges for each bin (0–10, 10–20, ..., 90–100)
const X_AXIS_LABELS = [
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

export default function HistogramPanel({ values, pixels, pixelValues, stats, histogram }) {
  // ============================================
  // PREFER BACKEND-COMPUTED HISTOGRAM
  // ============================================
  // If backend provides histogram counts, use them directly (guaranteed to match map overlay)
  // Otherwise, fall back to computing from pixel values
  let binCounts;
  let totalValidPixels;
  let binPercentages;
  let useBackendHistogram = false;

  if (histogram && Array.isArray(histogram.counts) && histogram.counts.length === 10) {
    // Use backend histogram (computed from REAL raster values, matches map overlay exactly)
    binCounts = histogram.counts.map((c) => Number(c) || 0);
    totalValidPixels = Number(histogram.total_valid_pixels) || 0;
    const pixelsInRange = Number(histogram.pixels_in_range) || binCounts.reduce((a, b) => a + b, 0);
    useBackendHistogram = true;

    // Use backend-provided percentages if available, otherwise compute from counts
    if (Array.isArray(histogram.percentages) && histogram.percentages.length === 10) {
      binPercentages = histogram.percentages.map((p) => Number(p) || 0);
      console.log("[HistogramPanel] Using backend-provided percentages");
    } else {
      // Fallback: compute percentages from counts
      const total = pixelsInRange || binCounts.reduce((a, b) => a + b, 0) || 1;
      binPercentages = binCounts.map((count) => (count / total) * 100);
      console.log("[HistogramPanel] Computing percentages from counts");
    }

    console.log("[HistogramPanel] Using backend histogram (matches map overlay exactly)");
    console.log("[HistogramPanel] Backend histogram counts:", binCounts);
    console.log("[HistogramPanel] Backend histogram percentages:", binPercentages.map((p) => `${p.toFixed(2)}%`));
    console.log("[HistogramPanel] Total valid pixels:", totalValidPixels);
    console.log("[HistogramPanel] Pixels in [0, 100] range:", pixelsInRange);
    console.log("[HistogramPanel] Sum of bins:", binCounts.reduce((a, b) => a + b, 0));

    // Verify bin sum matches pixels in range
    const binSum = binCounts.reduce((a, b) => a + b, 0);
    if (binSum !== pixelsInRange && pixelsInRange > 0) {
      console.warn(
        `[HistogramPanel] Backend histogram mismatch: sum=${binSum}, pixels_in_range=${pixelsInRange}`
      );
    } else {
      console.log(`[HistogramPanel] ✓ Bin count verified: sum=${binSum} equals pixels in range`);
    }
  } else {
    // Fallback: Compute histogram from pixel values
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

    // Filter to numeric values and exclude nodata/null/NaN
    // Also exclude common nodata sentinel values
    const NODATA_SENTINELS = [-9999, -32768, null, undefined];
    const numeric = raw
      .map((v) => Number(v))
      .filter(
        (v) =>
          Number.isFinite(v) &&
          v !== null &&
          v !== undefined &&
          !NODATA_SENTINELS.includes(v)
      );

    if (!numeric.length) {
      return (
        <div className="panel-body">
          <p style={{ color: "#64748b", fontSize: 13 }}>
            No numeric data available.
          </p>
        </div>
      );
    }

    // ============================================
    // DETECT VALUE RANGE AND SCALE IF NEEDED
    // ============================================
    // Compute min/max from the actual values
    const valueMin = Math.min(...numeric);
    const valueMax = Math.max(...numeric);

    // Also check stats if available (more reliable)
    const statsMin = stats?.min;
    const statsMax = stats?.max;
    const detectedMin =
      statsMin !== undefined && statsMin !== null ? statsMin : valueMin;
    const detectedMax =
      statsMax !== undefined && statsMax !== null ? statsMax : valueMax;

    // Determine if values are in 0-1 range (need scaling to 0-100)
    // If max <= 1.5 and min >= 0, treat as 0-1 range
    const needsScaling = detectedMax <= 1.5 && detectedMin >= 0;

    // Scale values if needed and clamp to [0, 100]
    const scaledValues = needsScaling
      ? numeric.map((v) => Math.max(0, Math.min(100, v * 100)))
      : numeric.map((v) => Math.max(0, Math.min(100, v)));

    // Debug logging
    console.log("[HistogramPanel] Computing histogram from pixel values (fallback)");
    console.log("[HistogramPanel] Debug Info:", {
      inputCount: raw.length,
      numericCount: numeric.length,
      nodataFiltered: raw.length - numeric.length,
      valueRange: { min: valueMin, max: valueMax },
      statsRange: stats ? { min: statsMin, max: statsMax } : null,
      detectedRange: { min: detectedMin, max: detectedMax },
      needsScaling,
      scaledRange: {
        min: Math.min(...scaledValues),
        max: Math.max(...scaledValues),
      },
    });

    // --- 10 bins: [0,10), [10,20), ..., [90,100] (100 inclusive in last bin) ---
    // Bin assignment rules (must match backend and legend):
    // - if v === 100 => bin 9 (last bin)
    // - else idx = floor(v/10)
    binCounts = new Array(10).fill(0);

    scaledValues.forEach((v) => {
      const clamped = Math.max(0, Math.min(100, v));
      const idx = clamped === 100 ? 9 : Math.max(0, Math.min(9, Math.floor(clamped / 10)));
      binCounts[idx] += 1;
    });

    totalValidPixels = scaledValues.length;

    // Verify bin counts sum equals input count
    const binSum = binCounts.reduce((a, b) => a + b, 0);
    if (binSum !== totalValidPixels) {
      console.warn(
        `[HistogramPanel] Bin count mismatch: sum=${binSum}, input=${totalValidPixels}`
      );
    } else {
      console.log(
        `[HistogramPanel] ✓ Bin count verified: sum=${binSum} equals input count`
      );
    }

    // Debug: Print min/max of used values
    console.log("[HistogramPanel] Used values range:", {
      min: Math.min(...scaledValues),
      max: Math.max(...scaledValues),
    });

    // Compute percentages for fallback case
    const total = binCounts.reduce((a, b) => a + b, 0) || 1;
    binPercentages = binCounts.map((count) => (count / total) * 100);
  }

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
