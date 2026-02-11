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

import { sampleRasterValue, getRasterValueAt } from "../../lib/rasterApi";
import RasterOverlay from "./RasterOverlay";
import LayerGroupManager from "./LayerGroupManager";

// Default bounds for initial West Coast view (applied once on mount)
const DEFAULT_BOUNDS = [
  [32.0, -130.0], // Southwest corner
  [52.0, -105.0], // Northeast corner
];

// One-time bounds fitter to avoid re-zooming on state changes
function InitialBoundsSetter() {
  const map = useMap();
  const didInitRef = useRef(false);

  useEffect(() => {
    if (!map || didInitRef.current) return;

    try {
      map.fitBounds(DEFAULT_BOUNDS, { padding: [20, 20] });
      didInitRef.current = true;
    } catch (err) {
      console.warn("[BaseMap] Failed to apply initial bounds:", err);
    }
  }, [map]);

  return null;
}

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
function MapTools({ onUserClipChange, onRemoveAoi, aois = [], onDrawStart = null, onClearDrawnAoi = null, lastDrawnAoiRef, onAoiErased = null }) {
  const map = useMap();
  const lastDrawnLayerRef = useRef(null); // track ONLY the user clip layer
  const drawnLayersRef = useRef([]); // track all drawn AOI layers
  const prevAoisCountRef = useRef(aois.length); // track previous aois count to detect imports
  const currentAoiLayerRef = useRef(null); // track the current AOI geometry layer created by Geoman
  
  // lastDrawnAoiRef is passed from BaseMap parent - stores GeoJSON persistently

  // ============================================================
  // CLEAR PREVIOUS AOI GEOMETRY LAYER
  // ============================================================
  // Remove the previous AOI outline layer created by Geoman
  // This is called when starting a new draw to ensure clean state
  // ============================================================
  const clearPreviousAoiLayer = useCallback(() => {
    if (!map) return;
    
    // Remove the stored AOI layer if it exists
    if (currentAoiLayerRef.current) {
      console.log("🧹 Removing previous AOI geometry layer");
      try {
        map.removeLayer(currentAoiLayerRef.current);
      } catch (err) {
        // Layer might already be removed, ignore error
        console.log("Previous AOI layer already removed or not on map");
      }
      currentAoiLayerRef.current = null;
    }
    
    // Also clear the last drawn layer ref
    lastDrawnLayerRef.current = null;
  }, [map]);

  // ============================================================
  // CLEAR DRAWN AOI GEOMETRY
  // ============================================================
  // Remove all Geoman-drawn layers (polygons/rectangles) from the map
  // This is separate from overlay clearing - we clear geometry on draw start
  // NOTE: LayerGroupManager handles the actual layer removal, this just clears refs
  // ============================================================
  const clearDrawnAoiLayers = useCallback(() => {
    if (!map) return;
    
    console.log("🧹 Clearing drawn AOI geometry layers");
    
    // First, clear the tracked AOI layer
    clearPreviousAoiLayer();
    
    // Clear the refs (LayerGroupManager will handle actual layer removal)
    drawnLayersRef.current = [];
    
    // Also notify parent if callback provided
    if (onClearDrawnAoi) {
      onClearDrawnAoi();
    }
  }, [map, onClearDrawnAoi, clearPreviousAoiLayer]);

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

    // ============================================================
    // CLEAR DRAWN AOI GEOMETRY ON DRAW START
    // ============================================================
    // When user starts drawing (tool activated), clear old drawn AOI geometry
    // This ensures the map shows only the new shape being drawn
    // NOTE: We do NOT clear overlays here - those clear on pm:create or after Generate
    // ============================================================
    const handleDrawStart = (e) => {
      console.log("🔥 PM DRAW START — Clearing old drawn AOI geometry");
      // Remove the previous AOI layer explicitly
      clearPreviousAoiLayer();
      // Also clear any other drawn layers
      clearDrawnAoiLayers();
      // Clear created rasters list and overlays so only rasters from the new AOI will appear
      if (onDrawStart) onDrawStart();
    };

    // Listen for draw start events (when polygon/rectangle tool is activated)
    map.on("pm:drawstart", handleDrawStart);
    map.on("pm:globaldrawmodetoggled", (e) => {
      // This fires when any draw mode is toggled on
      if (e.enabled && (e.shape === "Polygon" || e.shape === "Rectangle")) {
        console.log("🔥 PM DRAW MODE TOGGLED — Clearing old drawn AOI geometry");
        clearDrawnAoiLayers();
      }
    });

    // ============================================================
    // CLEAR OVERLAYS ON NEW AOI CREATED (not on draw start)
    // ============================================================
    // When user finishes drawing a new AOI (pm:create), clear all overlays
    // This ensures the map is clean for the next clip operation
    // NOTE: We do NOT clear on draw start - user might cancel the draw
    // ============================================================
    
    // When a new shape is created (user finished drawing)
    map.on("pm:create", (e) => {
      console.log("[BaseMap] pm:create fired");
      const newLayer = e.layer;

      // Clear all previous drawn layers BEFORE adding the new one
      // Remove all existing layers from the map
      if (drawnLayersRef.current.length > 0) {
        console.log("🧹 Clearing all previous drawn AOI layers before adding new one");
        drawnLayersRef.current.forEach((layer) => {
          try {
            if (layer && map.hasLayer(layer)) {
              map.removeLayer(layer);
            }
          } catch (err) {
            // Layer might already be removed, ignore error
          }
        });
      }

      // Clear the array before adding the new layer
      drawnLayersRef.current = [];

      // Remove previous AOI layer if it exists (before storing the new one)
      if (currentAoiLayerRef.current && currentAoiLayerRef.current !== newLayer) {
        console.log("🧹 Removing previous AOI layer before storing new one");
        try {
          if (map.hasLayer(currentAoiLayerRef.current)) {
            map.removeLayer(currentAoiLayerRef.current);
          }
        } catch (err) {
          console.log("Previous AOI layer already removed");
        }
      }

      // Store the new AOI layer reference (only one at a time)
      currentAoiLayerRef.current = newLayer;
      lastDrawnLayerRef.current = newLayer;
      drawnLayersRef.current = [newLayer];

      // Attach stable ID to layer for pairing (assign once, keep forever)
      const aoiId = `drawn-${Date.now()}`;
      newLayer.__aoiId = aoiId;
      if (newLayer.options) {
        newLayer.options.__aoiId = aoiId;
      }

      // Convert to GeoJSON
      const geojson = newLayer.toGeoJSON();
      
      // Store aoiId in GeoJSON properties so it persists
      const feature = geojson.type === "FeatureCollection" ? geojson.features[0] : geojson;
      if (feature) {
        feature.properties = { ...(feature.properties || {}), __aoiId: aoiId, __aoiType: "draw" };
      }
      
      // ALWAYS ensure it's a FeatureCollection
      const featureCollection = geojson.type === "FeatureCollection" 
        ? { ...geojson, features: geojson.features.map(f => ({ ...f, properties: { ...(f.properties || {}), __aoiId: aoiId, __aoiType: "draw" } })) }
        : { type: "FeatureCollection", features: [{ ...geojson, properties: { ...(geojson.properties || {}), __aoiId: aoiId, __aoiType: "draw" } }] };

      // Save to persistent ref (survives state loss)
      if (lastDrawnAoiRef) {
        lastDrawnAoiRef.current = featureCollection;
        console.log("[MapTools] ✅ Saved drawn AOI to persistent ref:", aoiId);
      }

      // ✅ CRITICAL: Do NOT call onDrawStart here - overlays should only clear when AOI actually changes
      // The parent component (MapExplorer) will handle overlay clearing in handleUserClipChange
      // based on AOI change tracking, not on draw start events
      
      // Notify parent (updates React state and ref)
      // ALWAYS pass FeatureCollection format
      onUserClipChange(featureCollection);

      // ✅ CRITICAL: Prevent duplicate AOI layers.
      // Geoman leaves the drawn layer on the map, AND LayerGroupManager re-renders it from React state.
      // So we must remove the Geoman layer and let React manage the AOI display.
      try {
        if (map.hasLayer(newLayer)) {
          map.removeLayer(newLayer);
        }
      } catch (err) {
        console.warn("[MapTools] Could not remove Geoman layer after create:", err);
      }

      // Clear refs pointing to removed Leaflet layer (React AOI is now source of truth)
      currentAoiLayerRef.current = null;
      lastDrawnLayerRef.current = null;
      drawnLayersRef.current = [];
    });
    
    // When a drawn layer is edited/updated (user modifies existing shape)
    // This is critical for regeneration - user can keep the same drawing and re-generate
    map.on("pm:update", (e) => {
      const updatedLayer = e.layer;
      
      // Only handle if this is the drawn AOI layer (not base AOI or uploaded)
      if (updatedLayer === currentAoiLayerRef.current || updatedLayer === lastDrawnLayerRef.current) {
        console.log("🔥 PM UPDATE FIRED — DRAWN AOI EDITED");
        
        // Preserve the SAME aoiId (do not create a new one)
        const aoiId = updatedLayer.__aoiId || updatedLayer.options?.__aoiId;
        if (!aoiId) {
          console.warn("[MapTools] pm:update: Layer has no __aoiId, cannot preserve aoiId");
        }
        
        // Convert to GeoJSON
        const geojson = updatedLayer.toGeoJSON();
        
        // Store aoiId in GeoJSON properties (preserve existing aoiId)
        const feature = geojson.type === "FeatureCollection" ? geojson.features[0] : geojson;
        if (feature && aoiId) {
          feature.properties = { ...(feature.properties || {}), __aoiId: aoiId, __aoiType: "draw" };
        }
        
        // ALWAYS ensure it's a FeatureCollection
        const featureCollection = geojson.type === "FeatureCollection" 
          ? { ...geojson, features: geojson.features.map(f => ({ ...f, properties: { ...(f.properties || {}), __aoiId: aoiId || f.properties?.__aoiId, __aoiType: "draw" } })) }
          : { type: "FeatureCollection", features: [{ ...geojson, properties: { ...(geojson.properties || {}), __aoiId: aoiId || geojson.properties?.__aoiId, __aoiType: "draw" } }] };

        // Update persistent ref
        if (lastDrawnAoiRef) {
          lastDrawnAoiRef.current = featureCollection;
          console.log("[MapTools] ✅ Updated drawn AOI in persistent ref");
        }

        // Notify parent (updates React state and ref)
        // ALWAYS pass FeatureCollection format
        onUserClipChange(featureCollection);
      }
    });

    // When a layer is removed via the Geoman UI (erase tool)
    // NOTE: LayerGroupManager handles most removal logic, but we keep this for drawn layers
    map.on("pm:remove", (e) => {
      console.log("🔥 PM REMOVE FIRED — LAYER REMOVED");
      const removedLayer = e.layer;
      
      // Check if layer is locked (AOI_diss) - should never happen, but guard anyway
      if (removedLayer.options && removedLayer.options.__locked) {
        console.warn("[MapTools] Attempted to remove locked layer (AOI_diss) - blocked");
        e.preventDefault?.();
        return;
      }

      // For drawn layers, handle removal
      if (removedLayer === lastDrawnLayerRef.current || removedLayer === currentAoiLayerRef.current) {
        console.log("[MapTools] Removing drawn AOI layer - clearing persistent ref");
        
        // Get aoiId from layer before clearing refs
        const aoiId = removedLayer.__aoiId || removedLayer.options?.__aoiId;
        
        lastDrawnLayerRef.current = null;
        currentAoiLayerRef.current = null;
        if (lastDrawnAoiRef) {
          lastDrawnAoiRef.current = null; // Clear persistent GeoJSON ref
        }
        
        // CRITICAL: Call onRemoveAoi FIRST to trigger LayerGroupManager.removeAoiAndAllRasters
        // This ensures the AOI is removed from LayerGroupManager's registry
        if (aoiId && onRemoveAoi) {
          console.log("[MapTools] Calling onRemoveAoi with aoiId:", aoiId, "(triggers LayerGroupManager cleanup)");
          onRemoveAoi(aoiId);
        }
        
        // Notify parent that AOI was erased (so it can clean up rasters and state)
        if (aoiId && onAoiErased) {
          console.log("[MapTools] Calling onAoiErased with aoiId:", aoiId);
          onAoiErased(aoiId);
        }
        
        // Clear userClip state
        onUserClipChange(null);
      }
      
      // LayerGroupManager will handle uploaded AOI removal via onRemoveAoi callback
    });

    // Cleanup: Remove event listeners
    return () => {
      map.off("pm:drawstart", handleDrawStart);
      map.off("pm:globaldrawmodetoggled");
    };
  }, [map, onUserClipChange, onDrawStart, clearDrawnAoiLayers]);

  // ============================================================
  // CLEAR DRAWN AOI LAYERS ON IMPORT (Leaflet layers only, NOT React state)
  // ============================================================
  // When new AOIs are added (e.g., via import), clear old drawn Leaflet layers
  // This ensures imported AOIs don't have old drawn shapes cluttering the map
  // NOTE: This only clears Leaflet layers, NOT React state (userClip, aois array)
  // React state is managed by MapExplorer and should only be cleared on explicit user actions
  // ============================================================
  useEffect(() => {
    // If aois count increased, it means new AOIs were added (likely via import)
    // Clear old drawn Leaflet layers in this case (but NOT React state)
    if (aois.length > prevAoisCountRef.current && prevAoisCountRef.current > 0) {
      console.log("🧹 New AOIs detected (likely import) - clearing old drawn geometry");
      clearDrawnAoiLayers();
    }
    prevAoisCountRef.current = aois.length;
  }, [aois.length, clearDrawnAoiLayers]);

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
            <div class="legend-title">Mortality (%)</div>
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
// INVALIDATE ON RESIZE – fixes map disappearing when panels open/close
// ======================================================
function InvalidateOnResize({ trigger }) {
  const map = useMap();
  useEffect(() => {
    if (!map) return;
    const t = setTimeout(() => map.invalidateSize(true), 80);
    return () => clearTimeout(t);
  }, [map, trigger]);
  return null;
}

