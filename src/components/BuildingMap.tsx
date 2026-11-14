import { useEffect, useRef, useState } from "react";
import * as maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { GeoJSONSource, MapGeoJSONFeature } from "maplibre-gl";
import type { FeatureCollection, MultiPolygon, Point } from "geojson";
import {
  cellKey,
  cellsBBox,
  cellsFor,
  fetchBuildings,
  toCollection,
  type BBox,
  type BuildingFeature,
} from "../lib/overpass";

export const MAP_STYLE_URL = "https://tiles.openfreemap.org/styles/positron";

/** Ab dieser Zoomstufe werden Häuser geladen und angezeigt. */
export const BUILDING_MIN_ZOOM = 15;
/** Mehr Kacheln auf einmal laden wir nicht (schont den öffentlichen Overpass-Server). */
const MAX_CELLS_PER_REQUEST = 24;

export interface Mark {
  osmId: string;
  geometry: number[][][][];
}

export interface MapControls {
  locate: () => void;
  retry: () => void;
}

export type LoadState = "idle" | "zoom" | "loading" | "error";

interface Props {
  center: { lat: number; lng: number };
  bbox: number[] | null;
  marks: Mark[] | undefined;
  onToggle: (osmId: string, marked: boolean, geometry?: number[][][][]) => void;
  onLoadState: (s: LoadState) => void;
  controlsRef?: React.MutableRefObject<MapControls | null>;
}

const EMPTY: FeatureCollection = { type: "FeatureCollection", features: [] };

function marksToPolygons(marks: Mark[]): FeatureCollection<MultiPolygon> {
  return {
    type: "FeatureCollection",
    features: marks.map((m) => ({
      type: "Feature",
      properties: { osmId: m.osmId },
      geometry: { type: "MultiPolygon", coordinates: m.geometry },
    })),
  };
}

/** Grobe Mitte eines Hauses für die Punkte bei kleiner Zoomstufe. */
function marksToPoints(marks: Mark[]): FeatureCollection<Point> {
  return {
    type: "FeatureCollection",
    features: marks.map((m) => {
      const ring = m.geometry[0][0];
      let x = 0;
      let y = 0;
      const n = ring.length - 1 || 1;
      for (let i = 0; i < n; i++) {
        x += ring[i][0];
        y += ring[i][1];
      }
      return {
        type: "Feature",
        properties: { osmId: m.osmId },
        geometry: { type: "Point", coordinates: [x / n, y / n] },
      };
    }),
  };
}

