/**
 * OpenStreetMap-Gebäude: Overpass-Abfrage bauen, Antwort parsen, Kacheln.
 * Rein und ohne Netz – wird von der Convex-Action (convex/buildings.ts) und vom Browser genutzt.
 */
import type { Feature, FeatureCollection, MultiPolygon, Position } from "geojson";

export type BBox = [west: number, south: number, east: number, north: number];

export interface BuildingProps {
  osmId: string;
  /** Hausnummer(n) aus OSM, z. B. "12" oder "3, 5"; fehlt bei Garagen, Schuppen usw. */
  hn?: string;
}

/** Format der Cache-Einträge; ältere Einträge (ohne Hausnummern) werden neu geladen. */
export const BUILDINGS_FORMAT = 2;

export type BuildingFeature = Feature<MultiPolygon, BuildingProps>;

/** Größe einer Kachel im Cache in Grad (in Bornheim etwa 550 m Nord-Süd × 350 m Ost-West). */
export const CELL_SIZE = 0.005;
/** Ein Abruf umfasst nur nahe beieinanderliegende Kacheln (Abstand je Richtung kleiner als dieser Wert). */
export const MAX_CELL_SPAN = 8;

export function buildQuery([w, s, e, n]: BBox): string {
  const box = `${s},${w},${n},${e}`;
  return `[out:json][timeout:25];(way["building"](${box});relation["building"]["type"="multipolygon"](${box});node["addr:housenumber"](${box}););out geom;`;
}

interface OverpassPoint {
  lat: number;
  lon: number;
}
interface OverpassMember {
  type: string;
  role: string;
  geometry?: OverpassPoint[];
}
interface OverpassElement {
  type: string;
  id: number;
  lat?: number;
  lon?: number;
  tags?: Record<string, string>;
  geometry?: OverpassPoint[];
  members?: OverpassMember[];
}

const toRing = (pts: OverpassPoint[]): Position[] => pts.map((p) => [round(p.lon), round(p.lat)]);
const round = (x: number) => Math.round(x * 1e7) / 1e7;

function isClosed(ring: Position[]) {
  const a = ring[0];
  const b = ring[ring.length - 1];
  return ring.length >= 4 && a[0] === b[0] && a[1] === b[1];
}

/** Fügt offene Teilstücke (Multipolygon-Mitglieder) zu geschlossenen Ringen zusammen. */
export function joinRings(parts: Position[][]): Position[][] {
  const rings: Position[][] = [];
  const open = parts.filter((p) => p.length >= 2).map((p) => [...p]);
  const same = (a: Position, b: Position) => a[0] === b[0] && a[1] === b[1];
  while (open.length) {
    let current = open.shift()!;
    let changed = true;
    while (!same(current[0], current[current.length - 1]) && changed) {
      changed = false;
      for (let i = 0; i < open.length; i++) {
        const p = open[i];
        const end = current[current.length - 1];
        if (same(end, p[0])) current = current.concat(p.slice(1));
        else if (same(end, p[p.length - 1])) current = current.concat([...p].reverse().slice(1));
        else if (same(current[0], p[p.length - 1])) current = p.concat(current.slice(1));
        else if (same(current[0], p[0])) current = [...p].reverse().concat(current.slice(1));
        else continue;
        open.splice(i, 1);
        changed = true;
        break;
      }
    }
    if (isClosed(current)) rings.push(current);
  }
  return rings;
}

