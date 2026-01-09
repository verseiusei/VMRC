// src/lib/rasterApi.js

const API_BASE = "http://127.0.0.1:8000/api/v1";

/**
 * Get the global AOI GeoJSON from the backend.
 * Backend endpoint: GET /api/v1/aoi
 */
export async function fetchGlobalAOI() {
  console.log("[rasterApi] fetchGlobalAOI() called");

  const res = await fetch(`${API_BASE}/aoi`);

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

  const res = await fetch("http://127.0.0.1:8000/api/v1/rasters/clip", {
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

  const res = await fetch(`${API_BASE}/aoi/upload`, {
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
    res = await fetch(`${API_BASE}/rasters/export`, {
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

  const res = await fetch(`${API_BASE}/rasters/value`, {
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
  const res = await fetch("http://127.0.0.1:8000/api/v1/rasters/sample", {
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
