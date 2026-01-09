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

import React, { useEffect, useRef, useState, useCallback } from "react";
import {
  MapContainer,
  TileLayer,
  GeoJSON,
  LayersControl,
  useMap,
  useMapEvents,
  Marker,
  Tooltip
} from "react-leaflet";

import "leaflet/dist/leaflet.css";
import "@geoman-io/leaflet-geoman-free";
import "@geoman-io/leaflet-geoman-free/dist/leaflet-geoman.css";

import { sampleRasterValue } from "../../lib/rasterApi";
import RasterOverlay from "./RasterOverlay";

// ======================================================
// AOI LAYER - Renders a single AOI (drawn or uploaded)
// ======================================================
function AoiLayer({ data, aoiId, aoiType, onRemove }) {
  const map = useMap();
  const layerRef = useRef(null);

  useEffect(() => {
    if (!map || !layerRef.current) return;

    const layer = layerRef.current.leafletElement;
    if (!layer) return;

    // Prevent Geoman from attaching to this layer
    // Mark layer so Geoman knows to ignore it
    layer._pmIgnore = true;

    // Disable Geoman if it's already attached
    if (layer.pm) {
      layer.pm.disable();
      // Prevent re-enabling
      const originalEnable = layer.pm.enable;
      layer.pm.enable = function() {
        console.warn("Attempted to enable Geoman on uploaded AOI - ignored");
        return this;
      };
    }

    // Also handle child layers (for MultiPolygon, FeatureCollection with multiple features)
    if (layer.eachLayer) {
      layer.eachLayer((sublayer) => {
        sublayer._pmIgnore = true;
        if (sublayer.pm) {
          sublayer.pm.disable();
        }
      });
    }

    // Listen for Geoman trying to attach and prevent it
    const preventGeoman = () => {
      if (layer.pm) {
        layer.pm.disable();
      }
    };

    map.on("pm:create", preventGeoman);
    map.on("pm:globaleditmodetoggled", preventGeoman);

    return () => {
      map.off("pm:create", preventGeoman);
      map.off("pm:globaleditmodetoggled", preventGeoman);
      // Note: react-leaflet automatically removes the layer when component unmounts
    };
  }, [map, data]);

  // Style based on type
  const style = aoiType === "upload"
    ? {
        color: "#f97316", // orange outline for uploaded
        weight: 2,
        fillOpacity: 0.15,
      }
    : {
        color: "#2563eb", // blue outline for drawn
        weight: 3,
        fillColor: "#2563eb",
        fillOpacity: 0.1,
        dashArray: "5, 5", // dashed line
      };

  return (
    <GeoJSON
      ref={layerRef}
      data={data}
      style={style}
      eventHandlers={{
        // Handle removal via Geoman erase tool
        remove: () => {
          if (onRemove && aoiId) {
            onRemove(aoiId);
          }
        },
      }}
    />
  );
}

// ======================================================
// UPLOADED AOI LAYER - Legacy component (kept for compatibility)
// ======================================================
function UploadedAOILayer({ data, index }) {
  const map = useMap();
  const layerRef = useRef(null);

  useEffect(() => {
    if (!map || !layerRef.current) return;

    const layer = layerRef.current.leafletElement;
    if (!layer) return;

    layer._pmIgnore = true;

    if (layer.pm) {
      layer.pm.disable();
      const originalEnable = layer.pm.enable;
      layer.pm.enable = function() {
        console.warn("Attempted to enable Geoman on uploaded AOI - ignored");
        return this;
      };
    }

    if (layer.eachLayer) {
      layer.eachLayer((sublayer) => {
        sublayer._pmIgnore = true;
        if (sublayer.pm) {
          sublayer.pm.disable();
        }
      });
    }

    const preventGeoman = () => {
      if (layer.pm) {
        layer.pm.disable();
      }
    };

    map.on("pm:create", preventGeoman);
    map.on("pm:globaleditmodetoggled", preventGeoman);

    return () => {
      map.off("pm:create", preventGeoman);
      map.off("pm:globaleditmodetoggled", preventGeoman);
      // Note: react-leaflet automatically removes the layer when component unmounts
    };
  }, [map, data]);

  return (
    <GeoJSON
      ref={layerRef}
      data={data}
      style={{
        color: "#f97316", // orange outline
        weight: 2,
        fillOpacity: 0.15,
      }}
    />
  );
}