/** Wandelt eine Overpass-Antwort in GeoJSON-Gebäude um. */
export function parseOverpass(json: { elements?: OverpassElement[] }): BuildingFeature[] {
  const features: BuildingFeature[] = [];
  const numbers = new Map<BuildingFeature, string[]>();
  for (const el of json.elements ?? []) {
    let coords: Position[][][] = [];
    if (el.type === "way" && el.geometry) {
      const ring = toRing(el.geometry);
      if (isClosed(ring)) coords = [[ring]];
    } else if (el.type === "relation" && el.members) {
      const outers = joinRings(
        el.members.filter((m) => m.type === "way" && m.role !== "inner" && m.geometry).map((m) => toRing(m.geometry!)),
      );
      // Innenhöfe lassen wir weg: Für das Antippen reicht der Umriss.
      coords = outers.map((r) => [r]);
    }
    if (coords.length === 0) continue;
    features.push({
      type: "Feature",
      id: `${el.type}/${el.id}`,
      properties: { osmId: `${el.type}/${el.id}` },
      geometry: { type: "MultiPolygon", coordinates: coords },
    });
    const own = el.tags?.["addr:housenumber"];
    if (own) numbers.set(features[features.length - 1], own.split(/[;,]/).map((x) => x.trim()));
  }
  assignAddressPoints(features, json.elements ?? [], numbers);
  for (const [f, list] of numbers) {
    const unique = [...new Set(list.filter(Boolean))].sort(byHouseNumber);
    if (unique.length) f.properties.hn = unique.length > 3 ? `${unique.slice(0, 3).join(", ")} …` : unique.join(", ");
  }
  return features;
}

/** Natürliche Reihenfolge: 3 < 5 < 11 < 11a. */
const byHouseNumber = (a: string, b: string) => parseInt(a, 10) - parseInt(b, 10) || a.localeCompare(b, "de");

/** Rastergröße für die Suche, in welchem Haus ein Adresspunkt liegt (≈ 30 m). */
const GRID = 0.0004;

/**
 * Adresspunkte (Knoten mit addr:housenumber) dem Haus zuordnen, in dem sie liegen.
 * In Deutschland hängt die Hausnummer oft an so einem Punkt statt am Gebäude.
 */
function assignAddressPoints(features: BuildingFeature[], elements: OverpassElement[], numbers: Map<BuildingFeature, string[]>) {
  const points = elements.filter((el) => el.type === "node" && el.tags?.["addr:housenumber"]);
  if (points.length === 0) return;
  const grid = new Map<string, BuildingFeature[]>();
  /** Sehr große Gebäude (Hallen, Fehler in den Daten) nicht ins Raster, sondern immer prüfen. */
  const big: BuildingFeature[] = [];
  const boxes = new Map<BuildingFeature, BBox>();
  for (const f of features) {
    let [w, s, e, n] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const poly of f.geometry.coordinates)
      for (const [x, y] of poly[0]) {
        w = Math.min(w, x); e = Math.max(e, x); s = Math.min(s, y); n = Math.max(n, y);
      }
    boxes.set(f, [w, s, e, n]);
    if ((Math.floor(e / GRID) - Math.floor(w / GRID) + 1) * (Math.floor(n / GRID) - Math.floor(s / GRID) + 1) > 100) {
      big.push(f);
      continue;
    }
    for (let gx = Math.floor(w / GRID); gx <= Math.floor(e / GRID); gx++)
      for (let gy = Math.floor(s / GRID); gy <= Math.floor(n / GRID); gy++) {
        const k = `${gx}:${gy}`;
        const list = grid.get(k);
        if (list) list.push(f);
        else grid.set(k, [f]);
      }
  }
  const contains = (f: BuildingFeature, pt: Position) => {
    const [w, s, e, n] = boxes.get(f)!;
    return pt[0] >= w && pt[0] <= e && pt[1] >= s && pt[1] <= n && f.geometry.coordinates.some((poly) => inRing(pt, poly[0]));
  };
  for (const el of points) {
    const hn = el.tags!["addr:housenumber"];
    if (el.lon === undefined || el.lat === undefined) continue;
    const pt: Position = [el.lon, el.lat];
    const house =
      grid.get(`${Math.floor(el.lon / GRID)}:${Math.floor(el.lat / GRID)}`)?.find((f) => contains(f, pt)) ??
      big.find((f) => contains(f, pt));
    if (!house) continue;
    const list = numbers.get(house) ?? [];
    list.push(...hn.split(/[;,]/).map((x) => x.trim()));
    numbers.set(house, list);
  }
}

/** Liegt der Punkt [lng, lat] im Haus (in einem seiner Außenringe)? */
export function containsPoint(f: BuildingFeature, pt: Position): boolean {
  return f.geometry.coordinates.some((poly) => inRing(pt, poly[0]));
}

