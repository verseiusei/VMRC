// src/components/charts/StatsTable.jsx

/**
 * StatsTable
 * ----------
 * Displays statistical summary for the clipped raster.
 * Expects `stats` to be an object returned by your backend:
 *
 * {
 *    min: 1.23,
 *    max: 4.56,
 *    mean: 2.34,
 *    std: 0.98,
 *    count: 1500
 * }
 */

export default function StatsTable({ stats }) {
  if (!stats) {
    return <p className="empty-hist">No stats available. Draw a clip region.</p>;
  }

  const rows = [
    ["Count", stats.count],
    ["Minimum", stats.min?.toFixed(2)],
    ["Maximum", stats.max?.toFixed(2)],
    ["Mean", stats.mean?.toFixed(2)],
    ["Std Dev", stats.std?.toFixed(2)],
  ];

  return (
    <div className="stats-table-container">
      <h3 className="panel-subtitle">Statistical Summary</h3>

      <table className="stats-table">
        <tbody>
          {rows.map(([label, value]) => (
            <tr key={label}>
              <td className="stats-label">{label}</td>
              <td className="stats-value">{value ?? "--"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