// ======================================================
// CUSTOM DRAWING TOOLBOX (user clip only, AOI stays)
// ======================================================
function MapTools({ onUserClipChange, onRemoveAoi, aois = [] }) {
  const map = useMap();
  const lastDrawnLayerRef = useRef(null); // track ONLY the user clip layer

  useEffect(() => {
    if (!map) return;
    if (map.pmInitialized) return;

    map.pmInitialized = true;

    // Enable draw tools (polygon + rectangle) and removal mode (ERASE)
    // Disable all edit-related tools completely
    // IMPORTANT: This is the ONLY addControls call - no overwriting
    map.pm.addControls({
      position: "topleft",
      // Enable draw tools
      drawPolygon: true,
      drawRectangle: true,
      // Enable removal mode (ERASE/trash button) - MUST be true
      removalMode: true,
      // Disable all other draw tools
      drawMarker: false,
      drawCircle: false,
      drawPolyline: false,
      drawCircleMarker: false,
      drawText: false,
      editControls: true,
      editMode: false,
      dragMode: false,
      rotateMode: false,
      cutPolygon: false,
 // Disable edit mode completely
    });

    // Remove unwanted controls BUT preserve RemovalMode (erase tool)
    // Wait a moment for toolbar to initialize before removing controls
    setTimeout(() => {
      if (map.pm && map.pm.Toolbar) {
        try {
          // Remove unwanted controls
        map.pm.Toolbar.removeControl("Text");
        map.pm.Toolbar.removeControl("RotateMode");
        map.pm.Toolbar.removeControl("Cut");
          // Remove edit controls if they exist
          map.pm.Toolbar.removeControl("EditMode");
          map.pm.Toolbar.removeControl("editMode");
          map.pm.Toolbar.removeControl("edit");
          
          // Verify RemovalMode control exists and is enabled
          // Try different possible control names
          const controlNames = ["RemovalMode", "removalMode", "Remove", "Delete", "Erase"];
          let foundControl = null;
          
          for (const name of controlNames) {
            try {
              const control = map.pm.Toolbar.getControl(name);
              if (control) {
                foundControl = control;
                console.log(`✓ RemovalMode (erase) control found as "${name}"`);
                break;
              }
            } catch (e) {
              // Try next name
            }
          }
          
          if (!foundControl) {
            // List all available controls for debugging
            try {
              const allControls = map.pm.Toolbar._toolbars;
              console.warn("⚠ RemovalMode control not found. Available controls:", Object.keys(allControls || {}));
            } catch (e) {
              console.warn("⚠ Could not list available controls");
            }
            console.warn("⚠ Make sure removalMode: true is set in addControls()");
          }
        } catch (err) {
          console.warn("Error managing Geoman toolbar controls:", err);
        }
      }
    }, 200);

    // When a new shape is created
    map.on("pm:create", (e) => {
      console.log("🔥 PM CREATE FIRED — POLYGON CAPTURED");
      const newLayer = e.layer;

      // DO NOT remove previous layers - allow multiple polygons
      // Store reference for potential future use, but don't remove
      lastDrawnLayerRef.current = newLayer;
      onUserClipChange(newLayer.toGeoJSON());
    });

    // When a layer is removed via the Geoman UI (erase tool)
    map.on("pm:remove", (e) => {
      console.log("🔥 PM REMOVE FIRED — LAYER REMOVED");
      const removedLayer = e.layer;
      
      // Find which AOI this layer belongs to by comparing GeoJSON
      const removedGeoJSON = removedLayer.toGeoJSON();
      const matchingAoi = aois.find(aoi => {
        try {
          return JSON.stringify(aoi.geojson) === JSON.stringify(removedGeoJSON);
        } catch (err) {
          return false;
        }
      });
      
      if (matchingAoi && onRemoveAoi) {
        // Remove the AOI and its overlay
        onRemoveAoi(matchingAoi.id);
      } else if (removedLayer === lastDrawnLayerRef.current) {
        // Fallback: if it was the last drawn layer, clear it
        lastDrawnLayerRef.current = null;
        onUserClipChange(null);
      }
    });
  }, [map, onUserClipChange]);

  return null; // this component is only for side-effects
}

// ======================================================
// LEGEND (Discrete Color Ramp) - Always visible
// ======================================================
const LEGEND_ITEMS = [
  { color: "#006400", label: "0–10" },
  { color: "#228B22", label: "10–20" },
  { color: "#9ACD32", label: "20–30" },
  { color: "#FFD700", label: "30–40" },
  { color: "#FFA500", label: "40–50" },
  { color: "#FF8C00", label: "50–60" },
  { color: "#FF6B00", label: "60–70" },
  { color: "#FF4500", label: "70–80" },
  { color: "#DC143C", label: "80–90" },
  { color: "#B22222", label: "90–100" },
];

