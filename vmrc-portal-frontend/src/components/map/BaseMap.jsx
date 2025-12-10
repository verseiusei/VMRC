// ----------------------------------------------
// src/components/map/BaseMap.jsx  (AOI + Inspector)
// ----------------------------------------------

import React, { useEffect, useRef, useState } from "react";
import {
  MapContainer,
  TileLayer,
  GeoJSON,
  LayersControl,
  useMap,
  Marker,
  Tooltip
} from "react-leaflet";

import "leaflet/dist/leaflet.css";
import "@geoman-io/leaflet-geoman-free";
import "@geoman-io/leaflet-geoman-free/dist/leaflet-geoman.css";

import { getRasterValueAt } from "../../lib/rasterApi"; // <-- path to rasterApi
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

      // ❗ Only remove the previous user-drawn clip,
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
// MAP INSPECTOR – click to get value at location
// ======================================================
function MapInspector({ activeRasterId, onValueLoaded }) {
  const map = useMap();

  useEffect(() => {
    if (!map) return;
    if (!activeRasterId) return;

    const handleClick = async (e) => {
      const { lat, lng } = e.latlng;
      try {
        const res = await getRasterValueAt({
          rasterLayerId: activeRasterId,
          lat,
          lon: lng,
        });

        onValueLoaded({
          lat,
          lon: lng,
          value: res.value,
          isValid: res.is_valid,
        });
      } catch (err) {
        console.error("Inspector error:", err);
        onValueLoaded(null);
      }
    };

    map.on("click", handleClick);
    return () => {
      map.off("click", handleClick);
    };
  }, [map, activeRasterId, onValueLoaded]);

  return null;
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
// MAIN MAP COMPONENT
// ======================================================
export default function BaseMap({
  globalAoi,
  uploadedAoi,      // NEW
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
        style={{ width: "100%", height: "100%" }}
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
              color: "#00BFFF",       // bright aqua blue outline
              weight: 3,              // thicker border
              fillColor: "#00BFFF",   // light fill
              fillOpacity: 0.05       // slightly visible but not covering map
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

        {/* Raster overlay */}
        <RasterOverlay overlayUrl={overlayUrl} bounds={overlayBounds} />

        {/* Drawing tools + legend */}
        <MapTools onUserClipChange={onUserClipChange} />
        <LegendControl />

        {/* Inspector click handler */}
        <MapInspector
          activeRasterId={activeRasterId}
          onValueLoaded={setInspectInfo}
        />

        {/* Floating tooltip at clicked location */}
        {inspectInfo && inspectInfo.isValid && (
          <Marker position={[inspectInfo.lat, inspectInfo.lon]}>
            <Tooltip
              permanent
              direction="top"
              offset={[0, -20]}
              className="inspect-tooltip"
            >
              <div className="inspect-tooltip-inner">
                <div className="inspect-title">Location</div>
                <div className="inspect-line">
                  Lat: {inspectInfo.lat.toFixed(4)}
                </div>
                <div className="inspect-line">
                  Lon: {inspectInfo.lon.toFixed(4)}
                </div>
                <div className="inspect-line">
                  Value: {inspectInfo.value.toFixed(2)}
                </div>
              </div>
            </Tooltip>
          </Marker>
        )}

        {/* Permanent VMRC AOI */}
        {globalAoi && (
          <GeoJSON
            data={globalAoi}
            style={{ color: "#22c55e", weight: 3, fillOpacity: 0 }}
          />
        )}

        {/* User-uploaded AOI (extra layer) */}
        {uploadedAoi && (
          <GeoJSON
            data={uploadedAoi}
            style={{ color: "#eab308", weight: 2, fillOpacity: 0 }}
          />
        )}

      </MapContainer>
    </div>
  );
}
