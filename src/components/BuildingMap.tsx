import { useEffect, useRef, useState } from "react";
import * as maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import type { CircleLayerSpecification, ExpressionSpecification, GeoJSONSource, MapGeoJSONFeature } from "maplibre-gl";
import type { FeatureCollection, Point } from "geojson";
import {
  CELL_SIZE,
  MAX_CELL_SPAN,
  cellKey,
  cellsFor,
  centerOf,
  toCollection,
  type BBox,
  type BuildingFeature,
} from "../lib/overpass";
import { DOUBLE_TAP_MS, dragZoomDelta, onPress, type Press } from "../lib/taps";
import { markCellOf, markCellsIn } from "../../convex/cells";
import { nextStatus, statusOf, type HouseStatus, type MarkStatus } from "../../convex/status";

// Ab MapLibre 6 braucht jeder Bundler den Pfad zum Worker.
maplibregl.setWorkerUrl(workerUrl);

export const MAP_STYLE_URL = "https://tiles.openfreemap.org/styles/positron";

/** Ab dieser Zoomstufe werden Häuser geladen und angezeigt. */
export const BUILDING_MIN_ZOOM = 15;
/** Mindest-Zoom beim Öffnen einer Aktion. */
const START_MIN_ZOOM = 16;
/** Mehr Kacheln auf einmal laden wir nicht (schont den öffentlichen Overpass-Server). */
const MAX_CELLS_PER_REQUEST = 24;
/** Mehr Markierungs-Zellen abonnieren wir nicht; weiter rausgezoomt gibt es keine Punkte. */
const MAX_MARK_CELLS = 100;
/** Wartezeit nach einem Overpass-Fehler, verdoppelt sich bis zum Maximum. */
const BACKOFF_START_MS = 5_000;
const BACKOFF_MAX_MS = 60_000;

const COLOR_HOUSE = "#24262c";
const COLOR_HOUSE_LINE = "#0d0e11";
const COLOR_MARKED = "#ffd60a";
const COLOR_MARKED_LINE = "#c99a00";
/** Einwerfen nicht möglich: dunkles, gräuliches Gelb (gleich --color-blocked in index.css). */
const COLOR_BLOCKED = "#938443";
const COLOR_BLOCKED_LINE = "#5e5326";

export interface Mark {
  osmId: string;
  /** [lng, lat] */
  center: number[];
  status: MarkStatus;
}

export interface MapControls {
  retry: () => void;
}

export type LoadState = "idle" | "zoom" | "loading" | "error" | "mapError";

interface Props {
  center: { lat: number; lng: number };
  bbox: number[] | null;
  /** Markierungen der zuletzt gemeldeten Zellen. */
  marks: Mark[];
  /** Markierungs-Zellen, deren Daten schon da sind. */
  loadedMarkCells: Set<string>;
  /** Sichtbare Markierungs-Zellen; null = zu weit herausgezoomt. */
  onCellsChange: (cells: string[] | null) => void;
  /** Neuer Zustand nach einem Tipp (offen → Flyer drin → nicht möglich → offen). */
  onToggle: (osmId: string, status: HouseStatus, center: number[]) => void;
  onLoadState: (s: LoadState) => void;
  /** Lädt die Häuser der Kacheln ("x:y"), über Convex mit gemeinsamem Cache. */
  loadBuildings: (cells: string[]) => Promise<BuildingFeature[]>;
  controlsRef?: React.MutableRefObject<MapControls | null>;
}

const EMPTY: FeatureCollection = { type: "FeatureCollection", features: [] };

