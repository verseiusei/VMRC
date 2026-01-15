// src/components/map/RasterOverlay.jsx
import PropTypes from "prop-types";
import { ImageOverlay } from "react-leaflet";

const BACKEND_BASE =
  import.meta.env.VITE_BACKEND_URL || "http://127.0.0.1:8000";

export default function RasterOverlay({ overlayUrl, bounds }) {
  // CRITICAL: Require both overlayUrl and bounds - NO fallback to global AOI
  if (!overlayUrl || !bounds) {
    console.warn("RasterOverlay: Missing overlayUrl or bounds, not rendering");
    return null;
  }

  // Validate bounds structure
  if (typeof bounds.west !== "number" || typeof bounds.south !== "number" || 
      typeof bounds.east !== "number" || typeof bounds.north !== "number") {
    console.error("RasterOverlay: Invalid bounds structure", bounds);
    return null;
  }

  // Always prepend backend base URL
  const fullUrl = overlayUrl.startsWith("http")
    ? overlayUrl
    : `${BACKEND_BASE}${overlayUrl}`;

  // Convert backend bounds object {west, south, east, north} -> Leaflet bounds array
  // Leaflet expects: [[south, west], [north, east]]
  const leafletBounds = [
    [bounds.south, bounds.west],
    [bounds.north, bounds.east],
  ];

  // Log bounds being used for rendering
  console.log("RasterOverlay: Rendering with bounds:", {
    west: bounds.west,
    south: bounds.south,
    east: bounds.east,
    north: bounds.north,
    leafletBounds: leafletBounds
  });

  return (
    <ImageOverlay
      url={fullUrl}
      bounds={leafletBounds}
      opacity={1.0}
      interactive={false} // let clicks pass through to map
      zIndex={200}
      className="vmrc-raster-overlay raster-overlay-pixelated"
    />
  );
}

RasterOverlay.propTypes = {
  overlayUrl: PropTypes.string,
  bounds: PropTypes.shape({
    north: PropTypes.number,
    south: PropTypes.number,
    east: PropTypes.number,
    west: PropTypes.number,
  }),
};
