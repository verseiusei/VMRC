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

  // Compute threshold area percentages
  const thresholdStats = hasValues
    ? {
        pct70Plus: (numericValues.filter((v) => v >= 70).length / numericValues.length) * 100,
        pct50Plus: (numericValues.filter((v) => v >= 50).length / numericValues.length) * 100,
        pct30Minus: (numericValues.filter((v) => v <= 30).length / numericValues.length) * 100,
      }
    : { pct70Plus: null, pct50Plus: null, pct30Minus: null };

  // Compute dominant bin (same bins as histogram: 0-10, 10-20, ..., 90-100)
  const binCounts = new Array(10).fill(0);
  if (hasValues) {
    numericValues.forEach((v) => {
      const clamped = Math.max(0, Math.min(100, v));
      const idx = clamped === 100 ? 9 : Math.max(0, Math.min(9, Math.floor(clamped / 10)));
      binCounts[idx] += 1;
    });
  }
  const totalPixels = binCounts.reduce((a, b) => a + b, 0) || 1;
  const maxBinCount = Math.max(...binCounts);
  const dominantBinIndex = binCounts.indexOf(maxBinCount);
  const dominantBinRange =
    dominantBinIndex === 9
      ? "90–100"
      : `${dominantBinIndex * 10}–${(dominantBinIndex + 1) * 10}`;
  const dominantBinShare = (maxBinCount / totalPixels) * 100;

  // Format number helper
  const fmt = (val, decimals = 2) => {
    if (val === null || val === undefined || isNaN(val)) return "--";
    return Number(val).toFixed(decimals);
  };

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
          Statistical measures computed from all pixel values within the selected area of interest.
        </p>
        <table
          style={{
            width: "100%",
            borderCollapse: "collapse",
            fontSize: 12,
          }}
        >
          <tbody>
            <tr>
              <td style={{ padding: "6px 8px", color: "#6b7280", fontWeight: 600 }}>
                Total Pixels
              </td>
              <td style={{ padding: "6px 8px", textAlign: "right", color: "#111827", fontWeight: 600 }}>
                {finalStats.count?.toLocaleString() || "--"}
              </td>
            </tr>
            <tr>
              <td style={{ padding: "6px 8px", color: "#6b7280", fontWeight: 600 }}>
                Minimum Value
              </td>
              <td style={{ padding: "6px 8px", textAlign: "right", color: "#111827", fontWeight: 600 }}>
                {fmt(finalStats.min)}
              </td>
            </tr>
            <tr>
              <td style={{ padding: "6px 8px", color: "#6b7280", fontWeight: 600 }}>
                Maximum Value
              </td>
              <td style={{ padding: "6px 8px", textAlign: "right", color: "#111827", fontWeight: 600 }}>
                {fmt(finalStats.max)}
              </td>
            </tr>
            <tr>
              <td style={{ padding: "6px 8px", color: "#6b7280", fontWeight: 600 }}>
                Average (Mean)
              </td>
              <td style={{ padding: "6px 8px", textAlign: "right", color: "#111827", fontWeight: 600 }}>
                {fmt(finalStats.mean)}
              </td>
            </tr>
            <tr>
              <td style={{ padding: "6px 8px", color: "#6b7280", fontWeight: 600 }}>
                Median Value
              </td>
              <td style={{ padding: "6px 8px", textAlign: "right", color: "#111827", fontWeight: 600 }}>
                {fmt(finalStats.median)}
              </td>
            </tr>
            <tr>
              <td style={{ padding: "6px 8px", color: "#6b7280", fontWeight: 600 }}>
                Variability (Std. Dev)
              </td>
              <td style={{ padding: "6px 8px", textAlign: "right", color: "#111827", fontWeight: 600 }}>
                {fmt(finalStats.std)}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* C) Area by Threshold */}
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
          Area by Threshold
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
          Percentage of pixels that fall within specific value ranges.
        </p>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <tbody>
            <tr>
              <td style={{ padding: "6px 8px", color: "#6b7280", fontWeight: 600 }}>
                High Values (≥ 70)
              </td>
              <td style={{ padding: "6px 8px", textAlign: "right", color: "#111827", fontWeight: 600 }}>
                {fmt(thresholdStats.pct70Plus)}%
              </td>
            </tr>
            <tr>
              <td style={{ padding: "6px 8px", color: "#6b7280", fontWeight: 600 }}>
                Moderate–High Values (≥ 50)
              </td>
              <td style={{ padding: "6px 8px", textAlign: "right", color: "#111827", fontWeight: 600 }}>
                {fmt(thresholdStats.pct50Plus)}%
              </td>
            </tr>
            <tr>
              <td style={{ padding: "6px 8px", color: "#6b7280", fontWeight: 600 }}>
                Low Values (≤ 30)
              </td>
              <td style={{ padding: "6px 8px", textAlign: "right", color: "#111827", fontWeight: 600 }}>
                {fmt(thresholdStats.pct30Minus)}%
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* D) Most Common Value Range */}
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
          Most Common Value Range
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
          The value range that contains the most pixels in the selected area.
        </p>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <tbody>
            <tr>
              <td style={{ padding: "6px 8px", color: "#6b7280", fontWeight: 600 }}>
                Dominant Range
              </td>
              <td style={{ padding: "6px 8px", textAlign: "right", color: "#111827", fontWeight: 600 }}>
                {dominantBinRange}
              </td>
            </tr>
            <tr>
              <td style={{ padding: "6px 8px", color: "#6b7280", fontWeight: 600 }}>
                Coverage
              </td>
              <td style={{ padding: "6px 8px", textAlign: "right", color: "#111827", fontWeight: 600 }}>
                {fmt(dominantBinShare)}%
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

