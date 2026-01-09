// src/lib/rasterApi.js

// API Base URL from environment variable
// Defaults to Cloudflare tunnel URL for testing "frontend -> public backend" locally
// Set VITE_API_BASE_URL in .env file to override
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || "https://feel-robin-punch-ping.trycloudflare.com";

// Helper function to build API URLs
// Ensures proper path joining (handles trailing/leading slashes)
export function apiUrl(path) {
  const base = API_BASE_URL.endsWith("/") ? API_BASE_URL.slice(0, -1) : API_BASE_URL;
  const apiPath = path.startsWith("/") ? path : `/${path}`;
  // Ensure /api/v1 prefix
  if (!apiPath.startsWith("/api/v1")) {
    return `${base}/api/v1${apiPath}`;
  }
  return `${base}${apiPath}`;
}

// Export API base for debugging
export const API_BASE = API_BASE_URL;

// Log API base URL at module load (for debugging)
console.log("[rasterApi] API Base URL:", API_BASE_URL);

/**
 * Get the global AOI GeoJSON from the backend.
 * Backend endpoint: GET /api/v1/aoi
 */
export async function fetchGlobalAOI() {
  console.log("[rasterApi] fetchGlobalAOI() called");

  const res = await fetch(apiUrl("/aoi"));

  const text = await res.text();
  console.log("[rasterApi] /aoi raw response:", text);

  if (!res.ok) {
    console.error("[rasterApi] fetchGlobalAOI failed:", res.status, text);
    throw new Error("Failed to load global AOI");
  }

  const data = JSON.parse(text);
  console.log("[rasterApi] fetchGlobalAOI parsed JSON:", data);
  return data;
}

/**
 * Clip a raster by the user-drawn polygon (and global AOI on backend).
 * Backend endpoint: POST /api/v1/rasters/clip
 */
export async function clipRaster({ rasterLayerId, userClipGeoJSON }) {

  const res = await fetch(apiUrl("/rasters/clip"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      raster_layer_id: rasterLayerId,
      user_clip_geojson: userClipGeoJSON,
    }),
  });


  const text = await res.text();
  console.log("[rasterApi] /rasters/clip raw response:", text);

  if (!res.ok) {
    console.error("[rasterApi] clipRaster failed:", res.status, text);
    throw new Error("Clip failed");
  }

  const data = JSON.parse(text);
  console.log("[rasterApi] clipRaster parsed JSON:", data);
  return data;
}

/**
 * Export the clipped raster in one or more formats.
 * Backend endpoint: POST /api/v1/rasters/export
 *
 * formats: array of strings, e.g. ["png", "tif", "csv"]
 * 
 * 
 */

export async function uploadAOI(file) {
  const form = new FormData();
  form.append("file", file);

  const res = await fetch(apiUrl("/aoi/upload"), {
    method: "POST",
    body: form,
  });

  if (!res.ok) {
    throw new Error(`Upload failed: ${res.status}`);
  }

  return await res.json();
}


export async function exportRaster({ rasterLayerId, userClipGeoJSON, formats, filename, context }) {
  console.log("[rasterApi] exportRaster() called with:", {
    rasterLayerId,
    userClipGeoJSON,
    formats,
    filename,
    context,
  });

  let res;
  try {
    res = await fetch(apiUrl("/rasters/export"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        raster_layer_id: rasterLayerId,
        user_clip_geojson: userClipGeoJSON,
        formats: formats || [],
        filename: filename || null,
        context: context || {},
      }),
    });
  } catch (err) {
    console.error("[rasterApi] network error in exportRaster:", err);
    throw new Error("Network error while exporting (backend not reachable?)");
  }

  const text = await res.text();
  console.log("[rasterApi] /rasters/export raw response:", text);

  if (!res.ok) {
    // Try to surface backend message if present
    try {
      const data = JSON.parse(text);
      const detail = data?.detail || JSON.stringify(data);
      console.error("[rasterApi] exportRaster failed:", res.status, detail);
      throw new Error(`Export failed (${res.status}): ${detail}`);
    } catch {
      console.error("[rasterApi] exportRaster failed:", res.status, text);
      throw new Error(`Export failed (${res.status})`);
    }
  }

  const data = text ? JSON.parse(text) : {};
  console.log("[rasterApi] exportRaster parsed JSON:", data);
  return data;
}

/**
 * Get raster value at a specific lat/lon for the given layer.
 * Backend endpoint: POST /api/v1/rasters/value
 */
export async function getRasterValueAt({ rasterLayerId, lat, lon }) {
  console.log("[rasterApi] getRasterValueAt():", {
    rasterLayerId,
    lat,
    lon,
  });

  const res = await fetch(apiUrl("/rasters/value"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      raster_layer_id: rasterLayerId,
      lat,
      lon,
    }),
  });

  const text = await res.text();
  console.log("[rasterApi] /rasters/value raw response:", text);

  if (!res.ok) {
    console.error("[rasterApi] getRasterValueAt failed:", res.status, text);
    throw new Error("Failed to get value at point");
  }

  const data = text ? JSON.parse(text) : {};
  console.log("[rasterApi] getRasterValueAt parsed JSON:", data);
  return data;
}

