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
  // SINGLE CATEGORICAL DATA: one bar per bin, bin label = x-axis tick (1:1).
  // Chart uses this array for BOTH bars and labels so alignment is structural.
  //
  // Histogram input data shape (per bin):
  //   { bin: "0–10" | "10–20" | ... | "90–100", value: number (0–100), count: number, color: string }
  // --------------------------------------------------------------------
  const chartData = X_AXIS_LABELS.map((bin, i) => ({
    bin,
    value: binPercentages[i],
    count: binCounts[i],
    color: BAR_COLORS[i],
  }));

  // --------------------------------------------------------------------
  // CHART LAYOUT — custom div chart (no Chart.js/Recharts).
  // CSS Grid: 10 columns (one per bin), 2 rows (bars, then labels). Categorical: 1:1 bar-to-label.
  // Slim bars (BAR_WIDTH_RATIO), minimal gaps, labels centered under bars.
  // --------------------------------------------------------------------
  const CHART_HEIGHT = 220;
  const Y_AXIS_WIDTH = 34;
  const GAP_AXIS_TO_PLOT = 2;      // minimal gap between y-axis and first bar
  const COL_GAP_PX = 1;            // minimal gap between bars (reduces horizontal bloat)
  const ROW_GAP_PX = 4;            // gap between bar row and label row
  const BAR_WIDTH_RATIO = 0.55;    // bar width as fraction of column (0.4–0.6 = slimmer bars)
  const yTicks = [0, 25, 50, 75, 100];

  const PLOT_PADDING_LEFT = 2;     // gap between y-axis and first bar
  const PLOT_PADDING_RIGHT = 4;   // minimal so rightmost bar/label stays inside bounds

  // Plot domain: nearly full width so all 10 labels fit (like xaxis.domain [0.08, 0.995])
  const PLOT_DOMAIN_WIDTH = 0.995;

  const CHART_PADDING_TOP = 22;
  const CHART_PADDING_BOTTOM = 28;  // extra bottom so rotated x-axis labels don't clip
  const CHART_PADDING_SIDE = 8;     // minimal left/right so plot has max usable width; y-axis still visible
  const CHART_PADDING_LEFT = CHART_PADDING_SIDE;
  const CHART_PADDING_RIGHT = CHART_PADDING_SIDE;
  const X_TITLE_MARGIN_TOP = 8;
  const LABEL_ROW_HEIGHT = 52;
  const X_TICK_FONT_SIZE = 8;       // smaller so all 10 labels fit without overflow
  const X_TICK_PADDING = 2;         // minimal padding (2–4) to shrink label footprint

  return (
    <div className="panel-body histogram-panel-body" style={{ padding: "6px 4px 8px 4px", width: "100%", minHeight: 320, boxSizing: "border-box" }}>
      <h3 style={{ color: "#111827", fontSize: 25, fontWeight: 700, marginBottom: 4 }}>
        Histogram
      </h3>
      <div
          style={{
            marginTop: 16,
            width: "100%",
            boxSizing: "border-box",
            background: "#fff",
            border: "1px solid #e5e7eb",
            borderRadius: 0,
            padding: `${CHART_PADDING_TOP}px ${CHART_PADDING_RIGHT}px ${CHART_PADDING_BOTTOM}px ${CHART_PADDING_LEFT}px`,
            overflow: "hidden",
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

          {/* Plot area: constrained to PLOT_DOMAIN_WIDTH so bars/labels stay inside bounds; categorical 10 bins. */}
          <div style={{ flex: 1, minWidth: 0, position: "relative", display: "flex", justifyContent: "center" }}>
            <div
              style={{
                width: `${PLOT_DOMAIN_WIDTH * 100}%`,
                maxWidth: "100%",
                position: "relative",
              }}
            >
              {/* Gridlines + border overlay on bar row */}
              <div
                style={{
                  position: "absolute",
                  top: 0,
                  left: PLOT_PADDING_LEFT,
                  right: PLOT_PADDING_RIGHT,
                  height: CHART_HEIGHT,
                  borderLeft: "1px solid #9ca3af",
                  borderBottom: "1px solid #9ca3af",
                  pointerEvents: "none",
                }}
              >
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
                    }}
                  />
                ))}
              </div>

              {/* Categorical grid: 10 columns (one per bin), 2 rows. Bars centered in cells; labels under bars. */}
              <div
                style={{
                display: "grid",
                gridTemplateColumns: "repeat(10, 1fr)",
                gridTemplateRows: `${CHART_HEIGHT}px ${LABEL_ROW_HEIGHT}px`,
                columnGap: COL_GAP_PX,
                rowGap: ROW_GAP_PX,
                padding: `0 ${PLOT_PADDING_RIGHT}px 4px ${PLOT_PADDING_LEFT}px`,
              }}
            >
              {chartData.map((d) => (
                <div
                  key={`bar-${d.bin}`}
                  style={{
                    display: "flex",
                    alignItems: "flex-end",
                    justifyContent: "center",
                  }}
                >
                  <div
                    style={{
                      width: `${BAR_WIDTH_RATIO * 100}%`,
                      minWidth: 4,
                      height: `${Math.max(2, (d.value / 100) * CHART_HEIGHT)}px`,
                      background: d.color,
                      borderRadius: 0,
                      cursor: "pointer",
                    }}
                    title={`${d.bin}: ${d.value.toFixed(1)}% (${d.count} pixels)`}
                    onMouseEnter={(e) => (e.currentTarget.style.opacity = "0.85")}
                    onMouseLeave={(e) => (e.currentTarget.style.opacity = "1")}
                  />
                </div>
              ))}
              {chartData.map((d) => (
                <div
                  key={`label-${d.bin}`}
                  style={{
                    display: "flex",
                    justifyContent: "center",
                    alignItems: "center",
                  }}
                >
                  <span
                    style={{
                      fontSize: X_TICK_FONT_SIZE,
                      color: "#374151",
                      fontWeight: 600,
                      whiteSpace: "nowrap",
                      transform: "rotate(-90deg)",
                      transformOrigin: "center center",
                      padding: X_TICK_PADDING,
                    }}
                    title={d.bin}
                  >
                    {d.bin}
                  </span>
                </div>
              ))}
            </div>

            {/* X-axis title: gap above so it’s not cramped under tick labels */}
            <div style={{ textAlign: "center", marginTop: X_TITLE_MARGIN_TOP, marginBottom: 0, fontSize: 12, color: "#374151", fontWeight: 700 }}>
              Mortality Range (%)
            </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