export function BuildingMap({
  center,
  bbox,
  marks,
  onCellsChange,
  onToggle,
  onLoadState,
  loadBuildings,
  loadedMarkCells,
  controlsRef,
}: Props) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const syncMarksRef = useRef<(() => void) | null>(null);
  const [ready, setReady] = useState(false);
  // In Refs, damit die Karten-Callbacks immer den aktuellen Stand sehen.
  const marksRef = useRef<Map<string, Mark>>(new Map());
  const onToggleRef = useRef(onToggle);
  const onLoadStateRef = useRef(onLoadState);
  const onCellsChangeRef = useRef(onCellsChange);
  const loadBuildingsRef = useRef(loadBuildings);
  const loadedMarkCellsRef = useRef(loadedMarkCells);
  loadedMarkCellsRef.current = loadedMarkCells;
  loadBuildingsRef.current = loadBuildings;
  onToggleRef.current = onToggle;
  onLoadStateRef.current = onLoadState;
  onCellsChangeRef.current = onCellsChange;

  useEffect(() => {
    if (!container.current) return;
    const buildings = new Map<string, BuildingFeature>();
    const loadedCells = new Set<string>();
    /** osmIds, die gerade als markiert eingefärbt sind (feature-state). */
    const painted = new Map<string, MarkStatus>();
    let inflight = false;
    let disposed = false;
    let loaded = false;
    let backoffMs = 0;
    let blockedUntil = 0;
    let lastCells = "";

    const map = new maplibregl.Map({
      container: container.current,
      style: MAP_STYLE_URL,
      center: [center.lng, center.lat],
      zoom: START_MIN_ZOOM,
      maxZoom: 20,
      attributionControl: { compact: true },
      dragRotate: false,
      pitchWithRotate: false,
      // Gesten wie bei Google Maps: schieben, Pinch, Doppeltipp-und-ziehen, Mausrad.
      // Den Doppeltipp-Zoom macht die App selbst (siehe unten), damit Markieren und
      // Zoomen nach derselben Regel entschieden werden.
      doubleClickZoom: false,
      cooperativeGestures: false,
    });
    map.touchZoomRotate.disableRotation();
    map.keyboard.disableRotation();
    mapRef.current = map;
    if (import.meta.env.DEV) (window as unknown as { __einwurfMap?: maplibregl.Map }).__einwurfMap = map;

    if (bbox && bbox.length === 4) {
      // Kleiner Ort (Straße, Ortsteil): ganz zeigen, aber nie weiter weg als Straßenansicht,
      // sonst sieht man keine Häuser.
      const [w, s, e, n] = bbox;
      const cam = map.cameraForBounds([w, s, e, n], { padding: 40, maxZoom: 17.5 });
      if (cam?.zoom && cam.zoom >= START_MIN_ZOOM) map.jumpTo(cam);
    }

    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");
    map.addControl(
      new maplibregl.GeolocateControl({
        positionOptions: { enableHighAccuracy: true },
        trackUserLocation: true,
        showAccuracyCircle: false,
      }),
      "bottom-right",
    );

    // ---------- Markierungen darstellen ----------

    /** Färbt markierte Häuser per feature-state und setzt Punkte für Häuser ohne Umriss. */
    function syncMarks() {
      if (!loaded) return;
      const current = marksRef.current;
      for (const id of [...painted.keys()]) {
        if (!current.has(id)) {
          map.setFeatureState({ source: "buildings", id }, { status: "none" });
          painted.delete(id);
        }
      }
      for (const [id, m] of current) {
        if (painted.get(id) !== m.status) {
          map.setFeatureState({ source: "buildings", id }, { status: m.status });
          painted.set(id, m.status);
        }
      }
      const points: FeatureCollection<Point> = {
        type: "FeatureCollection",
        features: [...current.values()].map((m) => ({
          type: "Feature",
          properties: { osmId: m.osmId, shape: buildings.has(m.osmId), status: m.status },
          geometry: { type: "Point", coordinates: m.center },
        })),
      };
      (map.getSource("mark-points") as GeoJSONSource | undefined)?.setData(points);
    }
    syncMarksRef.current = syncMarks;

    /** Sichtbarer Ausschnitt plus Vorrat am Rand (gleich für Häuser und Markierungen). */
    function paddedView(): BBox {
      const b = map.getBounds();
      const pad = map.getZoom() >= 16 ? 0.35 : 0.1;
      const dx = (b.getEast() - b.getWest()) * pad;
      const dy = (b.getNorth() - b.getSouth()) * pad;
      return [b.getWest() - dx, b.getSouth() - dy, b.getEast() + dx, b.getNorth() + dy];
    }

    function reportCells() {
      const cells = markCellsIn(paddedView());
      const next = cells.length > MAX_MARK_CELLS ? null : cells;
      const key = next ? next.join(",") : "-";
      if (key === lastCells) return;
      lastCells = key;
      onCellsChangeRef.current(next);
    }

    // ---------- Häuser von Overpass laden ----------

    function updateLoadState() {
      if (map.getZoom() < BUILDING_MIN_ZOOM) onLoadStateRef.current("zoom");
      else if (inflight) onLoadStateRef.current("loading");
      else if (Date.now() < blockedUntil) onLoadStateRef.current("error");
      else onLoadStateRef.current("idle");
    }

    async function loadVisible(force = false) {
      if (disposed || !loaded) return;
      if (map.getZoom() < BUILDING_MIN_ZOOM) return updateLoadState();
      if (inflight) return;
      // Nach einem Fehler nicht bei jedem Verschieben neu fragen (Overpass drosselt sonst noch mehr).
      if (!force && Date.now() < blockedUntil) return updateLoadState();
      // Etwas über den Rand hinaus laden, damit beim Schieben keine leeren Flächen auftauchen.
      const view = paddedView();
      const missing = cellsFor(view).filter((c) => !loadedCells.has(cellKey(c.x, c.y)));
      if (missing.length === 0) return updateLoadState();
      // Mitte zuerst, falls der Ausschnitt größer ist als ein Abruf.
      const cx = (view[0] + view[2]) / 2;
      const cy = (view[1] + view[3]) / 2;
      const dist = (c: { x: number; y: number }) =>
        Math.hypot((c.x + 0.5) * CELL_SIZE - cx, (c.y + 0.5) * CELL_SIZE - cy);
      missing.sort((a, b2) => dist(a) - dist(b2));
      // Ein Abruf: die nächsten Kacheln um die erste herum (Grenzen wie in convex/buildings.ts).
      const first = missing[0];
      const batch = missing
        .filter((c) => Math.abs(c.x - first.x) < MAX_CELL_SPAN / 2 && Math.abs(c.y - first.y) < MAX_CELL_SPAN / 2)
        .slice(0, MAX_CELLS_PER_REQUEST);
      inflight = true;
      updateLoadState();
      try {
        const features = await loadBuildingsRef.current(batch.map((c) => cellKey(c.x, c.y)));
        if (disposed) return;
        for (const f of features) buildings.set(f.properties.osmId, f);
        for (const c of batch) loadedCells.add(cellKey(c.x, c.y));
        (map.getSource("buildings") as GeoJSONSource).setData(toCollection(buildings.values()));
        syncMarks();
        inflight = false;
        backoffMs = 0;
        blockedUntil = 0;
        updateLoadState();
        // Weitere Kacheln, oder der Nutzer hat während des Ladens weitergeschoben.
        void loadVisible();
      } catch {
        if (disposed) return;
        inflight = false;
        backoffMs = Math.min(BACKOFF_MAX_MS, backoffMs ? backoffMs * 2 : BACKOFF_START_MS);
        blockedUntil = Date.now() + backoffMs;
        updateLoadState();
        setTimeout(() => void loadVisible(), backoffMs + 50);
      }
    }

    if (controlsRef) controlsRef.current = { retry: () => void loadVisible(true) };

    map.on("error", () => {
      // Ohne Grundkarte (Stil) kommt nie ein „load“; das soll man sehen.
      if (!loaded) onLoadStateRef.current("mapError");
    });

    map.on("load", () => {
      loaded = true;
      // Die Häuser der Grundkarte ausblenden, wir zeichnen unsere eigenen.
      for (const layer of map.getStyle().layers ?? []) {
        if ("source-layer" in layer && layer["source-layer"] === "building") {
          map.setLayoutProperty(layer.id, "visibility", "none");
        }
        // Autobahnschilder brauchen wir nicht; sie erzeugen zudem Warnungen in der Konsole.
        if (layer.id.includes("shield")) map.removeLayer(layer.id);
      }
      map.addSource("buildings", { type: "geojson", data: EMPTY, promoteId: "osmId" });
      map.addSource("mark-points", { type: "geojson", data: EMPTY });

      const state: ExpressionSpecification = ["coalesce", ["feature-state", "status"], "none"];
      const byState = (none: string | number, done: string | number, blocked: string | number): ExpressionSpecification =>
        ["match", state, "done", done, "blocked", blocked, none];
      map.addLayer({
        id: "buildings-fill",
        type: "fill",
        source: "buildings",
        minzoom: BUILDING_MIN_ZOOM - 0.5,
        paint: {
          "fill-color": byState(COLOR_HOUSE, COLOR_MARKED, COLOR_BLOCKED),
          "fill-opacity": byState(0.9, 1, 1),
        },
      });
      map.addLayer({
        id: "buildings-line",
        type: "line",
        source: "buildings",
        minzoom: BUILDING_MIN_ZOOM - 0.5,
        paint: {
          "line-color": byState(COLOR_HOUSE_LINE, COLOR_MARKED_LINE, COLOR_BLOCKED_LINE),
          "line-width": ["interpolate", ["linear"], ["zoom"], 15, 0.6, 18, byState(0.8, 2, 2)],
        },
      });
      const pointPaint: CircleLayerSpecification["paint"] = {
        "circle-color": ["match", ["get", "status"], "blocked", COLOR_BLOCKED, COLOR_MARKED],
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 10, 2, 14, 4.5, 18, 7],
        "circle-stroke-color": "#15171c",
        "circle-stroke-width": 1,
      };
      // Rausgezoomt: alle Markierungen als Punkte.
      map.addLayer({
        id: "mark-points",
        type: "circle",
        source: "mark-points",
        maxzoom: BUILDING_MIN_ZOOM - 0.5,
        paint: pointPaint,
      });
      // Nah dran: Punkte nur für Häuser, deren Umriss (noch) nicht geladen ist.
      map.addLayer({
        id: "mark-points-noshape",
        type: "circle",
        source: "mark-points",
        minzoom: BUILDING_MIN_ZOOM - 0.5,
        filter: ["==", ["get", "shape"], false],
        paint: pointPaint,
      });
      setReady(true);
      syncMarks();
      reportCells();
      void loadVisible();
    });

    map.on("moveend", () => {
      reportCells();
      void loadVisible();
    });

    // ---------- Antippen ----------

    function pick(point: maplibregl.Point): MapGeoJSONFeature | undefined {
      const layers = ["buildings-fill", "mark-points-noshape"];
      const exact = map.queryRenderedFeatures(point, { layers });
      if (exact.length) return exact[0];
      // Etwas Toleranz für Finger: nächstes Haus im Umkreis von 8 px.
      const r = 8;
      return map.queryRenderedFeatures(
        [
          [point.x - r, point.y - r],
          [point.x + r, point.y + r],
        ],
        { layers },
      )[0];
    }

    function osmIdAt(point: maplibregl.Point): string | null {
      if (map.getZoom() < BUILDING_MIN_ZOOM - 0.5) return null;
      return (pick(point)?.properties?.osmId as string | undefined) ?? null;
    }

    function toggle(osmId: string | null) {
      if (disposed || !osmId) return;
      const mark = marksRef.current.get(osmId);
      const next = nextStatus(statusOf(mark));
      const center = mark?.center ?? (buildings.has(osmId) ? centerOf(buildings.get(osmId)!) : null);
      if (!center) return;
      // Erst weiterschalten, wenn wir den Zustand des Hauses kennen; sonst könnte ein
      // Tipp ein dunkelgelbes Haus, dessen Markierung noch lädt, auf gelb zurücksetzen.
      if (!loadedMarkCellsRef.current.has(markCellOf(center[0], center[1]))) return;
      onToggleRef.current(osmId, next, center);
      navigator.vibrate?.(12);
    }

    // Ein Tipp wartet kurz, ob ein zweiter folgt, wie bei Google Maps:
    //   Doppeltipp = eine Stufe hinein, Doppeltipp und ziehen = mit einem Finger zoomen.
    // Beides entscheidet die App selbst nach der Regel in lib/taps.ts; MapLibres eigene
    // Erkennung ist dafür aus, damit es nur eine Regel gibt. Pointer-Events zählen jeden
    // Druck genau einmal, egal ob Finger oder Maus.
    map.touchZoomRotate._tapDragZoom.disable();
    let pending: { press: Press; payload: string | null; timer: ReturnType<typeof setTimeout> } | null = null;
    let lastPress: Press | null = null;
    let doubleArmed = false;
    let dragZoom: { pointerId: number; startY: number; startZoom: number; around: maplibregl.LngLat; moved: boolean } | null =
      null;
    const clearPending = () => {
      if (pending) clearTimeout(pending.timer);
      pending = null;
    };
    const endDragZoom = () => {
      if (!dragZoom) return;
      if (dragZoom.moved) doubleArmed = false; // kein zusätzlicher Stufen-Zoom
      dragZoom = null;
      map.dragPan.enable();
    };
    const canvas = map.getCanvasContainer();
    const onPointerDown = (e: PointerEvent) => {
      if (!e.isPrimary) {
        // Zweiter Finger (Pinch): kein Tipp.
        clearPending();
        doubleArmed = false;
        endDragZoom();
        return;
      }
      const r = canvas.getBoundingClientRect();
      const press = { x: e.clientX - r.left, y: e.clientY - r.top, t: performance.now() };
      lastPress = press;
      doubleArmed = false;
      const action = onPress(pending, press);
      if (action.kind === "double") {
        clearPending();
        doubleArmed = true;
        // Zieht der Finger jetzt, wird gezoomt statt geschoben.
        map.dragPan.disable();
        dragZoom = {
          pointerId: e.pointerId,
          startY: e.clientY,
          startZoom: map.getZoom(),
          around: map.unproject([press.x, press.y]),
          moved: false,
        };
      } else if (action.kind === "flush") {
        clearPending();
        toggle(action.previous);
      }
    };
    const onPointerMove = (e: PointerEvent) => {
      if (!dragZoom || e.pointerId !== dragZoom.pointerId) return;
      const delta = dragZoomDelta(e.clientY - dragZoom.startY);
      if (delta === 0 && !dragZoom.moved) return;
      dragZoom.moved = true;
      const zoom = Math.max(map.getMinZoom(), Math.min(map.getMaxZoom(), dragZoom.startZoom + delta));
      map.easeTo({ zoom, around: dragZoom.around, duration: 0 });
    };
    canvas.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", endDragZoom);
    window.addEventListener("pointercancel", endDragZoom);

    map.on("click", (e) => {
      if (doubleArmed) {
        // Zweiter Tipp eines Doppeltipps: hineinzoomen, nichts markieren.
        doubleArmed = false;
        map.easeTo({ zoom: Math.min(map.getMaxZoom(), map.getZoom() + 1), around: e.lngLat, duration: 250 });
        return;
      }
      const press = lastPress ?? { x: e.point.x, y: e.point.y, t: performance.now() };
      clearPending();
      // Das Haus jetzt bestimmen, nicht erst nach der Wartezeit: Bis dahin kann die Karte
      // weitergerückt sein (Standortverfolgung, laufender Zoom).
      const osmId = osmIdAt(e.point);
      pending = {
        press,
        payload: osmId,
        timer: setTimeout(() => {
          pending = null;
          toggle(osmId);
        }, DOUBLE_TAP_MS),
      };
    });

    map.on("mousemove", (e) => {
      const hit = map.getZoom() >= BUILDING_MIN_ZOOM - 0.5 && pick(e.point);
      map.getCanvas().style.cursor = hit ? "pointer" : "";
    });

    return () => {
      disposed = true;
      clearPending();
      canvas.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", endDragZoom);
      window.removeEventListener("pointercancel", endDragZoom);
      if (controlsRef) controlsRef.current = null;
      syncMarksRef.current = null;
      map.remove();
      mapRef.current = null;
      setReady(false);
    };
    // Die Karte wird nur einmal je Aktion aufgebaut.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    marksRef.current = new Map(marks.map((m) => [m.osmId, m]));
    if (ready) syncMarksRef.current?.();
  }, [marks, ready]);

  // MapLibre setzt am Container position: relative; deshalb ein eigener Rahmen außen.
  return (
    <div className="absolute inset-0">
      <div ref={container} className="h-full w-full" data-testid="map" />
    </div>
  );
}
