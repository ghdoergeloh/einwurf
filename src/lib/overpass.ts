import type { Feature, FeatureCollection, MultiPolygon, Position } from "geojson";

export type BBox = [west: number, south: number, east: number, north: number];

export interface BuildingProps {
  osmId: string;
}

export type BuildingFeature = Feature<MultiPolygon, BuildingProps>;

export const OVERPASS_URL = "https://overpass-api.de/api/interpreter";

/** Größe einer Kachel im Cache in Grad (etwa 550 m × 500 m in Mitteleuropa). */
export const CELL_SIZE = 0.005;

export function buildQuery([w, s, e, n]: BBox): string {
  const box = `${s},${w},${n},${e}`;
  return `[out:json][timeout:25];(way["building"](${box});relation["building"]["type"="multipolygon"](${box}););out geom;`;
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
  }
  return features;
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

export async function fetchBuildings(bbox: BBox, signal?: AbortSignal): Promise<BuildingFeature[]> {
  const res = await fetch(OVERPASS_URL, {
    method: "POST",
    body: new URLSearchParams({ data: buildQuery(bbox) }),
    signal,
  });
  if (!res.ok) throw new Error(`Overpass ${res.status}`);
  return parseOverpass(await res.json());
}

export function toCollection(features: Iterable<BuildingFeature>): FeatureCollection<MultiPolygon, BuildingProps> {
  return { type: "FeatureCollection", features: [...features] };
}
