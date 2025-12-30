// src/components/charts/HistogramPanel.jsx

// Bin edges and labels: 0–10, 10–20, ..., 90–100
const BIN_EDGES = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100];

// Colors roughly matching your legend
const BAR_COLORS = [
  "#006400", // 0–10  dark green
  "#008000", // 10–20 green
  "#00A000", // 20–30 bright green
  "#80B400", // 30–40 yellow-green
  "#B4C800", // 40–50 lime
  "#FFDC00", // 50–60 yellow
  "#FFA800", // 60–70 orange
  "#FF8C00", // 70–80 deep orange
  "#FF5000", // 80–90 red-orange
  "#C80000", // 90–100 red
];

export default function HistogramPanel({ values, pixels, pixelValues }) {
  // accept whatever prop name we get
  const raw = values ?? pixels ?? pixelValues ?? [];

  if (!raw || raw.length === 0) {
    return (
      <div className="panel-body">
        <p>No data available. Draw a clip region.</p>
      </div>
    );
  }

  // numeric only
  const numeric = raw
    .map((v) => Number(v))
    .filter((v) => !Number.isNaN(v) && Number.isFinite(v));

  if (!numeric.length) {
    return (
      <div className="panel-body">
        <p>No numeric data available.</p>
      </div>
    );
  }

  // --- 10 bins, 0–10, 10–20, ..., 90–100 ---
  const binCounts = new Array(10).fill(0);

  numeric.forEach((v) => {
    let idx;
    if (v <= 0) idx = 0;
    else if (v >= 100) idx = 9;
    else idx = Math.floor(v / 10); // 0–9

    if (idx < 0) idx = 0;
    if (idx > 9) idx = 9;
    binCounts[idx] += 1;
  });

  const total = binCounts.reduce((a, b) => a + b, 0) || 1;
  const maxFraction = Math.max(...binCounts.map((c) => c / total)) || 1;

  console.log("[Histogram] bins:", binCounts, "total pixels:", total);

return (
  <div className="panel-body">
    <h3 className="section-title">Value % Histogram</h3>
    <p className="section-help">
      Distribution of pixel values (0–100%), grouped in 10% bins.
    </p>

    {/* Outer box */}
    <div
      style={{
        marginTop: 10,
        padding: "8px 10px 10px",
        background:
          "linear-gradient(180deg, rgba(255,255,255,0.03), rgba(0,0,0,0.12))",
        borderRadius: 10,
      }}
    >
      {/* Y-axis + Bars */}
      <div
        style={{
          display: "flex",
          gap: 10,
          height: 220,
        }}
      >
        {/* Y-gridlines */}
        <div
          style={{
            width: 26,
            display: "flex",
            flexDirection: "column",
            justifyContent: "space-between",
            alignItems: "flex-end",
            paddingRight: 4,
          }}
        >
          {[100, 75, 50, 25, 0].map((v) => (
            <div
              key={v}
              style={{
                width: "100%",
                height: 1,
                backgroundColor: "rgba(255,255,255,0.08)",
              }}
            />
          ))}
        </div>

        {/* Bars */}
        <div
          style={{
            flex: 1,
            display: "flex",
            alignItems: "flex-end",
            gap: 6,
          }}
        >
          {binCounts.map((count, i) => {
            const fraction = count / total;
            const color = BAR_COLORS[i];
            const label = count > 0 ? `${(fraction * 100).toFixed(1)}%` : "";
            const barHeight = Math.max(8, (fraction / maxFraction) * 180);

            return (
              <div
                key={i}
                style={{
                  flex: 1,
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  justifyContent: "flex-end",
                  height: "100%",
                }}
              >
                <div
                  style={{
                    fontSize: 10,
                    color: "#e5e7ff",
                    marginBottom: 4,
                    minHeight: 14,
                  }}
                >
                  {label}
                </div>

                <div
                  style={{
                    width: "100%",
                    height: barHeight,
                    backgroundColor: color,
                    borderRadius: "4px 4px 0 0",
                    border: "1px solid rgba(0,0,0,0.45)",
                    boxShadow: "0 0 4px rgba(0,0,0,0.6)",
                  }}
                  title={`${count} pixels in ${BIN_EDGES[i]}–${BIN_EDGES[i + 1]}% (${label || "0%"})`}
                />
              </div>
            );
          })}
        </div>
      </div>

      {/* X-axis ticks */}

<div
  style={{
    marginTop: 10,
    width: "100%",
    display: "flex",
    justifyContent: "space-between",
    padding: "0 6px",
  }}
>
  {BIN_EDGES.slice(1).map((edge, i) => (
    <div
      key={i}
      style={{
        flex: 1,
        textAlign: "center",
        fontSize: 11,
        color: "#cbd5f5",
      }}
    >
      {edge}
    </div>
  ))}
</div>



      {/* X-axis label */}
      <div
        style={{
          marginTop: 16,
          textAlign: "center",
          fontSize: 12,
          color: "#cbd5f5",
        }}
      >
        Value (%)
      </div>
    </div>
  </div>
);
}