export function BuildingMap({ center, bbox, marks, onToggle, onLoadState, controlsRef }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const [ready, setReady] = useState(false);
  // In Refs, damit die Karten-Callbacks immer den aktuellen Stand sehen.
  const marksRef = useRef<Mark[]>([]);
  const onToggleRef = useRef(onToggle);
  const onLoadStateRef = useRef(onLoadState);
  onToggleRef.current = onToggle;
  onLoadStateRef.current = onLoadState;
  marksRef.current = marks ?? [];

  useEffect(() => {
    if (!container.current) return;
    const buildings = new Map<string, BuildingFeature>();
    const loadedCells = new Set<string>();
    let inflight: AbortController | null = null;
    let disposed = false;

    const map = new maplibregl.Map({
      container: container.current,
      style: MAP_STYLE_URL,
      center: [center.lng, center.lat],
      zoom: 16,
      maxZoom: 20,
      attributionControl: { compact: true },
      dragRotate: false,
      pitchWithRotate: false,
    });
    map.touchZoomRotate.disableRotation();
    mapRef.current = map;

    if (bbox && bbox.length === 4) {
      const [w, s, e, n] = bbox;
      // Ganze Städte wären zu weit weg; dann lieber die Mitte in Straßenansicht.
      const small = e - w < 0.03 && n - s < 0.02;
      if (small) map.fitBounds([w, s, e, n], { padding: 40, maxZoom: 17.5, animate: false });
    }

    const geolocate = new maplibregl.GeolocateControl({
      positionOptions: { enableHighAccuracy: true },
      trackUserLocation: true,
      showAccuracyCircle: false,
    });
    map.addControl(geolocate, "bottom-right");

    function updateLoadState() {
      if (map.getZoom() < BUILDING_MIN_ZOOM) onLoadStateRef.current("zoom");
      else if (inflight) onLoadStateRef.current("loading");
      else onLoadStateRef.current("idle");
    }

    async function loadVisible() {
      if (disposed) return;
      if (map.getZoom() < BUILDING_MIN_ZOOM) return updateLoadState();
      if (inflight) return;
      const b = map.getBounds();
      const view: BBox = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
      const missing = cellsFor(view).filter((c) => !loadedCells.has(cellKey(c.x, c.y)));
      if (missing.length === 0) return updateLoadState();
      // Mitte zuerst, falls der Ausschnitt größer ist als ein Abruf.
      const cx = (view[0] + view[2]) / 2;
      const cy = (view[1] + view[3]) / 2;
      missing.sort(
        (a, b2) => Math.hypot(a.x * 0.005 - cx, a.y * 0.005 - cy) - Math.hypot(b2.x * 0.005 - cx, b2.y * 0.005 - cy),
      );
      const batch = missing.slice(0, MAX_CELLS_PER_REQUEST);
      const ctrl = new AbortController();
      inflight = ctrl;
      updateLoadState();
      try {
        const features = await fetchBuildings(cellsBBox(batch), ctrl.signal);
        if (disposed) return;
        for (const f of features) buildings.set(f.properties.osmId, f);
        for (const c of batch) loadedCells.add(cellKey(c.x, c.y));
        (map.getSource("buildings") as GeoJSONSource | undefined)?.setData(toCollection(buildings.values()));
        inflight = null;
        updateLoadState();
        if (missing.length > batch.length) void loadVisible();
      } catch {
        if (disposed) return;
        inflight = null;
        onLoadStateRef.current("error");
      }
    }

    if (controlsRef) controlsRef.current = { locate: () => geolocate.trigger(), retry: () => void loadVisible() };

    map.on("load", () => {
      // Die Häuser der Grundkarte ausblenden, wir zeichnen unsere eigenen.
      for (const layer of map.getStyle().layers ?? []) {
        if ("source-layer" in layer && layer["source-layer"] === "building") {
          map.setLayoutProperty(layer.id, "visibility", "none");
        }
      }
      map.addSource("buildings", { type: "geojson", data: EMPTY, promoteId: "osmId" });
      map.addSource("marks", { type: "geojson", data: EMPTY, promoteId: "osmId" });
      map.addSource("mark-points", { type: "geojson", data: EMPTY });

      map.addLayer({
        id: "buildings-fill",
        type: "fill",
        source: "buildings",
        minzoom: BUILDING_MIN_ZOOM - 0.5,
        paint: { "fill-color": "#24262c", "fill-opacity": 0.9 },
      });
      map.addLayer({
        id: "buildings-line",
        type: "line",
        source: "buildings",
        minzoom: BUILDING_MIN_ZOOM - 0.5,
        paint: { "line-color": "#0d0e11", "line-width": 0.8 },
      });
      map.addLayer({
        id: "marks-fill",
        type: "fill",
        source: "marks",
        paint: { "fill-color": "#ffd60a", "fill-opacity": 1 },
      });
      map.addLayer({
        id: "marks-line",
        type: "line",
        source: "marks",
        paint: { "line-color": "#c99a00", "line-width": ["interpolate", ["linear"], ["zoom"], 14, 0.5, 18, 2] },
      });
      map.addLayer({
        id: "mark-points",
        type: "circle",
        source: "mark-points",
        maxzoom: BUILDING_MIN_ZOOM - 0.5,
        paint: {
          "circle-color": "#ffd60a",
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 10, 2, 14, 4.5],
          "circle-stroke-color": "#15171c",
          "circle-stroke-width": 1,
        },
      });
      setReady(true);
      void loadVisible();
    });

    map.on("moveend", () => void loadVisible());

    function pick(point: maplibregl.Point): MapGeoJSONFeature | undefined {
      const layers = ["marks-fill", "buildings-fill"];
      const exact = map.queryRenderedFeatures(point, { layers });
      if (exact.length) return exact[0];
      // Etwas Toleranz für Finger: nächstes Haus im Umkreis von 8 px.
      const r = 8;
      const near = map.queryRenderedFeatures(
        [
          [point.x - r, point.y - r],
          [point.x + r, point.y + r],
        ],
        { layers },
      );
      return near[0];
    }

    map.on("click", (e) => {
      if (map.getZoom() < BUILDING_MIN_ZOOM - 0.5) return;
      const f = pick(e.point);
      const osmId = f?.properties?.osmId as string | undefined;
      if (!osmId) return;
      const isMarked = marksRef.current.some((m) => m.osmId === osmId);
      if (isMarked) {
        onToggleRef.current(osmId, false);
      } else {
        // Geometrie aus dem Cache, nicht aus der gerenderten Kachel (die ist beschnitten).
        const building = buildings.get(osmId);
        if (!building) return;
        onToggleRef.current(osmId, true, building.geometry.coordinates);
      }
      navigator.vibrate?.(12);
    });

    map.on("mousemove", (e) => {
      const hit = map.getZoom() >= BUILDING_MIN_ZOOM - 0.5 && pick(e.point);
      map.getCanvas().style.cursor = hit ? "pointer" : "";
    });

    return () => {
      disposed = true;
      inflight?.abort();
      if (controlsRef) controlsRef.current = null;
      map.remove();
      mapRef.current = null;
      setReady(false);
    };
    // Die Karte wird nur einmal je Aktion aufgebaut.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    const list = marks ?? [];
    (map.getSource("marks") as GeoJSONSource).setData(marksToPolygons(list));
    (map.getSource("mark-points") as GeoJSONSource).setData(marksToPoints(list));
  }, [marks, ready]);

  return <div ref={container} className="absolute inset-0" data-testid="map" />;
}