export async function sampleRasterValue({ rasterLayerId, lat, lng }) {
  const res = await fetch(apiUrl("/rasters/sample"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      rasterLayerId,
      lon: lng,
      lat,
    }),
  });

  if (!res.ok) {
    throw new Error("Failed to sample raster value");
  }

  return res.json();
}

/**
 * Export a georeferenced PDF (GeoPDF) for Avenza Maps.
 * Backend endpoint: POST /api/v1/export/geopdf
 */
export async function exportGeoPDFNew({ rasterId, aoiGeoJSON, title, author }) {
  console.log("[rasterApi] exportGeoPDFNew() called with:", {
    rasterId,
    aoiGeoJSON,
    title,
    author,
  });

  let res;
  try {
    res = await fetch(apiUrl("/export/geopdf"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        raster_id: rasterId,
        aoi_geojson: aoiGeoJSON || null,
        title: title || null,
        author: author || null,
      }),
    });
  } catch (err) {
    console.error("[rasterApi] network error in exportGeoPDFNew:", err);
    throw new Error("Network error while exporting GeoPDF (backend not reachable?)");
  }

  if (!res.ok) {
    const text = await res.text();
    try {
      const data = JSON.parse(text);
      const detail = data?.detail || JSON.stringify(data);
      console.error("[rasterApi] exportGeoPDFNew failed:", res.status, detail);
      throw new Error(`GeoPDF export failed (${res.status}): ${detail}`);
    } catch {
      console.error("[rasterApi] exportGeoPDFNew failed:", res.status, text);
      throw new Error(`GeoPDF export failed (${res.status})`);
    }
  }

  // Response is a PDF file, download it
  const blob = await res.blob();
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = res.headers.get("Content-Disposition")?.split("filename=")[1]?.replace(/"/g, "") || "export.pdf";
  document.body.appendChild(a);
  a.click();
  window.URL.revokeObjectURL(url);
  document.body.removeChild(a);
  
  console.log("[rasterApi] ✓ GeoPDF downloaded");
  return { success: true };
}

/**
 * Legacy exportGeoPDF function (kept for backward compatibility)
 */
export async function exportGeoPDF({ rasterLayerId, userClipGeoJSON, title, dpi = 200 }) {
  // Map to new API
  return exportGeoPDFNew({
    rasterId: rasterLayerId,
    aoiGeoJSON: userClipGeoJSON,
    title,
    author: null,
  });
}

/**
 * Download a GeoPDF file.
 */
export async function downloadGeoPDF(downloadUrl) {
  const fullUrl = downloadUrl.startsWith("http") ? downloadUrl : apiUrl(downloadUrl);
  window.open(fullUrl, "_blank");
}

/**
 * Import a GeoPDF file and get overlay preview.
 * Backend endpoint: POST /api/v1/import/geopdf
 */
export async function importGeoPDF(file) {
  console.log("[rasterApi] importGeoPDF() called with:", { file });

  const formData = new FormData();
  formData.append("file", file);

  const res = await fetch(apiUrl("/import/geopdf"), {
    method: "POST",
    body: formData,
  });

  const text = await res.text();
  console.log("[rasterApi] /import/geopdf raw response:", text);

  if (!res.ok) {
    try {
      const data = JSON.parse(text);
      const detail = data?.detail || JSON.stringify(data);
      console.error("[rasterApi] importGeoPDF failed:", res.status, detail);
      throw new Error(`GeoPDF import failed (${res.status}): ${detail}`);
    } catch {
      console.error("[rasterApi] importGeoPDF failed:", res.status, text);
      throw new Error(`GeoPDF import failed (${res.status})`);
    }
  }

  const data = text ? JSON.parse(text) : {};
  console.log("[rasterApi] importGeoPDF parsed JSON:", data);
  return data;
}

/**
 * Legacy uploadGeoPDF function (kept for backward compatibility)
 */
export async function uploadGeoPDF(file, name = null) {
  return importGeoPDF(file);
}

/**
 * List all datasets (including uploaded GeoPDFs).
 * Backend endpoint: GET /api/v1/datasets
 */
export async function listDatasets() {
  const res = await fetch(apiUrl("/datasets"));

  if (!res.ok) {
    throw new Error(`Failed to list datasets: ${res.status}`);
  }

  return res.json();
}

/**
 * Download a dataset.
 * Backend endpoint: GET /api/v1/datasets/{id}/download
 */
export async function downloadDataset(datasetId) {
  const downloadUrl = apiUrl(`/datasets/${datasetId}/download`);
  window.open(downloadUrl, "_blank");
}

/**
 * Get dataset preview URL.
 * Backend endpoint: GET /api/v1/datasets/{id}/preview
 */
export async function getDatasetPreview(datasetId) {
  const res = await fetch(apiUrl(`/datasets/${datasetId}/preview`));

  if (!res.ok) {
    return null;
  }

  const data = await res.json();
  return data.preview_url;
}

/**
 * Delete a GeoPDF dataset.
 * Backend endpoint: DELETE /api/v1/geopdf/{id}
 */
export async function deleteGeoPDF(datasetId) {
  const res = await fetch(apiUrl(`/geopdf/${datasetId}`), {
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
