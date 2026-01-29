// src/lib/rasterApi.js

const API_BASE_URL =
  (import.meta.env.VITE_API_BASE_URL || "").trim() ||
  "http://127.0.0.1:8000";

export function apiUrl(path) {
  const base = API_BASE_URL.endsWith("/") ? API_BASE_URL.slice(0, -1) : API_BASE_URL;
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${base}${p}`;
}

// Export API base for debugging
export const API_BASE = API_BASE_URL;

// Print once on module load
console.log("[rasterApi] API_BASE_URL =", API_BASE_URL);

/**
 * Elevation at (lat, lng). Backend: GET /api/v1/elevation?lat=..&lng=..
 * Returns { elevation_ft: number | null, elevation_m: number | null } or null on failure.
 */
export async function fetchElevation(lat, lng) {
  const url = apiUrl(`/api/v1/elevation?lat=${encodeURIComponent(lat)}&lng=${encodeURIComponent(lng)}`);
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = await res.json();
  return {
    elevation_ft: data.elevation_ft ?? null,
    elevation_m: data.elevation_m ?? null,
  };
}

/**
 * Get the global AOI GeoJSON from the backend.
 * Backend endpoint: GET /api/v1/aoi
 */
export async function fetchGlobalAOI() {
  const res = await fetch(apiUrl("/api/v1/aoi"));
  const text = await res.text();

  if (!res.ok) {
    console.error("[rasterApi] fetchGlobalAOI failed:", res.status, text);
    throw new Error("Failed to load global AOI");
  }
  return JSON.parse(text);
}

/**
 * Upload custom AOI file.
 * Backend endpoint: POST /api/v1/aoi/upload
 */
export async function uploadAOI(file) {
  const form = new FormData();
  form.append("file", file);

  const res = await fetch(apiUrl("/api/v1/aoi/upload"), {
    method: "POST",
    body: form,
  });

  const text = await res.text();
  if (!res.ok) {
    console.error("[rasterApi] uploadAOI failed:", res.status, text);
    throw new Error(`Upload failed: ${res.status}`);
  }

  return text ? JSON.parse(text) : {};
}

/**
 * Clip a raster by the user-drawn polygon (and global AOI on backend).
 * Backend endpoint: POST /api/v1/rasters/clip
 * 
 * @param {Object} params
 * @param {number} params.rasterLayerId - ID of the raster layer to clip
 * @param {Object} params.userClipGeoJSON - GeoJSON polygon defining the AOI
 * @param {number} [params.zoom] - (Deprecated) Previously used for zoom-based display resampling. Generation is now zoom-independent.
 */
export async function clipRaster({ rasterLayerId, userClipGeoJSON, zoom }) {
  const res = await fetch(apiUrl("/api/v1/rasters/clip"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      raster_layer_id: rasterLayerId,
      user_clip_geojson: userClipGeoJSON,
      // zoom intentionally not sent: generation must be zoom-independent
    }),
  });

  const text = await res.text();
  if (!res.ok) {
    console.error("[rasterApi] clipRaster failed:", res.status, text);
    
    // Try to parse error detail for friendly messages
    let errorMessage = "Clip failed";
    try {
      const errorData = JSON.parse(text);
      const detail = errorData?.detail || errorData?.message || text;
      
      // Check for specific 422 errors (Unprocessable Entity - validation errors)
      if (res.status === 422) {
        if (detail.includes("AOI contains no raster data") || detail.includes("no raster data for this layer")) {
          errorMessage = "AOI doesn't overlap this raster. Try a different area.";
        } else if (detail.includes("AOI outside raster extent") || detail.includes("AOI too small") || detail.includes("no intersect")) {
          errorMessage = "AOI doesn't overlap this raster. Try a different area.";
        } else {
          errorMessage = detail;
        }
      } else {
        // For other errors, use the detail if available
        errorMessage = detail;
      }
    } catch (parseErr) {
      // If JSON parsing fails, use the raw text or default message
      errorMessage = text || "Clip failed";
    }
    
    // Create error object with status code and message
    const error = new Error(errorMessage);
    error.status = res.status;
    error.detail = errorMessage;
    throw error;
  }

  return text ? JSON.parse(text) : {};
}

/**
 * Export raster.
 * Backend endpoint: POST /api/v1/rasters/export
 */
export async function exportRaster({ rasterLayerId, userClipGeoJSON, formats, filename, context, overlayUrl, aoiName, overlayUrls }) {
  let res;
  try {
    const body = {
      raster_layer_id: rasterLayerId,
      user_clip_geojson: userClipGeoJSON,
      formats: formats || [],
      filename: filename || null,
      context: context || {},
    };
    
    // Add optional fields if provided
    if (overlayUrl) {
      body.overlay_url = overlayUrl;
    }
    if (aoiName) {
      body.aoi_name = aoiName;
    }
    if (overlayUrls && Array.isArray(overlayUrls) && overlayUrls.length > 0) {
      body.overlay_urls = overlayUrls;
    }
    
    res = await fetch(apiUrl("/api/v1/rasters/export"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    console.error("[rasterApi] network error in exportRaster:", err);
    throw new Error("Network error while exporting (backend not reachable?)");
  }

  const text = await res.text();
  if (!res.ok) {
    try {
      const data = JSON.parse(text);
      const detail = data?.detail || JSON.stringify(data);
      throw new Error(`Export failed (${res.status}): ${detail}`);
    } catch {
      throw new Error(`Export failed (${res.status})`);
    }
  }

  return text ? JSON.parse(text) : {};
}

/**
 * Sample value.
 * Backend endpoint: POST /api/v1/rasters/sample
 */
export async function sampleRasterValue({ rasterLayerId, lat, lng }) {
  const res = await fetch(apiUrl("/api/v1/rasters/sample"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      rasterLayerId,
      lon: lng,
      lat,
    }),
  });

  const text = await res.text();
  if (!res.ok) {
    console.error("[rasterApi] sampleRasterValue failed:", res.status, text);
    throw new Error("Failed to sample raster value");
  }

  return text ? JSON.parse(text) : {};
}

/**
 * Get raster value at a specific lat/lon.
 * Backend endpoint: GET /api/v1/rasters/value?layer_id=<id>&lat=<lat>&lon=<lon>
 */
export async function getRasterValueAt({ rasterLayerId, lat, lon }) {
  // Use GET with query parameters for better caching and simpler API
  const url = apiUrl(`/api/v1/rasters/value?layer_id=${rasterLayerId}&lat=${lat}&lon=${lon}`);
  const res = await fetch(url, {
    method: "GET",
    headers: { "Content-Type": "application/json" },
  });

  const text = await res.text();
  if (!res.ok) {
    console.error("[rasterApi] getRasterValueAt failed:", res.status, text);
    throw new Error("Failed to get value at point");
  }

  return text ? JSON.parse(text) : {};
}

/**
 * Download a GeoPDF file.
 */
export async function downloadGeoPDF(downloadUrl) {
  const fullUrl = downloadUrl.startsWith("http") ? downloadUrl : apiUrl(downloadUrl);
  window.open(fullUrl, "_blank");
}

/**
 * Delete a GeoPDF dataset.
 * Backend endpoint: DELETE /api/v1/geopdf/{datasetId}
 */
export async function deleteGeoPDF(datasetId) {
  const res = await fetch(apiUrl(`/api/v1/geopdf/${datasetId}`), {
    method: "DELETE",
  });

  const text = await res.text();

  if (!res.ok) {
    try {
      const data = JSON.parse(text);
      const detail = data?.detail || JSON.stringify(data);
      throw new Error(`Delete failed (${res.status}): ${detail}`);
    } catch {
      throw new Error(`Delete failed (${res.status})`);
    }
  }

  return text ? JSON.parse(text) : {};
}


/**
 * List all datasets (including uploaded GeoPDFs).
 * Backend endpoint: GET /api/v1/datasets
 */
export async function listDatasets() {
  const res = await fetch(apiUrl("/api/v1/datasets"));
  const text = await res.text();
  if (!res.ok) throw new Error(`Failed to list datasets: ${res.status}`);
  return text ? JSON.parse(text) : {};
}

/**
 * Download a dataset file.
 * Backend endpoint: GET /api/v1/datasets/{datasetId}/download
 */
export function downloadDataset(datasetId) {
  const url = apiUrl(`/api/v1/datasets/${datasetId}/download`);
  window.open(url, "_blank");
}

/**
 * Get dataset preview URL.
 * Backend endpoint: GET /api/v1/datasets/{datasetId}/preview
 */
export async function getDatasetPreview(datasetId) {
  const res = await fetch(apiUrl(`/api/v1/datasets/${datasetId}/preview`));
  if (!res.ok) return null;

  const data = await res.json();
  return data.preview_url || null;
}

/**
 * Fetch metadata for a layer (uploaded GeoPDF or processed layer).
 * Backend endpoint: GET /api/v1/layers/{layer_id}/metadata
 */
export async function fetchLayerMetadata(layerId) {
  const res = await fetch(apiUrl(`/api/v1/layers/${layerId}/metadata`));
  const text = await res.text();

  if (!res.ok) {
    console.error("[rasterApi] fetchLayerMetadata failed:", res.status, text);
    throw new Error(`Failed to fetch layer metadata: ${res.status}`);
  }

  return text ? JSON.parse(text) : {};
}

/**
 * Fetch metadata for a raster layer.
 * Backend endpoint: GET /api/v1/rasters/{raster_id}/metadata
 */
export async function fetchRasterMetadata(rasterId) {
  const res = await fetch(apiUrl(`/api/v1/rasters/${rasterId}/metadata`));
  const text = await res.text();

  if (!res.ok) {
    console.error("[rasterApi] fetchRasterMetadata failed:", res.status, text);
    throw new Error(`Failed to fetch raster metadata: ${res.status}`);
  }

  return text ? JSON.parse(text) : {};
}

/**
 * Get GeoPDF status (diagnostic endpoint to check GDAL availability).
 * Backend endpoint: GET /api/v1/geopdf/status
 */
export async function getGeopdfStatus() {
  const res = await fetch(apiUrl("/api/v1/geopdf/status"));
  const text = await res.text();

  if (!res.ok) {
    console.error("[rasterApi] getGeopdfStatus failed:", res.status, text);
    throw new Error(`Failed to get GeoPDF status: ${res.status}`);
  }

  return text ? JSON.parse(text) : {};
}

/**
 * Delete an overlay PNG file from the server.
 * Backend endpoint: DELETE /api/v1/rasters/overlays/{overlay_filename}
 * 
 * @param {string} overlayUrl - The overlay URL (e.g., "/static/overlays/abc123.png")
 * @returns {Promise<{success: boolean, message: string}>}
 */
export async function deleteOverlay(overlayUrl) {
  // Extract filename from URL (e.g., "/static/overlays/abc123.png" -> "abc123.png")
  const filename = overlayUrl.split("/").pop();
  
  if (!filename) {
    throw new Error("Invalid overlay URL: cannot extract filename");
  }
  
  const res = await fetch(apiUrl(`/api/v1/rasters/overlays/${filename}`), {
    method: "DELETE",
  });

  const text = await res.text();
  if (!res.ok) {
    console.error("[rasterApi] deleteOverlay failed:", res.status, text);
    try {
      const data = JSON.parse(text);
      const detail = data?.detail || JSON.stringify(data);
      throw new Error(`Delete failed (${res.status}): ${detail}`);
    } catch {
      throw new Error(`Delete failed (${res.status})`);
    }
  }

  return text ? JSON.parse(text) : {};
}

/**
 * Download a blob file without navigation (read-only operation).
 * Uses fetch -> blob -> objectURL and programmatic <a download> click.
 * 
 * @param {string} url - URL to download
 * @param {string} filename - Filename for the download
 */
export async function downloadBlob(url, filename) {
  console.log("[rasterApi] Downloading blob:", url);
  // CRITICAL: Use credentials: "omit" for static file downloads to avoid CORS issues
  // Static exports don't need cookies/credentials
  const res = await fetch(url, { credentials: "omit" });
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);
  const blob = await res.blob();

  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = objectUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(objectUrl);
  console.log("[rasterApi] Blob downloaded successfully:", filename);
}
