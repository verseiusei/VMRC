// ----------------------------------------------
// src/components/map/BaseMap.jsx  (AOI + Click-to-sample)
// ----------------------------------------------

// Leaflet marker icon fix (if you later use markers elsewhere)
import L from "leaflet";
import marker2x from "leaflet/dist/images/marker-icon-2x.png";
import marker from "leaflet/dist/images/marker-icon.png";
import shadow from "leaflet/dist/images/marker-shadow.png";

delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: marker2x,
  iconUrl: marker,
  shadowUrl: shadow,
});

import React, { useEffect, useRef, useState } from "react";
import {
  MapContainer,
  TileLayer,
  GeoJSON,
  LayersControl,
  useMap,
  useMapEvents,
} from "react-leaflet";

import "leaflet/dist/leaflet.css";
import "@geoman-io/leaflet-geoman-free";
import "@geoman-io/leaflet-geoman-free/dist/leaflet-geoman.css";

import { sampleRasterValue } from "../../lib/rasterApi";
import RasterOverlay from "./RasterOverlay";

// ======================================================
// CUSTOM DRAWING TOOLBOX (user clip only, AOI stays)
// ======================================================
function MapTools({ onUserClipChange }) {
  const map = useMap();
  const lastDrawnLayerRef = useRef(null); // track ONLY the user clip layer

  useEffect(() => {
    if (!map) return;
    if (map.pmInitialized) return;

    map.pmInitialized = true;

    // Turn on only Polygon + Rectangle
    map.pm.addControls({
      position: "topleft",
      drawMarker: false,
      drawCircle: false,
      drawPolyline: false,
      drawCircleMarker: false,
      drawText: false,
      dragMode: false,
      cutPolygon: false,
      rotateMode: false,
    });

    // Remove any stray Geoman weird buttons like T / Rotate
    if (map.pm.Toolbar) {
      try {
        map.pm.Toolbar.removeControl("Text");
        map.pm.Toolbar.removeControl("RotateMode");
        map.pm.Toolbar.removeControl("Cut");
      } catch {
        // ignore
      }
    }

    // When a new shape is created
    map.on("pm:create", (e) => {
      console.log("🔥 PM CREATE FIRED — POLYGON CAPTURED");
      const newLayer = e.layer;

      // Only remove the previous user-drawn clip,
      // NEVER touch the AOI GeoJSON layer.
      if (lastDrawnLayerRef.current && map.hasLayer(lastDrawnLayerRef.current)) {
        map.removeLayer(lastDrawnLayerRef.current);
      }

      lastDrawnLayerRef.current = newLayer;
      onUserClipChange(newLayer.toGeoJSON());
    });

    // When a layer is removed via the Geoman UI, clear clip
    map.on("pm:remove", (e) => {
      console.log("🔥 PM REMOVE FIRED — CLIP CLEARED");
      if (e.layer === lastDrawnLayerRef.current) {
        lastDrawnLayerRef.current = null;
        onUserClipChange(null);
      }
    });
  }, [map, onUserClipChange]);

  return null; // this component is only for side-effects
}

// ======================================================
// LEGEND (Discrete Color Ramp)
// ======================================================
const LEGEND_ITEMS = [
  { color: "#006400", label: "0–10" },
  { color: "#228B22", label: "10–20" },
  { color: "#6B8E23", label: "20–30" },
  { color: "#9ACD32", label: "30–40" },
  { color: "#FFD700", label: "40–50" },
  { color: "#FFC000", label: "50–60" },
  { color: "#FFA500", label: "60–70" },
  { color: "#FF8C00", label: "70–80" },
  { color: "#FF4500", label: "80–90" },
  { color: "#B22222", label: "90–100" },
];