/** Punkt im Ring (Strahl-Methode). */
function inRing([x, y]: Position, ring: Position[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function cellKey(x: number, y: number) {
  return `${x}:${y}`;
}

/** Alle Cache-Kacheln, die einen Ausschnitt überdecken. */
export function cellsFor([w, s, e, n]: BBox): { x: number; y: number }[] {
  const cells = [];
  for (let x = Math.floor(w / CELL_SIZE); x <= Math.floor(e / CELL_SIZE); x++) {
    for (let y = Math.floor(s / CELL_SIZE); y <= Math.floor(n / CELL_SIZE); y++) cells.push({ x, y });
  }
  return cells;
}

/** Umschließender Ausschnitt einer Menge von Kacheln. */
export function cellsBBox(cells: { x: number; y: number }[]): BBox {
  const xs = cells.map((c) => c.x);
  const ys = cells.map((c) => c.y);
  return [
    Math.min(...xs) * CELL_SIZE,
    Math.min(...ys) * CELL_SIZE,
    (Math.max(...xs) + 1) * CELL_SIZE,
    (Math.max(...ys) + 1) * CELL_SIZE,
  ];
}

export function toCollection(features: Iterable<BuildingFeature>): FeatureCollection<MultiPolygon, BuildingProps> {
  return { type: "FeatureCollection", features: [...features] };
}

/** Mittelpunkt eines Hauses (Schwerpunkt der Eckpunkte des ersten Außenrings), [lng, lat]. */
export function centerOf(f: BuildingFeature): [number, number] {
  const ring = f.geometry.coordinates[0][0];
  const n = Math.max(1, ring.length - 1); // letzter Punkt = erster Punkt
  let x = 0;
  let y = 0;
  for (let i = 0; i < n; i++) {
    x += ring[i][0];
    y += ring[i][1];
  }
  return [Math.round((x / n) * 1e7) / 1e7, Math.round((y / n) * 1e7) / 1e7];
}

/** Kachel "x:y" → {x, y}; null bei ungültigem Format. */
export function parseCellKey(key: string): { x: number; y: number } | null {
  const m = /^(-?\d{1,6}):(-?\d{1,6})$/.exec(key);
  if (!m) return null;
  const x = Number(m[1]);
  const y = Number(m[2]);
  // Nur Kacheln auf der Erde (±180° Länge, ±90° Breite).
  if (x < -180 / CELL_SIZE || x >= 180 / CELL_SIZE || y < -90 / CELL_SIZE || y >= 90 / CELL_SIZE) return null;
  return { x, y };
}

/** Kachel, in der ein Punkt [lng, lat] liegt. */
export function cellKeyOf([lng, lat]: [number, number]): string {
  return cellKey(Math.floor(lng / CELL_SIZE), Math.floor(lat / CELL_SIZE));
}

/** Kompakte Form für Cache und Übertragung: [[osmId, MultiPolygon-Koordinaten, Hausnummer?], …] als JSON. */
export function encodeBuildings(features: BuildingFeature[]): string {
  const r = (x: number) => Math.round(x * 1e6) / 1e6; // ≈ 10 cm
  return JSON.stringify(
    features.map((f) => {
      const row: unknown[] = [f.properties.osmId, f.geometry.coordinates.map((p) => p.map((ring) => ring.map(([x, y]) => [r(x), r(y)])))];
      if (f.properties.hn) row.push(f.properties.hn);
      return row;
    }),
  );
}

export function decodeBuildings(data: string): BuildingFeature[] {
  const rows = JSON.parse(data) as [string, Position[][][], string?][];
  return rows.map(([osmId, coordinates, hn]) => ({
    type: "Feature",
    id: osmId,
    properties: hn ? { osmId, hn } : { osmId },
    geometry: { type: "MultiPolygon", coordinates },
  }));
}

/** Höchstens so viele Kacheln lädt das Vorladen je Aktion (in Mitteleuropa etwa 100–120 km², etwa ganz Bornheim). */
export const MAX_PREFETCH_CELLS = 600;
/** Ein Vorlade-Abruf umfasst einen Block von 6 × 4 Kacheln (= MAX_CELLS_PER_LOAD, Spanne < MAX_CELL_SPAN). */
const BLOCK_W = 6;
const BLOCK_H = 4;

/**
 * Plant das Vorladen eines Gebiets: Blöcke von Kacheln, vom Startpunkt nach außen sortiert.
 * Ist das Gebiet zu groß, fallen die vom Startpunkt am weitesten entfernten Blöcke weg.
 */
export function planPrefetch(
  bbox: BBox,
  start: [number, number],
  maxCells = MAX_PREFETCH_CELLS,
  /** Nur Blöcke, deren Ausschnitt das liefert (z. B. die gewählten Gebiete berührt). */
  wanted?: (block: BBox) => boolean,
): string[][] {
  const [w, s, e, n] = bbox;
  if (!(w < e && s < n)) return [];
  // Nur ein Fenster um den Startpunkt betrachten: Mehr als maxCells Kacheln werden ohnehin
  // nicht geladen, und so bleibt die Planung auch für riesige Ausschnitte schnell.
  const r = Math.ceil(Math.sqrt(maxCells)) + Math.max(BLOCK_W, BLOCK_H);
  const sx = Math.floor(start[0] / CELL_SIZE);
  const sy = Math.floor(start[1] / CELL_SIZE);
  const x0 = Math.max(Math.floor(w / CELL_SIZE), sx - r);
  const x1 = Math.min(Math.floor(e / CELL_SIZE), sx + r);
  const y0 = Math.max(Math.floor(s / CELL_SIZE), sy - r);
  const y1 = Math.min(Math.floor(n / CELL_SIZE), sy + r);
  if (x0 > x1 || y0 > y1) return [];
  const blocks: { cells: string[]; dist: number }[] = [];
  // Raster so ausrichten, dass die Startkachel mitten in einem Block liegt.
  const ox = sx - Math.floor(BLOCK_W / 2);
  const oy = sy - Math.floor(BLOCK_H / 2);
  const firstX = ox - Math.ceil((ox - x0) / BLOCK_W) * BLOCK_W;
  const firstY = oy - Math.ceil((oy - y0) / BLOCK_H) * BLOCK_H;
  for (let bx = firstX; bx <= x1; bx += BLOCK_W) {
    for (let by = firstY; by <= y1; by += BLOCK_H) {
      const cells: string[] = [];
      const xa = Math.max(bx, x0);
      const xb = Math.min(bx + BLOCK_W, x1 + 1);
      const ya = Math.max(by, y0);
      const yb = Math.min(by + BLOCK_H, y1 + 1);
      if (xa >= xb || ya >= yb) continue;
      for (let x = xa; x < xb; x++)
        for (let y = ya; y < yb; y++) {
          // Mit Filter: jede Kachel einzeln prüfen, damit keine Kachel ganz außerhalb geladen wird.
          if (wanted && !wanted([x * CELL_SIZE, y * CELL_SIZE, (x + 1) * CELL_SIZE, (y + 1) * CELL_SIZE])) continue;
          cells.push(cellKey(x, y));
        }
      if (cells.length === 0) continue;
      const cx = ((xa + xb) / 2) * CELL_SIZE;
      const cy = ((ya + yb) / 2) * CELL_SIZE;
      // Abstand in etwa gleichen Metern (Länge schrumpft mit dem Breitengrad).
      const kx = Math.cos((start[1] * Math.PI) / 180);
      blocks.push({ cells, dist: Math.hypot((cx - start[0]) * kx, cy - start[1]) });
    }
  }
  blocks.sort((a, b) => a.dist - b.dist);
  const out: string[][] = [];
  let total = 0;
  for (const b of blocks) {
    if (total + b.cells.length > maxCells) break;
    out.push(b.cells);
    total += b.cells.length;
  }
  return out;
}

/** Ausschnitt einer Aktion fürs Vorladen: Gebiet der Ortssuche, sonst 1 km um die Mitte. */
export function prefetchArea(campaign: { center: { lat: number; lng: number }; bbox?: number[] | null }): BBox {
  const b = campaign.bbox;
  if (b && b.length === 4) return [b[0], b[1], b[2], b[3]];
  const { lat, lng } = campaign.center;
  return [lng - 0.014, lat - 0.009, lng + 0.014, lat + 0.009];
}
