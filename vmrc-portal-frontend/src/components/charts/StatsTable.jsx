// src/components/charts/StatsTable.jsx

/**
 * StatsTable - Statistics Summary Report
 * --------------------------------------
 * Displays comprehensive statistical summary for the clipped raster.
 * 
 * Props:
 *   - stats: Object from backend { min, max, mean, std, count, median?, ... }
 *   - values: Array of pixel values (0-100) for computing additional stats
 *   - rasterName: Filename of the selected raster (e.g., "M2.5_DF_D04_h.tif")
 *   - rasterPath: Full file path of the raster (if available)
 */

export default function StatsTable({ stats, values, rasterName, rasterPath }) {
  // Compute statistics from pixel values if stats object is incomplete
  const numericValues = Array.isArray(values)
    ? values.map((v) => Number(v)).filter((v) => Number.isFinite(v))
    : [];

  const hasValues = numericValues.length > 0;
  const hasStats = stats && typeof stats === "object";

  // If no data at all, show empty state
  if (!hasValues && !hasStats) {
    return (
      <div className="panel-body">
        <p style={{ color: "#64748b", fontSize: 13 }}>
          No statistics available. Draw a clip region and generate a map.
        </p>
      </div>
    );
  }

  // Compute statistics from values if needed
  let computedStats = {};
  if (hasValues) {
    const sorted = [...numericValues].sort((a, b) => a - b);
    const count = sorted.length;
    const sum = sorted.reduce((a, b) => a + b, 0);
    const mean = sum / count;
    
    // Standard deviation
    const variance = sorted.reduce((acc, val) => acc + Math.pow(val - mean, 2), 0) / count;
    const std = Math.sqrt(variance);
    
    // Percentiles
    const percentile = (arr, p) => {
      if (arr.length === 0) return null;
      const index = (p / 100) * (arr.length - 1);
      const lower = Math.floor(index);
      const upper = Math.ceil(index);
      const weight = index - lower;
      return arr[lower] * (1 - weight) + arr[upper] * weight;
    };

    computedStats = {
      count,
      min: sorted[0],
      max: sorted[sorted.length - 1],
      mean,
      std,
      median: percentile(sorted, 50),
      p10: percentile(sorted, 10),
      p25: percentile(sorted, 25),
      p50: percentile(sorted, 50),
      p75: percentile(sorted, 75),
      p90: percentile(sorted, 90),
    };
  }

  // Merge backend stats with computed stats (backend takes precedence)
  const finalStats = {
    ...computedStats,
    ...(hasStats ? stats : {}),
  };

  // Format number helper: one decimal place for Statistics page (reviewer requirement)
  const fmt = (val, decimals = 1) => {
    if (val === null || val === undefined || isNaN(val)) return "--";
    return Number(val).toFixed(decimals);
  };

  // Area by Mortality Class: fixed ranges 0–20, 20–40, 40–60, 60–80, 80–100 (percent of pixels in each)
  const mortalityClassRanges = [
    { label: "0–20", min: 0, max: 20 },
    { label: "20–40", min: 20, max: 40 },
    { label: "40–60", min: 40, max: 60 },
    { label: "60–80", min: 60, max: 80 },
    { label: "80–100", min: 80, max: 100 },
  ];
  const mortalityClassPcts = hasValues
    ? mortalityClassRanges.map(({ min, max }) => {
        const inRange = numericValues.filter((v) => v >= min && (max === 100 ? v <= max : v < max)).length;
        return (inRange / numericValues.length) * 100;
      })
    : mortalityClassRanges.map(() => null);

  return (
    <div className="panel-body" style={{ padding: "12px", width: "100%" }}>
      <h3 style={{ color: "#111827", fontSize: 20, fontWeight: 700, marginBottom: 16 }}>
        Statistics Summary
      </h3>

      {/* A) Raster Overview */}
      <div
        style={{
          marginBottom: 20,
          padding: "12px",
          background: "#f9fafb",
          border: "1px solid #e5e7eb",
          borderRadius: 0,
        }}
      >
        <h4
          style={{
            color: "#374151",
            fontSize: 13,
            fontWeight: 700,
            marginBottom: 4,
            textTransform: "uppercase",
            letterSpacing: "0.5px",
          }}
        >
          Raster Overview
        </h4>
        <p
          style={{
            fontSize: 11,
            color: "#9ca3af",
            marginBottom: 10,
            marginTop: 0,
            lineHeight: 1.4,
          }}
        >
          Information about the raster dataset being analyzed.
        </p>
        <div style={{ fontSize: 12, color: "#6b7280", lineHeight: 1.8 }}>
          <div>
            <strong style={{ color: "#374151" }}>Raster Name:</strong>{" "}
            {rasterName || "(not provided)"}
          </div>
        </div>
      </div>

      {/* B) Area Summary */}
      <div
        style={{
          marginBottom: 20,
          padding: "12px",
          background: "#f9fafb",
          border: "1px solid #e5e7eb",
          borderRadius: 0,
        }}
      >
        <h4
          style={{
            color: "#374151",
            fontSize: 13,
            fontWeight: 700,
            marginBottom: 4,
            textTransform: "uppercase",
            letterSpacing: "0.5px",
          }}
        >
          Area Summary (Within Selected AOI)
        </h4>
        <p
          style={{
            fontSize: 11,
            color: "#9ca3af",
            marginBottom: 12,
            marginTop: 0,
            lineHeight: 1.4,
          }}
        >
          Total area and seedling mortality statistics within the selected area of interest (acres).
        </p>
        <table
          style={{
            width: "100%",
            borderCollapse: "collapse",
            fontSize: 12,
          }}
        >
          <thead>
            <tr>
              <td style={{ padding: "6px 8px", color: "#6b7280", fontWeight: 600 }} />
              <td style={{ padding: "6px 8px", textAlign: "right", color: "#374151", fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.5px" }}>
                Area (%)
              </td>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td style={{ padding: "6px 8px", color: "#6b7280", fontWeight: 600 }}>
                Total Acres
              </td>
              <td style={{ padding: "6px 8px", textAlign: "right", color: "#111827", fontWeight: 600 }}>
                {finalStats.count != null ? fmt(finalStats.count) : "--"}
              </td>
            </tr>
            <tr>
              <td colSpan={2} style={{ padding: "8px 8px 4px 8px", color: "#374151", fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.5px" }}>
                Seedling Mortality (%)
              </td>
            </tr>
            <tr>
              <td style={{ padding: "6px 8px", color: "#6b7280", fontWeight: 600 }}>
                Minimum
              </td>
              <td style={{ padding: "6px 8px", textAlign: "right", color: "#111827", fontWeight: 600 }}>
                {fmt(finalStats.min)}
              </td>
            </tr>
            <tr>
              <td style={{ padding: "6px 8px", color: "#6b7280", fontWeight: 600 }}>
                Maximum
              </td>
              <td style={{ padding: "6px 8px", textAlign: "right", color: "#111827", fontWeight: 600 }}>
                {fmt(finalStats.max)}
              </td>
            </tr>
            <tr>
              <td style={{ padding: "6px 8px", color: "#6b7280", fontWeight: 600 }}>
                Average
              </td>
              <td style={{ padding: "6px 8px", textAlign: "right", color: "#111827", fontWeight: 600 }}>
                {fmt(finalStats.mean)}
              </td>
            </tr>
            <tr>
              <td style={{ padding: "6px 8px", color: "#6b7280", fontWeight: 600 }}>
                Median
              </td>
              <td style={{ padding: "6px 8px", textAlign: "right", color: "#111827", fontWeight: 600 }}>
                {fmt(finalStats.median)}
              </td>
            </tr>
            <tr>
              <td style={{ padding: "6px 8px", color: "#6b7280", fontWeight: 600 }}>
                Std. Dev
              </td>
              <td style={{ padding: "6px 8px", textAlign: "right", color: "#111827", fontWeight: 600 }}>
                {fmt(finalStats.std)}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* C) Area by Mortality Class */}
      <div
        style={{
          marginBottom: 20,
          padding: "12px",
          background: "#f9fafb",
          border: "1px solid #e5e7eb",
          borderRadius: 0,
        }}
      >
        <h4
          style={{
            color: "#374151",
            fontSize: 13,
            fontWeight: 700,
            marginBottom: 4,
            textTransform: "uppercase",
            letterSpacing: "0.5px",
          }}
        >
          Area by Mortality Class
        </h4>
        <p
          style={{
            fontSize: 11,
            color: "#9ca3af",
            marginBottom: 12,
            marginTop: 0,
            lineHeight: 1.4,
          }}
        >
          Percentage of area in each seedling mortality class within the selected AOI.
        </p>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <thead>
            <tr>
              <td style={{ padding: "6px 8px", color: "#374151", fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.5px" }}>
                Seedling Mortality (%)
              </td>
              <td style={{ padding: "6px 8px", textAlign: "right", color: "#374151", fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.5px" }}>
                Area (%)
              </td>
            </tr>
          </thead>
          <tbody>
            {mortalityClassRanges.map((range, i) => (
              <tr key={range.label}>
                <td style={{ padding: "6px 8px", color: "#6b7280", fontWeight: 600 }}>
                  {range.label}
                </td>
                <td style={{ padding: "6px 8px", textAlign: "right", color: "#111827", fontWeight: 600 }}>
                  {mortalityClassPcts[i] != null ? fmt(mortalityClassPcts[i]) : "--"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

    </div>
  );
}