function LegendControl() {
  useMap();

  return (
    <div className="leaflet-top leaflet-left" style={{ marginTop: "240px" }}>
      <div className="leaflet-control legend-card">
        <div className="legend-title">Value (%)</div>
        {LEGEND_ITEMS.map((item) => (
          <div className="legend-row" key={item.label}>
            <span
              className="legend-swatch"
              style={{ backgroundColor: item.color }}
            />
            <span className="legend-label">{item.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ======================================================
// CLICK SAMPLER – real .tif value, only after clip
// ======================================================
function ClickSampler({ activeRasterId, overlayBounds, onSample }) {
  useMapEvents({
    async click(e) {
      console.log("📍 Map clicked:", e.latlng);

      // Only respond if we actually have a clipped raster visible
      if (!activeRasterId) {
        console.log("❌ No active raster, ignoring click");
        return;
      }

      if (!overlayBounds) {
        console.log("❌ No overlay bounds (no clip yet), ignoring click");
        return;
      }

      const { lat, lng } = e.latlng;

      try {
        const result = await sampleRasterValue({
          rasterLayerId: activeRasterId,
          lat,
          lng,
        });

        console.log("🎯 Sample Result from .tif:", result);

        onSample({
          lat,
          lon: lng,
          value: result.value,
          isNoData: result.is_nodata,
        });
      } catch (err) {
        console.error("❌ Sample failed:", err);
        // keep last sample on screen instead of clearing it
      }
    },
  });

  return null;
}

// ======================================================
// MAIN MAP COMPONENT
// ======================================================
export default function BaseMap({
  globalAoi,
  userClip,
  overlayUrl,
  overlayBounds,
  onUserClipChange,
  activeRasterId,
}) {
  const [inspectInfo, setInspectInfo] = useState(null);

  return (
    <div className="map-container">
      <MapContainer
        center={[44, -123]}
        zoom={7}
        scrollWheelZoom={true}
        className="vmrc-map"
        style={{
          width: "100%",
          height: "100%",
        }}
      >
        {/* Basemap Layers */}
        <LayersControl position="topright">
          <LayersControl.BaseLayer checked name="Topographic">
            <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
          </LayersControl.BaseLayer>

          <LayersControl.BaseLayer name="Satellite (Esri)">
            <TileLayer url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}" />
          </LayersControl.BaseLayer>

          <LayersControl.BaseLayer name="Dark">
            <TileLayer url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png" />
          </LayersControl.BaseLayer>
        </LayersControl>

        {/* Permanent AOI */}
        {globalAoi && (
          <GeoJSON
            data={globalAoi}
            style={{
              color: "#00BFFF", // bright aqua blue outline
              weight: 3,
              fillColor: "#00BFFF",
              fillOpacity: 0.05,
            }}
          />
        )}

        

        {/* User Clip (temporary) */}
        {userClip && (
          <GeoJSON
            data={userClip}
            style={{ color: "#38bdf8", weight: 2, fillOpacity: 0.15 }}
          />
        )}

        {/* Raster overlay from backend-clipped PNG */}
        <RasterOverlay overlayUrl={overlayUrl} bounds={overlayBounds} />

        {/* Drawing tools + legend */}
        <MapTools onUserClipChange={onUserClipChange} />
        <LegendControl />

        {/* Click sampler for real .tif value */}
        <ClickSampler
          activeRasterId={activeRasterId}
          overlayBounds={overlayBounds}
          onSample={setInspectInfo}
        />

        {/* Small info card in the map (top-left) with last sampled point */}
        {inspectInfo && !inspectInfo.isNoData && (
          <div className="leaflet-top leaflet-right">
            <div className="info-card">
              <div className="info-title">Sampled point</div>
              <div className="info-line">
                <strong>Lat:</strong> {inspectInfo.lat.toFixed(4)}
              </div>
              <div className="info-line">
                <strong>Lon:</strong> {inspectInfo.lon.toFixed(4)}
              </div>
              <div className="info-line">
                <strong>Value:</strong>{" "}
                {inspectInfo.value == null
                  ? "No data"
                  : inspectInfo.value.toFixed(2)}
              </div>
            </div>
          </div>
        )}
      </MapContainer>
    </div>
  );
}
