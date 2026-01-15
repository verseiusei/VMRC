// src/components/map/LayerGroupManager.jsx
// Manages separate layer groups for AOI_diss, uploaded AOIs, drawn AOIs, and raster overlays
// Uses app-level stable IDs (aoi.id) for reliable pairing between AOIs and raster overlays
// Ensures AOI_diss is never removed/edited and eraser deletes pairs correctly

import { useEffect, useRef, useCallback } from "react";
import { useMap } from "react-leaflet";
import L from "leaflet";

/**
 * Safe stringify that won't crash on Leaflet objects
 */
function safeStringify(x) {
  try {
    return JSON.stringify(x);
  } catch (err) {
    console.warn("[LayerGroupManager] safeStringify failed, using fallback:", err);
    return String(x?.id || x?.type || "unstringifiable");
  }
}

/**
 * Compute stable hash for AOI (only JSON-safe fields)
 */
function stableHashAoi(aoi) {
  if (!aoi) return null;
  try {
    return safeStringify({
      id: aoi.id,
      type: aoi.type,
      geojson: aoi.geojson, // must already be real GeoJSON
    });
  } catch (err) {
    console.warn("[LayerGroupManager] Error computing AOI hash:", err);
    return null;
  }
}

/**
 * Compute stable hash for raster (only JSON-safe fields)
 */
function stableHashRaster(raster) {
  if (!raster) return null;
  try {
    return safeStringify({
      id: raster.id,
      aoiId: raster.aoiId,
      overlayUrl: raster.overlayUrl,
      overlayBounds: raster.overlayBounds,
      rasterLayerId: raster.activeRasterId,
    });
  } catch (err) {
    console.warn("[LayerGroupManager] Error computing raster hash:", err);
    return null;
  }
}

/**
 * Compute stable hash for GeoJSON (generic - use specific functions above)
 * @deprecated Use stableHashAoi or stableHashRaster instead
 */
function stableHash(obj) {
  // If it's an AOI object, use AOI-specific hash
  if (obj && (obj.type === "draw" || obj.type === "upload")) {
    return stableHashAoi(obj);
  }
  // If it's a raster object, use raster-specific hash
  if (obj && obj.overlayUrl !== undefined) {
    return stableHashRaster(obj);
  }
  // Fallback: try to stringify, but use safe stringify
  return safeStringify(obj);
}

/**
 * Compute stable geometry hash for GeoJSON (legacy - kept for compatibility)
 * Creates a stable string representation of the geometry that can be used
 * to detect actual geometry changes vs reference changes
 * Supports FeatureCollection, Feature, and Geometry types
 */
function computeGeometryHash(geojson) {
  if (!geojson) return null;
  try {
    // Extract coordinates from GeoJSON and create stable string
    // Handle FeatureCollection, Feature, and Geometry formats
    let features = [];
    if (geojson.type === "FeatureCollection") {
      features = geojson.features || [];
    } else if (geojson.type === "Feature") {
      features = [geojson];
    } else if (geojson.type && geojson.coordinates) {
      // Direct Geometry object
      features = [{ geometry: geojson }];
    }
    
    if (features.length === 0) return null;
    
    // Extract coordinates from first feature and normalize
    const coords = features[0]?.geometry?.coordinates;
    if (!coords) return null;
    
    // Create stable hash by stringifying coordinates with fixed precision
    // Round to 6 decimal places (about 10cm precision) to handle floating point variations
    const normalizeCoords = (coords) => {
      if (Array.isArray(coords[0])) {
        return coords.map(normalizeCoords);
      }
      return coords.map(c => typeof c === 'number' ? Number(c.toFixed(6)) : c);
    };
    
    const normalized = normalizeCoords(coords);
    return JSON.stringify(normalized);
  } catch (err) {
    console.warn("[LayerGroupManager] Error computing geometry hash:", err);
    return null;
  }
}

/**
 * LayerGroupManager - Manages all layer groups and ensures proper isolation
 * 
 * Panes (z-index order, bottom to top):
 * - rasterPane: zIndex 200 (raster overlays, non-interactive)
 * - baseAoiPane: zIndex 350 (AOI_diss, pointerEvents: none, non-interactive)
 * - userAoiPane: zIndex 450 (uploaded/drawn AOIs, interactive)
 * 
 * Layer Groups:
 * - uploadedAoiLayerGroup: Uploaded AOIs (in userAoiPane)
 * - drawnAoiLayerGroup: User-drawn AOIs (in userAoiPane)
 * - overlayLayerGroup: Raster overlays (in rasterPane)
 * - Base AOI (AOI_diss) is added DIRECTLY to map (NOT in a layer group)
 * 
 * Pair Registry (using app-level stable IDs):
 * - pairsRef: Maps aoiId (app-level stable ID) -> { aoiLayer, overlayLayer, createdRasterId }
 * - Uses aoi.id as the key for reliable pairing (not Leaflet internal IDs which can change)
 * 
 * Pairing System:
 * - When an AOI layer is created, it's marked with layer.__aoiId = aoi.id
 * - When a raster overlay is created, it finds the AOI layer by aoiId and registers the pair
 * - When an AOI is erased (pm:remove), deletePairByAoiId() removes both AOI and overlay (full delete, user intent)
 * - When regenerating overlays, removeOverlayForAoiId() removes only overlay, keeps AOI (system delete, no state clear)
 * - Base AOI (__locked=true) is always protected from deletion
 */
