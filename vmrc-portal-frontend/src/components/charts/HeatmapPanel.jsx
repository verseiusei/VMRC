// src/components/charts/HeatmapPanel.jsx

import { useState, useEffect } from "react";

/**
 * HeatmapPanel
 * ------------
 * Controls for heatmap visualization.
 * The BaseMap consumes values, not this component directly.
 */

export default function HeatmapPanel({ values = [] }) {
  const [intensity, setIntensity] = useState(1.0);
  const [radius, setRadius] = useState(25);

  // Basic stats
  const count = values.length;
  const min = count > 0 ? Math.min(...values) : 0;
  const max = count > 0 ? Math.max(...values) : 0;
  const mean =
    count > 0 ? values.reduce((a, b) => a + b, 0) / values.length : 0;

  return (
    <div className="heatmap-panel">
      <h3 className="panel-subtitle">Heatmap Settings</h3>

      {/* IF NO VALUES */}
      {count === 0 && (
        <p className="empty-hist">No clipped data. Draw a region.</p>
      )}

      {count > 0 && (
        <>
          {/* INTENSITY SLIDER */}
          <div className="slider-group">
            <label>Intensity: {intensity.toFixed(1)}</label>
            <input
              type="range"
              min="0.1"
              max="3"
              step="0.1"
              value={intensity}
              onChange={(e) => setIntensity(parseFloat(e.target.value))}
            />
          </div>

          {/* RADIUS SLIDER */}
          <div className="slider-group">
            <label>Point Radius: {radius}px</label>
            <input
              type="range"
              min="10"
              max="50"
              step="1"
              value={radius}
              onChange={(e) => setRadius(parseFloat(e.target.value))}
            />
          </div>

          {/* VALUE SUMMARY */}
          <div className="heatmap-summary">
            <h4>Value Summary</h4>
            <div className="summary-row">
              <span>Count:</span> <span>{count}</span>
            </div>
            <div className="summary-row">
              <span>Min:</span> <span>{min.toFixed(2)}</span>
            </div>
            <div className="summary-row">
              <span>Max:</span> <span>{max.toFixed(2)}</span>
            </div>
            <div className="summary-row">
              <span>Mean:</span> <span>{mean.toFixed(2)}</span>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
