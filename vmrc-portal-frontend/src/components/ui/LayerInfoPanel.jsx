// src/components/ui/LayerInfoPanel.jsx

import { useState } from "react";

export default function LayerInfoPanel({ metadata, isLoading }) {
  const [copied, setCopied] = useState(false);

  if (isLoading) {
    return (
      <div
        style={{
          padding: "16px",
          fontSize: "13px",
          color: "#6b7280",
          textAlign: "center",
        }}
      >
        Loading layer metadata...
      </div>
    );
  }

  if (!metadata) {
    return null; // Don't render anything when no metadata
  }

  const handleCopyJSON = () => {
    navigator.clipboard.writeText(JSON.stringify(metadata, null, 2));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const formatBounds = (bounds) => {
    if (!bounds || !Array.isArray(bounds) || bounds.length !== 2) {
      return "N/A";
    }
    const [[south, west], [north, east]] = bounds;
    return `[${south.toFixed(6)}, ${west.toFixed(6)}], [${north.toFixed(6)}, ${east.toFixed(6)}]`;
  };

  const formatDate = (dateStr) => {
    if (!dateStr) return "N/A";
    try {
      const date = new Date(dateStr);
      return date.toLocaleString();
    } catch {
      return dateStr;
    }
  };

  return (
    <div
      style={{
        padding: "16px",
        backgroundColor: "#ffffff",
        border: "1px solid #e5e7eb",
        borderRadius: "4px",
      }}
    >
      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: "16px",
        }}
      >
        <h3
          style={{
            fontSize: "18px",
            fontWeight: 700,
            color: "#111827",
            margin: 0,
          }}
        >
          {metadata.title || "Layer Info"}
        </h3>
        <button
          onClick={handleCopyJSON}
          style={{
            padding: "4px 10px",
            fontSize: "11px",
            background: copied ? "#10b981" : "#f3f4f6",
            color: copied ? "#ffffff" : "#374151",
            border: "none",
            borderRadius: "3px",
            cursor: "pointer",
            fontWeight: 500,
          }}
        >
          {copied ? "Copied!" : "Copy JSON"}
        </button>
      </div>

      {/* Summary */}
      {metadata.summary && (
        <p
          style={{
            fontSize: "13px",
            color: "#374151",
            lineHeight: "1.6",
            marginBottom: "16px",
          }}
        >
          {metadata.summary}
        </p>
      )}

      {/* Tags */}
      {metadata.tags && metadata.tags.length > 0 && (
        <div style={{ marginBottom: "16px" }}>
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: "6px",
            }}
          >
            {metadata.tags.map((tag, i) => (
              <span
                key={i}
                style={{
                  padding: "4px 8px",
                  fontSize: "11px",
                  backgroundColor: "#eff6ff",
                  color: "#1e40af",
                  borderRadius: "3px",
                  fontWeight: 500,
                }}
              >
                {tag}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Metadata Table */}
      <div
        style={{
          marginBottom: "16px",
        }}
      >
        <table
          style={{
            width: "100%",
            borderCollapse: "collapse",
            fontSize: "12px",
          }}
        >
          <tbody>
            <tr>
              <td
                style={{
                  padding: "6px 8px",
                  fontWeight: 600,
                  color: "#6b7280",
                  borderBottom: "1px solid #e5e7eb",
                  width: "40%",
                }}
              >
                Source Type
              </td>
              <td
                style={{
                  padding: "6px 8px",
                  color: "#111827",
                  borderBottom: "1px solid #e5e7eb",
                }}
              >
                {metadata.source_type || "N/A"}
              </td>
            </tr>
            <tr>
              <td
                style={{
                  padding: "6px 8px",
                  fontWeight: 600,
                  color: "#6b7280",
                  borderBottom: "1px solid #e5e7eb",
                }}
              >
                CRS
              </td>
              <td
                style={{
                  padding: "6px 8px",
                  color: "#111827",
                  borderBottom: "1px solid #e5e7eb",
                }}
              >
                {metadata.crs || "N/A"}
              </td>
            </tr>
            {metadata.bounds && (
              <tr>
                <td
                  style={{
                    padding: "6px 8px",
                    fontWeight: 600,
                    color: "#6b7280",
                    borderBottom: "1px solid #e5e7eb",
                  }}
                >
                  Bounds (EPSG:4326)
                </td>
                <td
                  style={{
                    padding: "6px 8px",
                    color: "#111827",
                    borderBottom: "1px solid #e5e7eb",
                    fontFamily: "monospace",
                    fontSize: "11px",
                  }}
                >
                  {formatBounds(metadata.bounds)}
                </td>
              </tr>
            )}
            {metadata.pixel_size && (
              <tr>
                <td
                  style={{
                    padding: "6px 8px",
                    fontWeight: 600,
                    color: "#6b7280",
                    borderBottom: "1px solid #e5e7eb",
                  }}
                >
                  Pixel Size
                </td>
                <td
                  style={{
                    padding: "6px 8px",
                    color: "#111827",
                    borderBottom: "1px solid #e5e7eb",
                  }}
                >
                  {metadata.pixel_size[0].toFixed(1)}m × {metadata.pixel_size[1].toFixed(1)}m
                </td>
              </tr>
            )}
            {metadata.units && (
              <tr>
                <td
                  style={{
                    padding: "6px 8px",
                    fontWeight: 600,
                    color: "#6b7280",
                    borderBottom: "1px solid #e5e7eb",
                  }}
                >
                  Units
                </td>
                <td
                  style={{
                    padding: "6px 8px",
                    color: "#111827",
                    borderBottom: "1px solid #e5e7eb",
                  }}
                >
                  {metadata.units}
                </td>
              </tr>
            )}
            {metadata.created_at && (
              <tr>
                <td
                  style={{
                    padding: "6px 8px",
                    fontWeight: 600,
                    color: "#6b7280",
                    borderBottom: "1px solid #e5e7eb",
                  }}
                >
                  Created
                </td>
                <td
                  style={{
                    padding: "6px 8px",
                    color: "#111827",
                    borderBottom: "1px solid #e5e7eb",
                  }}
                >
                  {formatDate(metadata.created_at)}
                </td>
              </tr>
            )}
            {metadata.credits && (
              <tr>
                <td
                  style={{
                    padding: "6px 8px",
                    fontWeight: 600,
                    color: "#6b7280",
                    borderBottom: "1px solid #e5e7eb",
                  }}
                >
                  Credits
                </td>
                <td
                  style={{
                    padding: "6px 8px",
                    color: "#111827",
                    borderBottom: "1px solid #e5e7eb",
                  }}
                >
                  {metadata.credits}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Stats Grid */}
      {metadata.stats && (
        <div
          style={{
            marginTop: "16px",
            padding: "12px",
            backgroundColor: "#f9fafb",
            borderRadius: "4px",
          }}
        >
          <h4
            style={{
              fontSize: "13px",
              fontWeight: 700,
              color: "#111827",
              marginBottom: "10px",
            }}
          >
            Statistics
          </h4>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: "8px",
              fontSize: "12px",
            }}
          >
            {metadata.stats.min !== null && metadata.stats.min !== undefined && (
              <>
                <div style={{ color: "#6b7280", fontWeight: 600 }}>Min:</div>
                <div style={{ color: "#111827" }}>{metadata.stats.min.toFixed(2)}</div>
              </>
            )}
            {metadata.stats.max !== null && metadata.stats.max !== undefined && (
              <>
                <div style={{ color: "#6b7280", fontWeight: 600 }}>Max:</div>
                <div style={{ color: "#111827" }}>{metadata.stats.max.toFixed(2)}</div>
              </>
            )}
            {metadata.stats.mean !== null && metadata.stats.mean !== undefined && (
              <>
                <div style={{ color: "#6b7280", fontWeight: 600 }}>Mean:</div>
                <div style={{ color: "#111827" }}>{metadata.stats.mean.toFixed(2)}</div>
              </>
            )}
            {metadata.stats.std !== null && metadata.stats.std !== undefined && (
              <>
                <div style={{ color: "#6b7280", fontWeight: 600 }}>Std Dev:</div>
                <div style={{ color: "#111827" }}>{metadata.stats.std.toFixed(2)}</div>
              </>
            )}
            {metadata.stats.nodata !== null && metadata.stats.nodata !== undefined && (
              <>
                <div style={{ color: "#6b7280", fontWeight: 600 }}>NoData:</div>
                <div style={{ color: "#111827" }}>{metadata.stats.nodata}</div>
              </>
            )}
            {metadata.stats.count !== null && metadata.stats.count !== undefined && (
              <>
                <div style={{ color: "#6b7280", fontWeight: 600 }}>Valid Pixels:</div>
                <div style={{ color: "#111827" }}>{metadata.stats.count.toLocaleString()}</div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