export default function LayerGroupManager({
  globalAoi, // AOI_diss - permanent base AOI
  uploadedAois = [], // Array of uploaded AOIs: [{id, name, geojson, type}]
  drawnAoi, // Single drawn AOI: {id, geojson, type} or null
  createdRasters = [], // Array of created rasters: [{id, overlayUrl, overlayBounds, aoiId, aoiType}]
  onRemoveAoi, // Callback when AOI is removed: (aoiId) => void
  onRemoveRaster, // Callback when raster overlay is removed: (rasterId) => void
  onRemoveRasterByAoiId, // Callback when raster overlay is removed by AOI ID: (aoiId) => void
}) {
  const map = useMap();

  // Layer group refs - created once and never destroyed
  const uploadedAoiLayerGroupRef = useRef(null);
  const drawnAoiLayerGroupRef = useRef(null);
  const overlayLayerGroupRef = useRef(null);

  // Track individual layers by app-level ID (for lookup)
  const uploadedLayersRef = useRef(new Map()); // aoiId -> L.GeoJSON layer
  const drawnLayerRef = useRef(null); // Single drawn layer
  const baseAoiLayerRef = useRef(null); // AOI_diss layer (added directly to map, NOT in group)
  
  // ============================================================
  // SPLIT REGISTRIES: AOI vs Raster Overlay
  // ============================================================
  // aoiLayersById: Maps aoiId -> { layer, hash }
  // Tracks AOI layers independently of raster overlays
  const aoiLayersById = useRef(new Map()); // key: aoiId, value: { layer, hash }
  
  // rasterOverlaysByRasterId: Maps rasterId -> { layer, bounds, aoiId }
  // Tracks raster overlay layers independently of AOIs
  const rasterOverlaysByRasterId = useRef(new Map()); // key: rasterId, value: { layer, bounds, aoiId }
  
  // pairByAoiId: Maps aoiId -> rasterId (optional mapping for lookup)
  const pairByAoiId = useRef(new Map()); // key: aoiId, value: rasterId
  
  // Legacy refs (kept for backward compatibility during transition)
  const aoiLayersRef = useRef(new Map()); // Unified registry (deprecated, use aoiLayersById)
  const pairsRef = useRef(new Map()); // Pair registry (deprecated, use split registries)
  
  // Track previous drawnAoi to detect real changes vs temporary nulls (e.g., export UI re-renders)
  // This prevents accidental deletion when drawnAoi is temporarily null during re-renders
  const prevDrawnAoiRef = useRef(null);
  
  // Track geometry hashes per AOI ID to detect actual geometry changes vs reference changes
  // Key: aoiId, Value: stable geometry hash string
  const geometryHashesRef = useRef(new Map()); // aoiId -> geometryHash
  
  // ============================================================
  // PENDING OVERLAYS (non-destructive registration)
  // ============================================================
  // pendingOverlaysRef: Maps aoiId -> { overlayLayer, rasterId }
  // Stores overlays that tried to register before their AOI layer was registered
  // These will be attached when the AOI layer registers
  const pendingOverlaysRef = useRef(new Map()); // key: aoiId, value: { overlayLayer, rasterId }
  
  const removalModeRef = useRef(false); // Track if Geoman removal mode is active

  // ============================================================
  // HELPER: TAG AOI LAYER (SAFE - prevents setting properties on strings)
  // ============================================================
  // Safely tags a Leaflet layer with AOI ID
  // Guards against accidentally tagging strings or non-objects
  // ============================================================
  const tagAoiLayer = useCallback((layer, aoiId) => {
    if (!layer || typeof layer !== "object") {
      console.warn("[LayerGroupManager] tagAoiLayer skipped: not a Leaflet layer", { layer, aoiId, layerType: typeof layer });
      return;
    }
    layer.__aoiId = aoiId;
    layer.options = layer.options || {};
    layer.options.__aoiId = aoiId;
  }, []);

  // ============================================================
  // HELPER: TAG RASTER OVERLAY (SAFE - prevents setting properties on strings)
  // ============================================================
  // Safely tags a Leaflet overlay layer with raster ID
  // Guards against accidentally tagging strings or non-objects
  // ============================================================
  const tagRasterOverlay = useCallback((layer, rasterId) => {
    if (!layer || typeof layer !== "object") {
      console.warn("[LayerGroupManager] tagRasterOverlay skipped: not a Leaflet layer", { layer, rasterId, layerType: typeof layer });
      return;
    }
    layer.__rasterId = rasterId;
    layer.options = layer.options || {};
    layer.options.__rasterId = rasterId;
  }, []);

  // ============================================================
  // CLEAR PM TEMP LAYERS (PREVIEW/HINT LAYERS)
  // ============================================================
  // Removes Leaflet-Geoman temporary drawing layers (preview/hint layers)
  // that appear during drawing but should be cleaned up after drawing finishes
  // Only removes temp layers, never removes base AOI or registered user AOIs
  // ============================================================
  const clearPmTempLayers = useCallback(() => {
    if (!map) return;

    // Helper: Check if a layer is a registered USER AOI layer (NOT base AOI)
    const isRegisteredUserLayer = (layer) => {
      // NEVER include base AOI in user layers
      if (layer === baseAoiLayerRef.current || layer.__locked || layer.options?.__locked) {
        return false; // Base AOI is NOT a user layer
      }

      // Check if layer is in uploaded AOI group
      if (uploadedAoiLayerGroupRef.current?.hasLayer(layer)) {
        return true;
      }

      // Check if layer is in drawn AOI group
      if (drawnAoiLayerGroupRef.current?.hasLayer(layer)) {
        return true;
      }

      // Check if layer is tracked in uploadedLayersRef
      for (const [id, trackedLayer] of uploadedLayersRef.current.entries()) {
        if (trackedLayer === layer) {
          return true;
        }
        // Also check child layers
        if (trackedLayer.eachLayer) {
          trackedLayer.eachLayer((child) => {
            if (child === layer) return true;
          });
        }
      }

      // Check if layer is the drawn layer
      if (drawnLayerRef.current === layer) {
        return true;
      }

      // Check if layer has __aoiId (is a registered user AOI)
      if (layer.__aoiId || layer.options?.__aoiId) {
        return true;
      }

      return false;
    };

    const layersToRemove = [];

    // Iterate through all layers on the map
    map.eachLayer((layer) => {
      // Skip layers that are NOT GeoJSON/vector layers (e.g., tile layers, image overlays)
      if (!layer.options || !(layer instanceof L.GeoJSON || layer instanceof L.Polygon || layer instanceof L.Rectangle || layer instanceof L.Path)) {
        return;
      }

      // NEVER remove base AOI (locked)
      if (layer.__locked || layer.options?.__locked || layer === baseAoiLayerRef.current) {
        return;
      }

      // NEVER remove registered user AOI layers
      if (isRegisteredUserLayer(layer)) {
        return;
      }

      // Check if layer is a temp/hint layer
      const isPmTemp = layer.options?.pmTempLayer || layer.options?._pmTempLayer || layer._pmTempLayer;
      
      // Check if layer has hint-style dashed line (Geoman preview style)
      const isHint = !!layer.options?.dashArray && String(layer.options.dashArray).length > 0;

      // Remove if it's a temp layer OR has hint style (preview outline)
      if (isPmTemp || (isHint && !isRegisteredUserLayer(layer))) {
        layersToRemove.push(layer);
      }
    });

    // Remove all identified temp layers
    for (const layer of layersToRemove) {
      try {
        console.log("[LayerGroupManager] clearPmTempLayers: Removing Geoman temp/hint layer:", layer);
        map.removeLayer(layer);
      } catch (err) {
        console.warn("[LayerGroupManager] clearPmTempLayers: Error removing temp layer:", err);
      }
    }

    if (layersToRemove.length > 0) {
      console.log(`[LayerGroupManager] clearPmTempLayers: Cleared ${layersToRemove.length} Geoman temp/hint layer(s)`);
    }
  }, [map]);

  // ============================================================
  // HELPER: REGISTER AOI LAYER (IDEMPOTENT)
  // ============================================================
  // Registers an AOI layer, ensuring no duplicates
  // Computes hash and checks if layer already exists before creating
  // Returns the layer (existing or newly created)
  // ============================================================
  const registerAoiLayer = useCallback((aoiId, geojson, style, type, layerGroup) => {
    if (!aoiId || !geojson) {
      console.warn("[LayerGroupManager] registerAoiLayer: Missing aoiId or geojson");
      return null;
    }

    // Compute stable hash (only on GeoJSON, never on Leaflet objects)
    // geojson should already be a plain GeoJSON object, not a Leaflet layer
    const hash = safeStringify(geojson);
    
    // Check if AOI already exists
    const existing = aoiLayersById.current.get(aoiId);
    if (existing) {
      // Same hash = same geometry, return existing layer
      if (existing.hash === hash) {
        console.log(`[LayerGroupManager] ✅ AOI ${aoiId} already registered (same hash) - returning existing layer`);
        console.log("[AOI] registry size", aoiLayersById.current.size);
        return existing.layer;
      }
      // Different hash = geometry changed, remove old layer
      console.log(`[LayerGroupManager] AOI ${aoiId} hash changed - removing old layer`);
      if (existing.layer && map) {
        try {
          if (layerGroup && layerGroup.hasLayer(existing.layer)) {
            layerGroup.removeLayer(existing.layer);
          } else if (map.hasLayer && map.hasLayer(existing.layer)) {
            map.removeLayer(existing.layer);
          }
        } catch (err) {
          console.warn("[LayerGroupManager] Error removing old AOI layer:", err);
        }
      }
      aoiLayersById.current.delete(aoiId);
    }

    // Create new layer (only if hash differs or doesn't exist)
    const layer = L.geoJSON(geojson, style);
    
    // Store app-level aoiId on layer (safe tagging)
    tagAoiLayer(layer, aoiId);
    layer.__locked = false; // User AOIs are not locked

    // Add to split registry
    aoiLayersById.current.set(aoiId, { layer, hash });
    
    // Also add to legacy registry (for backward compatibility)
    aoiLayersRef.current.set(aoiId, layer);

    // Add to type-specific registry
    if (type === "upload") {
      uploadedLayersRef.current.set(aoiId, layer);
    } else if (type === "draw") {
      drawnLayerRef.current = layer;
    }

    console.log(`[LayerGroupManager] ✅ Registered AOI layer: aoiId=${aoiId}, type=${type}`);
    console.log("[AOI] registry size", aoiLayersById.current.size);
    
    // Check if there's a pending overlay for this AOI and attach it
    const pendingOverlay = pendingOverlaysRef.current.get(aoiId);
    if (pendingOverlay) {
      console.log(`[LayerGroupManager] Attaching pending overlay for aoiId=${aoiId}`);
      pendingOverlaysRef.current.delete(aoiId);
      
      // ✅ CRITICAL: Tag overlay with safe functions
      tagRasterOverlay(pendingOverlay.overlayLayer, pendingOverlay.rasterId);
      tagAoiLayer(pendingOverlay.overlayLayer, aoiId);
      pendingOverlay.overlayLayer.__createdRasterId = pendingOverlay.rasterId; // Keep for backward compatibility
      
      // Register in split registry
      rasterOverlaysByRasterId.current.set(pendingOverlay.rasterId, {
        layer: pendingOverlay.overlayLayer,
        bounds: pendingOverlay.overlayLayer.__bounds,
        aoiId: aoiId,
      });
      pairByAoiId.current.set(aoiId, pendingOverlay.rasterId);
      
      // Also register in legacy pair registry (for backward compatibility)
      pairsRef.current.set(aoiId, {
        aoiLayer: layer,
        overlayLayer: pendingOverlay.overlayLayer,
        createdRasterId: pendingOverlay.rasterId,
      });
      
      console.log(`[PAIR] attached pending overlay: aoiId=${aoiId}, rasterId=${pendingOverlay.rasterId}`);
    }
    
    return layer;
  }, [map]);

  // ============================================================
  // HELPER: SET RASTER OVERLAY FOR AOI (REPLACE OVERLAY FOR SAME AOI)
  // ============================================================
  // Sets a raster overlay for an AOI, replacing any existing overlay
  // Does NOT remove the AOI layer
  // ============================================================
  const setRasterOverlayForAoi = useCallback((aoiId, rasterId, overlayLayer, bounds) => {
    if (!aoiId || !rasterId || !overlayLayer) {
      console.warn("[LayerGroupManager] setRasterOverlayForAoi: Missing aoiId, rasterId, or overlayLayer");
      return;
    }

    // Check if AOI exists (with retry for race condition)
    if (!aoiLayersById.current.has(aoiId) && !aoiLayersRef.current.has(aoiId)) {
      console.warn(`[LayerGroupManager] setRasterOverlayForAoi: AOI layer not found for aoiId=${aoiId} - storing as pending`);
      // Retry once after a tick (fix race condition)
      setTimeout(() => {
        if (aoiLayersById.current.has(aoiId) || aoiLayersRef.current.has(aoiId)) {
          setRasterOverlayForAoi(aoiId, rasterId, overlayLayer, bounds);
        } else {
          // Store as pending
          pendingOverlaysRef.current.set(aoiId, { overlayLayer, rasterId });
        }
      }, 0);
      return;
    }

    // If AOI already has an overlay, remove ONLY the overlay layer
    const existingRasterId = pairByAoiId.current.get(aoiId);
    if (existingRasterId) {
      const existingOverlay = rasterOverlaysByRasterId.current.get(existingRasterId);
      if (existingOverlay && existingOverlay.layer) {
        console.log(`[LayerGroupManager] Replacing overlay for AOI ${aoiId} (old raster: ${existingRasterId}, new raster: ${rasterId})`);
        try {
          if (overlayLayerGroupRef.current?.hasLayer(existingOverlay.layer)) {
            overlayLayerGroupRef.current.removeLayer(existingOverlay.layer);
          }
          if (map.hasLayer && map.hasLayer(existingOverlay.layer)) {
            map.removeLayer(existingOverlay.layer);
          }
        } catch (err) {
          console.warn("[LayerGroupManager] Error removing old overlay:", err);
        }
        rasterOverlaysByRasterId.current.delete(existingRasterId);
      }
    }

    // ✅ CRITICAL: Tag raster overlay with rasterId using safe function
    // Raster overlays use __rasterId, AOI layers use __aoiId (separate keyspaces)
    tagRasterOverlay(overlayLayer, rasterId);
    // Also store aoiId for pairing lookup (but use safe tagging)
    tagAoiLayer(overlayLayer, aoiId);
    overlayLayer.__createdRasterId = rasterId; // Keep for backward compatibility
    overlayLayer.__bounds = bounds;

    // Register in split registry
    rasterOverlaysByRasterId.current.set(rasterId, {
      layer: overlayLayer,
      bounds: bounds,
      aoiId: aoiId,
    });
    pairByAoiId.current.set(aoiId, rasterId);

    // Also register in legacy pair registry (for backward compatibility)
    const aoiLayer = aoiLayersById.current.get(aoiId)?.layer || aoiLayersRef.current.get(aoiId);
    if (aoiLayer) {
      pairsRef.current.set(aoiId, {
        aoiLayer,
        overlayLayer,
        createdRasterId: rasterId,
      });
    }

    console.log(`[LayerGroupManager] ✅ Set raster overlay for AOI: aoiId=${aoiId}, rasterId=${rasterId}`);
    console.log("[Overlay] overlays size", rasterOverlaysByRasterId.current.size, "pairs", pairByAoiId.current.size);
  }, [map]);

  // Legacy function name for backward compatibility
  const registerOverlay = setRasterOverlayForAoi;

  // ============================================================
  // REMOVE OVERLAY ONLY (SYSTEM DELETE - for regeneration)
  // ============================================================
  // This function removes ONLY the raster overlay layer and pair mapping
  // It does NOT remove the AOI layer, does NOT call onRemoveAoi, does NOT clear userClip
  // Used when regenerating overlays with new filters (same AOI, new raster)
  // ============================================================
  const removeOverlayForAoiId = useCallback((aoiId) => {
    if (!aoiId) {
      console.warn("[LayerGroupManager] removeOverlayForAoiId: No aoiId provided");
      return;
    }

    // Find the pair using app-level aoiId
    const pair = pairsRef.current.get(aoiId);
    if (!pair) {
      console.log(`[LayerGroupManager] removeOverlayForAoiId: No pair found for aoiId: ${aoiId}`);
      return;
    }

    const { overlayLayer, createdRasterId } = pair;

    console.log(`[LayerGroupManager] removeOverlayForAoiId: Removing overlay only (Raster: ${createdRasterId}, AOI: ${aoiId}) - AOI layer preserved`);

    // Remove overlay from map
    if (overlayLayer) {
      try {
        if (overlayLayerGroupRef.current?.hasLayer(overlayLayer)) {
          overlayLayerGroupRef.current.removeLayer(overlayLayer);
        }
        if (map.hasLayer && map.hasLayer(overlayLayer)) {
          map.removeLayer(overlayLayer);
        }
        console.log(`[LayerGroupManager] removeOverlayForAoiId: Removed overlay layer from map`);
      } catch (err) {
        console.warn(`[LayerGroupManager] Error removing overlay:`, err);
      }
    }

    // Cleanup pair registry (but keep AOI layer tracking refs)
    pairsRef.current.delete(aoiId);

    // Remove raster from React state (createdRasters array)
    // This prevents the old overlay from reappearing
    if (onRemoveRasterByAoiId && aoiId) {
      console.log(`[LayerGroupManager] removeOverlayForAoiId: Calling onRemoveRasterByAoiId(${aoiId}) to remove raster from React state`);
      onRemoveRasterByAoiId(aoiId);
    } else if (onRemoveRaster && createdRasterId) {
      console.log(`[LayerGroupManager] removeOverlayForAoiId: Calling onRemoveRaster(${createdRasterId}) to remove raster from React state`);
      onRemoveRaster(createdRasterId);
    }

    // IMPORTANT: We do NOT call onRemoveAoi here
    // We do NOT remove AOI layer from map
    // We do NOT clear AOI tracking refs
    // This allows regeneration with the same AOI

    console.log(`[LayerGroupManager] removeOverlayForAoiId: ✅ Completed overlay removal (Raster: ${createdRasterId}, AOI: ${aoiId}) - AOI layer preserved`);
    return true; // Return success indicator
  }, [map, onRemoveRaster, onRemoveRasterByAoiId]);

  // ============================================================
  // DELETE PAIR (USER INTENT - full delete)
  // ============================================================
  // This function deletes BOTH the AOI layer and its paired raster overlay
  // It uses app-level stable IDs (aoi.id) for reliable pairing
  // Used when user explicitly deletes AOI (eraser tool, remove action)
  // Calls onRemoveAoi to clear AOI state (userClip, aois array, etc.)
  // ============================================================
  const deletePairByAoiId = useCallback((aoiId) => {
    if (!aoiId) {
      console.warn("[LayerGroupManager] deletePairByAoiId: No aoiId provided");
      return;
    }

    // Find the pair using app-level aoiId
    const pair = pairsRef.current.get(aoiId);
    if (!pair) {
      console.warn(`[LayerGroupManager] deletePairByAoiId: No pair found for aoiId: ${aoiId}`);
      console.warn(`[LayerGroupManager] Available keys in pairsRef:`, Array.from(pairsRef.current.keys()));
      return;
    }

    const { aoiLayer, overlayLayer, createdRasterId } = pair;

    console.log(`[LayerGroupManager] deletePairByAoiId: Deleting pair (Raster: ${createdRasterId}, AOI: ${aoiId}) - FULL DELETE`);

    // NEVER delete base AOI - check for locked flag
    if (aoiLayer?.__locked || aoiLayer?.options?.__locked || aoiLayer === baseAoiLayerRef.current) {
      console.log("[LayerGroupManager] deletePairByAoiId: Blocked deletion of locked AOI (base AOI)");
      return;
    }

    // Remove overlay from map
    if (overlayLayer) {
      try {
        if (overlayLayerGroupRef.current?.hasLayer(overlayLayer)) {
          overlayLayerGroupRef.current.removeLayer(overlayLayer);
        }
        if (map.hasLayer && map.hasLayer(overlayLayer)) {
          map.removeLayer(overlayLayer);
        }
        console.log(`[LayerGroupManager] deletePairByAoiId: Removed overlay layer from map`);
      } catch (err) {
        console.warn(`[LayerGroupManager] Error removing overlay:`, err);
      }
    }

    // Remove AOI from map
    if (aoiLayer && map.hasLayer && map.hasLayer(aoiLayer)) {
      try {
        // Remove from appropriate layer group
        if (uploadedAoiLayerGroupRef.current?.hasLayer(aoiLayer)) {
          uploadedAoiLayerGroupRef.current.removeLayer(aoiLayer);
        } else if (drawnAoiLayerGroupRef.current?.hasLayer(aoiLayer)) {
          drawnAoiLayerGroupRef.current.removeLayer(aoiLayer);
        } else {
          map.removeLayer(aoiLayer);
        }
        console.log(`[LayerGroupManager] deletePairByAoiId: Removed AOI layer from map`);
      } catch (err) {
        console.warn(`[LayerGroupManager] Error removing AOI layer:`, err);
      }
    }

    // Cleanup pair registry
    pairsRef.current.delete(aoiId);
    pairByAoiId.current.delete(aoiId); // Also clean up split registry pair mapping

    // Cleanup tracking refs
    if (uploadedLayersRef.current.has(aoiId)) {
      uploadedLayersRef.current.delete(aoiId);
    }
    if (drawnLayerRef.current === aoiLayer) {
      drawnLayerRef.current = null;
    }
    aoiLayersRef.current.delete(aoiId); // Remove from legacy unified registry
    aoiLayersById.current.delete(aoiId); // CRITICAL: Remove from split registry to prevent re-registration

    // Remove raster from React state (createdRasters array)
    if (onRemoveRasterByAoiId && aoiId) {
      console.log(`[LayerGroupManager] deletePairByAoiId: Calling onRemoveRasterByAoiId(${aoiId}) to remove raster from React state`);
      onRemoveRasterByAoiId(aoiId);
    } else if (onRemoveRaster && createdRasterId) {
      console.log(`[LayerGroupManager] deletePairByAoiId: Calling onRemoveRaster(${createdRasterId}) to remove raster from React state`);
      onRemoveRaster(createdRasterId);
    }
    
    // Remove AOI from React state (userClip, aois array, etc.)
    // This is the key difference from removeOverlayForAoiId
    if (onRemoveAoi && aoiId) {
      console.log(`[LayerGroupManager] deletePairByAoiId: Calling onRemoveAoi(${aoiId}) to remove AOI from React state`);
      onRemoveAoi(aoiId);
    }

    console.log(`[LayerGroupManager] deletePairByAoiId: ✅ Completed FULL deletion of pair (Raster: ${createdRasterId}, AOI: ${aoiId})`);
    return true; // Return success indicator
  }, [map, onRemoveAoi, onRemoveRaster, onRemoveRasterByAoiId]);

  // Legacy function for backward compatibility (uses layer reference)
  const deletePairByAoiLayer = useCallback((aoiLayer) => {
    if (!aoiLayer) return;

    // NEVER delete base AOI - check for locked flag
    if (aoiLayer.__locked || aoiLayer.options?.__locked || aoiLayer === baseAoiLayerRef.current) {
      console.log("[LayerGroupManager] deletePairByAoiLayer: Blocked deletion of locked AOI (base AOI)");
      return;
    }

    // Get app-level aoiId from layer
    const aoiId = aoiLayer.__aoiId || aoiLayer.options?.__aoiId;
    if (!aoiId) {
      console.warn("[LayerGroupManager] deletePairByAoiLayer: AOI layer has no __aoiId");
      // Try to find aoiId from tracking refs
      for (const [id, layer] of uploadedLayersRef.current.entries()) {
        if (layer === aoiLayer) {
          deletePairByAoiId(id);
          return;
        }
      }
      if (drawnLayerRef.current === aoiLayer) {
        // Can't determine aoiId from drawn layer ref alone, just remove the layer
        const aoiKey = aoiLayer.options?.__aoiKey;
        if (aoiKey && onRemoveAoi) {
          onRemoveAoi(aoiKey);
        }
      }
      return;
    }

    // Use the app-level ID-based deletion
    deletePairByAoiId(aoiId);
  }, [deletePairByAoiId, onRemoveAoi]);

  // ============================================================
  // INITIALIZE PANES AND LAYER GROUPS (once on mount)
  // ============================================================
  useEffect(() => {
    if (!map) return;

    // Create custom panes for proper z-ordering
    // Base AOI pane (pointerEvents: none - never clickable/editable)
    if (!map.getPane("baseAoiPane")) {
      const baseAoiPane = map.createPane("baseAoiPane");
      baseAoiPane.style.zIndex = 350; // Visually on top
      baseAoiPane.style.pointerEvents = "none"; // CRITICAL: never clickable/editable
      console.log("[LayerGroupManager] Created baseAoiPane (zIndex: 350, pointerEvents: none)");
    }

    // User AOI pane (interactive)
    if (!map.getPane("userAoiPane")) {
      const userAoiPane = map.createPane("userAoiPane");
      userAoiPane.style.zIndex = 450; // Above base AOI
      console.log("[LayerGroupManager] Created userAoiPane (zIndex: 450)");
    }

    // Raster overlay pane (non-interactive, below AOIs)
    if (!map.getPane("rasterPane")) {
      const rasterPane = map.createPane("rasterPane");
      rasterPane.style.zIndex = 200; // Below AOI layers
      console.log("[LayerGroupManager] Created rasterPane (zIndex: 200)");
    }

    // Create layer groups (NOT for base AOI - it's added directly to map)
    if (!uploadedAoiLayerGroupRef.current) {
      uploadedAoiLayerGroupRef.current = L.layerGroup().addTo(map);
      console.log("[LayerGroupManager] Created uploadedAoiLayerGroup");
    }
    if (!drawnAoiLayerGroupRef.current) {
      drawnAoiLayerGroupRef.current = L.layerGroup().addTo(map);
      console.log("[LayerGroupManager] Created drawnAoiLayerGroup");
    }
    if (!overlayLayerGroupRef.current) {
      overlayLayerGroupRef.current = L.layerGroup().addTo(map);
      console.log("[LayerGroupManager] Created overlayLayerGroup");
    }
  }, [map]);

  // ============================================================
  // HOOK 0: CLEAR TEMP LAYERS ON DRAW END / MODE TOGGLE
  // ============================================================
  useEffect(() => {
    if (!map) return;

    // Clear temp layers when drawing finishes
    const handlePmCreate = () => {
      console.log("[LayerGroupManager] pm:create - clearing temp layers");
      clearPmTempLayers();
    };

    // Clear temp layers when draw ends
    const handlePmDrawEnd = () => {
      console.log("[LayerGroupManager] pm:drawend - clearing temp layers");
      clearPmTempLayers();
    };

    // Clear temp layers when draw mode is toggled off
    const handleDrawModeToggle = (e) => {
      if (!e.enabled) {
        console.log("[LayerGroupManager] pm:globaldrawmodetoggled (disabled) - clearing temp layers");
        clearPmTempLayers();
      }
    };

    // Clear temp layers when removal mode is toggled on (eraser activated)
    const handleRemovalModeToggle = (e) => {
      if (e.enabled) {
        console.log("[LayerGroupManager] pm:globalremovalmodetoggled (enabled) - clearing temp layers");
        clearPmTempLayers();
      }
    };

    map.on("pm:create", handlePmCreate);
    map.on("pm:drawend", handlePmDrawEnd);
    map.on("pm:globaldrawmodetoggled", handleDrawModeToggle);
    map.on("pm:globalremovalmodetoggled", handleRemovalModeToggle);

    return () => {
      map.off("pm:create", handlePmCreate);
      map.off("pm:drawend", handlePmDrawEnd);
      map.off("pm:globaldrawmodetoggled", handleDrawModeToggle);
      map.off("pm:globalremovalmodetoggled", handleRemovalModeToggle);
    };
  }, [map, clearPmTempLayers]);

  // ============================================================
  // HOOK 1: PM:REMOVE - Delete pair when AOI is erased
  // ============================================================
  useEffect(() => {
    if (!map) return;

    const handlePmRemove = (e) => {
      const layer = e.layer;
      if (!layer) return;

      // NEVER delete base AOI
      if (layer.__locked || layer.options?.__locked || layer === baseAoiLayerRef.current) {
        console.log("[LayerGroupManager] pm:remove: Blocked removal of locked layer (AOI_diss)");
        e.preventDefault?.();
        return;
      }

      // Get app-level aoiId from layer
      const aoiId = layer.__aoiId || layer.options?.__aoiId || layer.feature?.properties?.__aoiId;
      
      if (!aoiId) {
        console.warn("[LayerGroupManager] pm:remove: Layer has no __aoiId, cannot delete pair");
        console.warn("[LayerGroupManager] Available keys in pairsRef:", Array.from(pairsRef.current.keys()));
        return;
      }

      console.log("[PAIR] erase", aoiId, layer._leaflet_id);

      // Delete the pair using app-level aoiId
      // This will remove both AOI and overlay, and update React state
      deletePairByAoiId(aoiId);
    };

    map.on("pm:remove", handlePmRemove);

    return () => {
      map.off("pm:remove", handlePmRemove);
    };
  }, [map, deletePairByAoiId]);

  // ============================================================
  // HOOK 2: TRACK REMOVAL MODE AND HANDLE RASTER OVERLAY CLICKS
  // ============================================================
  useEffect(() => {
    if (!map) return;

    // Track when removal mode is toggled
    const handleRemovalModeToggle = (e) => {
      removalModeRef.current = !!e.enabled;
      console.log(`[LayerGroupManager] Removal mode ${removalModeRef.current ? "enabled" : "disabled"}`);
    };

    map.on("pm:globalremovalmodetoggled", handleRemovalModeToggle);

    // Handle map clicks when removal mode is active
    // When user clicks on a raster overlay in removal mode, delete the pair
    const handleMapClick = (e) => {
      if (!removalModeRef.current) return; // Only handle clicks when eraser is active

      // Guard: ensure valid latlng
      if (!e?.latlng || !Number.isFinite(e.latlng.lat) || !Number.isFinite(e.latlng.lng)) {
        return;
      }

      const clickLatLng = e.latlng;

      // Find overlay that contains click by iterating through overlay layer group
      if (!overlayLayerGroupRef.current) return;

      overlayLayerGroupRef.current.eachLayer((overlayLayer) => {
        // Get bounds from overlay's stored __bounds or from getBounds()
        let bounds = null;
        
        // Try to use stored bounds first (more reliable)
        if (overlayLayer.__bounds) {
          try {
            bounds = L.latLngBounds(overlayLayer.__bounds);
          } catch (err) {
            // Fall back to getBounds()
            bounds = overlayLayer.getBounds?.();
          }
        } else {
          bounds = overlayLayer.getBounds?.();
        }

        if (!bounds) {
          // Log which overlay is missing bounds but don't ignore globally
          const overlayId = overlayLayer.options?.__overlayId || overlayLayer._leaflet_id;
          console.warn(`[LayerGroupManager] Overlay ${overlayId} has no bounds, skipping erase check`);
          return;
        }

        try {
          // Guard: ensure bounds are valid
          if (!bounds.isValid || !bounds.isValid()) {
            return;
          }

          if (bounds.contains(clickLatLng)) {
            // Found overlay that contains click - find its paired AOI using overlay's aoiId
            const overlayAoiId = overlayLayer.__aoiId || overlayLayer.options?.__aoiId;
            
            if (!overlayAoiId) {
              const overlayId = overlayLayer.options?.__overlayId || overlayLayer._leaflet_id;
              console.warn(`[LayerGroupManager] erase click hit overlay ${overlayId} but no aoiId found`);
              return;
            }

            console.log("[LayerGroupManager] 🗑️ Erase click hit overlay - deleting pair", { 
              overlayAoiId,
              overlayId: overlayLayer._leaflet_id,
              rasterId: overlayLayer.__createdRasterId
            });

            // Delete the pair using app-level aoiId
            deletePairByAoiId(overlayAoiId);
            return; // Stop iterating after finding and deleting the pair
          }
        } catch (err) {
          console.warn(`[LayerGroupManager] Error checking bounds for overlay:`, err);
        }
      });
    };

    map.on("click", handleMapClick);

    return () => {
      map.off("pm:globalremovalmodetoggled", handleRemovalModeToggle);
      map.off("click", handleMapClick);
    };
  }, [map, deletePairByAoiId]);

  // ============================================================
  // RENDER AOI_DISS (PERMANENT BASE AOI) - Added DIRECTLY to map
  // ============================================================
  useEffect(() => {
    if (!map) return;

    // Remove old base AOI layer if it exists
    if (baseAoiLayerRef.current) {
      map.removeLayer(baseAoiLayerRef.current);
      baseAoiLayerRef.current = null;
    }

    // Add new base AOI layer if provided
    if (globalAoi) {
      const baseLayer = L.geoJSON(globalAoi, {
        style: {
          color: "#00BFFF", // bright aqua blue outline
          weight: 3,
          fillColor: "#00BFFF",
          fillOpacity: 0.05,
        },
        pane: "baseAoiPane", // CRITICAL: uses baseAoiPane with pointerEvents: none
        interactive: false, // CRITICAL: never interactive
        pmIgnore: true, // CRITICAL: Geoman ignores this layer
      });

      // Lock the layer to prevent removal
      baseLayer.options.__locked = true;
      baseLayer.__locked = true;
      baseLayer.options.pmIgnore = true;
      baseLayer._pmIgnore = true;

      // Explicitly disable pm on the base layer
      if (baseLayer.pm) {
        baseLayer.pm.disable();
      }

      // Also disable pm on child layers if it's a FeatureCollection
      if (baseLayer.eachLayer) {
        baseLayer.eachLayer((childLayer) => {
          childLayer.options.__locked = true;
          childLayer.__locked = true;
          childLayer.options.pmIgnore = true;
          childLayer.options.interactive = false;
          childLayer._pmIgnore = true;
          if (childLayer.pm) {
            childLayer.pm.disable();
          }
        });
      }

      // Add DIRECTLY to map (NOT in a layer group)
      baseLayer.addTo(map);
      baseAoiLayerRef.current = baseLayer;

      // Debug log: verify base AOI settings
      console.log("[LayerGroupManager] Added AOI_diss directly to map:", {
        interactive: baseLayer.options.interactive,
        pmIgnore: baseLayer.options.pmIgnore,
        __locked: baseLayer.options.__locked,
        pane: baseLayer.options.pane,
      });
    }

    return () => {
      // Cleanup: remove base AOI layer when globalAoi changes
      if (baseAoiLayerRef.current) {
        map.removeLayer(baseAoiLayerRef.current);
        baseAoiLayerRef.current = null;
      }
    };
  }, [map, globalAoi]);

  // ============================================================
  // RENDER UPLOADED AOIs (in userAoiPane)
  // ============================================================
  useEffect(() => {
    if (!map || !uploadedAoiLayerGroupRef.current) return;

    const currentIds = new Set(uploadedAois.map((aoi) => aoi.id));
    const existingIds = new Set(uploadedLayersRef.current.keys());

    // Remove layers that are no longer in uploadedAois
    // CRITICAL: Only remove if it's an explicit removal (ID was in array, now it's not)
    // Do NOT remove if uploadedAois is temporarily empty during re-renders (e.g., export UI changes)
    existingIds.forEach((id) => {
      if (!currentIds.has(id)) {
        const layer = uploadedLayersRef.current.get(id);
        if (layer) {
          // Only delete pair if this is an explicit removal
          // If uploadedAois array is empty but we had items before, it might be a re-render - be cautious
          // Only delete if the specific ID is missing from a non-empty array (explicit removal)
          const isExplicitRemoval = uploadedAois.length > 0 || existingIds.size === 1;
          if (isExplicitRemoval) {
            console.log(`[LayerGroupManager] Explicit removal of uploaded AOI ${id} - deleting pair`);
            deletePairByAoiId(id);
          } else {
            console.log(`[LayerGroupManager] Skipping removal of uploaded AOI ${id} - may be temporary re-render (array empty)`);
            // Don't delete - preserve the layer
            return;
          }
        } else {
          // No pair - just remove from map
          if (uploadedAoiLayerGroupRef.current.hasLayer(layer)) {
            uploadedAoiLayerGroupRef.current.removeLayer(layer);
          }
          uploadedLayersRef.current.delete(id);
          aoiLayersRef.current.delete(id); // Remove from unified registry
        }
      }
    });

    // Add new layers for AOIs that don't have layers yet
    uploadedAois.forEach((aoi) => {
      if (!uploadedLayersRef.current.has(aoi.id) && aoi.geojson) {
        // ✅ CRITICAL: Validate GeoJSON before rendering
        const uploadedGeojson = aoi.geojson;
        const isValidGeoJSON =
          uploadedGeojson &&
          (uploadedGeojson.type === "FeatureCollection" ||
           uploadedGeojson.type === "Feature" ||
           uploadedGeojson.type === "Polygon" ||
           uploadedGeojson.type === "MultiPolygon");
        
        if (!isValidGeoJSON) {
          console.warn("[LayerGroupManager] Skipping invalid GeoJSON for uploaded AOI:", uploadedGeojson);
          return;
        }
        
        // ✅ CRITICAL: Use registerAoiLayer to create layer (idempotent, checks hash)
        // It will return existing layer if hash matches, or create new one
        const layer = registerAoiLayer(aoi.id, uploadedGeojson, {
          color: "#f97316", // orange outline for uploaded
          weight: 2,
          fillOpacity: 0.15,
          pane: "userAoiPane", // CRITICAL: uses userAoiPane (interactive)
          interactive: true, // CRITICAL: interactive
          pmIgnore: false, // CRITICAL: Geoman can interact with this
        }, "upload", uploadedAoiLayerGroupRef.current);
        
        if (!layer) {
          console.warn("[LayerGroupManager] Failed to register uploaded AOI layer:", aoi.id);
          return;
        }

        // Mark as uploaded AOI with app-level stable ID (if not already set)
        if (!layer.options.__aoiKey) {
          layer.options.__aoiKey = aoi.id; // App-level ID for state removal
          layer.options.__aoiType = "uploaded";
          layer.options.__aoiId = aoi.id;
          layer.__aoiId = aoi.id; // Store on layer itself for pm:remove handler
          layer.__locked = false; // Not base AOI, can be removed

          // Allow Geoman eraser to work (don't set _pmIgnore)
          if (layer.eachLayer) {
            layer.eachLayer((childLayer) => {
              childLayer.options.__aoiKey = aoi.id;
              childLayer.options.__aoiType = "uploaded";
              childLayer.options.__aoiId = aoi.id;
              childLayer.__aoiId = aoi.id; // Store on layer itself
              childLayer.__locked = false; // Not base AOI
              childLayer.options.interactive = true;
              childLayer.options.pmIgnore = false;
              if (childLayer.pm) {
                childLayer.pm.disable(); // Disable edit mode, but allow removal
              }
            });
          } else {
            if (layer.pm) {
              layer.pm.disable(); // Disable edit mode, but allow removal
            }
          }
        }

        // Add to layer group if not already added
        if (!uploadedAoiLayerGroupRef.current.hasLayer(layer)) {
          uploadedAoiLayerGroupRef.current.addLayer(layer);
        }
        uploadedLayersRef.current.set(aoi.id, layer);
        aoiLayersRef.current.set(aoi.id, layer); // Add to unified registry

        console.log(`[LayerGroupManager] Added uploaded AOI layer: ${aoi.id}`);
      }
    });
  }, [map, uploadedAois, deletePairByAoiId]);

  // ============================================================
  // RENDER DRAWN AOI (in userAoiPane)
  // ============================================================
  useEffect(() => {
    if (!map || !drawnAoiLayerGroupRef.current) return;

    // CRITICAL: Only remove old drawn layer if we have a NEW drawnAoi to replace it
    // OR if drawnAoi was explicitly removed (was non-null, now null)
    // Do NOT remove if drawnAoi is temporarily null during re-renders (e.g., export UI changes)
    const hasOldLayer = !!drawnLayerRef.current;
    const hasNewAoi = drawnAoi && drawnAoi.geojson;
    const prevHadAoi = prevDrawnAoiRef.current && prevDrawnAoiRef.current.geojson;
    const isExplicitRemoval = !drawnAoi && prevHadAoi && hasOldLayer; // Was non-null, now null, and we have a layer
    
    // CRITICAL: Check if geometry actually changed (not just object reference)
    let geometryActuallyChanged = false;
    if (hasNewAoi && hasOldLayer) {
      const oldAoiId = drawnLayerRef.current.__aoiId || drawnLayerRef.current.options?.__aoiId;
      const newAoiId = drawnAoi.id;
      
      // Only check geometry if IDs match (same AOI, possible geometry change)
      if (oldAoiId === newAoiId) {
        const oldHash = geometryHashesRef.current.get(oldAoiId);
        const newHash = computeGeometryHash(drawnAoi.geojson);
        
        if (oldHash && newHash) {
          geometryActuallyChanged = oldHash !== newHash;
          if (!geometryActuallyChanged) {
            console.log(`[LayerGroupManager] Drawn AOI ${oldAoiId} geometry unchanged (same hash) - skipping replace`);
          }
        } else {
          // First time seeing this AOI or hash computation failed - assume changed
          geometryActuallyChanged = true;
        }
      } else {
        // Different AOI IDs - definitely a change
        geometryActuallyChanged = true;
      }
    } else if (hasNewAoi && !hasOldLayer) {
      // New AOI (no old layer) - definitely a change
      geometryActuallyChanged = true;
    }
    
    // Only cleanup if we're replacing with a new AOI with DIFFERENT geometry OR it's an explicit removal
    // Do NOT cleanup if drawnAoi is just temporarily null (could be export UI re-render)
    // Do NOT cleanup if geometry is the same (just a reference change)
    if (hasOldLayer && ((hasNewAoi && geometryActuallyChanged) || isExplicitRemoval)) {
      const oldAoiId = drawnLayerRef.current.__aoiId || drawnLayerRef.current.options?.__aoiId;
      if (oldAoiId) {
        // Only delete pair if we have a new AOI with different geometry (replacing) or it's an explicit removal
        // For explicit removal, deletePairByAoiId will handle full cleanup
        if (hasNewAoi && geometryActuallyChanged) {
          // Replacing with new AOI with different geometry - use removeOverlayForAoiId to keep AOI, just remove old overlay
          console.log(`[LayerGroupManager] Replacing drawn AOI ${oldAoiId} with new geometry - removing old overlay only`);
          removeOverlayForAoiId(oldAoiId);
        } else if (isExplicitRemoval) {
          // Explicit removal - full delete
          console.log(`[LayerGroupManager] Explicit removal of drawn AOI ${oldAoiId} - full delete`);
          deletePairByAoiId(oldAoiId);
          // Clear geometry hash for removed AOI
          geometryHashesRef.current.delete(oldAoiId);
        }
        aoiLayersRef.current.delete(oldAoiId); // Remove from unified registry
      }
      // Safe removal: check if layer exists and is valid before removing
      if (drawnLayerRef.current && drawnAoiLayerGroupRef.current.hasLayer(drawnLayerRef.current)) {
        try {
          drawnAoiLayerGroupRef.current.removeLayer(drawnLayerRef.current);
        } catch (err) {
          console.warn("[LayerGroupManager] Error removing drawn layer:", err);
        }
      }
      drawnLayerRef.current = null;
    }

    // Add new drawn layer if provided
    if (drawnAoi && drawnAoi.geojson) {
      // ✅ CRITICAL: Validate GeoJSON before rendering
      const drawnGeojson = drawnAoi.geojson;
      const isValidGeoJSON =
        drawnGeojson &&
        (drawnGeojson.type === "FeatureCollection" ||
         drawnGeojson.type === "Feature" ||
         drawnGeojson.type === "Polygon" ||
         drawnGeojson.type === "MultiPolygon");
      
      if (!isValidGeoJSON) {
        console.warn("[LayerGroupManager] Skipping invalid GeoJSON for drawn AOI:", drawnGeojson);
        return;
      }
      
      // ✅ CRITICAL: Use registerAoiLayer to create layer (idempotent, checks hash)
      // It will return existing layer if hash matches, or create new one
      const layer = registerAoiLayer(drawnAoi.id, drawnGeojson, {
        color: "#2563eb", // blue outline for drawn
        weight: 3,
        fillColor: "#2563eb",
        fillOpacity: 0.1,
        dashArray: "5, 5", // dashed line
        pane: "userAoiPane", // CRITICAL: uses userAoiPane (interactive)
        interactive: true, // CRITICAL: interactive
        pmIgnore: false, // CRITICAL: Geoman can interact with this
      }, "draw", drawnAoiLayerGroupRef.current);
      
      if (!layer) {
        console.warn("[LayerGroupManager] Failed to register drawn AOI layer:", drawnAoi.id);
        return;
      }

      // Mark layer properties (if not already set)
      if (!layer.options.__aoiKey) {
        layer.options.__aoiKey = drawnAoi.id; // App-level ID for state removal
        layer.options.__aoiType = "drawn";
        layer.options.__aoiId = drawnAoi.id;
        layer.__aoiId = drawnAoi.id; // Store on layer itself for pm:remove handler
        layer.__locked = false; // Not base AOI, can be removed

        // Allow Geoman eraser to work (don't set _pmIgnore)
        if (layer.eachLayer) {
          layer.eachLayer((childLayer) => {
            childLayer.options.__aoiKey = drawnAoi.id;
            childLayer.options.__aoiType = "drawn";
            childLayer.options.__aoiId = drawnAoi.id;
            childLayer.__aoiId = drawnAoi.id; // Store on layer itself
            childLayer.__locked = false; // Not base AOI
            childLayer.options.interactive = true;
            childLayer.options.pmIgnore = false;
            if (childLayer.pm) {
              childLayer.pm.disable(); // Disable edit mode, but allow removal
            }
          });
        } else {
          if (layer.pm) {
            layer.pm.disable(); // Disable edit mode, but allow removal
          }
        }
      }

      // Add to layer group if not already added
      if (!drawnAoiLayerGroupRef.current.hasLayer(layer)) {
        drawnAoiLayerGroupRef.current.addLayer(layer);
      }
      drawnLayerRef.current = layer;
      aoiLayersRef.current.set(drawnAoi.id, layer); // Add to unified registry

      // Store geometry hash for this AOI
      const geomHash = computeGeometryHash(drawnAoi.geojson);
      if (geomHash) {
        geometryHashesRef.current.set(drawnAoi.id, geomHash);
      }
      
      console.log(`[LayerGroupManager] Added drawn AOI layer: ${drawnAoi.id}`);
    } else if (hasOldLayer && !hasNewAoi && !isExplicitRemoval) {
      // We have an old layer but drawnAoi is temporarily null (not an explicit removal)
      // Do NOT delete - just log that we're preserving it
      console.log(`[LayerGroupManager] Preserving drawn AOI layer - drawnAoi is temporarily null (likely re-render, not explicit removal)`);
    }
    
    // Update previous ref for next comparison
    prevDrawnAoiRef.current = drawnAoi;
  }, [map, drawnAoi, deletePairByAoiId, removeOverlayForAoiId, registerAoiLayer]);

  // ============================================================
  // RENDER RASTER OVERLAYS AND REGISTER PAIRS
  // ============================================================
  useEffect(() => {
    console.log("[LayerGroupManager] 🔍 useEffect createdRasters triggered - count:", createdRasters?.length || 0);
    if (!map || !overlayLayerGroupRef.current) return;

    const currentIds = new Set(createdRasters.map((r) => r.id));

    // Remove overlays that are no longer in createdRasters
    // Cleanup pairs for removed rasters
    // IMPORTANT: This automatically removes old overlays when createdRasters array is replaced
    for (const [aoiId, pair] of pairsRef.current.entries()) {
      if (!currentIds.has(pair.createdRasterId)) {
        // Cleanup pair registry
        pairsRef.current.delete(aoiId);
        
        // Remove overlay from map
        if (pair.overlayLayer && overlayLayerGroupRef.current.hasLayer(pair.overlayLayer)) {
          overlayLayerGroupRef.current.removeLayer(pair.overlayLayer);
          map.removeLayer(pair.overlayLayer);
        }
        console.log(`[LayerGroupManager] Removed raster overlay pair: ${pair.createdRasterId}`);
      }
    }
    
    // ✅ CRITICAL: LayerGroupManager is a pure renderer - it should NEVER clear overlays
    // based on createdRasters being empty. MapExplorer controls state, LayerGroupManager just renders.
    // If createdRasters is empty, just render nothing (do NOT clear existing overlays)
    if (createdRasters.length === 0) {
      // Do NOT clear overlays - just don't render new ones
      // MapExplorer controls overlay lifecycle, not LayerGroupManager
      return; // Early return - preserve existing overlays
    }

    // Add new overlays and register pairs
    for (const raster of createdRasters) {
      // Guard: ensure overlayUrl and overlayBounds exist
      if (!raster.overlayUrl || !raster.overlayBounds) {
        console.warn(`[LayerGroupManager] Skipping raster ${raster.id}: missing overlayUrl or overlayBounds`);
        continue;
      }

      // ✅ CRITICAL: Only replace overlay if we're actually regenerating with a NEW raster
      // Do NOT replace on UI re-renders (export, histogram, stats clicks)
      const rasterAoiId = raster.aoiId;
      if (rasterAoiId && pairsRef.current.has(rasterAoiId)) {
        const existingPair = pairsRef.current.get(rasterAoiId);
        const existingRasterId = existingPair?.createdRasterId;
        
        // Only replace if the raster ID is DIFFERENT (actual regeneration)
        // If it's the same raster ID, this is just a re-render, don't remove it
        if (existingRasterId && existingRasterId !== raster.id) {
          // Remove old overlay but keep AOI layer (for regeneration with new raster)
          // Use removeOverlayForAoiId (system delete) instead of deletePairByAoiId (user delete)
          console.log(`[LayerGroupManager] Replacing overlay for AOI ${rasterAoiId} (regenerating with new raster: ${existingRasterId} -> ${raster.id})`);
          removeOverlayForAoiId(rasterAoiId);
        } else {
          // Same raster ID - this is just a re-render, skip it
          console.log(`[LayerGroupManager] Skipping overlay replacement - same raster ID (${raster.id}), likely UI re-render`);
          continue; // Skip to next raster
        }
      }

      const BACKEND_BASE = import.meta.env.VITE_BACKEND_URL || "http://127.0.0.1:8000";
      const fullUrl = raster.overlayUrl.startsWith("http")
        ? raster.overlayUrl
        : `${BACKEND_BASE}${raster.overlayUrl}`;

      // Handle both array format [[south, west], [north, east]] and object format {west, south, east, north}
      let leafletBounds;
      if (Array.isArray(raster.overlayBounds) && raster.overlayBounds.length === 2) {
        // Guard: ensure bounds array has valid coordinates
        const [southWest, northEast] = raster.overlayBounds;
        if (!southWest || !northEast || 
            !Array.isArray(southWest) || !Array.isArray(northEast) ||
            southWest.length < 2 || northEast.length < 2 ||
            !Number.isFinite(southWest[0]) || !Number.isFinite(southWest[1]) ||
            !Number.isFinite(northEast[0]) || !Number.isFinite(northEast[1])) {
          console.warn(`[LayerGroupManager] Invalid bounds array format for raster ${raster.id}:`, raster.overlayBounds);
          continue;
        }
        leafletBounds = raster.overlayBounds;
      } else if (raster.overlayBounds.south !== undefined) {
        // Guard: ensure bounds object has valid coordinates
        const { south, west, north, east } = raster.overlayBounds;
        if (!Number.isFinite(south) || !Number.isFinite(west) || 
            !Number.isFinite(north) || !Number.isFinite(east)) {
          console.warn(`[LayerGroupManager] Invalid bounds object format for raster ${raster.id}:`, raster.overlayBounds);
          continue;
        }
        leafletBounds = [
          [south, west],
          [north, east],
        ];
      } else {
        console.warn(`[LayerGroupManager] Invalid bounds format for raster ${raster.id}:`, raster.overlayBounds);
        continue;
      }

      // Guard: ensure bounds are valid before creating overlay
      try {
        const testBounds = L.latLngBounds(leafletBounds);
        if (!testBounds.isValid()) {
          console.warn(`[LayerGroupManager] Invalid Leaflet bounds for raster ${raster.id}:`, leafletBounds);
          continue;
        }
      } catch (err) {
        console.warn(`[LayerGroupManager] Error validating bounds for raster ${raster.id}:`, err);
        continue;
      }

      const overlay = L.imageOverlay(fullUrl, leafletBounds, {
        opacity: 1.0,
        interactive: false, // Must NOT block clicks (eraser needs to work)
        pane: "rasterPane", // Below AOI layers
        className: "raster-overlay-pixelated",
      });

      overlay.options.__overlayId = raster.id;
      overlay._pmIgnore = true;
      overlay.__bounds = leafletBounds; // Store bounds for erase-by-click

      overlayLayerGroupRef.current.addLayer(overlay);

      // Register overlay using helper function
      // ✅ CRITICAL: Correct parameter order: (aoiId, rasterId, overlayLayer, bounds)
      const aoiId = rasterAoiId;
      if (aoiId) {
        setRasterOverlayForAoi(aoiId, raster.id, overlay, leafletBounds);
      } else {
        console.warn(`[LayerGroupManager] ⚠️ Could not register overlay for raster ${raster.id}: missing aoiId`);
      }
    }
  }, [map, createdRasters, registerOverlay, removeOverlayForAoiId]);

  // Expose layer groups and clearPmTempLayers via map instance (for external access if needed)
  useEffect(() => {
    if (map) {
      map._layerGroups = {
        uploaded: uploadedAoiLayerGroupRef.current,
        drawn: drawnAoiLayerGroupRef.current,
        overlay: overlayLayerGroupRef.current,
      };
      // Expose clearPmTempLayers so it can be called from Clear All button
      map._clearPmTempLayers = clearPmTempLayers;
      // Also keep old name for backward compatibility
      map._clearGeomanTempLayers = clearPmTempLayers;
    }
  }, [map, clearPmTempLayers]);

  return null; // This component doesn't render anything
}
