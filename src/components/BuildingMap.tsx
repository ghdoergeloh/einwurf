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
import { addTap, cellsToWatch, settleTaps, type PendingTap } from "../lib/pendingTaps";
import { BURST_SECONDS, createBurst, drawBurst, type Burst } from "../lib/sparks";

// Ab MapLibre 6 braucht jeder Bundler den Pfad zum Worker.
maplibregl.setWorkerUrl(workerUrl);

export const MAP_STYLE_URL = "https://tiles.openfreemap.org/styles/positron";

/** Ab dieser Zoomstufe werden Häuser geladen und angezeigt. */
export const BUILDING_MIN_ZOOM = 15;
/** Mindest-Zoom beim Öffnen einer Aktion. */
const START_MIN_ZOOM = 16;
/** Overpass braucht oft 20–40 s; ein neues Gebiet soll nicht auf den laufenden Abruf warten. */
const MAX_PARALLEL_LOADS = 2;
/** Ab hier stehen Hausnummern auf den Häusern. */
const HOUSE_NUMBER_MIN_ZOOM = 17;
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
  /** Ein gemerkter Tipp wurde verworfen, weil jemand anderes das Haus inzwischen geändert hat. */
  onConflict: () => void;
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
  onConflict,
  onLoadState,
  loadBuildings,
  loadedMarkCells,
  controlsRef,
}: Props) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const syncMarksRef = useRef<(() => void) | null>(null);
  const settleRef = useRef<(() => void) | null>(null);
  const sparksRef = useRef<HTMLCanvasElement>(null);
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
  const onConflictRef = useRef(onConflict);
  onConflictRef.current = onConflict;
  onLoadStateRef.current = onLoadState;
  onCellsChangeRef.current = onCellsChange;

  useEffect(() => {
    if (!container.current) return;
    const buildings = new Map<string, BuildingFeature>();
    const loadedCells = new Set<string>();
    /** osmIds, die gerade als markiert eingefärbt sind (feature-state). */
    const painted = new Map<string, MarkStatus>();
    /** Tipps auf Häuser, deren Markierungen noch laden (siehe lib/pendingTaps.ts). */
    let pendingTaps = new Map<string, PendingTap>();
    /** Laufende Abrufe und ihre Kacheln; bis zu MAX_PARALLEL_LOADS gleichzeitig. */
    let inflight = 0;
    const fetching = new Set<string>();
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
      const current = new Map(marksRef.current);
      for (const [id, p] of pendingTaps) {
        if (p.to === "none") current.delete(id);
        else current.set(id, { osmId: id, center: p.center, status: p.to });
      }
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

    /** Gemerkte Tipps abschicken, sobald der echte Zustand ihrer Zelle bekannt ist. */
    function settle() {
      if (pendingTaps.size === 0) return;
      const r = settleTaps(
        pendingTaps,
        (c) => loadedMarkCellsRef.current.has(markCellOf(c[0], c[1])),
        (id) => statusOf(marksRef.current.get(id)),
      );
      pendingTaps = r.rest;
      for (const t of r.send) {
        onToggleRef.current(t.osmId, t.status, t.center);
        // Bis die Liste neu kommt, gilt schon der neue Zustand (kein kurzes Zurückspringen).
        if (t.status === "none") marksRef.current.delete(t.osmId);
        else marksRef.current.set(t.osmId, { osmId: t.osmId, center: t.center, status: t.status });
      }
      if (r.conflicts.length) onConflictRef.current();
      syncMarks();
      reportCells();
    }
    settleRef.current = settle;

    // ---------- Pixel-Funken ----------

    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    let bursts: { burst: Burst; at: maplibregl.LngLat; start: number }[] = [];
    let frame = 0;
    function drawSparks(now: number) {
      frame = 0;
      const cv = sparksRef.current;
      const ctx = cv?.getContext("2d");
      if (!cv || !ctx) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = cv.clientWidth;
      const h = cv.clientHeight;
      if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
        cv.width = Math.round(w * dpr);
        cv.height = Math.round(h * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      bursts = bursts.filter((b) => (now - b.start) / 1000 < BURST_SECONDS);
      for (const b of bursts) {
        // Am Ort auf der Karte festhalten, auch wenn sie gerade geschoben wird.
        const p = map.project(b.at);
        drawBurst(ctx, b.burst, p.x, p.y, (now - b.start) / 1000);
      }
      // Nur zeichnen, solange etwas sprüht.
      if (bursts.length) frame = requestAnimationFrame(drawSparks);
    }
    function sparkle(status: HouseStatus, at: maplibregl.LngLat) {
      if (reduceMotion) return;
      bursts.push({ burst: createBurst(status), at, start: performance.now() });
      if (!frame) frame = requestAnimationFrame(drawSparks);
    }

    /** Sichtbarer Ausschnitt plus Vorrat am Rand (gleich für Häuser und Markierungen). */
    function paddedView(): BBox {
      const b = map.getBounds();
      const pad = map.getZoom() >= 16 ? 0.35 : 0.1;
      const dx = (b.getEast() - b.getWest()) * pad;
      const dy = (b.getNorth() - b.getSouth()) * pad;
      return [b.getWest() - dx, b.getSouth() - dy, b.getEast() + dx, b.getNorth() + dy];
    }

    function reportCells() {
      const view = markCellsIn(paddedView());
      // Zellen gemerkter Tipps bleiben abonniert, sonst würden sie nach dem Weitergehen nie abgeschickt.
      const watch = cellsToWatch(pendingTaps).filter((c) => !view.includes(c));
      const next = view.length > MAX_MARK_CELLS ? (watch.length ? watch : null) : [...view, ...watch];
      const key = next ? next.join(",") : "-";
      if (key === lastCells) return;
      lastCells = key;
      onCellsChangeRef.current(next);
    }

    // ---------- Häuser von Overpass laden ----------

    function updateLoadState() {
      if (map.getZoom() < BUILDING_MIN_ZOOM) onLoadStateRef.current("zoom");
      else if (inflight > 0) onLoadStateRef.current("loading");
      else if (Date.now() < blockedUntil) onLoadStateRef.current("error");
      else onLoadStateRef.current("idle");
    }

    async function loadVisible(force = false) {
      if (disposed || !loaded) return;
      if (map.getZoom() < BUILDING_MIN_ZOOM) return updateLoadState();
      if (inflight >= MAX_PARALLEL_LOADS) return;
      // Nach einem Fehler nicht bei jedem Verschieben neu fragen (Overpass drosselt sonst noch mehr).
      if (!force && Date.now() < blockedUntil) return updateLoadState();
      // Etwas über den Rand hinaus laden, damit beim Schieben keine leeren Flächen auftauchen.
      const view = paddedView();
      const missing = cellsFor(view).filter((c) => !loadedCells.has(cellKey(c.x, c.y)) && !fetching.has(cellKey(c.x, c.y)));
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
      const keys = batch.map((c) => cellKey(c.x, c.y));
      inflight++;
      keys.forEach((k) => fetching.add(k));
      updateLoadState();
      try {
        const features = await loadBuildingsRef.current(keys);
        if (disposed) return;
        for (const f of features) buildings.set(f.properties.osmId, f);
        for (const c of batch) loadedCells.add(cellKey(c.x, c.y));
        (map.getSource("buildings") as GeoJSONSource).setData(toCollection(buildings.values()));
        syncMarks();
        inflight--;
        keys.forEach((k) => fetching.delete(k));
        backoffMs = 0;
        blockedUntil = 0;
        updateLoadState();
        // Weitere Kacheln, oder der Nutzer hat während des Ladens weitergeschoben.
        void loadVisible();
      } catch {
        if (disposed) return;
        inflight--;
        keys.forEach((k) => fetching.delete(k));
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
      // Hausnummern: auf dem Haus, hell auf dunkel, dunkel auf gelb. Schrift aus dem Stil der Grundkarte.
      const font = (map.getStyle().layers ?? [])
        .map((l) => (l.type === "symbol" ? l.layout?.["text-font"] : undefined))
        .find((f): f is string[] => Array.isArray(f) && f.every((x) => typeof x === "string"));
      if (map.getStyle().glyphs && font) {
        map.addLayer({
          id: "buildings-number",
          type: "symbol",
          source: "buildings",
          minzoom: HOUSE_NUMBER_MIN_ZOOM,
          filter: ["has", "hn"],
          layout: {
            "text-field": ["get", "hn"],
            "text-font": font.some((f) => f.includes("Bold")) ? font : [font[0].replace(/Regular|Italic/, "Bold")],
            "text-size": ["interpolate", ["linear"], ["zoom"], HOUSE_NUMBER_MIN_ZOOM, 10, 19, 14],
            "text-padding": 1,
          },
          paint: {
            "text-color": byState("#d4d7de", "#3a2f00", "#f3ecd0"),
          },
        });
      }
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

    function toggle(tap: { osmId: string; at: maplibregl.LngLat } | null) {
      if (disposed || !tap) return;
      const { osmId, at } = tap;
      const mark = marksRef.current.get(osmId);
      const center = mark?.center ?? (buildings.has(osmId) ? centerOf(buildings.get(osmId)!) : null);
      if (!center) return;
      const known = loadedMarkCellsRef.current.has(markCellOf(center[0], center[1]));
      let next: HouseStatus;
      if (known && !pendingTaps.has(osmId)) {
        next = nextStatus(statusOf(mark));
        onToggleRef.current(osmId, next, center);
      } else {
        // Zustand lädt noch: sofort umfärben, abschicken erst, wenn er bekannt ist. So kann
        // ein Tipp kein „nicht möglich“ überschreiben, das jemand anderes gesetzt hat.
        const pending = pendingTaps.get(osmId);
        next = nextStatus(pending ? pending.to : statusOf(mark));
        pendingTaps = addTap(pendingTaps, osmId, statusOf(mark), center);
        syncMarks();
        reportCells();
        settle();
      }
      sparkle(next, at);
      navigator.vibrate?.(next === "done" ? 12 : 6);
    }

    // Ein Tipp wartet kurz, ob ein zweiter folgt, wie bei Google Maps:
    //   Doppeltipp = eine Stufe hinein, Doppeltipp und ziehen = mit einem Finger zoomen.
    // Beides entscheidet die App selbst nach der Regel in lib/taps.ts; MapLibres eigene
    // Erkennung ist dafür aus, damit es nur eine Regel gibt. Pointer-Events zählen jeden
    // Druck genau einmal, egal ob Finger oder Maus.
    map.touchZoomRotate._tapDragZoom.disable();
    type Tap = { osmId: string; at: maplibregl.LngLat } | null;
    let pending: { press: Press; payload: Tap; timer: ReturnType<typeof setTimeout> } | null = null;
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
      const tap: Tap = osmId ? { osmId, at: e.lngLat } : null;
      pending = {
        press,
        payload: tap,
        timer: setTimeout(() => {
          pending = null;
          toggle(tap);
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
      if (frame) cancelAnimationFrame(frame);
      settleRef.current = null;
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
    if (ready) {
      syncMarksRef.current?.();
      settleRef.current?.();
    }
  }, [marks, loadedMarkCells, ready]);

  // MapLibre setzt am Container position: relative; deshalb ein eigener Rahmen außen.
  return (
    <div className="absolute inset-0">
      <div ref={container} className="h-full w-full" data-testid="map" />
      <canvas ref={sparksRef} className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden="true" />
    </div>
  );
}
