// src/lib/aoiParser.js
// Frontend-only AOI file parser (Shapefile, GeoJSON, KML)

import shp from "shpjs";

/**
 * Normalize GeoJSON to ensure it's a FeatureCollection
 * Handles Feature, FeatureCollection, or raw Geometry
 */
export function normalizeGeoJSON(geo) {
  if (!geo) {
    throw new Error("Invalid GeoJSON: null or undefined");
  }

  // If it's already a FeatureCollection, return as-is
  if (geo.type === "FeatureCollection") {
    if (!Array.isArray(geo.features)) {
      throw new Error("Invalid FeatureCollection: features must be an array");
    }
    return geo;
  }

  // If it's a single Feature, wrap it
  if (geo.type === "Feature") {
    return {
      type: "FeatureCollection",
      features: [geo],
    };
  }

  // If it's a raw Geometry, wrap it in a Feature
  if (geo.type && ["Point", "LineString", "Polygon", "MultiPoint", "MultiLineString", "MultiPolygon", "GeometryCollection"].includes(geo.type)) {
    return {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: geo,
          properties: {},
        },
      ],
    };
  }

  throw new Error(`Unsupported GeoJSON type: ${geo.type || "unknown"}`);
}

/**
 * Parse a GeoJSON file (text)
 */
export async function parseGeoJSONFile(file) {
  const text = await file.text();
  const geo = JSON.parse(text);
  return normalizeGeoJSON(geo);
}

/**
 * Parse a Shapefile ZIP
 * Returns array of FeatureCollections (one per layer in the shapefile)
 */
export async function parseShapefile(file) {
  const buffer = await file.arrayBuffer();
  
  // shpjs returns either:
  // - A single FeatureCollection (one layer)
  // - An array of FeatureCollections (multiple layers)
  const result = await shp(buffer);
  
  if (Array.isArray(result)) {
    // Multiple layers - normalize each
    return result.map(normalizeGeoJSON);
  } else {
    // Single layer - normalize and return as array
    return [normalizeGeoJSON(result)];
  }
}

/**
 * Parse KML file (basic support)
 * Note: Full KML support requires @placemark/tokml or similar
 * This is a simplified version that handles basic KML
 */
export async function parseKMLFile(file) {
  const text = await file.text();
  
  // Basic KML parsing - extract coordinates from Placemark elements
  // For production, consider using @placemark/tokml or toGeoJSON library
  const parser = new DOMParser();
  const doc = parser.parseFromString(text, "text/xml");
  
  // Check for XML parsing errors
  const parseError = doc.querySelector("parsererror");
  if (parseError) {
    throw new Error("Invalid KML file: XML parsing failed. Please ensure the file is a valid KML document.");
  }
  
  const placemarks = doc.querySelectorAll("Placemark");
  const features = [];
  
  placemarks.forEach((placemark) => {
    const nameEl = placemark.querySelector("name");
    const coordinatesEl = placemark.querySelector("coordinates");
    
    if (coordinatesEl) {
      const coordsText = coordinatesEl.textContent.trim();
      const coordPairs = coordsText.split(/\s+/).map((pair) => {
        const parts = pair.split(",");
        if (parts.length < 2) {
          throw new Error("Invalid KML coordinates: each coordinate must have at least longitude and latitude");
        }
        const [lon, lat] = [Number(parts[0]), Number(parts[1])];
        if (isNaN(lon) || isNaN(lat)) {
          throw new Error("Invalid KML coordinates: longitude and latitude must be numbers");
        }
        return [lon, lat];
      });
      
      // Only create Polygon geometries (AOI requires polygons)
      // Skip Points and LineStrings
      if (coordPairs.length >= 3) {
        // Create Polygon (close the ring)
        const closed = [...coordPairs, coordPairs[0]];
        features.push({
          type: "Feature",
          geometry: { type: "Polygon", coordinates: [closed] },
          properties: {
            name: nameEl?.textContent || "Unnamed",
          },
        });
      }
    }
  });
  
  if (features.length === 0) {
    throw new Error("No valid polygon features found in KML file. KML must contain Placemark elements with at least 3 coordinates to form a polygon.");
  }
  
  return {
    type: "FeatureCollection",
    features,
  };
}

/**
 * Main parser function - detects file type and parses accordingly
 * Returns array of FeatureCollections (for shapefiles with multiple layers)
 */
export async function parseAOIFile(file) {
  const name = file.name.toLowerCase();
  const ext = name.split(".").pop();

  try {
    if (ext === "geojson" || ext === "json") {
      const geo = await parseGeoJSONFile(file);
      return [geo]; // Return as array for consistency
    } else if (ext === "zip") {
      return await parseShapefile(file);
    } else if (ext === "kml") {
      const geo = await parseKMLFile(file);
      return [geo];
    } else {
      throw new Error(`Unsupported file type: .${ext}`);
    }
  } catch (err) {
    throw new Error(`Failed to parse ${file.name}: ${err.message}`);
  }
}

/**
 * Calculate bounds from a FeatureCollection
 * Returns [south, west, north, east] for Leaflet
 */
export function getGeoJSONBounds(geoJSON) {
  if (!geoJSON || !geoJSON.features || geoJSON.features.length === 0) {
    return null;
  }

  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLon = Infinity;
  let maxLon = -Infinity;

  const extractCoords = (coords, isRing = false) => {
    if (Array.isArray(coords[0])) {
      coords.forEach((c) => extractCoords(c, isRing));
    } else if (coords.length >= 2) {
      const [lon, lat] = coords;
      minLat = Math.min(minLat, lat);
      maxLat = Math.max(maxLat, lat);
      minLon = Math.min(minLon, lon);
      maxLon = Math.max(maxLon, lon);
    }
  };

  geoJSON.features.forEach((feature) => {
    if (feature.geometry) {
      const { type, coordinates } = feature.geometry;
      
      if (type === "Point") {
        extractCoords(coordinates);
      } else if (type === "LineString" || type === "MultiPoint") {
        extractCoords(coordinates);
      } else if (type === "Polygon" || type === "MultiLineString") {
        coordinates.forEach((ring) => extractCoords(ring));
      } else if (type === "MultiPolygon") {
        coordinates.forEach((polygon) => {
          polygon.forEach((ring) => extractCoords(ring));
        });
      }
    }
  });

  if (minLat === Infinity) {
    return null;
  }

  return [[minLat, minLon], [maxLat, maxLon]];
}