// ======================================================
// LEGEND CONTROL – Persistent Leaflet Control
// Always visible from page load, static reference legend
// Uses useRef to persist across React StrictMode double renders
// ======================================================
function LegendControl() {
  const map = useMap();
  const controlRef = useRef(null);
  const containerRef = useRef(null);

  // Create control once - persist using useRef to prevent flicker in StrictMode
  useEffect(() => {
    if (!map) return;
    
    // Only create if it doesn't exist
    if (controlRef.current) return;

    // Create custom Leaflet Control
    const VMRCLegendControl = L.Control.extend({
      onAdd: function(map) {
        const container = L.DomUtil.create('div', 'leaflet-control vmrc-legend');
        container.style.pointerEvents = 'none';
        container.style.zIndex = '1000';
        containerRef.current = container;
        
        // Build static legend HTML - always show bins, no conditional content
        const legendHTML = `
          <div class="legend-card">
            <div class="legend-title">Value (%)</div>
            ${LEGEND_ITEMS.map((item) => `
              <div class="legend-row">
                <span class="legend-swatch" style="background-color: ${item.color}; pointer-events: none;"></span>
                <span class="legend-label" style="pointer-events: none;">${item.label}</span>
              </div>
            `).join('')}
          </div>
        `;
        
        container.innerHTML = legendHTML;
        return container;
      },
      onRemove: function(map) {
        // Cleanup handled by React
      }
    });

    // Create and add control - only once
    const control = new VMRCLegendControl({ position: 'topleft' });
    control.addTo(map);
    controlRef.current = control;

    // Don't remove in cleanup - let it persist
    // Only remove if map is actually unmounting (handled by Leaflet)
  }, [map]); // Only depend on map

  return null; // Control is managed by Leaflet, not React
}



// ======================================================
// MAP REF HANDLER – Expose map instance to parent
// ======================================================
function MapRefHandler({ onMapReady }) {
  const map = useMap();
  
  useEffect(() => {
    if (map && onMapReady) {
      onMapReady(map);
    }
  }, [map, onMapReady]);

  return null;
}

