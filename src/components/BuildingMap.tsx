import { useEffect, useRef, useState } from "react";
import * as maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
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

// Ab MapLibre 6 braucht jeder Bundler den Pfad zum Worker.
maplibregl.setWorkerUrl(workerUrl);

export const MAP_STYLE_URL = "https://tiles.openfreemap.org/styles/positron";

/** Ab dieser Zoomstufe werden Häuser geladen und angezeigt. */
export const BUILDING_MIN_ZOOM = 15;
/** Mehr Kacheln auf einmal laden wir nicht (schont den öffentlichen Overpass-Server). */
/** Mindest-Zoom beim Öffnen einer Aktion. */
const START_MIN_ZOOM = 16;
/** So lange wartet ein Tipp, ob ein zweiter (Zoom) folgt. */
export const DOUBLE_TAP_MS = 260;
/** Ein zweiter Tipp in diesem Umkreis (px) gilt als Doppeltipp. */
const DOUBLE_TAP_RADIUS = 40;
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
      zoom: START_MIN_ZOOM,
      maxZoom: 20,
      attributionControl: { compact: true },
      dragRotate: false,
      pitchWithRotate: false,
      // Gesten wie bei Google Maps: schieben, Pinch, Doppeltipp, Doppeltipp-und-ziehen, Mausrad.
      cooperativeGestures: false,
    });
    map.touchZoomRotate.disableRotation();
    map.keyboard.disableRotation();
    mapRef.current = map;

    if (bbox && bbox.length === 4) {
      // Kleiner Ort (Straße, Ortsteil): ganz zeigen, aber nie weiter weg als Straßenansicht,
      // sonst sieht man keine Häuser.
      const [w, s, e, n] = bbox;
      const cam = map.cameraForBounds([w, s, e, n], { padding: 40, maxZoom: 17.5 });
      if (cam?.zoom && cam.zoom >= START_MIN_ZOOM) map.jumpTo(cam);
    }

    const geolocate = new maplibregl.GeolocateControl({
      positionOptions: { enableHighAccuracy: true },
      trackUserLocation: true,
      showAccuracyCircle: false,
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");
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
      // Etwas über den Rand hinaus laden, damit beim Schieben keine leeren Flächen auftauchen.
      const pad = map.getZoom() >= 16 ? 0.35 : 0;
      const dx = (b.getEast() - b.getWest()) * pad;
      const dy = (b.getNorth() - b.getSouth()) * pad;
      const view: BBox = [b.getWest() - dx, b.getSouth() - dy, b.getEast() + dx, b.getNorth() + dy];
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
        // Weitere Kacheln, oder der Nutzer hat während des Ladens weitergeschoben.
        void loadVisible();
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

    // Ein Tipp markiert, ein Doppeltipp zoomt. Deshalb wartet ein Tipp kurz, ob ein
    // zweiter folgt (wie bei Google Maps); dann zoomt nur die Karte, das Haus bleibt.
    let pending: { timer: ReturnType<typeof setTimeout>; run: () => void; x: number; y: number } | null = null;
    // Der zweite Tipp eines Doppeltipps löst auch ein click aus; das ignorieren wir.
    let swallowNextClick = false;
    const cancelTap = () => {
      if (pending) clearTimeout(pending.timer);
      pending = null;
    };
    const canvas = map.getCanvasContainer();
    const onDown = (clientX: number, clientY: number) => {
      swallowNextClick = false;
      if (!pending) return;
      const r = canvas.getBoundingClientRect();
      const near = Math.hypot(clientX - r.left - pending.x, clientY - r.top - pending.y) < DOUBLE_TAP_RADIUS;
      if (near) {
        cancelTap(); // Doppeltipp: die Karte zoomt.
        swallowNextClick = true;
      } else {
        const { run } = pending; // Schnell ein anderes Haus: das erste sofort übernehmen.
        cancelTap();
        run();
      }
    };
    const onTouchStart = (e: TouchEvent) => e.touches[0] && onDown(e.touches[0].clientX, e.touches[0].clientY);
    const onMouseDown = (e: MouseEvent) => onDown(e.clientX, e.clientY);
    canvas.addEventListener("touchstart", onTouchStart, { passive: true });
    canvas.addEventListener("mousedown", onMouseDown);

    map.on("click", (e) => {
      if (swallowNextClick) {
        swallowNextClick = false;
        return;
      }
      if (map.getZoom() < BUILDING_MIN_ZOOM - 0.5) return;
      const f = pick(e.point);
      const osmId = f?.properties?.osmId as string | undefined;
      if (!osmId) return;
      const run = () => {
        if (disposed) return;
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
      };
      cancelTap();
      pending = {
        timer: setTimeout(() => {
          pending = null;
          run();
        }, DOUBLE_TAP_MS),
        run,
        x: e.point.x,
        y: e.point.y,
      };
    });

    map.on("mousemove", (e) => {
      const hit = map.getZoom() >= BUILDING_MIN_ZOOM - 0.5 && pick(e.point);
      map.getCanvas().style.cursor = hit ? "pointer" : "";
    });

    return () => {
      disposed = true;
      cancelTap();
      canvas.removeEventListener("touchstart", onTouchStart);
      canvas.removeEventListener("mousedown", onMouseDown);
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

  // MapLibre setzt am Container position: relative; deshalb ein eigener Rahmen außen.
  return (
    <div className="absolute inset-0">
      <div ref={container} className="h-full w-full" data-testid="map" />
    </div>
  );
}