// ======================================================
// MAP STATUS BAR – Cursor coords only
// ======================================================

function formatCoords(lat, lng) {
  if (lat == null || lng == null || !Number.isFinite(lat) || !Number.isFinite(lng)) return "—";
  return `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
}

function MapStatusBarControl() {
  const map = useMap();
  const controlRef = useRef(null);
  const containerRef = useRef(null);
  const lastLatLngRef = useRef({ lat: null, lng: null });

  const updateDisplay = useCallback(() => {
    if (!containerRef.current) return;
    const { lat, lng } = lastLatLngRef.current;
    const coords = formatCoords(lat, lng);
    containerRef.current.innerHTML = `
      <span class="map-status-item">${coords}</span>
    `;
  }, [map]);

  useEffect(() => {
    if (!map) return;
    if (controlRef.current) return;

    const StatusBarControl = L.Control.extend({
      onAdd: function () {
        const container = L.DomUtil.create("div", "leaflet-control map-status-bar");
        container.style.pointerEvents = "none";
        container.style.zIndex = "1000";
        containerRef.current = container;
        updateDisplay();
        return container;
      },
      onRemove: function () {
        containerRef.current = null;
      },
    });
    const control = new StatusBarControl({ position: "bottomleft" });
    control.addTo(map);
    controlRef.current = control;
    return () => {
      if (controlRef.current && map) {
        map.removeControl(controlRef.current);
        controlRef.current = null;
        containerRef.current = null;
      }
    };
  }, [map, updateDisplay]);

  useEffect(() => {
    if (!map || !containerRef.current) return;

    const onMouseMove = (e) => {
      const lat = e?.latlng?.lat;
      const lng = e?.latlng?.lng;
      if (lat == null || lng == null || !Number.isFinite(lat) || !Number.isFinite(lng)) return;
      lastLatLngRef.current = { lat, lng };
      updateDisplay();
    };

    map.on("mousemove", onMouseMove);
    return () => {
      map.off("mousemove", onMouseMove);
    };
  }, [map, updateDisplay]);

  return null;
}

// ======================================================
// CLICK SAMPLER – real .tif value, only after clip
// ======================================================
function ClickSampler({ activeRasterId, overlayBounds, onSample }) {
  useMapEvents({
    async click(e) {
      // Guard: ensure valid latlng
      if (!e?.latlng || !Number.isFinite(e.latlng.lat) || !Number.isFinite(e.latlng.lng)) {
        return;
      }

      console.log("📍 Map clicked:", e.latlng);

      // Only respond if we actually have a clipped raster visible
      // Note: This is for click sampling, not for erase functionality
      if (!activeRasterId) {
        // Silently return - no need to log for every click when no raster is active
        return;
      }

      if (!overlayBounds) {
        // Silently return - no need to log for every click when no bounds
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
// GEOMAN STATE TRACKER – tracks when any Geoman mode is active
// ======================================================
// This hook tracks Geoman drawing/editing/removal modes to disable
// the raster hover tooltip during these interactions, preventing
// interference with map editing tools.
function useGeomanState() {
  const map = useMap();
  const [isGeomanBusy, setIsGeomanBusy] = useState(false);

  useEffect(() => {
    if (!map) return;

    // Track removal mode (eraser)
    const handleRemovalToggle = (e) => {
      setIsGeomanBusy(e.enabled);
      if (e.enabled) {
        console.log("[GeomanState] Removal mode enabled - disabling tooltip");
      } else {
        console.log("[GeomanState] Removal mode disabled - enabling tooltip");
      }
    };

    // Track draw mode (polygon/rectangle)
    const handleDrawToggle = (e) => {
      setIsGeomanBusy(e.enabled);
      if (e.enabled) {
        console.log("[GeomanState] Draw mode enabled - disabling tooltip");
      } else {
        console.log("[GeomanState] Draw mode disabled - enabling tooltip");
      }
    };

    // Track edit mode
    const handleEditToggle = (e) => {
      setIsGeomanBusy(e.enabled);
      if (e.enabled) {
        console.log("[GeomanState] Edit mode enabled - disabling tooltip");
      } else {
        console.log("[GeomanState] Edit mode disabled - enabling tooltip");
      }
    };

    // Track draw start (when user starts drawing)
    const handleDrawStart = () => {
      setIsGeomanBusy(true);
      console.log("[GeomanState] Draw started - disabling tooltip");
    };

    // Track draw end (when user finishes drawing)
    const handleDrawEnd = () => {
      // Check if any mode is still active before re-enabling
      const pm = map.pm;
      if (pm) {
        const stillActive = pm.globalRemovalModeEnabled() || 
                           pm.globalDrawModeEnabled() || 
                           pm.globalEditModeEnabled();
        setIsGeomanBusy(stillActive);
        if (!stillActive) {
          console.log("[GeomanState] Draw ended and no modes active - enabling tooltip");
        }
      } else {
        setIsGeomanBusy(false);
      }
    };

    // Track when a layer is removed (eraser action)
    const handleRemove = () => {
      // Keep tooltip disabled briefly after removal
      setIsGeomanBusy(true);
      setTimeout(() => {
        const pm = map.pm;
        if (pm) {
          const stillActive = pm.globalRemovalModeEnabled() || 
                             pm.globalDrawModeEnabled() || 
                             pm.globalEditModeEnabled();
          setIsGeomanBusy(stillActive);
        } else {
          setIsGeomanBusy(false);
        }
      }, 100);
    };

    // Listen to all Geoman events
    map.on("pm:globalremovalmodetoggled", handleRemovalToggle);
    map.on("pm:globaldrawmodetoggled", handleDrawToggle);
    map.on("pm:globaleditmodetoggled", handleEditToggle);
    map.on("pm:drawstart", handleDrawStart);
    map.on("pm:drawend", handleDrawEnd);
    map.on("pm:remove", handleRemove);

    // Check initial state
    const pm = map.pm;
    if (pm) {
      const initialActive = pm.globalRemovalModeEnabled() || 
                          pm.globalDrawModeEnabled() || 
                          pm.globalEditModeEnabled();
      setIsGeomanBusy(initialActive);
    }

    return () => {
      map.off("pm:globalremovalmodetoggled", handleRemovalToggle);
      map.off("pm:globaldrawmodetoggled", handleDrawToggle);
      map.off("pm:globaleditmodetoggled", handleEditToggle);
      map.off("pm:drawstart", handleDrawStart);
      map.off("pm:drawend", handleDrawEnd);
      map.off("pm:remove", handleRemove);
    };
  }, [map]);

  return isGeomanBusy;
}

// ======================================================
// RASTER HOVER TOOLTIP WRAPPER – provides Geoman state to tooltip
// ======================================================
function RasterHoverTooltipWrapper({ activeRasterId, createdRasters = [], activeCreatedRasterId = null }) {
  const isGeomanBusy = useGeomanState();
  
  return (
    <RasterHoverTooltip
      activeRasterId={activeRasterId}
      createdRasters={createdRasters}
      activeCreatedRasterId={activeCreatedRasterId}
      isGeomanBusy={isGeomanBusy}
    />
  );
}

// ======================================================
// RASTER HOVER TOOLTIP – shows lat/lon/value on mouse hover
// ======================================================
// Disabled during Geoman drawing/editing/removal modes to prevent
// interference with map interaction tools.
function RasterHoverTooltip({ activeRasterId, createdRasters = [], activeCreatedRasterId = null, isGeomanBusy = false }) {
  const map = useMap();
  const [tooltipInfo, setTooltipInfo] = useState(null);
  const [tooltipPosition, setTooltipPosition] = useState(null);
  const [isPinned, setIsPinned] = useState(false);
  const tooltipRef = useRef(null);
  const lastQueryRef = useRef({ lat: null, lng: null, timestamp: 0 }); // Use lng consistently
  const throttleDelay = 100; // Throttle requests to every 100ms
  const queryCacheRef = useRef(new Map()); // Cache queries by rounded lat/lng

  // Find active raster from createdRasters; default to newest (last) so we don't flash to #1
  const activeRaster = createdRasters.find(r => r.id === activeCreatedRasterId) ||
                       (createdRasters.length > 0 ? createdRasters[createdRasters.length - 1] : null);
  
  // Get overlay bounds from active raster
  const overlayBounds = activeRaster?.overlayBounds || null;
  const rasterLayerId = activeRaster?.activeRasterId || activeRasterId;

  // Helper to check if point is inside overlay bounds
  const isInsideBounds = useCallback((lat, lon) => {
    // Guard: ensure lat/lon are valid
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return false;
    }

    if (!overlayBounds) return false;
    
    // Handle both array format [[south, west], [north, east]] and object format
    let south, west, north, east;
    if (Array.isArray(overlayBounds) && overlayBounds.length === 2) {
      const [southWest, northEast] = overlayBounds;
      if (!Array.isArray(southWest) || !Array.isArray(northEast) ||
          southWest.length < 2 || northEast.length < 2) {
        return false;
      }
      south = southWest[0];
      west = southWest[1];
      north = northEast[0];
      east = northEast[1];
    } else if (overlayBounds.south !== undefined) {
      south = overlayBounds.south;
      west = overlayBounds.west;
      north = overlayBounds.north;
      east = overlayBounds.east;
    } else {
      return false;
    }

    // Guard: ensure bounds values are valid
    if (!Number.isFinite(south) || !Number.isFinite(west) || 
        !Number.isFinite(north) || !Number.isFinite(east)) {
      return false;
    }
    
    return lat >= south && lat <= north && lon >= west && lon <= east;
  }, [overlayBounds]);

  // Helper to round coordinates for caching (0.0001 degree ≈ 11 meters)
  const roundCoord = (coord) => Math.round(coord * 10000) / 10000;

  // Throttled query function
  const queryRasterValue = useCallback(async (lat, lon) => {
    if (!rasterLayerId) return null;

    // Check cache first
    const roundedLat = roundCoord(lat);
    const roundedLon = roundCoord(lon);
    const cacheKey = `${roundedLat},${roundedLon}`;
    const cached = queryCacheRef.current.get(cacheKey);
    
    if (cached && Date.now() - cached.timestamp < 5000) {
      // Use cached value if less than 5 seconds old
      return cached.value;
    }

    // Throttle: don't query if last query was too recent
    const now = Date.now();
    if (now - lastQueryRef.current.timestamp < throttleDelay) {
      return null; // Skip this query
    }

    // Check if same pixel (rounded)
    if (lastQueryRef.current.lat === roundedLat && lastQueryRef.current.lng === roundedLon) {
      return null; // Same pixel, skip
    }

    lastQueryRef.current = { lat: roundedLat, lng: roundedLon, timestamp: now };

    try {
      const result = await getRasterValueAt({
        rasterLayerId,
        lat,
        lon,
      });

      // Cache the result
      queryCacheRef.current.set(cacheKey, {
        value: result,
        timestamp: now,
      });

      // Limit cache size (keep last 100 entries)
      if (queryCacheRef.current.size > 100) {
        const firstKey = queryCacheRef.current.keys().next().value;
        queryCacheRef.current.delete(firstKey);
      }

      return result;
    } catch (err) {
      console.error("[RasterHoverTooltip] Failed to get raster value:", err);
      return null;
    }
  }, [rasterLayerId]);

  // Hide tooltip immediately when Geoman becomes active
  useEffect(() => {
    if (isGeomanBusy) {
      setTooltipInfo(null);
      setTooltipPosition(null);
      setIsPinned(false);
      // Close tooltip if it exists
      if (tooltipRef.current && map && map.hasLayer && map.hasLayer(tooltipRef.current)) {
        try {
          map.closePopup(tooltipRef.current);
        } catch (err) {
          // Ignore errors when closing
        }
      }
    }
  }, [isGeomanBusy, map]);

  // Mouse move handler
  useEffect(() => {
    // Hard guard: only run if we have all required data
    if (!map || !rasterLayerId || !overlayBounds) {
      setTooltipInfo(null);
      setTooltipPosition(null);
      // Close tooltip if it exists
      if (tooltipRef.current && map && map.hasLayer && map.hasLayer(tooltipRef.current)) {
        try {
          map.closePopup(tooltipRef.current);
        } catch (err) {
          // Ignore errors when closing
        }
      }
      return;
    }

    // CRITICAL: Disable tooltip when Geoman is active
    // This prevents interference with drawing/editing/removal tools
    if (isGeomanBusy) {
      return;
    }

    const handleMouseMove = async (e) => {
      if (isPinned) return; // Don't update if pinned
      
      // Early return if Geoman becomes active during handler
      if (isGeomanBusy) {
        setTooltipInfo(null);
        setTooltipPosition(null);
        return;
      }

      // Guard: ensure e.latlng exists and has valid lat/lng
      if (!e?.latlng || !Number.isFinite(e.latlng.lat) || !Number.isFinite(e.latlng.lng)) {
        setTooltipInfo(null);
        setTooltipPosition(null);
        return;
      }

      const lat = e.latlng.lat;
      const lng = e.latlng.lng; // Leaflet uses 'lng', not 'lon'

      // Check if mouse is inside overlay bounds
      if (!isInsideBounds(lat, lng)) {
        setTooltipInfo(null);
        setTooltipPosition(null);
        return;
      }

      // Update tooltip position (use lng consistently)
      setTooltipPosition({ lat, lng });

      // Query raster value (throttled)
      const result = await queryRasterValue(lat, lng);
      
      if (result) {
        if (result.nodata || result.value === null || result.value === undefined) {
          setTooltipInfo(null); // Hide tooltip for nodata
        } else {
          setTooltipInfo({
            lat,
            lng, // Use lng consistently
            value: result.value,
          });
        }
      }
    };

    const handleClick = (e) => {
      // CRITICAL: Disable tooltip clicks when Geoman is active
      if (isGeomanBusy) {
        return;
      }

      // Guard: ensure e.latlng exists and has valid lat/lng
      if (!e?.latlng || !Number.isFinite(e.latlng.lat) || !Number.isFinite(e.latlng.lng)) {
        return;
      }

      const lat = e.latlng.lat;
      const lng = e.latlng.lng; // Leaflet uses 'lng', not 'lon'

      // Toggle pin on click
      if (isPinned) {
        setIsPinned(false);
        setTooltipInfo(null);
        setTooltipPosition(null);
      } else {
        if (isInsideBounds(lat, lng)) {
          setIsPinned(true);
          setTooltipPosition({ lat, lng });
          // Query value for pinned location
          queryRasterValue(lat, lng).then(result => {
            if (result && !result.nodata && result.value !== null && result.value !== undefined) {
              setTooltipInfo({
                lat,
                lng, // Use lng consistently
                value: result.value,
              });
            }
          });
        }
      }
    };

    map.on("mousemove", handleMouseMove);
    map.on("click", handleClick);

    return () => {
      map.off("mousemove", handleMouseMove);
      map.off("click", handleClick);
    };
  }, [map, rasterLayerId, overlayBounds, isInsideBounds, queryRasterValue, isPinned, isGeomanBusy]);

  // Create tooltip popup
  useEffect(() => {
    if (!map) return;

    // CRITICAL: Never render tooltip when Geoman is active
    // This ensures tooltip doesn't interfere with drawing/editing/removal tools
    if (isGeomanBusy) {
      // Close tooltip if it exists
      if (tooltipRef.current && map.hasLayer && map.hasLayer(tooltipRef.current)) {
        try {
          map.closePopup(tooltipRef.current);
        } catch (err) {
          // Ignore errors when closing
        }
      }
      return;
    }

    // Guard: only create/update tooltip if we have valid data
    if (tooltipInfo && tooltipPosition && 
        Number.isFinite(tooltipPosition.lat) && Number.isFinite(tooltipPosition.lng) &&
        Number.isFinite(tooltipInfo.lat) && Number.isFinite(tooltipInfo.lng) &&
        Number.isFinite(tooltipInfo.value)) {
      
      // Create or update tooltip
      if (!tooltipRef.current) {
        tooltipRef.current = L.popup({
          closeButton: false,
          className: "raster-hover-tooltip",
          offset: [10, 10],
          autoPan: false,
        });
      }

      const content = `
        <div class="raster-tooltip-content">
          <div class="raster-tooltip-title">Location Info</div>
          <div class="raster-tooltip-line"><strong>Lat:</strong> ${tooltipInfo.lat.toFixed(4)}</div>
          <div class="raster-tooltip-line"><strong>Lon:</strong> ${tooltipInfo.lng.toFixed(4)}</div>
          <div class="raster-tooltip-line"><strong>Value:</strong> ${tooltipInfo.value.toFixed(2)}%</div>
        </div>
      `;

      try {
        // Use lng (not lon) - Leaflet uses lng
        tooltipRef.current
          .setLatLng([tooltipPosition.lat, tooltipPosition.lng])
          .setContent(content)
          .openOn(map);
      } catch (err) {
        console.error("[RasterHoverTooltip] Failed to set tooltip position:", err);
        // Don't crash - just hide tooltip
        setTooltipInfo(null);
        setTooltipPosition(null);
      }
    } else {
      // Close tooltip if data is invalid
      if (tooltipRef.current && map.hasLayer && map.hasLayer(tooltipRef.current)) {
        try {
          map.closePopup(tooltipRef.current);
        } catch (err) {
          // Ignore errors when closing
        }
      }
    }

    return () => {
      if (tooltipRef.current && map && map.hasLayer && map.hasLayer(tooltipRef.current)) {
        try {
          map.closePopup(tooltipRef.current);
        } catch (err) {
          // Ignore errors in cleanup
        }
      }
    };
  }, [map, tooltipInfo, tooltipPosition, isGeomanBusy]);

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
  createdRasters = [], // Array of created rasters to display simultaneously
  onUserClipChange,
  onRemoveAoi = null, // Optional callback to remove AOI by ID
  onRemoveRaster = null, // Optional callback to remove raster overlay by ID
  onRemoveRasterByAoiId = null, // Optional callback to remove raster overlay by AOI ID
  onClearAll = null, // Optional callback when Clear All is called: () => void
  onDrawStart = null, // Callback when new AOI is created (to clear overlays)
  onClearDrawnAoi = null, // Optional callback when drawn AOI geometry should be cleared
  activeRasterId,
  activeCreatedRasterId = null, // ID of the active created raster (for hover tooltip)
  datasetPreview = null, // GeoPDF dataset preview: { id, preview_url, preview_bounds }
  onMapReady,
  onLastDrawnAoiRefReady = null, // Callback to expose lastDrawnAoiRef to parent
  onAoiErased = null, // Callback when AOI is erased: (aoiId) => void
})
 {
  const [inspectInfo, setInspectInfo] = useState(null);
  
  // ============================================================
  // PERSISTENT AOI GEOJSON REF (survives re-renders and state loss)
  // ============================================================
  // This ref stores the GeoJSON of the last drawn AOI, even if React state is cleared
  // It's used as a fallback source of truth when userClip state is empty
  // ============================================================
  const lastDrawnAoiRef = useRef(null); // Stores GeoJSON: { type: "FeatureCollection", features: [...] }
  
  // Expose ref to parent (MapExplorer) so it can use it as fallback
  useEffect(() => {
    if (onLastDrawnAoiRefReady) {
      onLastDrawnAoiRefReady(lastDrawnAoiRef);
    }
  }, [onLastDrawnAoiRefReady]);

  // ============================================================
  // INSTRUMENTATION: Log MapContainer render (check for remounts)
  // ============================================================
  console.log("[BaseMap] 🔍 MapContainer rendering - createdRasters:", createdRasters?.length || 0, "overlayUrl:", !!overlayUrl);

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
        {/* Apply initial zoomed-out West Coast view once on mount */}
        <InitialBoundsSetter />
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

        {/* Layer Group Manager - Handles all layer groups (AOI_diss, uploaded, drawn, overlays) */}
        {/* This component manages separate layer groups to ensure proper isolation and prevent accidental removal */}
        <LayerGroupManager
          globalAoi={globalAoi}
          uploadedAois={uploadedAois.filter((aoi) => aoi.type === "upload")}
          drawnAoi={aois.find((aoi) => aoi.type === "draw") || null}
          createdRasters={createdRasters}
          onRemoveAoi={onRemoveAoi}
          onRemoveRaster={onRemoveRaster}
          onRemoveRasterByAoiId={onRemoveRasterByAoiId}
          onClearAll={onClearAll}
        />

        {/* Legacy: Single overlay support (for backward compatibility) */}
        {/* Only show if no created rasters and no AOI overlays */}
        {overlayUrl && overlayBounds && 
         (!createdRasters || createdRasters.length === 0) &&
         (aois.length === 0 || !aois.some(aoi => aoi.overlayUrl && aoi.overlayBounds)) && (
            <RasterOverlay
              overlayUrl={overlayUrl}
              bounds={overlayBounds}
            />
          )
        }

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
          onDrawStart={onDrawStart}
          onClearDrawnAoi={onClearDrawnAoi}
        />
        <LegendControl />

        {/* Raster quality control - persistent Leaflet control */}
        <RasterQualityControl 
          overlayUrl={overlayUrl}
          overlayBounds={overlayBounds}
        />

        {/* Map status bar: coords only */}
        <MapStatusBarControl />

        {/* Map ref handler */}
        <MapRefHandler onMapReady={onMapReady} />

        {/* Click sampler for real .tif value */}
        <ClickSampler
          activeRasterId={activeRasterId}
          overlayBounds={overlayBounds}
          onSample={setInspectInfo}
        />

        {/* Hover tooltip for raster overlay - disabled during Geoman interactions */}
        <RasterHoverTooltipWrapper
          activeRasterId={activeRasterId}
          createdRasters={createdRasters}
          activeCreatedRasterId={activeCreatedRasterId || (createdRasters.length > 0 ? createdRasters[createdRasters.length - 1].id : null)}
        />

        {/* Fix map disappearing when panels open/close */}
        <InvalidateOnResize trigger={createdRasters.length} />

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