// ======================================================
// RASTER QUALITY CONTROL – Persistent Leaflet Control
// Only visible when raster exists, updates only on zoomend to prevent flicker
// Uses useRef to persist across React StrictMode double renders
// ======================================================
function RasterQualityControl({ overlayUrl, overlayBounds }) {
  const map = useMap();
  const controlRef = useRef(null);
  const containerRef = useRef(null);

  // Raster pixel size: ~700-800m (average 750m)
  const RASTER_PIXEL_SIZE_M = 750;

  const hasRaster = overlayUrl && overlayBounds;

  // Create/remove control based on raster state - persist using useRef
  useEffect(() => {
    if (!map) return;

    if (!hasRaster) {
      // Remove control if it exists and no raster
      if (controlRef.current) {
        map.removeControl(controlRef.current);
        controlRef.current = null;
        containerRef.current = null;
      }
      return;
    }

    // Only create if it doesn't exist
    if (controlRef.current) return;

    // Create custom Leaflet Control only when raster exists
    const QualityControl = L.Control.extend({
      onAdd: function(map) {
        const container = L.DomUtil.create('div', 'leaflet-control zoom-resolution-indicator');
        container.style.pointerEvents = 'none';
        container.style.zIndex = '1000';
        containerRef.current = container;
        return container;
      },
      onRemove: function(map) {
        // Cleanup handled by React
      }
    });

    // Create and add control - only once
    const control = new QualityControl({ position: 'bottomright' });
    control.addTo(map);
    controlRef.current = control;

    // No cleanup needed - effect body handles removal when hasRaster becomes false
    // Control persists using useRef to prevent flicker in StrictMode
  }, [map, hasRaster]);

  // Update content function - only called when raster exists
  const updateContent = useCallback(() => {
    if (!containerRef.current || !hasRaster) return;

    const zoom = map.getZoom();
    const center = map.getCenter();
    
    // Calculate meters per screen pixel
    const metersPerScreenPixel = (156543.03392 * Math.cos(center.lat * Math.PI / 180)) / Math.pow(2, zoom);
    
    // Calculate how big one raster pixel appears on screen
    const pixelScreenSize = RASTER_PIXEL_SIZE_M / metersPerScreenPixel;

    // Determine status
    let status;
    if (pixelScreenSize <= 30) {
      status = "good";
    } else if (pixelScreenSize <= 80) {
      status = "warning";
    } else {
      status = "error";
    }

    const statusConfig = {
      good: { color: "#10b981", text: "True to size", label: "GOOD" },
      warning: { color: "#f59e0b", text: "Getting blocky", label: "WARNING" },
      error: { color: "#ef4444", text: "Too zoomed in — pixels huge", label: "ERROR" },
    };

    const config = statusConfig[status];

    // Update DOM directly to avoid React re-renders
    containerRef.current.innerHTML = `
      <div class="zoom-resolution-badge zoom-resolution-${status}" style="border-left-color: ${config.color}; pointer-events: none;">
        <div class="zoom-resolution-label" style="color: ${config.color}; pointer-events: none;">
          ${config.label}
        </div>
        <div class="zoom-resolution-text" style="pointer-events: none;">
          ${config.text}
        </div>
        <div class="zoom-resolution-size" style="pointer-events: none;">
          ${pixelScreenSize.toFixed(0)}px/pixel
        </div>
      </div>
    `;
  }, [map, hasRaster]);

  // Update content when raster changes
  useEffect(() => {
    updateContent();
  }, [updateContent]);

  // Update content only on zoomend (not zoom or moveend) to prevent flicker
  useEffect(() => {
    if (!containerRef.current) return;

    // Only listen to zoomend (not zoom or moveend) to prevent flicker
    map.on("zoomend", updateContent);

    return () => {
      map.off("zoomend", updateContent);
    };
  }, [map, updateContent]);

  return null; // Control is managed by Leaflet, not React
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
  uploadedAois = [],
  aois = [], // Unified AOI array with overlays
  userClip, // Legacy - keep for compatibility
  overlayUrl = null, // Optional - legacy single overlay
  overlayBounds = null, // Optional - legacy single overlay
  onUserClipChange,
  onRemoveAoi = null, // Optional callback to remove AOI by ID
  activeRasterId,
  datasetPreview = null, // GeoPDF dataset preview: { id, preview_url, preview_bounds }
  onMapReady,
})
 {
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

        {/* All AOIs (both drawn and uploaded) with their overlays */}
        {aois && Array.isArray(aois) && aois.map((aoi) => {
          if (!aoi || !aoi.id || !aoi.geojson) return null;
          
          return (
            <React.Fragment key={aoi.id}>
              {/* AOI Geometry */}
              <AoiLayer
                data={aoi.geojson}
                aoiId={aoi.id}
                aoiType={aoi.type || "draw"}
                onRemove={onRemoveAoi}
              />
              
              {/* Raster Overlay for this AOI */}
              {aoi.overlayUrl && aoi.overlayBounds && (
                <RasterOverlay
                  overlayUrl={aoi.overlayUrl}
                  bounds={aoi.overlayBounds}
                />
              )}
            </React.Fragment>
          );
        })}

        {/* Legacy: Single overlay support (for backward compatibility) */}
        {/* Also show if aois exist but none have overlays (e.g., when showing raster from list whose AOI was removed) */}
        {overlayUrl && overlayBounds && (
          (aois.length === 0 || !aois.some(aoi => aoi.overlayUrl && aoi.overlayBounds)) && (
            <RasterOverlay
              overlayUrl={overlayUrl}
              bounds={overlayBounds}
            />
          )
        )}

        {/* GeoPDF Dataset Preview Overlay */}
        {datasetPreview && datasetPreview.preview_url && datasetPreview.preview_bounds && (
          <RasterOverlay
            overlayUrl={datasetPreview.preview_url}
            bounds={datasetPreview.preview_bounds}
          />
        )}

        {/* Drawing tools + legend */}
        <MapTools 
          onUserClipChange={onUserClipChange}
          onRemoveAoi={onRemoveAoi}
          aois={aois}
        />
        <LegendControl />

        {/* Raster quality control - persistent Leaflet control */}
        <RasterQualityControl 
          overlayUrl={overlayUrl}
          overlayBounds={overlayBounds}
        />

        {/* Map ref handler */}
        <MapRefHandler onMapReady={onMapReady} />

        {/* Click sampler for real .tif value */}
        <ClickSampler
          activeRasterId={activeRasterId}
          overlayBounds={overlayBounds}
          onSample={setInspectInfo}
        />

        {/* Small info card in the map (top-left) with last sampled point */}
        {inspectInfo && !inspectInfo.isNoData && (
          <Marker position={[inspectInfo.lat, inspectInfo.lon]}>
            <Tooltip
              permanent
              direction="top"
              offset={[0, -18]}
              className="inspect-tooltip"
            >
              <div className="inspect-tooltip-inner">
                <div className="inspect-title">Location Info</div>
                <div className="inspect-line"><strong>Lat:</strong> {inspectInfo.lat.toFixed(4)}</div>
                <div className="inspect-line"><strong>Lon:</strong> {inspectInfo.lon.toFixed(4)}</div>
                <div className="inspect-line"><strong>Value:</strong> {inspectInfo.value.toFixed(2)}</div>
              </div>
            </Tooltip>
          </Marker>
        )}

      </MapContainer>
    </div>
  );
}

