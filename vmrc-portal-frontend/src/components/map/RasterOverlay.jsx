// src/components/map/RasterOverlay.jsx
import PropTypes from "prop-types";
import { ImageOverlay } from "react-leaflet";

const BACKEND_BASE =
  import.meta.env.VITE_BACKEND_URL || "http://127.0.0.1:8000";

export default function RasterOverlay({ overlayUrl, bounds }) {
  if (!overlayUrl || !bounds) return null;

  // Always prepend backend base URL
  const fullUrl = overlayUrl.startsWith("http")
    ? overlayUrl
    : `${BACKEND_BASE}${overlayUrl}`;

  // Convert object bounds -> Leaflet bounds array
  const leafletBounds = [
    [bounds.south, bounds.west],
    [bounds.north, bounds.east],
  ];

  return (
    <ImageOverlay
      url={fullUrl}
      bounds={leafletBounds}
      opacity={1.0}
      interactive={false} // let clicks pass through to map
      zIndex={200}
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
